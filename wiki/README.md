# spark-mcp-remote — architecture & history

See the root [README](../README.md) for current install/expose/run instructions — those are kept
up to date there. This page is for design rationale and to flag how the architecture has changed
since it was first built.

## What it is

A small bridge that spawns Readdle's official `Spark for Claude` stdio MCP server (which only runs
where Spark Desktop is signed in — macOS/Windows) and re-exposes it over **MCP Streamable HTTP**
with **OAuth 2.1**, so devices other than the one Mac running Spark Desktop can reach the mailbox.
It proxies at the MCP level (`tools/list`, `tools/call`) so upstream Readdle tool changes flow
through untouched.

## Architecture change: tunnel dropped in favor of Tailscale-only (important — supersedes earlier plans)

The bridge was originally built (2026-09-05) with a **Cloudflare Tunnel** for public exposure, run
via supervisord as a user-level LaunchAgent, so that claude.ai/Claude mobile could reach it.

**As of 2026-09-18, the tunnel was removed.** The bridge now binds directly to the Mac's Tailscale
address (`HOST=<tailscale-ip-or-MagicDNS-name>`, never `0.0.0.0`), and there is no tunnel, ingress,
or public hostname to configure at all — WireGuard is the network boundary, and only devices
already authorized on the tailnet can route to the port.

This is a deliberate trade, not a regression:

- **Cost**: claude.ai and the Claude mobile app can no longer connect — they fetch custom
  connectors from Anthropic's servers, not from the user's device, so a tailnet-only address is
  unreachable to them. What still works is any MCP client running **on a tailnet device**:
  Claude Code, Claude Desktop.
- **Benefit**: removes a public domain, a Cloudflare tunnel run token, a second supervised
  process, and the Cloudflare API surface, in exchange for one env var (`HOST`).
- **Reversible**: `tailscale serve` puts a real `ts.net` TLS cert in front if a client insists on
  HTTPS; `tailscale funnel` makes it public again (restoring claude.ai access) with no code change.
- The bridge retries the bind on `EADDRNOTAVAIL` instead of exiting, because supervisord can start
  it at login before `tailscaled` has brought the interface up — a race the process manager itself
  can't see or order around.

If any other note or doc describes this bridge as tunnel-based / Cloudflare-fronted, that is now
out of date — check this file or the current README first.

Separately, the earlier supervisord + tunnel *pattern* used here was extracted into
`Interlink-Spatial/interlink-pipeline`'s "collision" service, replacing an older `sudo cloudflared`
LaunchDaemon there. That extraction happened before the tunnel was dropped from *this* repo, so it
should not be assumed to have followed this repo's later Tailscale-only change.

## Why OAuth, even on a private tailnet

Nothing on a tailnet strictly requires it, but it's deliberate: `/mcp` can hand a model an entire
mailbox, and a tailnet is flat — every device and every process/user on the Mac itself can reach
the port. A shared secret in a client config is the kind of thing that ends up committed to a
dotfile repo; what travels over the wire instead is a short-lived, audience-bound access token, and
the long-lived secret (`SPARK_MCP_TOKEN`) never goes on the wire. It also keeps the exposure
decision reversible (see `tailscale funnel` above), since OAuth is the only auth method the hosted
Claude surfaces accept for custom connectors.

There is one user and no user database: `SPARK_MCP_TOKEN` is both the consent-screen credential and
the HMAC key signing every `client_id`, authorization code, and token, so the server holds no
session state (supervisord can restart it on every deploy without logging Claude out) and rotating
the token revokes everything issued so far. The raw token is **not** accepted as a bearer on `/mcp`
— only tokens the server itself issued through the OAuth flow are.

## Send gate

`SPARK_MCP_ALLOW_SEND` is off by default, so a leaked token can't send mail — enabling it turns on
the `event` tool and `action` `send`/`unschedule`. `SPARK_MCP_READ_ONLY=1` hides/blocks
`draft`/`comment`/`action`/`contact-action`/`event` entirely. Spark's own per-account access levels
(Settings → AI Agents) still apply underneath; this bridge only ever narrows them. Calls are tagged
`AI_AGENT=claude-remote` in Spark's own audit log so remote calls are distinguishable from Desktop.

## Dependency pinning

2026-09-18 also committed the lockfile, pinning `@modelcontextprotocol/sdk` at 1.30.0 (and its
tree) so a fresh clone on the Spark machine installs exactly what was tested rather than whatever
`^` resolves to that day.
