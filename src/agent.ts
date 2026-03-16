import { BaseAgent } from "@domien-sev/agent-sdk";
import type { AgentConfig } from "@domien-sev/agent-sdk";
import type { RoutedMessage, AgentResponse } from "@domien-sev/shared-types";
import { ShopifyAdminClient, DeepLClient } from "@domien-sev/shopify-sdk";
import { stopScheduler } from "./scheduler.js";
import { handleDailyScan } from "./handlers/daily-scan.js";
import { handleOnDemand } from "./handlers/on-demand.js";

export class ShopifyMonitorAgent extends BaseAgent {
  public readonly shopifyClient: ShopifyAdminClient;
  public readonly deeplClient: DeepLClient;
  public readonly anthropicApiKey: string;

  constructor(config: AgentConfig) {
    super(config);

    const shop = process.env.SHOPIFY_SHOP;
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
    const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

    if (!shop) {
      throw new Error("Missing required env var: SHOPIFY_SHOP");
    }

    if (clientId && clientSecret) {
      this.shopifyClient = new ShopifyAdminClient({ shop, clientId, clientSecret });
    } else if (accessToken) {
      this.shopifyClient = new ShopifyAdminClient({ shop, accessToken });
    } else {
      throw new Error("Missing Shopify credentials: need SHOPIFY_CLIENT_ID/SECRET or SHOPIFY_ACCESS_TOKEN");
    }

    const deeplApiKey = process.env.DEEPL_API_KEY;
    if (!deeplApiKey) {
      throw new Error("Missing required env var: DEEPL_API_KEY");
    }

    this.deeplClient = new DeepLClient({
      apiKey: deeplApiKey,
      free: process.env.DEEPL_FREE === "true",
    });

    this.anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? "";
  }

  protected async onStart(): Promise<void> {
    this.logger.info("Monitor agent started — scheduled scans active");
  }

  protected async onStop(): Promise<void> {
    stopScheduler();
    this.logger.info("Monitor agent shutting down — scheduler stopped");
  }

  async handleMessage(message: RoutedMessage): Promise<AgentResponse> {
    const text = message.text.trim().toLowerCase();
    this.logger.info(`Message from ${message.user_id}: ${text}`);

    // Route based on keywords
    if (text === "scan now" || text === "run scan" || text === "check now") {
      return this.triggerImmediateScan(message);
    }

    if (text.startsWith("check ")) {
      return handleOnDemand(message, this);
    }

    if (text === "report" || text === "status" || text === "summary") {
      return handleOnDemand(message, this);
    }

    if (text.startsWith("resolve ") || text.startsWith("ignore ")) {
      return handleOnDemand(message, this);
    }

    // Default: help text
    return this.reply(message, [
      "*Shopify Translation Monitor* — available commands:",
      "",
      "`scan now` — trigger a full translation scan immediately",
      "`check [product handle]` — check translations for a specific product",
      "`report` / `status` — show latest scan results",
      "`resolve [issue-id]` — mark a translation issue as resolved",
      "`ignore [issue-id]` — mark a translation issue as ignored",
      "",
      "_Daily scans run automatically at the configured schedule._",
    ].join("\n"));
  }

  private async triggerImmediateScan(message: RoutedMessage): Promise<AgentResponse> {
    // Respond immediately, run scan in background
    const scanPromise = handleDailyScan(this).then((stats) => {
      this.logger.info("Immediate scan complete:", stats);
    }).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Immediate scan failed: ${errMsg}`);
    });

    // Fire and forget — the scan will post its own report when done
    void scanPromise;

    return this.reply(
      message,
      "Scan started. I'll post the results in this channel when the scan is complete.",
    );
  }

  private reply(message: RoutedMessage, text: string): AgentResponse {
    return {
      channel_id: message.channel_id,
      thread_ts: message.thread_ts ?? message.ts,
      text,
    };
  }
}
