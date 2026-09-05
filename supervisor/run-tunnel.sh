#!/usr/bin/env bash
# supervisord entrypoint for the remotely-managed Cloudflare tunnel that
# fronts spark-mcp-remote (spark-mcp.austindevs.com -> 127.0.0.1:8787).
#
# The tunnel's ingress lives in Cloudflare (Zero Trust / API), not in a local
# config.yml, so there is nothing to keep in sync on this machine. The run
# token is the only local secret: it sits in a chmod-600 file and is handed to
# cloudflared through TUNNEL_TOKEN, so it appears neither in the supervisor
# .ini (world-readable, and rendered in the supervisord web UI) nor in the
# process argv that `ps` shows to every user on the box.
#
# Provision the token file with:
#   curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
#     "https://api.cloudflare.com/client/v4/accounts/<account>/cfd_tunnel/<id>/token" \
#     | python3 -c 'import sys,json;sys.stdout.write(json.load(sys.stdin)["result"])' \
#     > ~/.cloudflared/spark-mcp.token
#   chmod 600 ~/.cloudflared/spark-mcp.token
set -euo pipefail

TOKEN_FILE="${SPARK_TUNNEL_TOKEN_FILE:-$HOME/.cloudflared/spark-mcp.token}"

[ -r "$TOKEN_FILE" ] || { echo "tunnel token file not readable: $TOKEN_FILE" >&2; exit 1; }
TUNNEL_TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
[ -n "$TUNNEL_TOKEN" ] || { echo "tunnel token file is empty: $TOKEN_FILE" >&2; exit 1; }
export TUNNEL_TOKEN

# supervisord runs with a fixed PATH; resolve cloudflared from brew if needed.
command -v cloudflared >/dev/null 2>&1 \
  || PATH="$(brew --prefix 2>/dev/null || echo /opt/homebrew)/bin:$PATH"

# --no-autoupdate: supervisord owns the restart policy, not cloudflared.
exec cloudflared tunnel --no-autoupdate run
