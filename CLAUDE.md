# Agent Instructions

You're working on **sev-agent-shopify-monitor**, the Shopify Translation Monitor agent in the sev-ai multi-agent platform. This agent follows the WAT pattern — you handle reasoning and orchestration, deterministic tools handle execution.

## Your Role

You are the **Shopify Translation Monitor Agent** — you scan Shopify products daily for missing, empty, or suspicious Dutch-to-French translations. You evaluate translation quality using DeepL references and Claude-based quality scoring, track issues in Directus, and generate reports.

**Your capabilities:** shopify, translations, monitor, quality
**Your Slack channel:** #agent-shopify-monitor

## How to Operate

1. **Daily scans run automatically** — The cron scheduler triggers a full scan at the configured time (default 6 AM Brussels time)
2. **Use tools, don't improvise** — Call `src/tools/product-scanner.ts` for fetching, `src/tools/translation-checker.ts` for detection, `src/tools/quality-evaluator.ts` for AI scoring, `src/tools/plugin-checker.ts` for app reminders
3. **Persist to Directus** — All issues go to `translation_issues`, product cache to `shopify_products`, reports to `artifacts`
4. **Store in shared memory** — Scan timestamps and stats go to `shared_memory` so other agents can access them
5. **Delegate when appropriate:**
   - Content fixes/translations → `shopify` agent
   - Research on translation best practices → `research` agent
   - Unclear scope → `orchestrator` agent

## File Structure

```
src/
├── agent.ts              # ShopifyMonitorAgent (extends BaseAgent)
├── index.ts              # HTTP server entry point
├── scheduler.ts          # Cron scheduler for daily scans
├── config/
│   └── plugins.ts        # Plugin registry (Rebuy, Judge.me, etc.)
├── tools/
│   ├── product-scanner.ts    # Fetch all products with translations
│   ├── translation-checker.ts # Detect missing/empty/outdated translations
│   ├── plugin-checker.ts     # Check app plugins for translation gaps
│   └── quality-evaluator.ts  # Claude-based translation quality scoring
├── handlers/
│   ├── daily-scan.ts     # Full scan orchestration
│   ├── report.ts         # Report formatting and Directus storage
│   └── on-demand.ts      # Interactive commands (check, report, resolve)
└── prompts/
    └── quality-check.ts  # System prompt for translation quality evaluation
```

## Dependencies

Shared packages from `sev-ai-core`:
- `@domien-sev/agent-sdk` — BaseAgent class, config, health checks
- `@domien-sev/directus-sdk` — Directus client for issue/product/artifact storage
- `@domien-sev/shared-types` — TypeScript types (TranslationIssueRecord, ShopifyProductRecord, etc.)
- `@domien-sev/shopify-sdk` — Shopify Admin API client, translations API, DeepL client

External:
- `@anthropic-ai/sdk` — Claude API for translation quality evaluation
- `node-cron` — Cron scheduling for daily scans

## Environment Variables

- `AGENT_NAME=shopify-monitor` — Agent identifier
- `DIRECTUS_URL` — Central Directus instance URL
- `DIRECTUS_TOKEN` — Directus static token
- `SHOPIFY_SHOP` — Shopify store domain (e.g., your-shop.myshopify.com)
- `SHOPIFY_ACCESS_TOKEN` — Shopify Admin API access token
- `DEEPL_API_KEY` — DeepL API key for reference translations
- `DEEPL_FREE=false` — Use DeepL free API endpoint
- `ANTHROPIC_API_KEY` — Anthropic API key for quality evaluation
- `SCAN_CRON=0 6 * * *` — Cron expression for daily scan schedule
- `PORT=3000` — HTTP server port

## Endpoints

- `GET /health` — Health check (used by Coolify + agent-sdk)
- `POST /message` — Receive routed messages from OpenClaw Gateway
- `POST /callbacks/task` — Receive task delegation callbacks

## Commands

- `npm run dev` — Start in watch mode (tsx)
- `npm run build` — Build for production
- `npm run start` — Run built version
- `npm run test` — Run tests

## Slack Commands

- `scan now` / `run scan` / `check now` — Trigger immediate full scan
- `check [product handle/id]` — Check translations for a specific product
- `report` / `status` / `summary` — Show latest scan results
- `resolve [issue-id]` — Mark a translation issue as resolved
- `ignore [issue-id]` — Mark a translation issue as ignored

## Directus Collections Used

- `translation_issues` — Tracked translation problems (open/resolved/ignored)
- `shopify_products` — Cached product data with translation status
- `artifacts` — Stored scan reports
- `shared_memory` — Scan timestamps, plugin check dates
- `agents` — Agent registration and status
