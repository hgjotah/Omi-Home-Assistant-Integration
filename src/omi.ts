import { randomId, sha256, timingSafeEqual } from "./crypto";
import { commandDistance, extractVoiceUnits, hasOmiPrefix, matchCommand, normalizeTranscript } from "./normalization";
import { HttpError, clientKey, isRecord, json, rateLimit, readJson } from "./http";
import type { CommandRow, Env, OmiSegment, VoiceUnit } from "./types";

const DEDUPE_WINDOW_MS = 8_000;
const ACCUMULATION_WINDOW_MS = 15_000;
const TRANSCRIPT_STATE_TTL_MS = 5 * 60_000;
const MAX_SEGMENTS = 100;
const MAX_TEXT_LENGTH = 2_000;
const MAX_ACCUMULATED_LENGTH = 180;

interface ExtractedTranscript {
  segments: OmiSegment[];
  text: string;
}

interface TranscriptStateRow {
  transcript: string;
  start: number | null;
  end: number | null;
  speaker: string | null;
  updated_at: number;
}

interface TranscriptChunk {
  text: string;
  first: OmiSegment;
  last: OmiSegment;
  speaker: string | null;
}

function validIdentifier(value: string | null, name: string, maxLength: number): string {
  if (!value || value.length > maxLength || !/^[A-Za-z0-9._:@-]+$/.test(value)) {
    throw new HttpError(400, `${name} no válido`);
  }
  return value;
}

function optionalIdentifier(value: string | null, name: string, maxLength: number): string | null {
  if (value === null || value === "") return null;
  return validIdentifier(value, name, maxLength);
}

function textValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= MAX_TEXT_LENGTH ? text : null;
}

function segmentFromRecord(raw: Record<string, unknown>): OmiSegment | null {
  const text = textValue(raw.text) ?? textValue(raw.transcript);
  if (!text) return null;
  const segment: OmiSegment = { text };
  if (typeof raw.speaker === "string" && raw.speaker.length <= 100) segment.speaker = raw.speaker;
  if (typeof raw.speakerId === "number" && Number.isInteger(raw.speakerId)) segment.speakerId = raw.speakerId;
  if (typeof raw.speaker_id === "number" && Number.isInteger(raw.speaker_id)) segment.speakerId = raw.speaker_id;
  if (typeof raw.is_user === "boolean") segment.is_user = raw.is_user;
  if (typeof raw.start === "number" && Number.isFinite(raw.start) && raw.start >= 0) segment.start = raw.start;
  if (typeof raw.end === "number" && Number.isFinite(raw.end) && raw.end >= 0) segment.end = raw.end;
  return segment;
}

function segmentsFromWords(value: unknown): OmiSegment[] {
  if (!Array.isArray(value) || value.length > MAX_SEGMENTS) return [];
  const words: string[] = [];
  let start: number | undefined;
  let end: number | undefined;
  let speaker: string | undefined;
  for (const raw of value) {
    const word = typeof raw === "string"
      ? textValue(raw)
      : isRecord(raw)
        ? textValue(raw.word) ?? textValue(raw.text)
        : null;
    if (!word) continue;
    words.push(word);
    if (isRecord(raw)) {
      if (start === undefined && typeof raw.start === "number" && Number.isFinite(raw.start) && raw.start >= 0) start = raw.start;
      if (typeof raw.end === "number" && Number.isFinite(raw.end) && raw.end >= 0) end = raw.end;
      if (!speaker && typeof raw.speaker === "string" && raw.speaker.length <= 100) speaker = raw.speaker;
    }
  }
  const text = words.join(" ").trim();
  if (!text || text.length > MAX_TEXT_LENGTH) return [];
  return [{ text, ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }), ...(speaker ? { speaker } : {}) }];
}

function segmentsFromArray(value: unknown): OmiSegment[] {
  if (!Array.isArray(value) || value.length > MAX_SEGMENTS) return [];
  const segments: OmiSegment[] = [];
  for (const raw of value) {
    if (typeof raw === "string") {
      const text = textValue(raw);
      if (text) segments.push({ text });
      continue;
    }
    if (!isRecord(raw)) continue;
    const segment = segmentFromRecord(raw);
    if (segment) {
      segments.push(segment);
      continue;
    }
    segments.push(...segmentsFromWords(raw.words));
  }
  return segments;
}

