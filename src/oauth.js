/**
 * OAuth 2.1 authorization server + protected-resource metadata for the bridge.
 *
 * Why this exists: Claude.ai / Claude mobile can only authenticate a custom
 * connector over OAuth. Its connector UI has no field for a static bearer
 * token (`static_headers` is beta and admin-only), so a server that only checks
 * `Authorization: Bearer <shared secret>` is reachable from curl and Claude
 * Code but not from the hosted Claude surfaces — which is the whole point of
 * this bridge. Claude supports `oauth_dcr` (OAuth 2.0 + RFC 7591 Dynamic Client
 * Registration) out of the box, so that is what we implement.
 *
 * There is exactly one user here (you, on your own Mac), so there is no user
 * database and no consent-per-scope. SPARK_MCP_TOKEN remains the single
 * credential: the /authorize consent screen asks for it, and proving you know
 * it is what authorizes the client.
 *
 * Everything is stateless — client registrations, authorization codes and
 * tokens are all HMAC-signed blobs keyed by SPARK_MCP_TOKEN, verified on
 * presentation. Nothing is persisted, which matters because supervisord
 * restarts this process on every deploy: a server-side session store would log
 * Claude out each time, while signed tokens keep working. It also means
 * rotating SPARK_MCP_TOKEN invalidates every issued token, which is the
 * behaviour you want from a rotation.
 *
 * Spec notes that cost real debugging time if missed:
 *   - /token must accept application/x-www-form-urlencoded (RFC 6749 4.1.3),
 *     but /register must accept application/json (RFC 7591 3.1).
 *   - The 401 must carry WWW-Authenticate with a resource_metadata pointer;
 *     Claude does not honour that header on a 200.
 *   - Refresh tokens must rotate for public clients, and a dead refresh token
 *     must come back as `invalid_grant`, not a custom code.
 */

import { createHmac, randomUUID, timingSafeEqual, createHash } from "node:crypto";

const ACCESS_TTL_S = 60 * 60;          // 1 h; Claude refreshes reactively on 401
const REFRESH_TTL_S = 60 * 60 * 24 * 30; // 30 d
const CODE_TTL_S = 60;                 // authorization codes are redeemed in seconds

// Authorization codes are single-use. They live 60s, so this stays tiny; we
// still sweep it so a long-running process cannot grow it without bound.
const usedCodes = new Map(); // jti -> expiry epoch seconds

function sweep() {
    const now = Math.floor(Date.now() / 1000);
    for (const [jti, exp] of usedCodes) if (exp < now) usedCodes.delete(jti);
}

// --- signing -------------------------------------------------------------

const b64url = buf => Buffer.from(buf).toString("base64url");

function sign(secret, type, payload) {
    const body = b64url(JSON.stringify({ ...payload, typ: type }));
    const mac = createHmac("sha256", secret).update(`${type}.${body}`).digest();
    return `${body}.${b64url(mac)}`;
}

function verify(secret, type, value) {
    if (typeof value !== "string") return null;
    const dot = value.lastIndexOf(".");
    if (dot < 1) return null;
    const body = value.slice(0, dot);
    const got = Buffer.from(value.slice(dot + 1), "base64url");
    const want = createHmac("sha256", secret).update(`${type}.${body}`).digest();
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    let payload;
    try {
        payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
        return null;
    }
    if (payload.typ !== type) return null;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
}

// --- URLs ----------------------------------------------------------------

/**
 * External origin of this server. Behind cloudflared the client-visible scheme
 * is https while we are listening on plain http, so trust X-Forwarded-Proto
 * (cloudflared always sets it) and fall back to the listening scheme.
 * SPARK_MCP_PUBLIC_URL overrides both when the deployment needs it pinned.
 */
export function originOf(req, override) {
    if (override) return override.replace(/\/+$/, "");
    const proto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
    return `${proto}://${host}`;
}

// Claude requires the metadata `resource` to equal the connector URL exactly as
// the user typed it, path included.
const resourceOf = (origin, mcpPath) => `${origin}${mcpPath}`;

const canonical = u => String(u || "").replace(/\/+$/, "");

// --- redirect URI policy -------------------------------------------------

/**
 * Exact match for https, port-agnostic for loopback. Claude Code redirects to
 * http://localhost:<ephemeral>/callback but declares the port-less form in its
 * client metadata document, and RFC 8252 §7.3 requires servers to ignore the
 * port for loopback redirects.
 */
