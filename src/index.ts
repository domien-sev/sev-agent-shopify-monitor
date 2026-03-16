import http from "node:http";
import { ShopifyMonitorAgent } from "./agent.js";
import { loadConfig, createHealthEndpoint } from "@domien-sev/agent-sdk";
import { initScheduler } from "./scheduler.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

async function main() {
  const config = loadConfig();
  const agent = new ShopifyMonitorAgent(config);

  // Create HTTP server for health checks and message intake
  const healthHandler = createHealthEndpoint(agent);

  const server = http.createServer(async (req, res) => {
    // Health endpoint
    if (req.url === "/health" && req.method === "GET") {
      return healthHandler(req, res);
    }

    // Message endpoint — receives routed messages from OpenClaw Gateway
    if (req.url === "/message" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const message = JSON.parse(body);
        const response = await agent.handleMessage(message);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("Error handling message:", errMsg);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errMsg }));
      }
      return;
    }

    // Callback endpoint for task delegation responses
    if (req.url === "/callbacks/task" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const taskResult = JSON.parse(body);
        console.log("Received task callback:", taskResult);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500);
        res.end();
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  // Graceful shutdown
  const shutdown = async () => {
    server.close();
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start HTTP server first so health checks can respond
  server.listen(PORT, () => {
    console.log(`Shopify monitor agent listening on port ${PORT}`);
  });

  // Register with Directus (retry on failure — Directus may not be ready yet)
  const MAX_RETRIES = 5;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await agent.start();
      break;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`Directus registration attempt ${attempt}/${MAX_RETRIES} failed: ${errMsg}`);
      if (attempt === MAX_RETRIES) {
        console.error("Could not register with Directus — running without registration");
      } else {
        await new Promise((r) => setTimeout(r, 5000 * attempt));
      }
    }
  }

  // Initialize the cron scheduler after agent is started
  initScheduler(agent);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