/**
 * Extracts only known transcript shapes. Omi's native segment array remains
 * the primary format; wrappers used by webhook/STT providers are accepted too.
 */
export function extractTranscriptText(payload: unknown): ExtractedTranscript | null {
  const directText = textValue(payload);
  let segments = directText ? [{ text: directText }] : segmentsFromArray(payload);

  if (!segments.length && isRecord(payload)) {
    const directSegment = segmentFromRecord(payload);
    if (directSegment) segments = [directSegment];

    const containers: unknown[] = [payload.segments, payload.words];
    for (const key of ["transcript", "data", "result", "event"] as const) {
      const nested = payload[key];
      const nestedText = textValue(nested);
      if (nestedText) containers.push(nestedText);
      if (isRecord(nested)) {
        containers.push(nested.segments, nested.words, nested.text, nested.transcript);
      }
    }

    for (const container of containers) {
      const text = textValue(container);
      if (text) {
        segments = [{ text }];
        break;
      }
      const fromSegments = segmentsFromArray(container);
      if (fromSegments.length) {
        segments = fromSegments;
        break;
      }
      const fromWords = segmentsFromWords(container);
      if (fromWords.length) {
        segments = fromWords;
        break;
      }
    }
  }

  if (!segments.length) return null;
  const text = segments.slice(-8).map((segment) => segment.text.trim()).filter(Boolean).join(" ").trim();
  return text ? { segments, text } : null;
}

function payloadSessionId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  for (const key of ["session_id", "sessionId", "conversation_id", "conversationId"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.length <= 200 && /^[A-Za-z0-9._:@-]+$/.test(value)) return value;
  }
  for (const key of ["data", "event", "transcript"] as const) {
    const nested = payload[key];
    if (!isRecord(nested)) continue;
    const found = payloadSessionId(nested);
    if (found) return found;
  }
  return null;
}

function payloadForLog(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, MAX_SEGMENTS).map((item) => payloadForLog(item, depth + 1));
  if (!isRecord(value)) return value;
  const safe: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    safe[key] = /token|secret|authorization|api[_-]?key/i.test(key) ? "[redacted]" : payloadForLog(item, depth + 1);
  }
  return safe;
}

function mergeIncrementalTranscript(previous: string, incoming: string): string {
  const left = normalizeTranscript(previous);
  const right = normalizeTranscript(incoming);
  if (!left) return right;
  if (!right || left === right || left.startsWith(`${right} `)) return left;
  if (right.startsWith(`${left} `)) return right;
  if (hasOmiPrefix(right)) return right;

  const leftWords = left.split(" ");
  const rightWords = right.split(" ");
  let overlap = 0;
  const limit = Math.min(leftWords.length, rightWords.length);
  for (let size = limit; size > 0; size -= 1) {
    if (leftWords.slice(-size).join(" ") === rightWords.slice(0, size).join(" ")) {
      overlap = size;
      break;
    }
  }
  const merged = [...leftWords, ...rightWords.slice(overlap)].join(" ");
  return merged.length <= MAX_ACCUMULATED_LENGTH ? merged : right;
}

function speakerKey(segment: OmiSegment | undefined): string | null {
  if (!segment) return null;
  if (segment.speaker) return segment.speaker;
  return typeof segment.speakerId === "number" ? `id:${segment.speakerId}` : null;
}

function incrementalChunk(segments: OmiSegment[]): TranscriptChunk {
  const last = segments.at(-1)!;
  const selected = [last];
  const targetSpeaker = speakerKey(last);
  for (let index = segments.length - 2; index >= Math.max(0, segments.length - 8); index -= 1) {
    const current = segments[index];
    const next = selected[0];
    if (!current || !next) break;
    const currentSpeaker = speakerKey(current);
    if (targetSpeaker && currentSpeaker && targetSpeaker !== currentSpeaker) break;
    if (typeof current.end === "number" && typeof next.start === "number" && next.start - current.end > 2) break;
    const candidate = `${current.text} ${selected.map((segment) => segment.text).join(" ")}`.trim();
    if (candidate.length > MAX_ACCUMULATED_LENGTH) break;
    selected.unshift(current);
  }
  const first = selected[0]!;
  return {
    text: selected.map((segment) => segment.text).join(" ").trim(),
    first,
    last,
    speaker: speakerKey(first),
  };
}

