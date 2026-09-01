import type { BridgeRow, Env, JobRow, JobType } from "./types";
import { randomId } from "./crypto";
import { HttpError } from "./http";

export const JOB_MAX_AGE_MS = 5 * 60_000;
export const CLAIM_RETRY_MS = 45_000;
export const CONNECTED_WINDOW_MS = 75_000;
export const HEARTBEAT_PERSIST_MS = 45_000;

export async function ensureUser(env: Env, uid: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO users (uid, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET updated_at = excluded.updated_at",
  )
    .bind(uid, now, now)
    .run();
}

export async function selectBridgeForUser(env: Env, uid: string): Promise<BridgeRow> {
  const bridge = await env.DB.prepare(
    "SELECT * FROM bridges WHERE uid = ? AND enabled = 1 ORDER BY CASE WHEN last_seen IS NULL THEN 1 ELSE 0 END, last_seen DESC, created_at DESC LIMIT 1",
  )
    .bind(uid)
    .first<BridgeRow>();
  if (!bridge) throw new HttpError(409, "Primero crea y conecta un bridge ESP32");
  return bridge;
}

export async function createJob(
  env: Env,
  uid: string,
  bridgeId: string,
  type: JobType,
  payload: Record<string, unknown> = {},
): Promise<string> {
  const id = randomId("job");
  await env.DB.prepare(
    "INSERT INTO jobs (id, uid, bridge_id, type, payload, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
  )
    .bind(id, uid, bridgeId, type, JSON.stringify(payload), Date.now())
    .run();
  return id;
}

export async function claimNextJob(env: Env, bridge: BridgeRow): Promise<JobRow | null> {
  const now = Date.now();
  const candidate = await env.DB.prepare(
    `SELECT * FROM jobs
     WHERE bridge_id = ?
       AND created_at >= ?
       AND (status = 'pending' OR (status = 'claimed' AND claimed_at < ?))
     ORDER BY created_at ASC LIMIT 1`,
  )
    .bind(bridge.bridge_id, now - JOB_MAX_AGE_MS, now - CLAIM_RETRY_MS)
    .first<JobRow>();
  if (!candidate) return null;
  return env.DB.prepare(
    `UPDATE jobs SET status = 'claimed', claimed_at = ?
     WHERE id = ? AND bridge_id = ? AND created_at >= ?
       AND (status = 'pending' OR (status = 'claimed' AND claimed_at < ?))
     RETURNING *`,
  )
    .bind(now, candidate.id, bridge.bridge_id, now - JOB_MAX_AGE_MS, now - CLAIM_RETRY_MS)
    .first<JobRow>();
}

export async function persistHeartbeat(
  env: Env,
  bridge: BridgeRow,
  heartbeat: { firmware: string | null; ip: string | null; rssi: number | null; haOk: boolean | null },
): Promise<boolean> {
  const now = Date.now();
  if (bridge.last_persisted_heartbeat !== null && now - bridge.last_persisted_heartbeat < HEARTBEAT_PERSIST_MS) {
    return false;
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE bridges SET last_seen = ?, last_persisted_heartbeat = ?, firmware_version = ?, ip = ?, rssi = ?, ha_ok = ?, updated_at = ?
       WHERE bridge_id = ?`,
    ).bind(now, now, heartbeat.firmware, heartbeat.ip, heartbeat.rssi, heartbeat.haOk === null ? null : Number(heartbeat.haOk), now, bridge.bridge_id),
    env.DB.prepare(
      "UPDATE jobs SET status = 'expired', completed_at = ?, error = 'El trabajo superó su plazo máximo' WHERE bridge_id = ? AND status IN ('pending', 'claimed') AND created_at < ?",
    ).bind(now, bridge.bridge_id, now - JOB_MAX_AGE_MS),
    env.DB.prepare(
      `UPDATE users SET setup_completed = CASE
         WHEN ? = 1 AND EXISTS (SELECT 1 FROM bridges b WHERE b.uid = users.uid AND b.enabled = 1 AND b.last_seen IS NOT NULL) THEN 1
         ELSE setup_completed END, updated_at = ? WHERE uid = ?`,
    ).bind(heartbeat.haOk === true ? 1 : 0, now, bridge.uid),
  ]);
  return true;
}

export function publicJob(job: JobRow): Record<string, unknown> {
  let payload: unknown;
  let result: unknown;
  try { payload = JSON.parse(job.payload); } catch { payload = {}; }
  try { result = job.result ? JSON.parse(job.result) : null; } catch { result = job.result; }
  const status = job.status === "pending" && Date.now() - job.created_at > JOB_MAX_AGE_MS ? "expired" : job.status;
  return {
    id: job.id,
    type: job.type,
    payload,
    status,
    created_at: job.created_at,
    claimed_at: job.claimed_at,
    completed_at: job.completed_at,
    result,
    error: job.error,
  };
}
