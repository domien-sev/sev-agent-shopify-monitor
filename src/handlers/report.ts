import type { TranslationIssueRecord } from "@domien-sev/shared-types";
import type { ShopifyMonitorAgent } from "../agent.js";
import type { ScanStats } from "./daily-scan.js";
import type { PluginCheckResult } from "../tools/plugin-checker.js";
import { createItem } from "@directus/sdk";

/**
 * Format a Slack-friendly scan report using block formatting.
 */
export function formatScanReport(
  stats: ScanStats,
  issues: TranslationIssueRecord[],
  pluginResults?: PluginCheckResult[],
): string {
  const sections: string[] = [];

  // Header
  const statusEmoji = stats.missingTranslations === 0 && stats.suspiciousTranslations === 0
    ? ":white_check_mark:"
    : ":warning:";
  sections.push(
    `${statusEmoji} *Shopify Translation Scan Report* — ${new Date().toISOString().split("T")[0]}`,
  );

  sections.push("");
  sections.push("---");
  sections.push("");

  // Summary stats
  sections.push("*Summary*");
  sections.push(`- Products scanned: *${stats.totalProducts}*`);
  sections.push(`- Missing translations: *${stats.missingTranslations}*`);
  sections.push(`- Suspicious translations: *${stats.suspiciousTranslations}*`);
  sections.push(`- Plugin issues: *${stats.pluginIssues}*`);
  sections.push(`- Plugin reminders: *${stats.pluginReminders}*`);
  sections.push(`- New issues created: *${stats.newIssuesCreated}*`);
  sections.push(`- Issues updated: *${stats.issuesUpdated}*`);
  sections.push(`- Scan duration: *${(stats.scanDurationMs / 1000).toFixed(1)}s*`);

  sections.push("");
  sections.push("---");
  sections.push("");

  // Top critical issues (missing translations first, then lowest confidence scores)
  const criticalIssues = [...issues]
    .sort((a, b) => {
      // Missing comes first
      if (a.issue_type === "missing" && b.issue_type !== "missing") return -1;
      if (a.issue_type !== "missing" && b.issue_type === "missing") return 1;
      // Then by confidence score (lowest = most problematic)
      return a.confidence_score - b.confidence_score;
    })
    .slice(0, 5);

  if (criticalIssues.length > 0) {
    sections.push("*Top Issues*");
    sections.push("");

    for (const [idx, issue] of criticalIssues.entries()) {
      const typeLabel = issue.issue_type === "missing" ? ":red_circle: Missing"
        : issue.issue_type === "suspicious" ? ":large_orange_circle: Suspicious"
        : ":large_yellow_circle: Outdated";

      const productLink = issue.shopify_product_id
        ? `<https://admin.shopify.com/products/${issue.shopify_product_id}|Product ${issue.shopify_product_id}>`
        : "Unknown product";

      sections.push(`${idx + 1}. ${typeLabel} — ${productLink}`);
      sections.push(`   Field: \`${issue.field}\``);
      sections.push(`   Source (NL): _${truncate(issue.source_value, 80)}_`);

      if (issue.current_translation) {
        sections.push(`   Current (FR): _${truncate(issue.current_translation, 80)}_`);
      }

      if (issue.details) {
        sections.push(`   Details: ${truncate(issue.details, 120)}`);
      }

      sections.push("");
    }

    if (issues.length > 5) {
      sections.push(`_...and ${issues.length - 5} more issues. Use \`report\` for the full list._`);
      sections.push("");
    }
  }

  // Plugin reminders
  const reminders = pluginResults?.filter((r) => r.issueType === "stale_check_reminder") ?? [];
  if (reminders.length > 0) {
    sections.push("---");
    sections.push("");
    sections.push("*Plugin Reminders*");
    sections.push("");

    for (const reminder of reminders) {
      sections.push(`:bell: *${reminder.pluginName}*`);
      sections.push(`   ${reminder.details}`);
      sections.push("");
    }
  }

  // Footer
  sections.push("---");
  sections.push(
    `_Scan completed at ${new Date().toISOString()} | ` +
    `Use \`resolve [id]\` or \`ignore [id]\` to manage issues_`,
  );

  return sections.join("\n");
}

/**
 * Store the scan report as an artifact in Directus.
 */
export async function storeReportArtifact(
  agent: ShopifyMonitorAgent,
  report: string,
  stats: ScanStats,
): Promise<void> {
  try {
    const client = agent.directus.getClient("sev-ai") as any;
    const today = new Date().toISOString().split("T")[0];

    await client.request(
      createItem("artifacts", {
        title: `Translation Scan Report — ${today}`,
        type: "translation-report",
        content: JSON.stringify({
          report,
          stats,
          generated_at: new Date().toISOString(),
        }),
        created_by: "shopify-monitor",
        tags: ["translation", "scan", "auto-generated"],
      }),
    );

    console.log("[report] Scan report stored as artifact in Directus");
  } catch (err) {
    console.warn(`[report] Failed to store report artifact: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.substring(0, maxLen) + "..." : str;
}
