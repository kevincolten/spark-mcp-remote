# spark-mcp-remote

Reach your [Spark](https://sparkmailapp.com) mailbox from Claude on your phone / claude.ai.

Spark's official [Spark for Claude](https://github.com/readdle/spark-claude-extension) is a **stdio** MCP server that shells out to the Spark CLI, which only exists where Spark Desktop is running (macOS/Windows). That's fine for Claude Desktop, invisible to Claude mobile and claude.ai.

This is a small bridge that spawns Readdle's server as a child process and exposes it over **MCP Streamable HTTP**, authenticated with **OAuth 2.1** so the hosted Claude surfaces can actually connect to it. Run it on the Mac next to Spark, tunnel it out, add the URL as a custom connector, done.

```
Claude mobile / claude.ai
        │  HTTPS (Cloudflare Tunnel)
        ▼
spark-mcp-remote  (this)          ← OAuth 2.1 + DCR, send/read-only gates
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
- A domain on Cloudflare (free plan is fine) for the tunnel

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
# /mcp is OAuth-protected: unauthenticated requests must 401 and point at the
# metadata that starts the handshake.
curl -si -X POST localhost:8787/mcp | grep -i 'HTTP/\|www-authenticate'
```

There is no way to hand-craft a bearer for `/mcp` — a token has to be issued
through the OAuth flow. `npm test` drives that flow end to end if you want to
see it work locally.

## Expose it (Cloudflare Tunnel)

The server binds `127.0.0.1` on purpose; cloudflared handles ingress and TLS.

Use a **remotely-managed** tunnel: the ingress rules live in Cloudflare, not in a
local `config.yml`, so there is nothing to keep in sync on the Mac and no
`cert.pem` to obtain — which also means no `cloudflared tunnel login` and no
browser. An API token with *Cloudflare Tunnel: Edit*, *DNS: Edit* on the zone and
*Account Settings: Read* is enough.

```bash
brew install cloudflared
export CLOUDFLARE_API_TOKEN=...   ACCOUNT=<account id>   ZONE=<zone id>
API=https://api.cloudflare.com/client/v4
auth="Authorization: Bearer $CLOUDFLARE_API_TOKEN"

# 1. create the tunnel (config_src=cloudflare => remotely managed)
TUNNEL=$(curl -s -X POST -H "$auth" -H 'content-type: application/json' \
  --data '{"name":"spark-mcp","config_src":"cloudflare"}' \
  "$API/accounts/$ACCOUNT/cfd_tunnel" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["id"])')

# 2. ingress: the hostname, then a catch-all
curl -s -X PUT -H "$auth" -H 'content-type: application/json' \
  --data '{"config":{"ingress":[
      {"hostname":"spark-mcp.example.com","service":"http://127.0.0.1:8787"},
      {"service":"http_status:404"}]}}' \
  "$API/accounts/$ACCOUNT/cfd_tunnel/$TUNNEL/configurations"

# 3. proxied CNAME
curl -s -X POST -H "$auth" -H 'content-type: application/json' \
  --data "{\"type\":\"CNAME\",\"name\":\"spark-mcp\",\"content\":\"$TUNNEL.cfargotunnel.com\",\"proxied\":true}" \
  "$API/zones/$ZONE/dns_records"

# 4. run token -> chmod-600 file the supervisor wrapper reads
mkdir -p ~/.cloudflared
curl -s -H "$auth" "$API/accounts/$ACCOUNT/cfd_tunnel/$TUNNEL/token" \
  | python3 -c 'import sys,json;sys.stdout.write(json.load(sys.stdin)["result"])' \
  > ~/.cloudflared/spark-mcp.token
chmod 600 ~/.cloudflared/spark-mcp.token
```

Test it in the foreground, then hand it to supervisord (below):

```bash
supervisor/run-tunnel.sh
curl -s https://spark-mcp.example.com/healthz
```

The token is the only local secret. It stays in `~/.cloudflared/spark-mcp.token`
and reaches cloudflared through `TUNNEL_TOKEN`, so it is in neither the
world-readable supervisor `.ini` nor the argv `ps` shows.

Optional: add a Cloudflare Access policy on the hostname for a second factor in front of OAuth.

## Add to Claude

Claude.ai → Settings → Connectors → Add custom connector → URL
`https://spark-mcp.example.com/mcp`

Leave the OAuth Client ID/Secret fields empty. Claude discovers the bridge's own
authorization server, registers itself, and opens a consent screen; paste the
`SPARK_MCP_TOKEN` from `.env` there and it connects. It shows up on mobile too.

Claude Code uses the same flow — no header, no token argument:

```bash
claude mcp add --transport http spark-mcp https://spark-mcp.example.com/mcp
# then `/mcp` in a session to run the OAuth flow
```

Install `Spark.skill` from the Readdle releases page for the full workflow guidance.

### Why OAuth

The hosted Claude surfaces authenticate a connector over OAuth. The connector
dialog has no field for a static bearer token — `static_headers` exists only as
an organization-admin beta — so a server that just checks a shared secret is
reachable from curl and unreachable from Claude.ai and mobile, which is the
entire point of this bridge.

So the bridge is also its own OAuth 2.1 authorization server (`src/oauth.js`):
RFC 9728 protected-resource metadata, RFC 8414 server metadata, RFC 7591 dynamic
client registration, S256 PKCE, audience-bound access tokens and rotating
refresh tokens. It adds `/.well-known/oauth-protected-resource`,
`/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`
and `/oauth/token`.

There is one user and no user database. `SPARK_MCP_TOKEN` is the credential the
consent screen checks, and it doubles as the HMAC key signing every `client_id`,
authorization code and token — so the server holds no session state (supervisord
restarts it on every deploy without logging Claude out) and rotating the secret
revokes everything at once.

`SPARK_MCP_TOKEN` is **not** accepted as a bearer token on `/mcp`. Only tokens
the server issued are, which keeps the long-lived secret off the wire: what
travels on each request is a short-lived, audience-bound token that expires in an
hour.

## Keep it running (macOS)

Two options. Both must run **as your user**, never as root — the Spark CLI talks to the Spark Desktop GUI session.

### Option A: supervisord (web UI, recommended)

Gives you a local start/stop/restart/tail-logs dashboard for this and any other bare-metal services on the Mac. No containers, no cloud.

```bash
brew install supervisor
mkdir -p $(brew --prefix)/etc/supervisor.d
for ini in spark-mcp-remote cloudflared-spark; do
  sed "s#/Users/YOU#$HOME#g; s#^user=YOU\$#user=$(whoami)#" "supervisor/$ini.ini" \
    > "$(brew --prefix)/etc/supervisor.d/$ini.ini"
done
# merge supervisor/supervisord.conf into $(brew --prefix)/etc/supervisord.conf (inet_http_server + include)
brew services start supervisor       # user-level launchd agent, survives reboots
supervisorctl status
```

UI is at `http://127.0.0.1:9001`. Keep it on loopback (or a Tailscale IP if you run Tailscale) — never `0.0.0.0`. OAuth protects `/mcp`, but the supervisor UI can restart things and read logs.

Intel Macs: replace `/opt/homebrew` with `/usr/local` in the ini files.

### Option B: launchd directly

```bash
cp launchd/com.kevincolten.spark-mcp-remote.plist ~/Library/LaunchAgents/
# edit WorkingDirectory + node path in the plist
launchctl load ~/Library/LaunchAgents/com.kevincolten.spark-mcp-remote.plist
```

The bridge respawns the upstream process if it dies (e.g. Spark restarted).

## Safety switches

| Env | Default | Effect |
|---|---|---|
| `SPARK_MCP_TOKEN` | required | Consent-screen credential and token signing key, ≥ 24 chars. Not a bearer token — rotating it revokes every issued token. |
| `SPARK_MCP_READ_ONLY=1` | off | Hides and blocks `draft`, `comment`, `action`, `contact-action`, `event` |
| `SPARK_MCP_ALLOW_SEND=1` | off | Enables the `event` tool and `action` `send`/`unschedule`. Off by default so a leaked token can't send mail. |
| `SPARK_MCP_ENTRY` | `vendor/…/server/index.js` | Point at a different upstream (e.g. the extracted `Spark.mcpb`) |
| `SPARK_PATH` | upstream default | Passed through to Readdle's server |
| `SPARK_MCP_PUBLIC_URL` | derived from `X-Forwarded-*` | Pin the external origin used in OAuth metadata when the proxy does not set forwarding headers |

Spark's own per-account access levels (read-only / triage / send in **Settings → AI Agents**) still apply underneath. This bridge only ever narrows, never widens.

Calls are tagged `AI_AGENT=claude-remote` in Spark's audit log so you can tell remote from desktop.

## Test

```bash
npm test   # boots the bridge against a fake stdio upstream; checks auth, tool
           # listing, send gate, and the full OAuth flow (discovery, DCR, PKCE,
           # code replay, audience binding, refresh rotation)
```

## License

MIT. The vendored upstream is MIT © Spark Mail Limited.
