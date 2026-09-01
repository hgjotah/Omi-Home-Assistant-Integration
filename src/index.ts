import { handleApiRoute, authenticatedPageSession } from "./api";
import { csrfToken, createSession, getSession } from "./auth";
import { handleBridgeRoute } from "./bridge";
import { ensureUser } from "./database";
import { HttpError, clientKey, json, rateLimit, securityHeaders } from "./http";
import { handleOmiWebhook } from "./omi";
import type { Env } from "./types";
import { renderApp, renderLanding, renderPrivacy, renderSetupError } from "./ui";

function validUid(value: string | null): value is string {
  return Boolean(value && value.length <= 160 && /^[A-Za-z0-9._:@-]+$/.test(value));
}

async function setup(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") throw new HttpError(405, "Método no permitido");
  const url = new URL(request.url);
  const uid = url.searchParams.get("uid");
  if (!validUid(uid)) {
    const existing = await getSession(request, env.APP_SECRET);
    if (existing) return Response.redirect(new URL("/", request.url), 302);
    return renderSetupError("Omi no añadió un uid válido a la Auth URL.");
  }
  if (!rateLimit(clientKey(request, "setup"), 20, 60_000)) throw new HttpError(429, "Demasiados intentos de configuración");
  await ensureUser(env, uid);
  const session = await createSession(uid, env.APP_SECRET);
  return new Response(null, {
    status: 302,
    headers: {
      location: new URL("/?welcome=1", request.url).toString(),
      "set-cookie": session.cookie,
      "cache-control": "no-store",
    },
  });
}

async function setupStatus(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") throw new HttpError(405, "Método no permitido");
  const uid = new URL(request.url).searchParams.get("uid");
  if (!validUid(uid)) return json({ is_setup_completed: false });
  const ready = await env.DB.prepare(
    `SELECT EXISTS(
       SELECT 1 FROM users u JOIN bridges b ON b.uid = u.uid
       WHERE u.uid = ? AND b.enabled = 1 AND b.last_seen IS NOT NULL AND b.ha_ok = 1
     ) AS ready`,
  ).bind(uid).first<{ ready: number }>();
  // This property name is the exact format currently documented by Omi.
  return json({ is_setup_completed: ready?.ready === 1 });
}

async function appPage(request: Request, env: Env, initialView = "dashboard"): Promise<Response> {
  const session = await getSession(request, env.APP_SECRET);
  if (!session) return renderLanding();
  return renderApp(await csrfToken(session.token, env.APP_SECRET), initialView);
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (!env.APP_SECRET || env.APP_SECRET.length < 32) {
        throw new HttpError(503, "APP_SECRET no está configurado correctamente");
      }
      if (!env.OMI_WEBHOOK_TOKEN || env.OMI_WEBHOOK_TOKEN.length < 32) {
        throw new HttpError(503, "OMI_WEBHOOK_TOKEN no está configurado correctamente");
      }
      const url = new URL(request.url);
      const { pathname } = url;

      if (pathname === "/health") {
        if (request.method !== "GET") throw new HttpError(405, "Método no permitido");
        return securityHeaders(json({ ok: true }));
      }
      if (pathname === "/privacy") return securityHeaders(renderPrivacy());
      if (pathname === "/setup") return securityHeaders(await setup(request, env));
      if (pathname === "/setup-status") return securityHeaders(await setupStatus(request, env));
      if (pathname === "/webhook/omi") return securityHeaders(await handleOmiWebhook(request, env));
      if (pathname.startsWith("/api/bridge/")) {
        const bridgeId = request.headers.get("x-bridge-id") ?? "missing";
        if (!rateLimit(`bridge:${bridgeId}`, 120)) throw new HttpError(429, "Demasiadas peticiones del bridge");
        return securityHeaders(await handleBridgeRoute(request, env, pathname));
      }
      if (pathname.startsWith("/api/")) return securityHeaders(await handleApiRoute(request, env, url));
      if (pathname === "/diagnostics") {
        await authenticatedPageSession(request, env);
        return securityHeaders(await appPage(request, env, "diagnostics"));
      }
      if (pathname === "/" && request.method === "GET") return securityHeaders(await appPage(request, env));
      throw new HttpError(404, "No encontrado");
    } catch (error) {
      if (error instanceof HttpError) return securityHeaders(json({ ok: false, error: error.message }, error.status));
      // Never include request URLs, Authorization headers, tokens, or secrets in logs/responses.
      console.error("Unhandled worker error", error instanceof Error ? error.message : "unknown");
      return securityHeaders(json({ ok: false, error: "Error interno" }, 500));
    }
  },
} satisfies ExportedHandler<Env>;

export default worker;
