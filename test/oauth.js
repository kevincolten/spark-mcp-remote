// Drives the whole OAuth 2.1 + DCR flow the way Claude.ai does it: 401 ->
// resource metadata -> AS metadata -> register -> authorize (consent) ->
// code+PKCE exchange -> authenticated MCP call -> refresh.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const TOKEN = "test-token-test-token-test-token";
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const REDIRECT = "http://localhost:51000/callback";

const proc = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, SPARK_MCP_TOKEN: TOKEN, PORT, SPARK_MCP_ENTRY: new URL("./fake-upstream.js", import.meta.url).pathname },
  stdio: ["ignore", "inherit", "inherit"]
});

const form = o => new URLSearchParams(o).toString();

try {
  for (let i = 0; i < 40; i++) { try { await fetch(`${BASE}/healthz`); break; } catch { await sleep(100); } }

  // 1. 401 must point at the resource metadata (Claude reads only this header).
  const un = await fetch(`${BASE}/mcp`, { method: "POST", body: "{}" });
  assert.equal(un.status, 401);
  const wwwAuth = un.headers.get("www-authenticate") || "";
  const rm = /resource_metadata="([^"]+)"/.exec(wwwAuth);
  assert.ok(rm, `401 must carry resource_metadata, got: ${wwwAuth}`);

  // 2. RFC 9728 protected resource metadata
  const prm = await (await fetch(rm[1])).json();
  assert.equal(prm.resource, `${BASE}/mcp`, "resource must equal the connector URL exactly");
  assert.ok(Array.isArray(prm.authorization_servers) && prm.authorization_servers.length);
  // Claude probes the path-suffixed form first; it must answer too.
  assert.equal((await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).status, 200);

  // 3. RFC 8414 authorization server metadata
  const as = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"], "Claude always sends S256");
  assert.ok(as.token_endpoint_auth_methods_supported.includes("none"), "Claude's DCR client is public");
  assert.ok(as.scopes_supported.includes("offline_access"), "needed for Claude to ask for a refresh token");
  assert.ok(as.registration_endpoint);

  // 4. RFC 7591 dynamic client registration (JSON, not form-encoded)
  const reg = await fetch(as.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: ["http://localhost/callback"] })
  });
  assert.equal(reg.status, 201);
  const client = await reg.json();
  assert.ok(client.client_id);

  const bad = await fetch(as.registration_endpoint, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"] })
  });
  assert.equal(bad.status, 400, "non-loopback http redirect must be rejected");

  // 5. authorize — PKCE
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authQ = {
    response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: "S256",
    state: "xyz", scope: "spark offline_access", resource: `${BASE}/mcp`
  };
  // Loopback redirect registered port-less must match with a port (RFC 8252 §7.3).
  const consent = await fetch(`${BASE}/oauth/authorize?${form(authQ)}`);
  assert.equal(consent.status, 200);
  assert.match(await consent.text(), /SPARK_MCP_TOKEN/);

  // wrong credential -> no code
  const denied = await fetch(`${BASE}/oauth/authorize`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ ...authQ, spark_token: "nope" }), redirect: "manual"
  });
  assert.equal(denied.status, 401);

  const granted = await fetch(`${BASE}/oauth/authorize`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ ...authQ, spark_token: TOKEN }), redirect: "manual"
  });
  assert.equal(granted.status, 302);
  const cb = new URL(granted.headers.get("location"));
  assert.equal(cb.searchParams.get("state"), "xyz");
  const code = cb.searchParams.get("code");
  assert.ok(code);

  // 6. token exchange — form-urlencoded (RFC 6749 §4.1.3)
  const wrongPkce = await fetch(`${BASE}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: "wrong" })
  });
  assert.equal(wrongPkce.status, 400);
  assert.equal((await wrongPkce.json()).error, "invalid_grant");

  const tokRes = await fetch(`${BASE}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier })
  });
  assert.equal(tokRes.status, 200);
  const tok = await tokRes.json();
  assert.equal(tok.token_type, "Bearer");
  assert.ok(tok.access_token && tok.refresh_token);

  // codes are single-use
  const replay = await fetch(`${BASE}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier })
  });
  assert.equal((await replay.json()).error, "invalid_grant", "replayed code must be rejected");

  // 7. the issued token actually works on /mcp
  const init = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tok.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } })
  });
  assert.equal(init.status, 200, "OAuth access token must authenticate the MCP endpoint");

  // a token forged for another audience must not work
  const otherAud = tok.access_token.slice(0, -4) + "AAAA";
  const forged = await fetch(`${BASE}/mcp`, {
    method: "POST", headers: { authorization: `Bearer ${otherAud}`, "content-type": "application/json" }, body: "{}"
  });
  assert.equal(forged.status, 401, "tampered token must be rejected");

  // 8. refresh, with rotation
  const refRes = await fetch(`${BASE}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: client.client_id })
  });
  assert.equal(refRes.status, 200);
  const refreshed = await refRes.json();
  assert.ok(refreshed.access_token);
  assert.ok(refreshed.refresh_token && refreshed.refresh_token !== tok.refresh_token, "refresh tokens must rotate");

  const deadRefresh = await fetch(`${BASE}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "refresh_token", refresh_token: "garbage" })
  });
  assert.equal((await deadRefresh.json()).error, "invalid_grant", "dead refresh must be invalid_grant");

  // 9. the shared secret is NOT a bearer credential — only issued tokens are
  const staticAuth = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } })
  });
  assert.equal(staticAuth.status, 401, "SPARK_MCP_TOKEN must not authenticate directly");

  // 10. a refresh-typed token must not be usable as an access token
  const wrongType = await fetch(`${BASE}/mcp`, {
    method: "POST", headers: { authorization: `Bearer ${tok.refresh_token}`, "content-type": "application/json" }, body: "{}"
  });
  assert.equal(wrongType.status, 401, "refresh token must not work as an access token");

  console.log("oauth: all checks passed");
} finally { proc.kill("SIGTERM"); }
