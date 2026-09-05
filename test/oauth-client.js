// Minimal OAuth 2.1 + DCR client: does what Claude does, so tests can obtain a
// real access token instead of reaching past the auth layer.
import { createHash, randomBytes } from "node:crypto";

const form = o => new URLSearchParams(o).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };

/** Runs discovery -> register -> consent -> code+PKCE exchange. */
export async function getAccessToken(base, sparkToken, { redirectUri = "http://localhost:51999/callback" } = {}) {
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  const as = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();

  const reg = await fetch(as.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "test", redirect_uris: [redirectUri] })
  });
  const { client_id } = await reg.json();

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = {
    response_type: "code", client_id, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: "S256",
    scope: "spark offline_access", resource: prm.resource
  };

  const granted = await fetch(as.authorization_endpoint, {
    method: "POST", headers: FORM, redirect: "manual",
    body: form({ ...params, spark_token: sparkToken })
  });
  if (granted.status !== 302) throw new Error(`consent failed: ${granted.status}`);
  const code = new URL(granted.headers.get("location")).searchParams.get("code");

  const tok = await (await fetch(as.token_endpoint, {
    method: "POST", headers: FORM,
    body: form({ grant_type: "authorization_code", code, client_id, redirect_uri: redirectUri, code_verifier: verifier })
  })).json();
  if (!tok.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tok)}`);
  return tok;
}
