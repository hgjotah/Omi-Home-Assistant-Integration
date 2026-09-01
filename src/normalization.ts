import type { CommandRow, OmiSegment, VoiceUnit } from "./types";

export function normalizeTranscript(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("es")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function hasOmiPrefix(normalized: string): boolean {
  return normalized === "omi" || normalized.startsWith("omi ");
}

function sameSpeaker(left: OmiSegment, right: OmiSegment): boolean {
  if (left.speaker && right.speaker) return left.speaker === right.speaker;
  if (typeof left.speakerId === "number" && typeof right.speakerId === "number") {
    return left.speakerId === right.speakerId;
  }
  return true;
}

/**
 * Builds only short, current voice units that start with Omi. It never scans a
 * persisted/full conversation and never uses is_user as authorization.
 */
export function extractVoiceUnits(segments: OmiSegment[]): VoiceUnit[] {
  const recent = segments.slice(-8);
  const units: VoiceUnit[] = [];
  for (let startIndex = 0; startIndex < recent.length; startIndex += 1) {
    const first = recent[startIndex];
    if (!first || typeof first.text !== "string") continue;
    let text = first.text.trim();
    let normalized = normalizeTranscript(text);
    if (!hasOmiPrefix(normalized)) continue;
    const start = Number.isFinite(first.start) ? first.start : undefined;
    let end = Number.isFinite(first.end) ? first.end : undefined;
    units.push({ text, normalized, ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }), ...(first.speaker ? { speaker: first.speaker } : {}) });

    for (let index = startIndex + 1; index < recent.length && index <= startIndex + 4; index += 1) {
      const current = recent[index];
      const previous = recent[index - 1];
      if (!current || !previous || !sameSpeaker(first, current)) break;
      if (typeof previous.end === "number" && typeof current.start === "number" && current.start - previous.end > 2) break;
      if (typeof start === "number" && typeof current.end === "number" && current.end - start > 12) break;
      if (text.length + current.text.length > 180) break;
      text = `${text} ${current.text}`.trim();
      normalized = normalizeTranscript(text);
      end = Number.isFinite(current.end) ? current.end : end;
      units.push({ text, normalized, ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }), ...(first.speaker ? { speaker: first.speaker } : {}) });
    }
  }
  return units;
}

function distanceAtMostOne(left: string, right: string): number {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > 1) return 2;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return 2;
    if (left.length > right.length) i += 1;
    else if (right.length > left.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  if (i < left.length || j < right.length) edits += 1;
  return edits;
}

export function commandDistance(candidate: string, configured: string): number {
  if (!hasOmiPrefix(candidate) || !hasOmiPrefix(configured)) return 2;
  if (candidate === configured) return 0;
  // One character of STT tolerance only for a substantial, whole utterance.
  if (candidate.length < 12 || configured.length < 12) return 2;
  return distanceAtMostOne(candidate, configured);
}

export function matchCommand(units: VoiceUnit[], commands: CommandRow[]): { command: CommandRow; unit: VoiceUnit } | null {
  let best: { command: CommandRow; unit: VoiceUnit; score: number } | null = null;
  for (const unit of units) {
    for (const command of commands) {
      if (command.enabled !== 1) continue;
      const score = commandDistance(unit.normalized, command.normalized_phrase);
      if (score > 1) continue;
      if (!best || score < best.score || (score === best.score && command.normalized_phrase.length > best.command.normalized_phrase.length)) {
        best = { command, unit, score };
      }
    }
  }
  return best ? { command: best.command, unit: best.unit } : null;
}
