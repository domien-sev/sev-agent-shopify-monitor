import type { ShopifyAdminClient } from "@domien-sev/shopify-sdk";
import { getMetafieldsByNamespace } from "@domien-sev/shopify-sdk";
import type { PluginConfig } from "../config/plugins.js";

export interface PluginCheckResult {
  pluginName: string;
  issueType: "missing_translation" | "stale_check_reminder";
  details: string;
  /** For metafield issues: the product ID and namespace */
  productId?: string;
  namespace?: string;
  key?: string;
  sourceValue?: string;
}

/**
 * Check all registered plugins for translation issues.
 *
 * For plugins with metafieldNamespaces: scan for NL content without FR equivalents.
 * For manualCheckRequired plugins: check last check date, generate reminder if stale (>7 days).
 *
 * @param client - Shopify Admin API client
 * @param plugins - Plugin configurations to check
 * @param getLastCheckDate - Function to retrieve last check date from shared memory
 */
export async function checkPlugins(
  client: ShopifyAdminClient,
  plugins: PluginConfig[],
  getLastCheckDate: (memoryKey: string) => Promise<string | null>,
): Promise<PluginCheckResult[]> {
  const results: PluginCheckResult[] = [];

  for (const plugin of plugins) {
    console.log(`[plugin-checker] Checking plugin: ${plugin.name}`);

    // Check metafield namespaces for untranslated content
    for (const namespace of plugin.metafieldNamespaces) {
      try {
        const products = await getMetafieldsByNamespace(client, namespace);

        for (const product of products) {
          for (const metafield of product.metafields) {
            // Check if the value contains translatable text
            if (metafield.value && metafield.value.trim().length > 0 && containsText(metafield.value)) {
              results.push({
                pluginName: plugin.name,
                issueType: "missing_translation",
                details:
                  `Metafield ${namespace}.${metafield.key} on product ${product.productId} ` +
                  `contains text that may need translation: "${truncate(metafield.value, 80)}"`,
                productId: product.productId,
                namespace: metafield.namespace,
                key: metafield.key,
                sourceValue: metafield.value,
              });
            }
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[plugin-checker] Failed to check metafields for ${plugin.name}/${namespace}: ${errMsg}`);
      }
    }

    // Check if manual review is needed (stale check)
    if (plugin.manualCheckRequired) {
      try {
        const lastCheckStr = await getLastCheckDate(plugin.lastCheckMemoryKey);
        const isStale = isCheckStale(lastCheckStr, 7);

        if (isStale) {
          const daysSince = lastCheckStr
            ? Math.floor((Date.now() - new Date(lastCheckStr).getTime()) / (1000 * 60 * 60 * 24))
            : null;

          const timeInfo = daysSince !== null
            ? `Last checked ${daysSince} days ago.`
            : "Never checked.";

          results.push({
            pluginName: plugin.name,
            issueType: "stale_check_reminder",
            details: `${plugin.reminderMessage} ${timeInfo}`,
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[plugin-checker] Failed to check last review date for ${plugin.name}: ${errMsg}`);
      }
    }
  }

  console.log(`[plugin-checker] Found ${results.length} plugin issues across ${plugins.length} plugins`);

  return results;
}

/**
 * Check if a metafield value contains translatable text (not just JSON/numbers).
 */
function containsText(value: string): boolean {
  // Try to parse as JSON — if it's a structured object, check inner values
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string") return /[a-zA-ZÀ-ÿ]{3,}/.test(parsed);
    if (typeof parsed === "object" && parsed !== null) {
      return Object.values(parsed).some(
        (v) => typeof v === "string" && /[a-zA-ZÀ-ÿ]{3,}/.test(v),
      );
    }
    return false;
  } catch {
    // Not JSON — check raw value
    return /[a-zA-ZÀ-ÿ]{3,}/.test(value);
  }
}

/**
 * Check if the last check date is stale (older than maxDays).
 */
function isCheckStale(lastCheckStr: string | null, maxDays: number): boolean {
  if (!lastCheckStr) return true;

  const lastCheck = new Date(lastCheckStr);
  if (isNaN(lastCheck.getTime())) return true;

  const daysSince = (Date.now() - lastCheck.getTime()) / (1000 * 60 * 60 * 24);
  return daysSince > maxDays;
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.substring(0, maxLen) + "..." : str;
}
