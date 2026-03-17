// @ts-nocheck — Directus SDK generics resolve collection names to `never` for custom schemas
import type { RoutedMessage, AgentResponse, TranslationIssueRecord } from "@domien-sev/shared-types";
import type { ShopifyMonitorAgent } from "../agent.js";
import { readItems, updateItem } from "@directus/sdk";
import { getProductTranslations } from "@domien-sev/shopify-sdk";
import { checkTranslations } from "../tools/translation-checker.js";

/**
 * Handle on-demand commands from users:
 * - "scan now" → delegated to agent.ts (triggerImmediateScan)
 * - "check [product]" → check translations for a specific product
 * - "report" / "status" → fetch latest scan stats
 * - "resolve [id]" → mark issue as resolved
 * - "ignore [id]" → mark issue as ignored
 */
export async function handleOnDemand(
  message: RoutedMessage,
  agent: ShopifyMonitorAgent,
): Promise<AgentResponse> {
  const text = message.text.trim().toLowerCase();

  if (text.startsWith("check ")) {
    return handleProductCheck(message, agent, text.substring(6).trim());
  }

  if (text === "report" || text === "status" || text === "summary") {
    return handleReportRequest(message, agent);
  }

  if (text.startsWith("resolve ")) {
    return handleStatusUpdate(message, agent, text.substring(8).trim(), "resolved");
  }

  if (text.startsWith("ignore ")) {
    return handleStatusUpdate(message, agent, text.substring(7).trim(), "ignored");
  }

  return reply(message, "Unknown command. Try `scan now`, `check [product]`, `report`, `resolve [id]`, or `ignore [id]`.");
}

/**
 * Check translations for a specific product by handle, title, or Shopify GID.
 */
async function handleProductCheck(
  message: RoutedMessage,
  agent: ShopifyMonitorAgent,
  query: string,
): Promise<AgentResponse> {
  try {
    // Try to interpret the query as a Shopify product GID
    let productGid: string;

    if (query.startsWith("gid://")) {
      productGid = query;
    } else if (/^\d+$/.test(query)) {
      productGid = `gid://shopify/Product/${query}`;
    } else {
      // Search by handle or title in Directus cache
      const client = agent.directus.getClient("sev-ai");
      const products = await client.request(
        readItems("shopify_products", {
          filter: {
            _or: [
              { handle: { _contains: query } },
              { title_nl: { _contains: query } },
              { title_fr: { _contains: query } },
            ],
          },
          limit: 1,
        }),
      ) as Array<{ shopify_id: string; handle: string; title_nl: string }>;

      if (products.length === 0) {
        return reply(message, `No product found matching "${query}". Try a product ID, handle, or title.`);
      }

      productGid = `gid://shopify/Product/${products[0].shopify_id}`;
    }

    // Fetch translations from Shopify
    const resource = await getProductTranslations(agent.shopifyClient, productGid, "fr");

    // Check for issues
    const issues = checkTranslations([resource], "fr");

    if (issues.length === 0) {
      const title = resource.translatableContent.find((c) => c.key === "title")?.value ?? "Unknown";
      return reply(
        message,
        `:white_check_mark: *${title}* — all translations look complete!\n\n` +
        `Translatable fields: ${resource.translatableContent.length}\n` +
        `Translated fields: ${resource.translations.filter((t) => t.value).length}`,
      );
    }

    // Format issues
    const lines: string[] = [];
    const title = resource.translatableContent.find((c) => c.key === "title")?.value ?? "Unknown";
    lines.push(`:warning: *${title}* — found ${issues.length} translation issues:\n`);

    for (const issue of issues) {
      const icon = issue.issueType === "missing" ? ":red_circle:"
        : issue.issueType === "empty" ? ":red_circle:"
        : ":large_orange_circle:";

      lines.push(`${icon} \`${issue.field}\` — ${issue.issueType}`);
      lines.push(`   NL: _${truncate(issue.sourceValue, 100)}_`);
      if (issue.currentTranslation) {
        lines.push(`   FR: _${truncate(issue.currentTranslation, 100)}_`);
      }
      lines.push("");
    }

    return reply(message, lines.join("\n"));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return reply(message, `Failed to check product: ${errMsg}`);
  }
}

/**
 * Fetch and display the latest scan results from Directus.
 */
