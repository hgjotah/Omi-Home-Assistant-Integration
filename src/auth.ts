import type { BridgeRow, Env, Session } from "./types";
import { base64Url, fromBase64Url, hmac, randomSecret, timingSafeEqual } from "./crypto";
import { HttpError } from "./http";

const SESSION_COOKIE = "omi_ha_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;

function cookies(request: Request): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name) result[name] = rest.join("=");
  }
  return result;
}

export async function createSession(uid: string, appSecret: string): Promise<{ token: string; cookie: string }> {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ uid, exp: expiresAt, nonce: randomSecret(12) })));
  const signature = await hmac(appSecret, `session.${payload}`);
  const token = `${payload}.${signature}`;
  return {
    token,
    cookie: `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
  };
}

export async function getSession(request: Request, appSecret: string): Promise<Session | null> {
  const token = cookies(request)[SESSION_COOKIE];
  if (!token) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  const expected = await hmac(appSecret, `session.${payload}`);
  if (!timingSafeEqual(signature, expected)) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as { uid?: unknown; exp?: unknown };
    if (typeof parsed.uid !== "string" || typeof parsed.exp !== "number") return null;
    if (parsed.exp <= Math.floor(Date.now() / 1000)) return null;
    return { uid: parsed.uid, expiresAt: parsed.exp, token };
  } catch {
    return null;
  }
}

export async function requireSession(request: Request, env: Env): Promise<Session> {
  const session = await getSession(request, env.APP_SECRET);
  if (!session) throw new HttpError(401, "Sesión no válida. Abre de nuevo la URL de configuración desde Omi.");
  return session;
}

export async function csrfToken(sessionToken: string, appSecret: string): Promise<string> {
  return hmac(appSecret, `csrf.${sessionToken}`);
}

export async function requireCsrf(request: Request, session: Session, appSecret: string): Promise<void> {
  const supplied = request.headers.get("x-csrf-token") ?? "";
  const expected = await csrfToken(session.token, appSecret);
  if (!supplied || !timingSafeEqual(supplied, expected)) throw new HttpError(403, "Token CSRF no válido");
}

export async function hashBridgeSecret(secret: string, appSecret: string, salt = randomSecret(16)): Promise<string> {
  const digest = await hmac(appSecret, `bridge.${salt}.${secret}`);
  return `v1:${salt}:${digest}`;
}

export async function verifyBridgeSecret(secret: string, stored: string, appSecret: string): Promise<boolean> {
  const [version, salt, digest, extra] = stored.split(":");
  if (version !== "v1" || !salt || !digest || extra) return false;
  const expected = await hmac(appSecret, `bridge.${salt}.${secret}`);
  return timingSafeEqual(digest, expected);
}

export async function authenticateBridge(request: Request, env: Env): Promise<BridgeRow> {
  const bridgeId = request.headers.get("x-bridge-id")?.trim();
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(authorization);
  if (!bridgeId || bridgeId.length > 100 || !match?.[1]) {
    throw new HttpError(401, "Credenciales del bridge no válidas");
  }
  const bridge = await env.DB.prepare("SELECT * FROM bridges WHERE bridge_id = ? LIMIT 1")
    .bind(bridgeId)
    .first<BridgeRow>();
  if (!bridge || bridge.enabled !== 1) throw new HttpError(401, "Credenciales del bridge no válidas");
  if (!(await verifyBridgeSecret(match[1], bridge.bridge_secret_hash, env.APP_SECRET))) {
    throw new HttpError(401, "Credenciales del bridge no válidas");
  }
  return bridge;
}
