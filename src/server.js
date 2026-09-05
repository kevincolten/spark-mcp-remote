#!/usr/bin/env node
/**
 * spark-mcp-remote
 *
 * Wraps the official Spark for Claude MCP server (readdle/spark-claude-extension,
 * a stdio server that shells out to the Spark CLI) and exposes it over MCP
 * Streamable HTTP with bearer-token auth.
 *
 * Runs on the same Mac/PC as Spark Desktop. Put it behind a Cloudflare Tunnel or
 * Tailscale Funnel and add the URL as a custom connector in Claude.ai / Claude
 * mobile.
 *
 * Architecture:
 *   Claude (remote) --HTTP--> [this server] --stdio--> readdle server/index.js --exec--> spark CLI --> Spark Desktop
 *
 * We proxy at the MCP protocol level (tools/list + tools/call) rather than
 * re-implementing the CLI mapping, so upstream tool changes flow through
 * automatically.
 */

import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createOAuth, originOf } from "./oauth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "127.0.0.1"; // bind loopback; let the tunnel do ingress
const MCP_PATH = process.env.MCP_PATH || "/mcp";
const TOKEN = process.env.SPARK_MCP_TOKEN;
// Pin the externally-visible origin when the proxy does not set X-Forwarded-*.
// Normally cloudflared does, and originOf() derives it per request.
const PUBLIC_URL = process.env.SPARK_MCP_PUBLIC_URL;

// Path to the upstream stdio server. Default: vendored clone (see scripts/setup.sh).
// Can also point at the extracted Spark.mcpb from Claude Desktop, e.g.
//   ~/Library/Application Support/Claude/Claude Extensions/local.mcpb.Spark.Spark/server/index.js
const UPSTREAM_ENTRY =
    process.env.SPARK_MCP_ENTRY || resolve(__dirname, "../vendor/spark-claude-extension/server/index.js");

// Tools that require `send` level in Spark. Off by default so a leaked token
// can't email people; enable with SPARK_MCP_ALLOW_SEND=1.
const ALLOW_SEND = process.env.SPARK_MCP_ALLOW_SEND === "1";
const SEND_ONLY_TOOLS = new Set(["event"]);
const SEND_ACTIONS = new Set(["send", "unschedule"]);

// Read-only mode: block every write tool regardless of Spark access level.
const READ_ONLY = process.env.SPARK_MCP_READ_ONLY === "1";
const WRITE_TOOLS = new Set(["draft", "comment", "action", "contact-action", "event"]);

const RESTART_BACKOFF_MS = 2000;

if (!TOKEN || TOKEN.length < 24) {
    console.error(
        "[spark-mcp-remote] SPARK_MCP_TOKEN must be set (>= 24 chars). Generate one with:\n" +
            "  openssl rand -base64 32"
    );
    process.exit(1);
}

if (!existsSync(UPSTREAM_ENTRY)) {
    console.error(
        `[spark-mcp-remote] Upstream server not found at ${UPSTREAM_ENTRY}\n` +
            "  Run `npm run setup` to clone readdle/spark-claude-extension, or set SPARK_MCP_ENTRY."
    );
    process.exit(1);
}

// Identify ourselves in Spark's audit log (the upstream server sets
// AI_AGENT=claude-desktop if unset; we override so remote calls are distinguishable).
process.env.AI_AGENT = process.env.AI_AGENT || "claude-remote";

// ---------------------------------------------------------------------------
// Upstream (stdio) connection with auto-restart
// ---------------------------------------------------------------------------

let upstream = null; // Client
let upstreamConnecting = null; // Promise<Client>

async function connectUpstream() {
    if (upstream) return upstream;
    if (upstreamConnecting) return upstreamConnecting;

    upstreamConnecting = (async () => {
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [UPSTREAM_ENTRY],
            env: { ...process.env },
            stderr: "pipe"
        });

        transport.stderr?.on("data", chunk => {
            process.stderr.write(`[upstream] ${chunk}`);
        });

        const client = new Client({ name: "spark-mcp-remote", version: "0.1.0" }, { capabilities: {} });

        transport.onclose = () => {
            console.error("[spark-mcp-remote] upstream exited; will respawn on next request");
            upstream = null;
        };

        await client.connect(transport);
        console.error(`[spark-mcp-remote] upstream connected (${UPSTREAM_ENTRY})`);
        upstream = client;
        return client;
    })();

    try {
        return await upstreamConnecting;
    } catch (err) {
        console.error(`[spark-mcp-remote] upstream connect failed: ${err.message}`);
        await new Promise(r => setTimeout(r, RESTART_BACKOFF_MS));
        throw err;
    } finally {
        upstreamConnecting = null;
    }
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

