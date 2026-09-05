// Boots the bridge against test/fake-upstream.js and exercises auth, tools/list and the send gate.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import assert from "node:assert/strict";

const TOKEN = "test-token-test-token-test-token";
const PORT = 8799;
const proc = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, SPARK_MCP_TOKEN: TOKEN, PORT, SPARK_MCP_ENTRY: new URL("./fake-upstream.js", import.meta.url).pathname },
  stdio: ["ignore", "inherit", "inherit"]
});
try {
  for (let i = 0; i < 30; i++) { try { await fetch(`http://127.0.0.1:${PORT}/healthz`); break; } catch { await sleep(100); } }

  const unauth = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: "POST", body: "{}" });
  assert.equal(unauth.status, 401, "unauthenticated requests must be rejected");

  const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
  const c = new Client({ name: "smoke", version: "0" });
  await c.connect(t);
  const { tools } = await c.listTools();
  const names = tools.map(x => x.name);
  assert.ok(names.includes("accounts"));
  assert.ok(!names.includes("event"), "send-level tool hidden by default");

  const ok = await c.callTool({ name: "accounts", arguments: {} });
  assert.match(ok.content[0].text, /^ok:accounts/);

  const gated = await c.callTool({ name: "action", arguments: { action_name: "send", message_ids: ["1"] } });
  assert.equal(gated.isError, true, "send action must be gated");

  const archive = await c.callTool({ name: "action", arguments: { action_name: "archive", message_ids: ["1"] } });
  assert.match(archive.content[0].text, /^ok:action/);

  await c.close();
  console.log("smoke: all checks passed");
} finally { proc.kill("SIGTERM"); }
