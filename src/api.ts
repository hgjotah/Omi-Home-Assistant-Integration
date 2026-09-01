import { hashBridgeSecret, requireCsrf, requireSession } from "./auth";
import { randomId, randomSecret } from "./crypto";
import { CONNECTED_WINDOW_MS, createJob, publicJob, selectBridgeForUser } from "./database";
import { parseActionInput } from "./homeAssistant";
import { HttpError, cleanText, isRecord, json, rateLimit, clientKey, readJson } from "./http";
import { hasCommandStructure, normalizeTranscript } from "./normalization";
import type { BridgeRow, CommandRow, Env, JobRow, Session } from "./types";

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function parseServiceData(value: unknown): Record<string, unknown> {
  if (!isRecord(value ?? {})) throw new HttpError(400, "service_data debe ser un objeto JSON");
  const encoded = JSON.stringify(value ?? {});
  if (encoded.length > 16_384) throw new HttpError(400, "service_data es demasiado grande");
  return value as Record<string, unknown>;
}

async function bootstrap(env: Env, uid: string): Promise<Response> {
  const now = Date.now();
  const [bridges, commands, entityCount, commandCount, serviceCount, lastJobs, entitySync, serviceSync] = await Promise.all([
    env.DB.prepare(
      "SELECT id, bridge_id, enabled, last_seen, firmware_version, ip, rssi, ha_ok, created_at FROM bridges WHERE uid = ? ORDER BY created_at DESC",
    ).bind(uid).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT c.*,
        CASE WHEN e.entity_id IS NULL THEN 0 ELSE 1 END AS entity_available,
        CASE WHEN s.service IS NULL THEN 0 ELSE 1 END AS service_available
       FROM commands c
       LEFT JOIN entity_cache e ON e.uid = c.uid AND e.entity_id = c.entity_id
       LEFT JOIN service_cache s ON s.uid = c.uid AND s.domain = c.domain AND s.service = c.service
       WHERE c.uid = ? ORDER BY c.created_at DESC`,
    ).bind(uid).all<CommandRow & { entity_available: number; service_available: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM entity_cache WHERE uid = ?").bind(uid).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM commands WHERE uid = ?").bind(uid).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM service_cache WHERE uid = ?").bind(uid).first<{ count: number }>(),
    env.DB.prepare("SELECT * FROM jobs WHERE uid = ? ORDER BY created_at DESC LIMIT 10").bind(uid).all<JobRow>(),
    env.DB.prepare("SELECT * FROM jobs WHERE uid = ? AND type = 'sync_entities' ORDER BY created_at DESC LIMIT 1").bind(uid).first<JobRow>(),
    env.DB.prepare("SELECT * FROM jobs WHERE uid = ? AND type = 'sync_services' ORDER BY created_at DESC LIMIT 1").bind(uid).first<JobRow>(),
  ]);
  return json({
    ok: true,
    now,
    connected_window_ms: CONNECTED_WINDOW_MS,
    bridges: bridges.results.map((bridge) => ({
      ...bridge,
      connected: typeof bridge.last_seen === "number" && now - bridge.last_seen <= CONNECTED_WINDOW_MS,
    })),
    commands: commands.results.map((command) => ({
      ...command,
      service_data: JSON.parse(command.service_data) as unknown,
    })),
    counts: {
      entities: entityCount?.count ?? 0,
      commands: commandCount?.count ?? 0,
      services: serviceCount?.count ?? 0,
    },
    sync: {
      entities: entitySync ? publicJob(entitySync) : null,
      services: serviceSync ? publicJob(serviceSync) : null,
    },
    jobs: lastJobs.results.map(publicJob),
  });
}

async function createBridge(request: Request, env: Env, uid: string): Promise<Response> {
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM bridges WHERE uid = ?").bind(uid).first<{ count: number }>();
  if ((count?.count ?? 0) >= 5) throw new HttpError(409, "Máximo de 5 bridges por usuario");
  const id = randomId("bridge");
  const bridgeId = randomId("br", 12);
  const bridgeSecret = randomSecret(32);
  const hash = await hashBridgeSecret(bridgeSecret, env.APP_SECRET);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO bridges (id, uid, bridge_id, bridge_secret_hash, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
  ).bind(id, uid, bridgeId, hash, now, now).run();
  return json({ ok: true, bridge_id: bridgeId, bridge_secret: bridgeSecret }, 201);
}

async function bridgeMutation(request: Request, env: Env, uid: string, bridgeId: string, operation: string): Promise<Response> {
  const existing = await env.DB.prepare("SELECT * FROM bridges WHERE uid = ? AND bridge_id = ? LIMIT 1")
    .bind(uid, bridgeId).first<BridgeRow>();
  if (!existing) throw new HttpError(404, "Bridge no encontrado");
  if (operation === "regenerate") {
    const secret = randomSecret(32);
    const hash = await hashBridgeSecret(secret, env.APP_SECRET);
    await env.DB.prepare("UPDATE bridges SET bridge_secret_hash = ?, updated_at = ? WHERE uid = ? AND bridge_id = ?")
      .bind(hash, Date.now(), uid, bridgeId).run();
    return json({ ok: true, bridge_id: bridgeId, bridge_secret: secret });
  }
  if (operation === "toggle") {
    const body = await readJson<{ enabled?: unknown }>(request, 1_024);
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled debe ser boolean");
    await env.DB.prepare("UPDATE bridges SET enabled = ?, updated_at = ? WHERE uid = ? AND bridge_id = ?")
      .bind(Number(body.enabled), Date.now(), uid, bridgeId).run();
    return json({ ok: true });
  }
  if (operation === "delete") {
    await env.DB.prepare("DELETE FROM bridges WHERE uid = ? AND bridge_id = ?").bind(uid, bridgeId).run();
    return json({ ok: true });
  }
  throw new HttpError(404, "Operación no encontrada");
}

async function listEntities(url: URL, env: Env, uid: string): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const domain = (url.searchParams.get("domain") ?? "").trim().toLowerCase().slice(0, 80);
  const pattern = `%${escapeLike(q)}%`;
  const result = await env.DB.prepare(
    `SELECT entity_id, domain, friendly_name, state, icon, updated_at FROM entity_cache
     WHERE uid = ? AND (? = '' OR domain = ?)
       AND (? = '' OR friendly_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR entity_id LIKE ? ESCAPE '\\' COLLATE NOCASE OR domain LIKE ? ESCAPE '\\' COLLATE NOCASE)
     ORDER BY CASE WHEN friendly_name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 0 ELSE 1 END, friendly_name COLLATE NOCASE
     LIMIT 50`,
  ).bind(uid, domain, domain, q, pattern, pattern, pattern, `${escapeLike(q)}%`).all();
  const domains = await env.DB.prepare("SELECT domain, COUNT(*) AS count FROM entity_cache WHERE uid = ? GROUP BY domain ORDER BY domain")
    .bind(uid).all();
  return json({ ok: true, items: result.results, domains: domains.results });
}

async function listServices(url: URL, env: Env, uid: string): Promise<Response> {
  const domain = (url.searchParams.get("domain") ?? "").trim().toLowerCase().slice(0, 80);
  const result = await env.DB.prepare(
    "SELECT domain, service, name, description, fields_json, updated_at FROM service_cache WHERE uid = ? AND (? = '' OR domain = ?) ORDER BY domain, service LIMIT 500",
  ).bind(uid, domain, domain).all<{ domain: string; service: string; name: string; description: string; fields_json: string; updated_at: number }>();
  return json({ ok: true, items: result.results.map((item) => ({ ...item, fields: JSON.parse(item.fields_json) as unknown, fields_json: undefined })) });
}

interface CommandInput {
  phrase?: unknown;
  entity_id?: unknown;
  entity_name?: unknown;
  domain?: unknown;
  service?: unknown;
  service_data?: unknown;
  enabled?: unknown;
}

function parseCommand(body: CommandInput): Omit<CommandRow, "id" | "uid" | "created_at" | "updated_at"> {
  const phrase = cleanText(body.phrase, "phrase", 180);
  const normalized = normalizeTranscript(phrase);
  if (!hasCommandStructure(normalized)) {
    throw new HttpError(400, "El comando debe incluir una palabra de activación y una acción");
  }
  const action = parseActionInput(body);
  const entityName = cleanText(body.entity_name ?? action.entity_id, "entity_name", 255);
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new HttpError(400, "enabled debe ser boolean");
  return {
    phrase,
    normalized_phrase: normalized,
    entity_id: action.entity_id,
    entity_name: entityName,
    domain: action.domain,
    service: action.service,
    service_data: JSON.stringify(parseServiceData(body.service_data)),
    enabled: body.enabled === false ? 0 : 1,
  };
}

async function saveCommand(request: Request, env: Env, uid: string, id?: string): Promise<Response> {
  const parsed = parseCommand(await readJson<CommandInput>(request, 24_576));
  const now = Date.now();
  if (!id) {
    const commandId = randomId("cmd");
    try {
      await env.DB.prepare(
        `INSERT INTO commands (id, uid, phrase, normalized_phrase, entity_id, entity_name, domain, service, service_data, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(commandId, uid, parsed.phrase, parsed.normalized_phrase, parsed.entity_id, parsed.entity_name, parsed.domain, parsed.service, parsed.service_data, parsed.enabled, now, now).run();
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new HttpError(409, "Ya existe un comando con esa frase");
      throw error;
    }
    return json({ ok: true, id: commandId }, 201);
  }
  const updated = await env.DB.prepare(
    `UPDATE commands SET phrase = ?, normalized_phrase = ?, entity_id = ?, entity_name = ?, domain = ?, service = ?, service_data = ?, enabled = ?, updated_at = ?
     WHERE id = ? AND uid = ? RETURNING id`,
  ).bind(parsed.phrase, parsed.normalized_phrase, parsed.entity_id, parsed.entity_name, parsed.domain, parsed.service, parsed.service_data, parsed.enabled, now, id, uid).first();
  if (!updated) throw new HttpError(404, "Comando no encontrado");
  return json({ ok: true, id });
}

async function commandOperation(request: Request, env: Env, uid: string, id: string, operation: string): Promise<Response> {
  if (operation === "delete") {
    const result = await env.DB.prepare("DELETE FROM commands WHERE id = ? AND uid = ?").bind(id, uid).run();
    if ((result.meta.changes ?? 0) !== 1) throw new HttpError(404, "Comando no encontrado");
    return json({ ok: true });
  }
  const command = await env.DB.prepare("SELECT * FROM commands WHERE id = ? AND uid = ? LIMIT 1").bind(id, uid).first<CommandRow>();
  if (!command) throw new HttpError(404, "Comando no encontrado");
  if (operation === "toggle") {
    const body = await readJson<{ enabled?: unknown }>(request, 1_024);
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled debe ser boolean");
    await env.DB.prepare("UPDATE commands SET enabled = ?, updated_at = ? WHERE id = ? AND uid = ?")
      .bind(Number(body.enabled), Date.now(), id, uid).run();
    return json({ ok: true });
  }
  if (operation === "test") {
    const bridge = await selectBridgeForUser(env, uid);
    const jobId = await createJob(env, uid, bridge.bridge_id, "call_service", {
      domain: command.domain,
      service: command.service,
      entity_id: command.entity_id,
      service_data: JSON.parse(command.service_data) as unknown,
    });
    return json({ ok: true, job_id: jobId }, 202);
  }
  throw new HttpError(404, "Operación de comando no encontrada");
}

async function action(request: Request, env: Env, uid: string, operation: string): Promise<Response> {
  const bridge = await selectBridgeForUser(env, uid);
  if (operation === "test") {
    const payload = parseActionInput(await readJson<unknown>(request, 24_576));
    return json({ ok: true, job_id: await createJob(env, uid, bridge.bridge_id, "call_service", { ...payload }) }, 202);
  }
  if (operation === "test-home-assistant") {
    return json({ ok: true, job_id: await createJob(env, uid, bridge.bridge_id, "test_home_assistant") }, 202);
  }
  if (operation === "sync") {
    const entitiesJobId = await createJob(env, uid, bridge.bridge_id, "sync_entities");
    const servicesJobId = await createJob(env, uid, bridge.bridge_id, "sync_services");
    return json({ ok: true, job_ids: [entitiesJobId, servicesJobId] }, 202);
  }
  if (operation === "get-state") {
    const body = await readJson<{ entity_id?: unknown }>(request, 2_048);
    const entityId = cleanText(body.entity_id, "entity_id", 255).toLowerCase();
    if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(entityId)) throw new HttpError(400, "entity_id no válido");
    return json({ ok: true, job_id: await createJob(env, uid, bridge.bridge_id, "get_entity_state", { entity_id: entityId }) }, 202);
  }
  throw new HttpError(404, "Acción no encontrada");
}

