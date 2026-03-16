import type { ShopifyMonitorAgent } from "../agent.js";
import type { TranslationIssueRecord, ShopifyProductRecord } from "@domien-sev/shared-types";
import { createItem, readItems, updateItem } from "@directus/sdk";
import { scanAllProducts } from "../tools/product-scanner.js";
import { checkTranslations } from "../tools/translation-checker.js";
import { checkPlugins } from "../tools/plugin-checker.js";
import { evaluateTranslationQuality } from "../tools/quality-evaluator.js";
import { PLUGIN_REGISTRY } from "../config/plugins.js";
import { formatScanReport, storeReportArtifact } from "./report.js";
import type { TranslationPair } from "../tools/quality-evaluator.js";

export interface ScanStats {
  totalProducts: number;
  missingTranslations: number;
  suspiciousTranslations: number;
  emptyTranslations: number;
  pluginIssues: number;
  pluginReminders: number;
  newIssuesCreated: number;
  issuesUpdated: number;
  scanDurationMs: number;
}

/**
 * Full daily scan orchestration:
 * 1. Scan all products via product-scanner
 * 2. Check translations via translation-checker
 * 3. For suspicious translations: get DeepL reference, then evaluate quality
 * 4. Check plugins via plugin-checker
 * 5. Deduplicate against existing open issues in Directus
 * 6. Sync shopify_products cache in Directus
 * 7. Create/update translation_issues in Directus
 * 8. Generate and post report
 */
