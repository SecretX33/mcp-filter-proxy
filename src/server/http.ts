import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export interface HttpExposeOptions {
  port: number;
  host: string;
  createServer: () => Server;
}

export function exposeViaHttp({
  port,
  host,
  createServer,
}: HttpExposeOptions): Promise<void> {
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({ error: "Method not allowed" });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json({ error: "Method not allowed" });
  });

  return new Promise((resolve) => {
    app.listen(port, host, () => {
      console.error(
        `MCP filter proxy HTTP server listening on http://${host}:${port}/mcp`,
      );
      resolve();
    });
  });
}
