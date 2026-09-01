import { authenticateBridge } from "./auth";
import { claimNextJob, persistHeartbeat, publicJob } from "./database";
import { HttpError, cleanText, isRecord, json, optionalText, readJson } from "./http";
import type { BridgeRow, Env, JobRow, JobType } from "./types";

const SYNC_CHUNK_LIMIT = 100;
const ENTITY_SYNC_BODY_LIMIT = 1_048_576;

interface HeartbeatBody {
  firmware?: unknown;
  ip?: unknown;
  rssi?: unknown;
  ha_ok?: unknown;
}

function integerOrNull(value: unknown, min: number, max: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, "Valor numérico no válido");
  }
  return value;
}

function booleanOrNull(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new HttpError(400, "ha_ok debe ser boolean");
  return value;
}

export async function bridgeNext(request: Request, env: Env): Promise<Response> {
  const bridge = await authenticateBridge(request, env);
  const body = await readJson<HeartbeatBody>(request, 2_048);
  const heartbeat = {
    firmware: optionalText(body.firmware, "firmware", 40),
    ip: optionalText(body.ip, "ip", 64),
    rssi: integerOrNull(body.rssi, -127, 0),
    haOk: booleanOrNull(body.ha_ok),
  };
  await persistHeartbeat(env, bridge, heartbeat);
  const job = await claimNextJob(env, bridge);
  if (!job) return json({ ok: true, job: null });
  let payload: unknown;
  try { payload = JSON.parse(job.payload); } catch { payload = {}; }
  return json({ ok: true, job: { id: job.id, type: job.type, payload } });
}

interface ResultBody {
  job_id?: unknown;
  success?: unknown;
  message?: unknown;
  upstream_http_code?: unknown;
  state?: unknown;
  previous_state?: unknown;
}

export async function bridgeResult(request: Request, env: Env): Promise<Response> {
  const bridge = await authenticateBridge(request, env);
  const body = await readJson<ResultBody>(request, 8_192);
  const jobId = cleanText(body.job_id, "job_id", 100);
  if (typeof body.success !== "boolean") throw new HttpError(400, "success debe ser boolean");
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND bridge_id = ? AND uid = ? LIMIT 1")
    .bind(jobId, bridge.bridge_id, bridge.uid)
    .first<JobRow>();
  if (!job) throw new HttpError(404, "Trabajo no encontrado para este bridge");
  if (["completed", "failed", "expired"].includes(job.status)) {
    return json({ ok: true, job: publicJob(job), duplicate: true });
  }
  const message = optionalText(body.message, "message", 1_000);
  const upstreamCode = integerOrNull(body.upstream_http_code, 0, 599);
  const state = optionalText(body.state, "state", 500);
  const previousState = optionalText(body.previous_state, "previous_state", 500);
  const result = JSON.stringify({ message, upstream_http_code: upstreamCode, state, previous_state: previousState });
  const now = Date.now();
  const status = body.success ? "completed" : "failed";
  const error = body.success ? null : (message ?? "El bridge indicó un error");
  const updated = await env.DB.prepare(
    `UPDATE jobs SET status = ?, completed_at = ?, result = ?, error = ?
     WHERE id = ? AND bridge_id = ? AND uid = ? AND status IN ('pending', 'claimed') RETURNING *`,
  )
    .bind(status, now, result, error, jobId, bridge.bridge_id, bridge.uid)
    .first<JobRow>();
  if (!updated) throw new HttpError(409, "El trabajo ya no se puede actualizar");

  if (job.type === "test_home_assistant") {
    await env.DB.batch([
      env.DB.prepare("UPDATE bridges SET ha_ok = ?, updated_at = ? WHERE bridge_id = ?")
        .bind(body.success ? 1 : 0, now, bridge.bridge_id),
      env.DB.prepare(
        "UPDATE users SET setup_completed = CASE WHEN ? = 1 THEN 1 ELSE setup_completed END, updated_at = ? WHERE uid = ?",
      ).bind(body.success ? 1 : 0, now, bridge.uid),
    ]);
  }
  if (!body.success) {
    const failureStatements = [
      env.DB.prepare("UPDATE users SET last_error = ?, updated_at = ? WHERE uid = ?").bind(error, now, bridge.uid),
    ];
    if (job.type === "sync_entities") {
      failureStatements.push(env.DB.prepare("DELETE FROM entity_sync_items WHERE job_id = ? AND uid = ?").bind(jobId, bridge.uid));
    } else if (job.type === "sync_services") {
      failureStatements.push(env.DB.prepare("DELETE FROM service_sync_items WHERE job_id = ? AND uid = ?").bind(jobId, bridge.uid));
    }
    await env.DB.batch(failureStatements);
  }
  return json({ ok: true, job: publicJob(updated) });
}

async function requireSyncJob(env: Env, bridge: BridgeRow, jobId: string, type: JobType): Promise<JobRow> {
  const job = await env.DB.prepare(
    "SELECT * FROM jobs WHERE id = ? AND bridge_id = ? AND uid = ? AND type = ? AND status = 'claimed' LIMIT 1",
  )
    .bind(jobId, bridge.bridge_id, bridge.uid, type)
    .first<JobRow>();
  if (!job) throw new HttpError(404, "Sincronización no encontrada o no reclamada por este bridge");
  return job;
}