async function resolveSessionKey(env: Env, uid: string, suppliedSessionId: string | null, now: number): Promise<string> {
  if (suppliedSessionId) return suppliedSessionId;
  const recent = await env.DB.prepare(
    "SELECT session_key FROM omi_transcript_state WHERE uid = ? AND session_key LIKE 'auto:%' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 1",
  ).bind(uid, now - ACCUMULATION_WINDOW_MS).first<{ session_key: string }>();
  if (recent?.session_key) return recent.session_key;
  return `auto:${await sha256(`${uid}|${Math.floor(now / ACCUMULATION_WINDOW_MS)}`)}`;
}

async function accumulateTranscript(
  env: Env,
  uid: string,
  sessionKey: string,
  extracted: ExtractedTranscript,
  now: number,
): Promise<VoiceUnit> {
  const state = await env.DB.prepare(
    "SELECT transcript, start, end, speaker, updated_at FROM omi_transcript_state WHERE uid = ? AND session_key = ? LIMIT 1",
  ).bind(uid, sessionKey).first<TranscriptStateRow>();
  const chunk = incrementalChunk(extracted.segments);
  const recentState = state && state.updated_at >= now - ACCUMULATION_WINDOW_MS ? state : null;
  const active = recentState && (!recentState.speaker || !chunk.speaker || recentState.speaker === chunk.speaker)
    ? recentState
    : null;
  const normalized = mergeIncrementalTranscript(active?.transcript ?? "", chunk.text);
  const start = active?.start ?? chunk.first.start ?? null;
  const end = chunk.last.end ?? active?.end ?? null;
  const speaker = active?.speaker ?? chunk.speaker;

  await env.DB.batch([
    env.DB.prepare("DELETE FROM omi_transcript_state WHERE updated_at < ?").bind(now - TRANSCRIPT_STATE_TTL_MS),
    env.DB.prepare(
      `INSERT INTO omi_transcript_state (uid, session_key, transcript, start, end, speaker, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uid, session_key) DO UPDATE SET
         transcript = excluded.transcript,
         start = excluded.start,
         end = excluded.end,
         speaker = excluded.speaker,
         updated_at = excluded.updated_at`,
    ).bind(uid, sessionKey, normalized, start, end, speaker, now),
  ]);

  return {
    text: normalized,
    normalized,
    ...(start === null ? {} : { start }),
    ...(end === null ? {} : { end }),
    ...(speaker ? { speaker } : {}),
  };
}

