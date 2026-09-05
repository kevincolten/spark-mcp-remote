# spark-mcp-remote

Reach your [Spark](https://sparkmailapp.com) mailbox from Claude on your phone / claude.ai.

Spark's official [Spark for Claude](https://github.com/readdle/spark-claude-extension) is a **stdio** MCP server that shells out to the Spark CLI, which only exists where Spark Desktop is running (macOS/Windows). That's fine for Claude Desktop, invisible to Claude mobile and claude.ai.

This is a ~200-line bridge that spawns Readdle's server as a child process and exposes it over **MCP Streamable HTTP** with bearer-token auth. Run it on the Mac next to Spark, tunnel it out, add the URL as a custom connector, done.

```
Claude mobile / claude.ai
        │  HTTPS (Cloudflare Tunnel / Tailscale Funnel)
        ▼
spark-mcp-remote  (this)          ← bearer auth, send/read-only gates
        │  stdio
        ▼
readdle/spark-claude-extension    ← official, vendored, unmodified
        │  execFile
        ▼
spark CLI  →  Spark Desktop  →  your accounts
```

It proxies at the MCP level (`tools/list`, `tools/call`), so upstream tool changes flow through without touching this repo. It does **not** run on Linux/Coolify — there is no headless Spark. It has to live on the machine that runs Spark Desktop.

## Requirements

- macOS or Windows with Spark Desktop signed in
- Spark CLI enabled: **Spark → Settings → AI Agents → Spark CLI Setup**
- Node ≥ 20.6 (for `--env-file`)
- Some way to expose a local port over HTTPS (Cloudflare Tunnel recommended)

## Install

```bash
git clone https://github.com/kevincolten/spark-mcp-remote.git
cd spark-mcp-remote
npm install
npm run setup     # clones readdle/spark-claude-extension into vendor/, writes .env with a random token
npm start
```

Check it:

```bash
curl -s localhost:8787/healthz
curl -s -H "Authorization: Bearer $(grep TOKEN .env | cut -d= -f2)" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  localhost:8787/mcp
```

## Expose it

The server binds `127.0.0.1` on purpose. Put the tunnel in front:

**Cloudflare Tunnel**
```bash
cloudflared tunnel create spark-mcp
cloudflared tunnel route dns spark-mcp spark-mcp.example.com
cloudflared tunnel run --url http://127.0.0.1:8787 spark-mcp
```
Consider adding a Cloudflare Access policy on top of the bearer token.

**Tailscale Funnel**
```bash
tailscale funnel 8787
```

## Add to Claude

Claude.ai → Settings → Connectors → Add custom connector

- URL: `https://spark-mcp.example.com/mcp`
- Auth: the bearer token from `.env`

It shows up on mobile too. Install `Spark.skill` from the Readdle releases page for the full workflow guidance.

## Keep it running (macOS)

```bash
cp launchd/com.kevincolten.spark-mcp-remote.plist ~/Library/LaunchAgents/
# edit WorkingDirectory + node path in the plist
launchctl load ~/Library/LaunchAgents/com.kevincolten.spark-mcp-remote.plist
```

The bridge respawns the upstream process if it dies (e.g. Spark restarted).

## Safety switches

| Env | Default | Effect |
|---|---|---|
| `SPARK_MCP_TOKEN` | required | Bearer token, ≥ 24 chars |
| `SPARK_MCP_READ_ONLY=1` | off | Hides and blocks `draft`, `comment`, `action`, `contact-action`, `event` |
| `SPARK_MCP_ALLOW_SEND=1` | off | Enables the `event` tool and `action` `send`/`unschedule`. Off by default so a leaked token can't send mail. |
| `SPARK_MCP_ENTRY` | `vendor/…/server/index.js` | Point at a different upstream (e.g. the extracted `Spark.mcpb`) |
| `SPARK_PATH` | upstream default | Passed through to Readdle's server |

Spark's own per-account access levels (read-only / triage / send in **Settings → AI Agents**) still apply underneath. This bridge only ever narrows, never widens.

Calls are tagged `AI_AGENT=claude-remote` in Spark's audit log so you can tell remote from desktop.

## Test

```bash
npm test   # boots the bridge against a fake stdio upstream; checks auth, tool listing, send gate
```

## License

MIT. The vendored upstream is MIT © Spark Mail Limited.
