# spark-mcp-remote

Reach your [Spark](https://sparkmailapp.com) mailbox from any Claude client on your tailnet.

Spark's official [Spark for Claude](https://github.com/readdle/spark-claude-extension) is a **stdio** MCP server that shells out to the Spark CLI, which only exists where Spark Desktop is running (macOS/Windows). That's fine on that one machine, useless from anywhere else.

This is a small bridge that spawns Readdle's server as a child process and exposes it over **MCP Streamable HTTP**, authenticated with **OAuth 2.1**. Run it on the Mac next to Spark, bind it to that Mac's Tailscale address, and every other device on your tailnet can add the URL as an MCP server. No tunnel, no public hostname, no TLS certificate.

```
Claude Code / Claude Desktop, any tailnet device
        │  HTTP over WireGuard (Tailscale)
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
- [Tailscale](https://tailscale.com) on this Mac and on whatever you connect from

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

## Expose it (Tailscale)

There is no tunnel and no ingress to configure. Bind the listener to this Mac's
Tailscale address and the tailnet is the network boundary: WireGuard does the
encryption, and only devices you have authorised can route to it at all.

```bash
tailscale ip -4                 # e.g. 100.87.225.42
tailscale status --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["Self"]["DNSName"])'
```

Put the address in `.env` and restart:

```bash
HOST=100.87.225.42              # or the MagicDNS name; never 0.0.0.0
```

From another device on the tailnet:

```bash
curl -s http://your-mac.your-tailnet.ts.net:8787/healthz
```

`HOST` is the only knob — anything the machine can bind works, so the same
server runs loopback-only during development and tailnet-wide in production
without a second process in front of it.

Two things worth knowing about this trade:

- **The hosted Claude surfaces can't reach it.** claude.ai and the Claude mobile
  app fetch custom connectors from Anthropic's servers, not from your device, so
  a tailnet address is unreachable to them. What works is a client running on a
  tailnet device: Claude Code, Claude Desktop.
- **It is plain HTTP.** That is fine here — the transport is already encrypted
  and authenticated by WireGuard, and OAuth still gates `/mcp`. If a client
  insists on TLS, `tailscale serve --bg --https=443 http://127.0.0.1:8787` puts a
  real `ts.net` certificate in front (tailnet-only), and `tailscale funnel` does
  the same thing publicly if you ever do want claude.ai back.

## Add to Claude

From any device on the tailnet — no header, no token argument:

```bash
claude mcp add --transport http spark http://your-mac.your-tailnet.ts.net:8787/mcp
# then `/mcp` in a session to run the OAuth flow
```

Claude discovers the bridge's own authorization server, registers itself, and
opens a consent screen; paste the `SPARK_MCP_TOKEN` from `.env` there and it
connects. The callback lands on `http://localhost:<port>/callback` in the browser
on that same device, so nothing has to route back to the Mac.

Claude Desktop's custom connector dialog takes the same URL. If it refuses a
plain-`http` one, front the bridge with `tailscale serve` (above) and give it the
`https://` form instead.

Install `Spark.skill` from the Readdle releases page for the full workflow guidance.

### Why OAuth

Nothing on a tailnet requires it — so this is deliberate. `/mcp` can hand a model
your entire mailbox, and the tailnet is a flat network: every device on it, and
every process and user on this Mac, can reach the port. A shared secret in a
client config is the kind of thing that ends up in a dotfile repo; what travels
here instead is a short-lived, audience-bound token, and the long-lived secret
never goes on the wire at all.

It also means the exposure decision stays reversible. Put a `tailscale funnel` in
front and the bridge is a working claude.ai custom connector with no code change,
because OAuth is the only authentication the hosted Claude surfaces accept — their
connector dialog has no static-token field (`static_headers` is an
organization-admin beta).

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
sed "s#/Users/YOU#$HOME#g; s#^user=YOU\$#user=$(whoami)#" supervisor/spark-mcp-remote.ini \
  > "$(brew --prefix)/etc/supervisor.d/spark-mcp-remote.ini"
# merge supervisor/supervisord.conf into $(brew --prefix)/etc/supervisord.conf (inet_http_server + include)
brew services start supervisor       # user-level launchd agent, survives reboots
supervisorctl status
```

UI is at `http://127.0.0.1:9001`. Keep it on loopback, or bind it to the Tailscale IP to reach it from your phone — never `0.0.0.0`. OAuth protects `/mcp`, but the supervisor UI can restart things and read logs.

At login this can start before tailscaled has the interface up, so a `HOST` that
is a Tailscale IP is not bindable yet. The server retries the bind instead of
exiting, so there is nothing to order here.

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
| `HOST` | `127.0.0.1` | Bind address. This Mac's Tailscale IP serves the tailnet; loopback serves only this machine. Never `0.0.0.0`. |
| `PORT` | `8787` | Listening port |
| `SPARK_MCP_TOKEN` | required | Consent-screen credential and token signing key, ≥ 24 chars. Not a bearer token — rotating it revokes every issued token. |
| `SPARK_MCP_READ_ONLY=1` | off | Hides and blocks `draft`, `comment`, `action`, `contact-action`, `event` |
| `SPARK_MCP_ALLOW_SEND=1` | off | Enables the `event` tool and `action` `send`/`unschedule`. Off by default so a leaked token can't send mail. |
| `SPARK_MCP_ENTRY` | `vendor/…/server/index.js` | Point at a different upstream (e.g. the extracted `Spark.mcpb`) |
| `SPARK_PATH` | upstream default | Passed through to Readdle's server |
| `SPARK_MCP_PUBLIC_URL` | derived per request from `Host` / `X-Forwarded-*` | Pin the external origin used in OAuth metadata when clients reach the bridge by a name this server never sees |

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