async function syncStart(request: Request, env: Env, kind: "entities" | "services"): Promise<Response> {
  const bridge = await authenticateBridge(request, env);
  const body = await readJson<{ job_id?: unknown }>(request, 2_048);
  const jobId = cleanText(body.job_id, "job_id", 100);
  await requireSyncJob(env, bridge, jobId, kind === "entities" ? "sync_entities" : "sync_services");
  const table = kind === "entities" ? "entity_sync_items" : "service_sync_items";
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM ${table} WHERE job_id = ? AND uid = ?`).bind(jobId, bridge.uid),
    env.DB.prepare(
      `DELETE FROM ${table} WHERE uid = ? AND job_id IN (
         SELECT id FROM jobs WHERE uid = ? AND status IN ('failed', 'expired')
       )`,
    ).bind(bridge.uid, bridge.uid),
  ]);
  return json({ ok: true });
}

interface SanitizedEntity {
  entityId: string;
  domain: string;
  state: string;
  friendlyName: string;
  icon: string | null;
}

function entityLogId(raw: unknown): string {
  if (!isRecord(raw) || typeof raw.entity_id !== "string") return "unknown";
  const value = raw.entity_id.trim().replace(/[\r\n\t]/g, " ");
  return value ? value.slice(0, 255) : "unknown";
}

function skipEntity(raw: unknown, reason: string): null {
  console.warn("[ENTITY SYNC] Skipped entity", { entity_id: entityLogId(raw), reason });
  return null;
}

function tolerantState(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean") return String(value).slice(0, 500);
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" && encoded.length > 0 ? encoded.slice(0, 500) : "unknown";
  } catch {
    return "unknown";
  }
}

function sanitizeEntity(raw: unknown): SanitizedEntity | null {
  if (!isRecord(raw)) return skipEntity(raw, "item is not an object");
  if (typeof raw.entity_id !== "string") return skipEntity(raw, "entity_id is missing or is not a string");
  const entityId = raw.entity_id.trim().toLowerCase();
  if (!entityId) return skipEntity(raw, "entity_id is empty");
  if (entityId.length > 255 || !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(entityId)) {
    return skipEntity(raw, "entity_id has an invalid Home Assistant format");
  }

  const friendlyCandidate = typeof raw.friendly_name === "string" ? raw.friendly_name.trim() : "";
  return {
    entityId,
    domain: entityId.slice(0, entityId.indexOf(".")),
    state: tolerantState(raw.state),
    friendlyName: (friendlyCandidate || entityId).slice(0, 255),
    icon: typeof raw.icon === "string" ? raw.icon.slice(0, 255) : null,
  };
}

async function entityChunk(request: Request, env: Env): Promise<Response> {
  const bridge = await authenticateBridge(request, env);
  const body = await readJson<{ job_id?: unknown; items?: unknown }>(request, ENTITY_SYNC_BODY_LIMIT);
  const jobId = cleanText(body.job_id, "job_id", 100);
  await requireSyncJob(env, bridge, jobId, "sync_entities");
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > SYNC_CHUNK_LIMIT) {
    throw new HttpError(400, `items debe contener entre 1 y ${SYNC_CHUNK_LIMIT} entidades`);
  }
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const raw of body.items) {
    const item = sanitizeEntity(raw);
    if (!item) continue;
    statements.push(env.DB.prepare(
      `INSERT INTO entity_sync_items (job_id, uid, entity_id, domain, friendly_name, state, icon, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, entity_id) DO UPDATE SET domain = excluded.domain, friendly_name = excluded.friendly_name,
         state = excluded.state, icon = excluded.icon, updated_at = excluded.updated_at`,
    ).bind(jobId, bridge.uid, item.entityId, item.domain, item.friendlyName, item.state, item.icon, now));
  }
  if (statements.length > 0) await env.DB.batch(statements);
  return json({
    ok: true,
    received: body.items.length,
    accepted: statements.length,
    skipped: body.items.length - statements.length,
  });
}

interface ServiceItem {
  domain?: unknown;
  service?: unknown;
  name?: unknown;
  description?: unknown;
  fields?: unknown;
}

async function serviceChunk(request: Request, env: Env): Promise<Response> {
  const bridge = await authenticateBridge(request, env);
  const body = await readJson<{ job_id?: unknown; items?: unknown }>(request, 65_536);
  const jobId = cleanText(body.job_id, "job_id", 100);
  await requireSyncJob(env, bridge, jobId, "sync_services");
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > SYNC_CHUNK_LIMIT) {
    throw new HttpError(400, `items debe contener entre 1 y ${SYNC_CHUNK_LIMIT} acciones`);
  }
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const raw of body.items) {
    if (!isRecord(raw)) throw new HttpError(400, "Acción no válida");
    const item = raw as ServiceItem;
    const domain = cleanText(item.domain, "domain", 80).toLowerCase();
    const service = cleanText(item.service, "service", 100).toLowerCase();
    if (!/^[a-z0-9_]+$/.test(domain) || !/^[a-z0-9_]+$/.test(service)) {
      throw new HttpError(400, "domain/service no válidos");
    }
    const name = cleanText(item.name ?? service, "name", 255);
    const description = typeof item.description === "string" ? item.description.slice(0, 2_000) : "";
    const fields = isRecord(item.fields) ? item.fields : {};
    const fieldsJson = JSON.stringify(fields);
    if (fieldsJson.length > 16_384) throw new HttpError(400, "fields es demasiado grande");
    statements.push(env.DB.prepare(
      `INSERT INTO service_sync_items (job_id, uid, domain, service, name, description, fields_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, domain, service) DO UPDATE SET name = excluded.name, description = excluded.description,
         fields_json = excluded.fields_json, updated_at = excluded.updated_at`,
    ).bind(jobId, bridge.uid, domain, service, name, description, fieldsJson, now));
  }
  await env.DB.batch(statements);
  return json({ ok: true, accepted: statements.length });
}

async function syncComplete(request: Request, env: Env, kind: "entities" | "services"): Promise<Response> {
  const bridge = await authenticateBridge(request, env);
  const body = await readJson<{ job_id?: unknown; count?: unknown }>(request, 2_048);
  const jobId = cleanText(body.job_id, "job_id", 100);
  const count = integerOrNull(body.count, 0, 100_000);
  if (count === null) throw new HttpError(400, "count es obligatorio");
  const type = kind === "entities" ? "sync_entities" : "sync_services";
  await requireSyncJob(env, bridge, jobId, type);
  const staging = kind === "entities" ? "entity_sync_items" : "service_sync_items";
  const counted = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${staging} WHERE job_id = ? AND uid = ?`)
    .bind(jobId, bridge.uid)
    .first<{ count: number }>();
  const synced = counted?.count ?? 0;
  if (kind === "services" && synced !== count) {
    throw new HttpError(409, `Sincronización incompleta: se anunciaron ${count} y llegaron ${counted?.count ?? 0}`);
  }
  if (kind === "entities" && count > 0 && synced === 0) {
    throw new HttpError(422, "No se aceptó ninguna entidad; se conserva la caché anterior");
  }
  const skipped = kind === "entities" ? Math.max(0, count - synced) : 0;
  const now = Date.now();
  const result = kind === "entities"
    ? { synced, skipped, received: count }
    : { count: synced, synced, skipped: 0, received: count };
  const statements = kind === "entities"
    ? [
        env.DB.prepare("DELETE FROM entity_cache WHERE uid = ?").bind(bridge.uid),
        env.DB.prepare(
          "INSERT INTO entity_cache (uid, entity_id, domain, friendly_name, state, icon, updated_at) SELECT uid, entity_id, domain, friendly_name, state, icon, ? FROM entity_sync_items WHERE job_id = ? AND uid = ?",
        ).bind(now, jobId, bridge.uid),
        env.DB.prepare("DELETE FROM entity_sync_items WHERE job_id = ? AND uid = ?").bind(jobId, bridge.uid),
      ]
    : [
        env.DB.prepare("DELETE FROM service_cache WHERE uid = ?").bind(bridge.uid),
        env.DB.prepare(
          "INSERT INTO service_cache (uid, domain, service, name, description, fields_json, updated_at) SELECT uid, domain, service, name, description, fields_json, ? FROM service_sync_items WHERE job_id = ? AND uid = ?",
        ).bind(now, jobId, bridge.uid),
        env.DB.prepare("DELETE FROM service_sync_items WHERE job_id = ? AND uid = ?").bind(jobId, bridge.uid),
      ];
  statements.push(
    env.DB.prepare(
      "UPDATE jobs SET status = 'completed', completed_at = ?, result = ?, error = NULL WHERE id = ? AND bridge_id = ? AND uid = ? AND status = 'claimed'",
    ).bind(now, JSON.stringify(result), jobId, bridge.bridge_id, bridge.uid),
  );
  await env.DB.batch(statements);
  return json({ ok: true, ...result });
}

export async function handleBridgeRoute(request: Request, env: Env, pathname: string): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "Método no permitido");
  switch (pathname) {
    case "/api/bridge/next": return bridgeNext(request, env);
    case "/api/bridge/result": return bridgeResult(request, env);
    case "/api/bridge/sync/entities/start": return syncStart(request, env, "entities");
    case "/api/bridge/sync/entities/chunk": return entityChunk(request, env);
    case "/api/bridge/sync/entities/complete": return syncComplete(request, env, "entities");
    case "/api/bridge/sync/services/start": return syncStart(request, env, "services");
    case "/api/bridge/sync/services/chunk": return serviceChunk(request, env);
    case "/api/bridge/sync/services/complete": return syncComplete(request, env, "services");
    default: throw new HttpError(404, "Ruta de bridge no encontrada");
  }
}