async function getJob(env: Env, uid: string, jobId: string): Promise<Response> {
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND uid = ? LIMIT 1").bind(jobId, uid).first<JobRow>();
  if (!job) throw new HttpError(404, "Trabajo no encontrado");
  return json({ ok: true, job: publicJob(job) });
}

async function diagnostics(env: Env, uid: string): Promise<Response> {
  const [user, bridge, job, actionJob, entitySync, serviceSync] = await Promise.all([
    env.DB.prepare("SELECT setup_completed, last_webhook_at, last_error FROM users WHERE uid = ?").bind(uid).first(),
    env.DB.prepare("SELECT bridge_id, last_seen, firmware_version, ip, rssi, ha_ok FROM bridges WHERE uid = ? ORDER BY last_seen DESC LIMIT 1").bind(uid).first(),
    env.DB.prepare("SELECT * FROM jobs WHERE uid = ? ORDER BY created_at DESC LIMIT 1").bind(uid).first<JobRow>(),
    env.DB.prepare("SELECT * FROM jobs WHERE uid = ? AND type = 'call_service' ORDER BY created_at DESC LIMIT 1").bind(uid).first<JobRow>(),
    env.DB.prepare("SELECT * FROM jobs WHERE uid = ? AND type = 'sync_entities' ORDER BY created_at DESC LIMIT 1").bind(uid).first<JobRow>(),
    env.DB.prepare("SELECT * FROM jobs WHERE uid = ? AND type = 'sync_services' ORDER BY created_at DESC LIMIT 1").bind(uid).first<JobRow>(),
  ]);
  return json({
    ok: true,
    worker: "OK",
    d1: "OK",
    user,
    bridge: bridge ? { ...bridge, connected: typeof bridge.last_seen === "number" && Date.now() - bridge.last_seen <= CONNECTED_WINDOW_MS } : null,
    last_job: job ? publicJob(job) : null,
    last_action: actionJob ? publicJob(actionJob) : null,
    sync: {
      entities: entitySync ? publicJob(entitySync) : null,
      services: serviceSync ? publicJob(serviceSync) : null,
    },
  });
}