function isBlocked(name, args) {
    if (READ_ONLY && WRITE_TOOLS.has(name)) {
        return `Tool "${name}" is disabled: server is running in read-only mode (SPARK_MCP_READ_ONLY=1).`;
    }
    if (!ALLOW_SEND) {
        if (SEND_ONLY_TOOLS.has(name)) {
            return `Tool "${name}" requires send access and is disabled on this bridge. Set SPARK_MCP_ALLOW_SEND=1 to enable.`;
        }
        if (name === "action" && SEND_ACTIONS.has(args?.action_name)) {
            return `action "${args.action_name}" sends mail and is disabled on this bridge. Set SPARK_MCP_ALLOW_SEND=1 to enable.`;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Downstream MCP server (what Claude talks to)
// ---------------------------------------------------------------------------

function buildDownstream() {
    const server = new Server(
        { name: "spark", version: "0.1.0" },
        { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const up = await connectUpstream();
        const { tools } = await up.listTools();
        const visible = tools.filter(t => {
            if (READ_ONLY && WRITE_TOOLS.has(t.name)) return false;
            if (!ALLOW_SEND && SEND_ONLY_TOOLS.has(t.name)) return false;
            return true;
        });
        return { tools: visible };
    });

    server.setRequestHandler(CallToolRequestSchema, async req => {
        const { name, arguments: args } = req.params;
        const blocked = isBlocked(name, args);
        if (blocked) {
            return { isError: true, content: [{ type: "text", text: blocked }] };
        }
        const up = await connectUpstream();
        try {
            return await up.callTool({ name, arguments: args ?? {} });
        } catch (err) {
            // If the upstream died mid-call, drop it so the next call respawns.
            if (/closed|EPIPE|not connected/i.test(String(err?.message))) upstream = null;
            return { isError: true, content: [{ type: "text", text: `Upstream error: ${err.message}` }] };
        }
    });

    return server;
}

// ---------------------------------------------------------------------------
// HTTP layer: bearer auth + Streamable HTTP transport (stateful sessions)
// ---------------------------------------------------------------------------

const sessions = new Map(); // sessionId -> { transport, server }

// Claude.ai can only authenticate a connector over OAuth, so the bridge is its
// own authorization server (see src/oauth.js). The raw SPARK_MCP_TOKEN still
// works as a bearer for curl / Claude Code / mcp-remote.
const oauth = createOAuth({ secret: TOKEN, mcpPath: MCP_PATH, publicUrl: PUBLIC_URL });

function authorized(req, origin) {
    const header = req.headers.authorization || "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) return false;
    return !!oauth.verifyAccess(m[1], origin);
}

async function readJsonBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (!chunks.length) return undefined;
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const origin = originOf(req, PUBLIC_URL);

    // Discovery + OAuth endpoints. Returns false when the path is not one of
    // them, so the MCP transport below still sees everything else.
    try {
        if ((await oauth.handle(req, res, url, origin)) !== false) return;
    } catch (err) {
        console.error(`[spark-mcp-remote] oauth error: ${err.stack || err}`);
        if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "server_error" }));
        }
        return;
    }

    if (url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, upstream: !!upstream, readOnly: READ_ONLY, allowSend: ALLOW_SEND }));
        return;
    }

    if (url.pathname !== MCP_PATH) {
        res.writeHead(404).end();
        return;
    }

    if (!authorized(req, origin)) {
        // The resource_metadata pointer is what lets Claude discover the
        // authorization server (RFC 9728 §5.1). Claude ignores this header on a
        // 200, so it has to ride on the 401.
        res.writeHead(401, {
            "www-authenticate":
                `Bearer realm="spark-mcp-remote", resource_metadata="${oauth.metadataUrl(origin)}"`
        }).end();
        return;
    }

    try {
        const sessionId = req.headers["mcp-session-id"];
        let entry = sessionId ? sessions.get(sessionId) : undefined;

        if (!entry) {
            if (req.method !== "POST") {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "Missing or unknown Mcp-Session-Id" }));
                return;
            }
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: id => {
                    sessions.set(id, { transport, server });
                    console.error(`[spark-mcp-remote] session ${id} opened (${sessions.size} active)`);
                }
            });
            transport.onclose = () => {
                if (transport.sessionId) {
                    sessions.delete(transport.sessionId);
                    console.error(`[spark-mcp-remote] session ${transport.sessionId} closed`);
                }
            };
            const server = buildDownstream();
            await server.connect(transport);
            entry = { transport, server };
        }

        const body = req.method === "POST" ? await readJsonBody(req) : undefined;
        await entry.transport.handleRequest(req, res, body);
    } catch (err) {
        console.error(`[spark-mcp-remote] request error: ${err.stack || err}`);
        if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: String(err.message || err) }));
        }
    }
});

httpServer.listen(PORT, HOST, () => {
    console.error(
        `[spark-mcp-remote] listening on http://${HOST}:${PORT}${MCP_PATH}` +
            ` (read-only=${READ_ONLY}, allow-send=${ALLOW_SEND})`
    );
});

for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
        console.error(`[spark-mcp-remote] ${sig}, shutting down`);
        httpServer.close();
        for (const { transport } of sessions.values()) await transport.close().catch(() => {});
        await upstream?.close().catch(() => {});
        process.exit(0);
    });
}