async function handleReportRequest(
  message: RoutedMessage,
  agent: ShopifyMonitorAgent,
): Promise<AgentResponse> {
  try {
    const client = agent.directus.getClient("sev-ai");

    // Get open issue counts by type
    const openIssues = await client.request(
      readItems("translation_issues", {
        filter: { status: { _eq: "open" } },
        limit: -1,
      }),
    ) as TranslationIssueRecord[];

    const missing = openIssues.filter((i) => i.issue_type === "missing").length;
    const suspicious = openIssues.filter((i) => i.issue_type === "suspicious").length;
    const outdated = openIssues.filter((i) => i.issue_type === "outdated").length;

    // Get last scan timestamp from shared memory
    let lastScanInfo = "No scan data available yet.";
    try {
      const memory = await agent.getMemory("shopify_monitor:last_scan");
      if (memory?.value && typeof memory.value === "object" && "timestamp" in memory.value) {
        const ts = memory.value.timestamp as string;
        const stats = memory.value.stats as Record<string, number> | undefined;
        lastScanInfo = `Last scan: ${ts}`;
        if (stats?.totalProducts) {
          lastScanInfo += ` (${stats.totalProducts} products scanned)`;
        }
      }
    } catch {
      // Ignore — no scan data yet
    }

    // Get recently resolved count (last 7 days)
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const recentlyResolved = await client.request(
      readItems("translation_issues", {
        filter: {
          status: { _eq: "resolved" },
          date_resolved: { _gte: weekAgo.toISOString() },
        },
        limit: -1,
      }),
    ) as TranslationIssueRecord[];

    const lines: string[] = [
      "*Translation Monitor Status*",
      "",
      lastScanInfo,
      "",
      "*Open Issues*",
      `:red_circle: Missing: *${missing}*`,
      `:large_orange_circle: Suspicious: *${suspicious}*`,
      `:large_yellow_circle: Outdated: *${outdated}*`,
      "",
      `:white_check_mark: Resolved this week: *${recentlyResolved.length}*`,
    ];

    // Show top 3 oldest open issues
    const oldest = [...openIssues]
      .sort((a, b) => (a.date_created ?? "").localeCompare(b.date_created ?? ""))
      .slice(0, 3);

    if (oldest.length > 0) {
      lines.push("");
      lines.push("*Oldest Open Issues*");
      for (const issue of oldest) {
        lines.push(
          `- \`${issue.id}\` — ${issue.issue_type} on \`${issue.field}\` ` +
          `(product ${issue.shopify_product_id}, since ${issue.date_created?.split("T")[0] ?? "unknown"})`,
        );
      }
    }

    lines.push("");
    lines.push("_Use `scan now` to trigger a new scan, or `resolve [id]` / `ignore [id]` to manage issues._");

    return reply(message, lines.join("\n"));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return reply(message, `Failed to fetch report: ${errMsg}`);
  }
}

/**
 * Update an issue's status to "resolved" or "ignored" in Directus.
 */
async function handleStatusUpdate(
  message: RoutedMessage,
  agent: ShopifyMonitorAgent,
  issueId: string,
  newStatus: "resolved" | "ignored",
): Promise<AgentResponse> {
  const cleanId = issueId.trim();

  if (!cleanId) {
    return reply(message, `Please provide an issue ID. Example: \`${newStatus} abc123\``);
  }

  try {
    const client = agent.directus.getClient("sev-ai");

    // Verify the issue exists
    const issues = await client.request(
      readItems("translation_issues", {
        filter: { id: { _eq: cleanId } },
        limit: 1,
      }),
    ) as TranslationIssueRecord[];

    if (issues.length === 0) {
      return reply(message, `Issue \`${cleanId}\` not found. Use \`report\` to see current issues.`);
    }

    const issue = issues[0];

    if (issue.status !== "open") {
      return reply(message, `Issue \`${cleanId}\` is already ${issue.status}.`);
    }

    // Update status
    await client.request(
      updateItem("translation_issues", cleanId, {
        status: newStatus,
        date_resolved: newStatus === "resolved" ? new Date().toISOString() : null,
      }),
    );

    const verb = newStatus === "resolved" ? "resolved" : "ignored";
    return reply(
      message,
      `:white_check_mark: Issue \`${cleanId}\` marked as *${verb}*.\n` +
      `Field: \`${issue.field}\` | Product: ${issue.shopify_product_id}`,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return reply(message, `Failed to update issue: ${errMsg}`);
  }
}

function reply(message: RoutedMessage, text: string): AgentResponse {
  return {
    channel_id: message.channel_id,
    thread_ts: message.thread_ts ?? message.ts,
    text,
  };
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.substring(0, maxLen) + "..." : str;
}