function redirectAllowed(registered, candidate) {
    let c;
    try {
        c = new URL(candidate);
    } catch {
        return false;
    }
    const loopback = c.protocol === "http:" && (c.hostname === "localhost" || c.hostname === "127.0.0.1" || c.hostname === "::1");
    if (c.protocol !== "https:" && !loopback) return false; // OAuth 2.1 §1.5
    return registered.some(r => {
        if (r === candidate) return true;
        if (!loopback) return false;
        let u;
        try {
            u = new URL(r);
        } catch {
            return false;
        }
        return (
            u.protocol === c.protocol &&
            u.hostname === c.hostname &&
            u.pathname === c.pathname
        );
    });
}

// --- request body helpers ------------------------------------------------

async function readBody(req, limit = 1024 * 64) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new Error("body too large");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

const json = (res, status, body, headers = {}) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...headers
    });
    res.end(payload);
};

const oauthError = (res, status, error, description) =>
    json(res, status, { error, error_description: description });

// --- consent screen ------------------------------------------------------

const escapeHtml = s =>
    String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function consentPage({ clientName, redirectUri, scope, params, error }) {
    const hidden = Object.entries(params)
        .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
        .join("\n      ");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize access to Spark</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         max-width: 26rem; margin: 12vh auto; padding: 0 1.25rem; }
  h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
  p { color: #666; margin: .35rem 0 1rem; }
  dl { background: rgba(127,127,127,.09); border-radius: 8px; padding: .75rem 1rem; margin: 0 0 1.25rem; }
  dt { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; color: #888; }
  dd { margin: 0 0 .6rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
       font-size: .82rem; word-break: break-all; }
  dd:last-child { margin-bottom: 0; }
  label { display: block; font-weight: 600; margin-bottom: .35rem; }
  input[type=password] { width: 100%; padding: .55rem .65rem; font-size: 1rem; box-sizing: border-box;
       border: 1px solid #bbb; border-radius: 6px; background: Canvas; color: CanvasText; }
  button { margin-top: .9rem; width: 100%; padding: .6rem; font-size: 1rem; font-weight: 600;
       border: 0; border-radius: 6px; background: #2f6feb; color: #fff; cursor: pointer; }
  .err { color: #c0362c; font-weight: 600; margin: .6rem 0 0; }
</style></head>
<body>
  <h1>Authorize access to Spark</h1>
  <p>Grant this client access to your Spark mailbox through spark-mcp-remote.</p>
  <dl>
    <dt>Client</dt><dd>${escapeHtml(clientName)}</dd>
    <dt>Redirects to</dt><dd>${escapeHtml(redirectUri)}</dd>
    <dt>Scope</dt><dd>${escapeHtml(scope || "spark")}</dd>
  </dl>
  <form method="post">
      ${hidden}
    <label for="tok">SPARK_MCP_TOKEN</label>
    <input id="tok" name="spark_token" type="password" autocomplete="off" autofocus
           placeholder="from your .env">
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
    <button type="submit">Authorize</button>
  </form>
</body></html>`;
}

// --- the handler ---------------------------------------------------------

/**
 * Returns a request handler for every OAuth + discovery path, or null when the
 * request is not ours (so the caller can fall through to the MCP transport).
 *
 * `secret` is SPARK_MCP_TOKEN; it doubles as the signing key and as the
 * credential the consent screen checks.
 */
export function createOAuth({ secret, mcpPath, publicUrl }) {
    const secretBuf = Buffer.from(secret);

    const checkToken = supplied => {
        const a = Buffer.from(String(supplied ?? ""));
        return a.length === secretBuf.length && timingSafeEqual(a, secretBuf);
    };

    /** Validate a bearer credential presented to the MCP endpoint. */
    const verifyAccess = (presented, origin) => {
        // Back-compat: the raw shared secret still works, so curl, Claude Code
        // --header and mcp-remote keep working exactly as before.
        if (checkToken(presented)) return { sub: "static", scope: "spark" };
        const claims = verify(secret, "access", presented);
        if (!claims) return null;
        // Audience binding (RFC 8707): only accept tokens minted for us.
        const want = new Set([canonical(resourceOf(origin, mcpPath)), canonical(origin)]);
        if (!want.has(canonical(claims.aud))) return null;
        return claims;
    };

    const metadataUrl = origin => `${origin}/.well-known/oauth-protected-resource`;

    async function handle(req, res, url, origin) {
        const path = url.pathname;
        const resource = resourceOf(origin, mcpPath);

        // -- RFC 9728 protected resource metadata ------------------------
        // Claude probes `/.well-known/oauth-protected-resource/<mcp path>`
        // before the bare path, so answer on both.
        if (
            req.method === "GET" &&
            (path === "/.well-known/oauth-protected-resource" ||
                path === `/.well-known/oauth-protected-resource${mcpPath}`)
        ) {
            return json(res, 200, {
                resource,
                authorization_servers: [origin],
                scopes_supported: ["spark", "offline_access"],
                bearer_methods_supported: ["header"],
                resource_name: "spark-mcp-remote"
            });
        }

        // -- RFC 8414 authorization server metadata ----------------------
        if (
            req.method === "GET" &&
            (path === "/.well-known/oauth-authorization-server" ||
                path === `/.well-known/oauth-authorization-server${mcpPath}` ||
                path === "/.well-known/openid-configuration")
        ) {
            return json(res, 200, {
                issuer: origin,
                authorization_endpoint: `${origin}/oauth/authorize`,
                token_endpoint: `${origin}/oauth/token`,
                registration_endpoint: `${origin}/oauth/register`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                // S256 only: OAuth 2.1 drops "plain".
                code_challenge_methods_supported: ["S256"],
                // Claude's DCR client is public and sends no client secret.
                token_endpoint_auth_methods_supported: ["none"],
                // offline_access here is what makes Claude ask for a refresh token.
                scopes_supported: ["spark", "offline_access"],
                service_documentation: "https://github.com/kevincolten/spark-mcp-remote"
            });
        }

        // -- RFC 7591 dynamic client registration ------------------------
        if (path === "/oauth/register") {
            if (req.method !== "POST") return oauthError(res, 405, "invalid_request", "POST required");
            let meta;
            try {
                meta = JSON.parse((await readBody(req)) || "{}");
            } catch {
                return oauthError(res, 400, "invalid_client_metadata", "body must be JSON");
            }
            const redirectUris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [];
            if (!redirectUris.length) {
                return oauthError(res, 400, "invalid_redirect_uri", "redirect_uris is required");
            }
            for (const u of redirectUris) {
                let parsed;
                try {
                    parsed = new URL(u);
                } catch {
                    return oauthError(res, 400, "invalid_redirect_uri", `not a URL: ${u}`);
                }
                const loopback =
                    parsed.protocol === "http:" &&
                    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1");
                if (parsed.protocol !== "https:" && !loopback) {
                    return oauthError(res, 400, "invalid_redirect_uri", `must be https or loopback: ${u}`);
                }
            }
            // The client_id *is* the registration: a signed blob carrying the
            // redirect URIs. No store to persist, nothing to lose on restart.
            const client_id = sign(secret, "client", {
                redirect_uris: redirectUris,
                client_name: String(meta.client_name || "MCP client").slice(0, 120),
                iat: Math.floor(Date.now() / 1000)
            });
            return json(res, 201, {
                client_id,
                client_id_issued_at: Math.floor(Date.now() / 1000),
                redirect_uris: redirectUris,
                client_name: meta.client_name,
                token_endpoint_auth_method: "none",
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"]
            });
        }

        // -- authorization endpoint --------------------------------------
        if (path === "/oauth/authorize") {
            const q =
                req.method === "POST"
                    ? Object.fromEntries(new URLSearchParams(await readBody(req)))
                    : Object.fromEntries(url.searchParams);

            const client = verify(secret, "client", q.client_id);
            if (!client) {
                return json(res, 400, { error: "invalid_client", error_description: "unknown or expired client_id" });
            }
            if (!redirectAllowed(client.redirect_uris, q.redirect_uri)) {
                // Never redirect to an unvalidated URI — that is the open-redirect
                // hole. Render the error instead.
                return json(res, 400, { error: "invalid_request", error_description: "redirect_uri not registered" });
            }

            // From here errors are safe to deliver back to the (validated) client.
            const back = (error, description) => {
                const to = new URL(q.redirect_uri);
                to.searchParams.set("error", error);
                if (description) to.searchParams.set("error_description", description);
                if (q.state) to.searchParams.set("state", q.state);
                res.writeHead(302, { location: to.toString(), "cache-control": "no-store" }).end();
            };

            if (q.response_type !== "code") return back("unsupported_response_type", "only code is supported");
            if (q.code_challenge_method !== "S256") return back("invalid_request", "code_challenge_method must be S256");
            if (!q.code_challenge) return back("invalid_request", "code_challenge is required");
            if (q.resource && !new Set([canonical(resource), canonical(origin)]).has(canonical(q.resource))) {
                return back("invalid_target", "resource does not match this server");
            }

            const params = {
                client_id: q.client_id,
                redirect_uri: q.redirect_uri,
                response_type: q.response_type,
                code_challenge: q.code_challenge,
                code_challenge_method: q.code_challenge_method,
                ...(q.state ? { state: q.state } : {}),
                ...(q.scope ? { scope: q.scope } : {}),
                ...(q.resource ? { resource: q.resource } : {})
            };

            if (req.method === "GET") {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
                return res.end(
                    consentPage({ clientName: client.client_name, redirectUri: q.redirect_uri, scope: q.scope, params })
                );
            }

            if (req.method !== "POST") return oauthError(res, 405, "invalid_request", "GET or POST");

            if (!checkToken(q.spark_token)) {
                res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
                return res.end(
                    consentPage({
                        clientName: client.client_name,
                        redirectUri: q.redirect_uri,
                        scope: q.scope,
                        params,
                        error: "That is not the SPARK_MCP_TOKEN for this server."
                    })
                );
            }

            const now = Math.floor(Date.now() / 1000);
            const code = sign(secret, "code", {
                jti: randomUUID(),
                client_id: q.client_id,
                redirect_uri: q.redirect_uri,
                code_challenge: q.code_challenge,
                scope: q.scope || "spark",
                aud: canonical(q.resource || resource),
                iat: now,
                exp: now + CODE_TTL_S
            });
            const to = new URL(q.redirect_uri);
            to.searchParams.set("code", code);
            if (q.state) to.searchParams.set("state", q.state);
            return res.writeHead(302, { location: to.toString(), "cache-control": "no-store" }).end();
        }

        // -- token endpoint ----------------------------------------------
        if (path === "/oauth/token") {
            if (req.method !== "POST") return oauthError(res, 405, "invalid_request", "POST required");
            // RFC 6749 §4.1.3 — Claude sends form-urlencoded for both the code
            // exchange and refreshes.
            const body = Object.fromEntries(new URLSearchParams(await readBody(req)));
            const now = Math.floor(Date.now() / 1000);

            const issue = (aud, scope, sub) => {
                const access_token = sign(secret, "access", {
                    jti: randomUUID(), sub, aud, scope, iat: now, exp: now + ACCESS_TTL_S
                });
                const refresh_token = sign(secret, "refresh", {
                    jti: randomUUID(), sub, aud, scope, iat: now, exp: now + REFRESH_TTL_S
                });
                return json(res, 200, {
                    access_token,
                    token_type: "Bearer",
                    expires_in: ACCESS_TTL_S,
                    refresh_token,
                    scope
                });
            };

            if (body.grant_type === "authorization_code") {
                const code = verify(secret, "code", body.code);
                // Expired or forged codes are invalid_grant, per RFC 6749.
                if (!code) return oauthError(res, 400, "invalid_grant", "authorization code invalid or expired");
                sweep();
                if (usedCodes.has(code.jti)) {
                    return oauthError(res, 400, "invalid_grant", "authorization code already used");
                }
                if (code.client_id !== body.client_id) {
                    return oauthError(res, 400, "invalid_grant", "code was issued to another client");
                }
                if (code.redirect_uri !== body.redirect_uri) {
                    return oauthError(res, 400, "invalid_grant", "redirect_uri mismatch");
                }
                // PKCE S256 (OAuth 2.1 §7.5.2)
                const challenge = createHash("sha256").update(String(body.code_verifier ?? "")).digest("base64url");
                const a = Buffer.from(challenge);
                const b = Buffer.from(String(code.code_challenge));
                if (a.length !== b.length || !timingSafeEqual(a, b)) {
                    return oauthError(res, 400, "invalid_grant", "PKCE verification failed");
                }
                usedCodes.set(code.jti, code.exp);
                return issue(code.aud, code.scope, "spark");
            }

            if (body.grant_type === "refresh_token") {
                const old = verify(secret, "refresh", body.refresh_token);
                if (!old) return oauthError(res, 400, "invalid_grant", "refresh token invalid or expired");
                // Public clients must get a rotated refresh token; issue() always
                // mints a fresh one, so the old blob is superseded on every use.
                return issue(old.aud, old.scope, old.sub);
            }

            return oauthError(res, 400, "unsupported_grant_type", `unsupported grant_type: ${body.grant_type}`);
        }

        return false; // not an OAuth path
    }

    return { handle, verifyAccess, metadataUrl };
}