export async function handleApiRoute(request: Request, env: Env, url: URL): Promise<Response> {
  const session = await requireSession(request, env);
  if (!rateLimit(`${clientKey(request, "web")}:${session.uid}`, 240)) throw new HttpError(429, "Demasiadas peticiones");
  if (request.method !== "GET" && request.method !== "HEAD") await requireCsrf(request, session, env.APP_SECRET);
  const { pathname } = url;
  if (pathname === "/api/bootstrap" && request.method === "GET") return bootstrap(env, session.uid);
  if (pathname === "/api/entities" && request.method === "GET") return listEntities(url, env, session.uid);
  if (pathname === "/api/services" && request.method === "GET") return listServices(url, env, session.uid);
  if (pathname === "/api/diagnostics" && request.method === "GET") return diagnostics(env, session.uid);
  if (pathname === "/api/bridges" && request.method === "POST") return createBridge(request, env, session.uid);
  if (pathname === "/api/commands" && request.method === "POST") return saveCommand(request, env, session.uid);

  let match = /^\/api\/bridges\/(br_[A-Za-z0-9_-]+)\/(regenerate|toggle)$/.exec(pathname);
  if (match?.[1] && match[2] && request.method === "POST") return bridgeMutation(request, env, session.uid, match[1], match[2]);
  match = /^\/api\/bridges\/(br_[A-Za-z0-9_-]+)$/.exec(pathname);
  if (match?.[1] && request.method === "DELETE") return bridgeMutation(request, env, session.uid, match[1], "delete");

  match = /^\/api\/commands\/(cmd_[A-Za-z0-9_-]+)$/.exec(pathname);
  if (match?.[1] && request.method === "PUT") return saveCommand(request, env, session.uid, match[1]);
  if (match?.[1] && request.method === "DELETE") return commandOperation(request, env, session.uid, match[1], "delete");
  match = /^\/api\/commands\/(cmd_[A-Za-z0-9_-]+)\/(toggle|test)$/.exec(pathname);
  if (match?.[1] && match[2] && request.method === "POST") return commandOperation(request, env, session.uid, match[1], match[2]);

  match = /^\/api\/actions\/(test|test-home-assistant|sync|get-state)$/.exec(pathname);
  if (match?.[1] && request.method === "POST") return action(request, env, session.uid, match[1]);
  match = /^\/api\/jobs\/(job_[A-Za-z0-9_-]+)$/.exec(pathname);
  if (match?.[1] && request.method === "GET") return getJob(env, session.uid, match[1]);

  throw new HttpError(404, "Ruta API no encontrada");
}

export async function authenticatedPageSession(request: Request, env: Env): Promise<Session> {
  return requireSession(request, env);
}