function uniqueVoiceUnits(extracted: ExtractedTranscript, accumulated: VoiceUnit): VoiceUnit[] {
  const units = [...extractVoiceUnits(extracted.segments), accumulated];
  const seen = new Set<string>();
  return units.filter((unit) => {
    const key = `${unit.normalized}|${unit.start ?? "none"}`;
    if (!hasOmiPrefix(unit.normalized) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function logMatches(units: VoiceUnit[], commands: CommandRow[]): void {
  for (const unit of units) {
    for (const command of commands) {
      const matched = commandDistance(unit.normalized, command.normalized_phrase) <= 1;
      console.log("[OMI MATCH]", {
        heard: unit.normalized,
        checking: command.normalized_phrase,
        matched,
        ...(matched ? { command_id: command.id } : { reason: "distance_exceeds_tolerance" }),
      });
    }
  }
}

export async function handleOmiWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "Método no permitido");
  if (!rateLimit(clientKey(request, "omi"), 180)) throw new HttpError(429, "Demasiadas peticiones");
  const url = new URL(request.url);
  const uid = validIdentifier(url.searchParams.get("uid"), "uid", 160);
  const querySessionId = optionalIdentifier(url.searchParams.get("session_id"), "session_id", 200);
  const supplied = url.searchParams.get("token") ?? request.headers.get("x-omi-webhook-token") ?? "";
  if (!timingSafeEqual(supplied, env.OMI_WEBHOOK_TOKEN)) throw new HttpError(401, "Token de webhook no válido");

  const payload = await readJson<unknown>(request, 65_536);
  const suppliedSessionId = querySessionId ?? payloadSessionId(payload);
  console.log("[OMI WEBHOOK] received", {
    uid,
    session_id: suppliedSessionId ?? "none",
    payload: payloadForLog(payload),
  });

  const extracted = extractTranscriptText(payload);
  if (!extracted) {
    console.log("[OMI WEBHOOK] ignored: no transcript text found", { uid, session_id: suppliedSessionId ?? "none" });
    return json({ ok: true, matched: false, reason: "no_transcript" });
  }
  console.log("[OMI TRANSCRIPT]", { raw: extracted.text, normalized: normalizeTranscript(extracted.text) });

  const now = Date.now();
  const user = await env.DB.prepare("SELECT uid FROM users WHERE uid = ? LIMIT 1").bind(uid).first<{ uid: string }>();
  if (!user) return json({ ok: true, matched: false, reason: "unknown_uid" });

  // Persistent diagnostics are deliberately throttled to avoid a D1 write per incremental transcript.
  await env.DB.prepare(
    "UPDATE users SET last_webhook_at = ?, updated_at = ? WHERE uid = ? AND (last_webhook_at IS NULL OR last_webhook_at < ?)",
  )
    .bind(now, now, uid, now - 30_000)
    .run();

  const commands = await env.DB.prepare("SELECT * FROM commands WHERE uid = ? AND enabled = 1")
    .bind(uid)
    .all<CommandRow>();
  if (!commands.results.length) return json({ ok: true, matched: false, reason: "no_commands" });

  const sessionKey = await resolveSessionKey(env, uid, suppliedSessionId, now);
  const accumulated = await accumulateTranscript(env, uid, sessionKey, extracted, now);
  const units = uniqueVoiceUnits(extracted, accumulated);
  logMatches(units, commands.results);
  const matched = matchCommand(units, commands.results);
  if (!matched) {
    if (units.length) console.log("[OMI MATCH]", { heard: accumulated.normalized, matched: false, reason: "no_command_match" });
    return json({ ok: true, matched: false, reason: "no_command_match" });
  }

  const bridge = await env.DB.prepare(
    "SELECT bridge_id FROM bridges WHERE uid = ? AND enabled = 1 ORDER BY CASE WHEN last_seen IS NULL THEN 1 ELSE 0 END, last_seen DESC, created_at DESC LIMIT 1",
  )
    .bind(uid)
    .first<{ bridge_id: string }>();
  if (!bridge) return json({ ok: true, matched: true, queued: false, reason: "no_bridge" });

  const transcriptSignature = await sha256(matched.unit.normalized);
  const hasStableUtteranceTiming = suppliedSessionId !== null && matched.unit.start !== undefined;
  const timingPart = hasStableUtteranceTiming
    ? `session:${sessionKey}:start:${Math.round(matched.unit.start! * 4) / 4}:${matched.unit.speaker ?? "unknown"}`
    : `bucket:${Math.floor(now / DEDUPE_WINDOW_MS)}`;
  // A real session plus a segment start identifies intentional repetitions.
  // Without either value, a short time window suppresses duplicate deliveries.
  const dedupeSince = hasStableUtteranceTiming ? now + 1 : now - DEDUPE_WINDOW_MS;
  const utteranceKey = await sha256(`${uid}|${matched.command.id}|${timingPart}`);
  const executionId = randomId("exe");
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO executions
      (id, uid, command_id, session_id, transcript_signature, utterance_key, executed_at)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM executions
       WHERE uid = ? AND command_id = ? AND transcript_signature = ? AND executed_at >= ?
     )`,
  )
    .bind(
      executionId,
      uid,
      matched.command.id,
      sessionKey,
      transcriptSignature,
      utteranceKey,
      now,
      uid,
      matched.command.id,
      transcriptSignature,
      dedupeSince,
    )
    .run();

  await env.DB.prepare("DELETE FROM omi_transcript_state WHERE uid = ? AND session_key = ?")
    .bind(uid, sessionKey)
    .run();

  if ((inserted.meta.changes ?? 0) !== 1) {
    console.log("[OMI COMMAND] duplicate suppressed", {
      command_id: matched.command.id,
      entity_id: matched.command.entity_id,
      service: matched.command.service,
    });
    return json({ ok: true, matched: true, queued: false, deduplicated: true, reason: "duplicate" });
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

  console.log("[OMI COMMAND]", {
    matched_command: matched.command.normalized_phrase,
    command_id: matched.command.id,
    job_id: jobId,
    entity_id: matched.command.entity_id,
    service: matched.command.service,
  });
  return json({ ok: true, matched: true, queued: true, job_id: jobId });
}
