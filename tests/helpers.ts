import { env, exports } from "cloudflare:workers";

export async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`https://example.com${path}`, init));
}

export interface Login {
  uid: string;
  cookie: string;
  csrf: string;
}

export async function login(uid: string): Promise<Login> {
  const setup = await call(`/setup?uid=${encodeURIComponent(uid)}`, { redirect: "manual" });
  const setCookie = setup.headers.get("set-cookie");
  if (!setCookie) throw new Error("Missing session cookie");
  const cookie = setCookie.split(";")[0] ?? "";
  const page = await call("/", { headers: { cookie } });
  const source = await page.text();
  const csrf = /const CSRF="([^"]+)"/.exec(source)?.[1];
  if (!csrf) throw new Error("Missing CSRF token");
  return { uid, cookie, csrf };
}

export async function api(loginState: Login, path: string, method = "GET", body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { cookie: loginState.cookie };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["x-csrf-token"] = loginState.csrf;
    init.body = JSON.stringify(body);
  }
  return call(path, init);
}

export async function createBridge(loginState: Login): Promise<{ bridge_id: string; bridge_secret: string }> {
  const response = await api(loginState, "/api/bridges", "POST", {});
  if (response.status !== 201) throw new Error(await response.text());
  return response.json() as Promise<{ bridge_id: string; bridge_secret: string }>;
}

export function bridgeHeaders(bridge: { bridge_id: string; bridge_secret: string }): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-bridge-id": bridge.bridge_id,
    authorization: `Bearer ${bridge.bridge_secret}`,
  };
}

export async function next(bridge: { bridge_id: string; bridge_secret: string }, body: Record<string, unknown> = {}): Promise<Response> {
  return call("/api/bridge/next", {
    method: "POST",
    headers: bridgeHeaders(bridge),
    body: JSON.stringify({ firmware: "1.0.0", ip: "192.168.1.50", rssi: -50, ha_ok: true, ...body }),
  });
}

export async function seedCommand(uid: string, overrides: Partial<Record<string, unknown>> = {}): Promise<string> {
  const id = String(overrides.id ?? "cmd_test");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO commands (id, uid, phrase, normalized_phrase, entity_id, entity_name, domain, service, service_data, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    uid,
    overrides.phrase ?? "Omi enciende la luz",
    overrides.normalized_phrase ?? "omi enciende la luz",
    overrides.entity_id ?? "light.habitacion",
    overrides.entity_name ?? "Luz habitación",
    overrides.domain ?? "light",
    overrides.service ?? "turn_on",
    JSON.stringify(overrides.service_data ?? {}),
    overrides.enabled ?? 1,
    now,
    now,
  ).run();
  return id;
}

export async function omi(uid: string, sessionId: string, segments: unknown): Promise<Response> {
  return call(`/webhook/omi?token=test-omi-webhook-token-32-bytes-long&uid=${encodeURIComponent(uid)}&session_id=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(segments),
  });
}
