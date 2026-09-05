// Minimal stdio MCP server standing in for readdle's server so the bridge can be tested on Linux/CI.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const s = new Server({ name: "fake-spark", version: "0.0.0" }, { capabilities: { tools: {} } });
s.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "accounts", description: "fake", inputSchema: { type: "object", properties: {} } },
    { name: "action", description: "fake", inputSchema: { type: "object", properties: { action_name: { type: "string" } } } },
    { name: "event", description: "fake", inputSchema: { type: "object", properties: {} } }
  ]
}));
s.setRequestHandler(CallToolRequestSchema, async r => ({ content: [{ type: "text", text: `ok:${r.params.name}:${JSON.stringify(r.params.arguments)}` }] }));
await s.connect(new StdioServerTransport());