export async function handleDailyScan(agent: ShopifyMonitorAgent): Promise<ScanStats> {
  const startTime = Date.now();
  console.log("[daily-scan] Starting full translation scan...");

  // Step 1: Scan all products
  const resources = await scanAllProducts(agent.shopifyClient, "fr");

  // Step 2: Check translations
  const translationIssues = checkTranslations(resources, "fr");

  // Step 3: For "outdated" (suspicious) translations, get DeepL references and evaluate quality
  const suspiciousIssues = translationIssues.filter((i) => i.issueType === "outdated");
  const qualityResults = new Map<string, { score: number; reasoning: string }>();

  if (suspiciousIssues.length > 0 && agent.anthropicApiKey) {
    console.log(`[daily-scan] Evaluating ${suspiciousIssues.length} suspicious translations...`);

    // Get DeepL reference translations for suspicious items
    const pairs: TranslationPair[] = [];
    for (const issue of suspiciousIssues) {
      try {
        const deeplSuggestion = await agent.deeplClient.translateText(issue.sourceValue, "nl", "fr");
        pairs.push({
          field: `${issue.resourceId}:${issue.field}`,
          source: issue.sourceValue,
          translation: issue.currentTranslation ?? "",
          deeplSuggestion,
        });
      } catch (err) {
        console.warn(`[daily-scan] DeepL failed for ${issue.field}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (pairs.length > 0) {
      const results = await evaluateTranslationQuality(pairs, agent.anthropicApiKey);
      for (const result of results) {
        qualityResults.set(result.field, { score: result.score, reasoning: result.reasoning });
      }
    }
  }

  // Step 4: Check plugins
  const pluginResults = await checkPlugins(
    agent.shopifyClient,
    PLUGIN_REGISTRY,
    async (memoryKey: string): Promise<string | null> => {
      try {
        const memory = await agent.getMemory(memoryKey);
        if (memory?.value && typeof memory.value === "object" && "lastChecked" in memory.value) {
          return memory.value.lastChecked as string;
        }
        return null;
      } catch {
        return null;
      }
    },
  );

  // Step 5: Deduplicate against existing open issues in Directus
  const client = agent.directus.getClient("sev-ai");
  let existingIssues: TranslationIssueRecord[] = [];
  try {
    existingIssues = await client.request(
      readItems("translation_issues", {
        filter: { status: { _eq: "open" } },
        limit: -1,
      }),
    ) as TranslationIssueRecord[];
  } catch (err) {
    console.warn(`[daily-scan] Failed to fetch existing issues: ${err instanceof Error ? err.message : String(err)}`);
  }

  const existingIssueKeys = new Set(
    existingIssues.map((i) => `${i.shopify_product_id}:${i.field}`),
  );

  // Step 6: Sync shopify_products cache in Directus
  await syncProductCache(agent, resources);

  // Step 7: Create/update translation_issues in Directus
  let newIssuesCreated = 0;
  let issuesUpdated = 0;

  for (const issue of translationIssues) {
    const issueKey = `${issue.resourceId}:${issue.field}`;
    const qualityInfo = qualityResults.get(issueKey);

    // Determine if this is "suspicious" based on quality score
    const issueType = issue.issueType === "outdated"
      ? (qualityInfo && qualityInfo.score >= 0.7 ? "outdated" : "suspicious" as "missing" | "suspicious" | "outdated")
      : issue.issueType;

    // Extract product handle from resource ID (gid://shopify/Product/12345 → 12345)
    const shopifyId = issue.resourceId.split("/").pop() ?? issue.resourceId;

    const record: Omit<TranslationIssueRecord, "id" | "date_created" | "date_updated"> = {
      shopify_product_id: shopifyId,
      product_handle: "", // Will be populated from cache if available
      product_title: "",
      field: issue.field,
      issue_type: issueType === "empty" ? "missing" : issueType as "missing" | "suspicious" | "outdated",
      source_value: issue.sourceValue.substring(0, 5000),
      current_translation: issue.currentTranslation?.substring(0, 5000) ?? null,
      suggested_translation: null,
      confidence_score: qualityInfo?.score ?? 0,
      details: qualityInfo?.reasoning ?? `${issue.issueType} translation detected`,
      source_type: "product",
      plugin_name: null,
      status: "open",
      date_resolved: null,
    };

    try {
      if (existingIssueKeys.has(issueKey)) {
        // Update existing issue
        const existing = existingIssues.find(
          (e) => `${e.shopify_product_id}:${e.field}` === issueKey,
        );
        if (existing?.id) {
          await client.request(
            updateItem("translation_issues", existing.id, {
              source_value: record.source_value,
              current_translation: record.current_translation,
              confidence_score: record.confidence_score,
              details: record.details,
              issue_type: record.issue_type,
            }),
          );
          issuesUpdated++;
        }
      } else {
        // Create new issue
        await client.request(createItem("translation_issues", record));
        newIssuesCreated++;
      }
    } catch (err) {
      console.warn(`[daily-scan] Failed to upsert issue ${issueKey}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Also create issues for plugin problems
  for (const pluginResult of pluginResults.filter((r) => r.issueType === "missing_translation")) {
    try {
      const issueKey = `${pluginResult.productId ?? "plugin"}:${pluginResult.namespace}.${pluginResult.key}`;
      if (!existingIssueKeys.has(issueKey)) {
        await client.request(
          createItem("translation_issues", {
            shopify_product_id: pluginResult.productId ?? "plugin",
            product_handle: "",
            product_title: "",
            field: `${pluginResult.namespace}.${pluginResult.key}`,
            issue_type: "missing",
            source_value: pluginResult.sourceValue?.substring(0, 5000) ?? "",
            current_translation: null,
            suggested_translation: null,
            confidence_score: 0,
            details: pluginResult.details,
            source_type: "plugin",
            plugin_name: pluginResult.pluginName,
            status: "open",
            date_resolved: null,
          } as Omit<TranslationIssueRecord, "id" | "date_created" | "date_updated">),
        );
        newIssuesCreated++;
      }
    } catch (err) {
      console.warn(`[daily-scan] Failed to create plugin issue: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 8: Generate report
  const stats: ScanStats = {
    totalProducts: resources.length,
    missingTranslations: translationIssues.filter((i) => i.issueType === "missing" || i.issueType === "empty").length,
    suspiciousTranslations: translationIssues.filter((i) => i.issueType === "outdated").length,
    emptyTranslations: translationIssues.filter((i) => i.issueType === "empty").length,
    pluginIssues: pluginResults.filter((r) => r.issueType === "missing_translation").length,
    pluginReminders: pluginResults.filter((r) => r.issueType === "stale_check_reminder").length,
    newIssuesCreated,
    issuesUpdated,
    scanDurationMs: Date.now() - startTime,
  };

  // Build full issue list for report
  const allIssues: TranslationIssueRecord[] = translationIssues.map((issue) => {
    const shopifyId = issue.resourceId.split("/").pop() ?? issue.resourceId;
    const qualityInfo = qualityResults.get(`${issue.resourceId}:${issue.field}`);
    return {
      shopify_product_id: shopifyId,
      product_handle: "",
      product_title: "",
      field: issue.field,
      issue_type: issue.issueType === "empty" ? "missing" : issue.issueType as "missing" | "suspicious" | "outdated",
      source_value: issue.sourceValue,
      current_translation: issue.currentTranslation,
      suggested_translation: null,
      confidence_score: qualityInfo?.score ?? 0,
      details: qualityInfo?.reasoning ?? null,
      source_type: "product" as const,
      plugin_name: null,
      status: "open" as const,
      date_resolved: null,
    };
  });

  const report = formatScanReport(stats, allIssues, pluginResults);
  await storeReportArtifact(agent, report, stats);

  // Store scan timestamp in shared memory
  try {
    await agent.setMemory("shopify_monitor:last_scan", {
      timestamp: new Date().toISOString(),
      stats,
    });
  } catch (err) {
    console.warn(`[daily-scan] Failed to store scan timestamp: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`[daily-scan] Scan complete in ${stats.scanDurationMs}ms`);

  return stats;
}

/**
 * Sync the shopify_products cache in Directus with current Shopify data.
 */
async function syncProductCache(
  agent: ShopifyMonitorAgent,
  resources: Array<{ resourceId: string; translatableContent: Array<{ key: string; value: string; locale: string }>; translations: Array<{ key: string; value: string | null; locale: string }> }>,
): Promise<void> {
  const client = agent.directus.getClient("sev-ai");

  for (const resource of resources) {
    const shopifyId = resource.resourceId.split("/").pop() ?? resource.resourceId;

    // Extract title and body from translatable content
    const titleNl = resource.translatableContent.find((c) => c.key === "title")?.value ?? "";
    const bodyNl = resource.translatableContent.find((c) => c.key === "body_html")?.value ?? null;
    const titleFr = resource.translations.find((t) => t.key === "title")?.value ?? null;
    const bodyFr = resource.translations.find((t) => t.key === "body_html")?.value ?? null;

    // Determine translation status
    const totalFields = resource.translatableContent.length;
    const translatedFields = resource.translations.filter((t) => t.value && t.value.trim()).length;
    const translationStatus: "complete" | "partial" | "missing" =
      translatedFields === 0
        ? "missing"
        : translatedFields >= totalFields
          ? "complete"
          : "partial";

    const record: Omit<ShopifyProductRecord, "id" | "date_created" | "date_updated"> = {
      shopify_id: shopifyId,
      handle: "", // Would need a separate REST call to get handle
      title_nl: titleNl,
      title_fr: titleFr,
      body_html_nl: bodyNl,
      body_html_fr: bodyFr,
      vendor: null,
      product_type: null,
      status: "active",
      tags: [],
      translation_status: translationStatus,
      last_synced: new Date().toISOString(),
    };

    try {
      // Check if product already exists in cache
      const existing = await client.request(
        readItems("shopify_products", {
          filter: { shopify_id: { _eq: shopifyId } },
          limit: 1,
        }),
      ) as ShopifyProductRecord[];

      if (existing[0]?.id) {
        await client.request(updateItem("shopify_products", existing[0].id, record));
      } else {
        await client.request(createItem("shopify_products", record));
      }
    } catch (err) {
      // Non-critical — log and continue
      console.warn(`[daily-scan] Failed to sync product ${shopifyId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`[daily-scan] Synced ${resources.length} products to Directus cache`);
}
