import { randomId, sha256, timingSafeEqual } from "./crypto";
import { extractVoiceUnits, matchCommand } from "./normalization";
import { HttpError, clientKey, isRecord, json, rateLimit, readJson } from "./http";
import type { CommandRow, Env, OmiSegment } from "./types";

const DEDUPE_WINDOW_MS = 8_000;

function validIdentifier(value: string | null, name: string, maxLength: number): string {
  if (!value || value.length > maxLength || !/^[A-Za-z0-9._:@-]+$/.test(value)) {
    throw new HttpError(400, `${name} no válido`);
  }
  return value;
}

function parseSegments(value: unknown): OmiSegment[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new HttpError(400, "Omi Real-Time Transcript debe enviar un array de segmentos");
  }
  return value.map((raw) => {
    if (!isRecord(raw) || typeof raw.text !== "string" || raw.text.length > 2_000) {
      throw new HttpError(400, "Segmento Omi no válido");
    }
    const segment: OmiSegment = { text: raw.text };
    if (typeof raw.speaker === "string" && raw.speaker.length <= 100) segment.speaker = raw.speaker;
    if (typeof raw.speakerId === "number" && Number.isInteger(raw.speakerId)) segment.speakerId = raw.speakerId;
    if (typeof raw.is_user === "boolean") segment.is_user = raw.is_user;
    if (typeof raw.start === "number" && Number.isFinite(raw.start) && raw.start >= 0) segment.start = raw.start;
    if (typeof raw.end === "number" && Number.isFinite(raw.end) && raw.end >= 0) segment.end = raw.end;
    return segment;
  });
}

export async function handleOmiWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "Método no permitido");
  if (!rateLimit(clientKey(request, "omi"), 180)) throw new HttpError(429, "Demasiadas peticiones");
  const url = new URL(request.url);
  const uid = validIdentifier(url.searchParams.get("uid"), "uid", 160);
  const sessionId = validIdentifier(url.searchParams.get("session_id"), "session_id", 200);
  const supplied = url.searchParams.get("token") ?? request.headers.get("x-omi-webhook-token") ?? "";
  if (!timingSafeEqual(supplied, env.OMI_WEBHOOK_TOKEN)) throw new HttpError(401, "Token de webhook no válido");
  const segments = parseSegments(await readJson<unknown>(request, 65_536));
  const now = Date.now();
  const user = await env.DB.prepare("SELECT uid FROM users WHERE uid = ? LIMIT 1").bind(uid).first<{ uid: string }>();
  if (!user) return json({ ok: true, matched: false });

  // Persistent diagnostics are deliberately throttled to avoid a D1 write per incremental transcript.
  await env.DB.prepare(
    "UPDATE users SET last_webhook_at = ?, updated_at = ? WHERE uid = ? AND (last_webhook_at IS NULL OR last_webhook_at < ?)",
  )
    .bind(now, now, uid, now - 30_000)
    .run();

  const commands = await env.DB.prepare("SELECT * FROM commands WHERE uid = ? AND enabled = 1")
    .bind(uid)
    .all<CommandRow>();
  if (!commands.results.length) return json({ ok: true, matched: false });
  const matched = matchCommand(extractVoiceUnits(segments), commands.results);
  if (!matched) return json({ ok: true, matched: false });

  const bridge = await env.DB.prepare(
    "SELECT bridge_id FROM bridges WHERE uid = ? AND enabled = 1 ORDER BY CASE WHEN last_seen IS NULL THEN 1 ELSE 0 END, last_seen DESC, created_at DESC LIMIT 1",
  )
    .bind(uid)
    .first<{ bridge_id: string }>();
  if (!bridge) return json({ ok: true, matched: true, queued: false });

  const transcriptSignature = await sha256(matched.unit.normalized);
  const timingPart = matched.unit.start === undefined
    ? `bucket:${Math.floor(now / DEDUPE_WINDOW_MS)}`
    : `start:${Math.round(matched.unit.start * 4) / 4}:${matched.unit.speaker ?? "unknown"}`;
  // With Omi timing, the unique stable start identifies the utterance and a
  // later start is an intentional repeat even if webhooks arrive back-to-back.
  const dedupeSince = matched.unit.start === undefined ? now - DEDUPE_WINDOW_MS : now + 1;
  const utteranceKey = await sha256(`${uid}|${sessionId}|${matched.command.id}|${timingPart}`);
  const executionId = randomId("exe");
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO executions
      (id, uid, command_id, session_id, transcript_signature, utterance_key, executed_at)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM executions
       WHERE uid = ? AND session_id = ? AND command_id = ? AND transcript_signature = ? AND executed_at >= ?
     )`,
  )
    .bind(
      executionId,
      uid,
      matched.command.id,
      sessionId,
      transcriptSignature,
      utteranceKey,
      now,
      uid,
      sessionId,
      matched.command.id,
      transcriptSignature,
      dedupeSince,
    )
    .run();
  if ((inserted.meta.changes ?? 0) !== 1) {
    return json({ ok: true, matched: true, queued: false, deduplicated: true });
  }

  const jobId = randomId("job");
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO jobs (id, uid, bridge_id, type, payload, status, created_at) VALUES (?, ?, ?, 'call_service', ?, 'pending', ?)",
      ).bind(jobId, uid, bridge.bridge_id, JSON.stringify({
        domain: matched.command.domain,
        service: matched.command.service,
        entity_id: matched.command.entity_id,
        service_data: JSON.parse(matched.command.service_data) as unknown,
      }), now),
      env.DB.prepare("UPDATE executions SET job_id = ? WHERE id = ? AND uid = ?").bind(jobId, executionId, uid),
    ]);
  } catch (error) {
    await env.DB.prepare("DELETE FROM executions WHERE id = ? AND job_id IS NULL").bind(executionId).run();
    throw error;
  }
  return json({ ok: true, matched: true, queued: true, job_id: jobId });
}
