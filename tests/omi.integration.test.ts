import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, call, createBridge, login, omi, seedCommand } from "./helpers";

describe("Omi Real-Time Transcript", () => {
  it("guarda y ejecuta una orden con una primera palabra personalizada", async () => {
    const user = await login("omi_custom_prefix");
    await createBridge(user);
    const saved = await api(user, "/api/commands", "POST", {
      phrase: "Jarvis enciende la luz",
      entity_id: "switch.sonoff_1001fccf20_1",
      entity_name: "Luz",
      domain: "switch",
      service: "turn_on",
      service_data: {},
      enabled: true,
    });
    expect(saved.status).toBe(201);
    const stored = await env.DB.prepare("SELECT phrase, normalized_phrase FROM commands WHERE uid = ?")
      .bind(user.uid)
      .first<{ phrase: string; normalized_phrase: string }>();
    expect(stored).toEqual({ phrase: "Jarvis enciende la luz", normalized_phrase: "jarvis enciende la luz" });

    const missingActivation = await omi(user.uid, "custom_prefix_missing", [{ text: "Omi enciende la luz" }]);
    expect(await missingActivation.json()).toEqual({ ok: true, matched: false, reason: "no_command_match" });
    const matched = await omi(user.uid, "custom_prefix_match", [{ text: "Jarvis, enciende la luz." }]);
    expect(await matched.json()).toMatchObject({ ok: true, matched: true, queued: true });
  });

  it("rechaza una frase que no contiene activación y acción", async () => {
    const user = await login("omi_invalid_custom_prefix");
    const response = await api(user, "/api/commands", "POST", {
      phrase: "Jarvis",
      entity_id: "light.habitacion",
      entity_name: "Luz",
      domain: "light",
      service: "turn_on",
      service_data: {},
      enabled: true,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "El comando debe incluir una palabra de activación y una acción" });
  });

  it("funciona sin session_id y devuelve el job creado", async () => {
    const user = await login("omi_without_session");
    await createBridge(user);
    await seedCommand(user.uid, {
      entity_id: "switch.sonoff_1001fccf20_1",
      entity_name: "Luz",
      domain: "switch",
      service: "turn_on",
    });

    const response = await omi(user.uid, null, [{ text: "Omi enciende la luz", is_user: false }]);
    expect(response.status).toBe(200);
    const result = await response.json<{ ok: boolean; matched: boolean; job_id?: string }>();
    expect(result).toMatchObject({ ok: true, matched: true });
    expect(result.job_id).toMatch(/^job_/);

    const job = await env.DB.prepare("SELECT type, payload FROM jobs WHERE id = ?")
      .bind(result.job_id)
      .first<{ type: string; payload: string }>();
    expect(job?.type).toBe("call_service");
    expect(JSON.parse(job?.payload ?? "{}")).toEqual({
      domain: "switch",
      service: "turn_on",
      entity_id: "switch.sonoff_1001fccf20_1",
      service_data: {},
    });
  });

  it("usa session_id cuando Omi lo incluye", async () => {
    const user = await login("omi_with_session");
    await createBridge(user);
    await seedCommand(user.uid);
    const response = await omi(user.uid, "real_session_123", [{ text: "Omi enciende la luz" }]);
    expect(await response.json()).toMatchObject({ ok: true, matched: true });
    const execution = await env.DB.prepare("SELECT session_id FROM executions WHERE uid = ? LIMIT 1")
      .bind(user.uid)
      .first<{ session_id: string }>();
    expect(execution?.session_id).toBe("real_session_123");
  });

  it("deduplica la transcripción incremental y no exige is_user", async () => {
    const user = await login("omi_incremental");
    await createBridge(user);
    await seedCommand(user.uid);

    await omi(user.uid, "session_incremental", [{ text: "Omi", is_user: false, speaker: "SPEAKER_01", start: 10, end: 10.2 }]);
    await omi(user.uid, "session_incremental", [{ text: "enciende", is_user: false, speaker: "SPEAKER_01", start: 10.3, end: 10.8 }]);
    await omi(user.uid, "session_incremental", [{ text: "la luz", is_user: false, speaker: "SPEAKER_01", start: 10.9, end: 11.4 }]);
    await omi(user.uid, "session_incremental", [{ text: "Omi enciende la luz", is_user: false, speaker: "SPEAKER_01", start: 10, end: 11.4 }]);

    const jobs = await env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE uid = ?").bind(user.uid).first<{ count: number }>();
    const executions = await env.DB.prepare("SELECT COUNT(*) AS count FROM executions WHERE uid = ?").bind(user.uid).first<{ count: number }>();
    expect(jobs?.count).toBe(1);
    expect(executions?.count).toBe(1);
  });

  it("deduplica un webhook repetido sin tiempos y sin session_id", async () => {
    const user = await login("omi_duplicate_without_session");
    await createBridge(user);
    await seedCommand(user.uid);
    const first = await omi(user.uid, null, { transcript: "Omi enciende la luz" });
    const second = await omi(user.uid, null, { transcript: "Omi enciende la luz" });
    expect(await first.json()).toMatchObject({ ok: true, matched: true });
    expect(await second.json()).toMatchObject({ ok: true, matched: true, deduplicated: true, reason: "duplicate" });
    const jobs = await env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE uid = ?").bind(user.uid).first<{ count: number }>();
    expect(jobs?.count).toBe(1);
  });

  it("acumula fragmentos incrementales aunque no haya session_id", async () => {
    const user = await login("omi_incremental_without_session");
    await createBridge(user);
    await seedCommand(user.uid);
    expect(await (await omi(user.uid, null, [{ text: "Omi" }])).json()).toEqual({
      ok: true, matched: false, reason: "no_command_match",
    });
    expect(await (await omi(user.uid, null, [{ text: "enciende" }])).json()).toEqual({
      ok: true, matched: false, reason: "no_command_match",
    });
    expect(await (await omi(user.uid, null, [{ text: "la luz" }])).json()).toMatchObject({ ok: true, matched: true });
    const jobs = await env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE uid = ?").bind(user.uid).first<{ count: number }>();
    expect(jobs?.count).toBe(1);
  });

  it("permite repetir intencionadamente la misma orden más tarde", async () => {
    const user = await login("omi_repeat");
    await createBridge(user);
    await seedCommand(user.uid);
    await omi(user.uid, "session_repeat", [{ text: "Omi enciende la luz", start: 10, end: 11 }]);
    await omi(user.uid, "session_repeat", [{ text: "Omi enciende la luz", start: 30, end: 31 }]);
    const jobs = await env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE uid = ?").bind(user.uid).first<{ count: number }>();
    expect(jobs?.count).toBe(2);
  });

  it("no activa sin Omi ni con una frase muy distinta", async () => {
    const user = await login("omi_disabled");
    await createBridge(user);
    await seedCommand(user.uid);
    const missingPrefix = await omi(user.uid, "session_disabled", [{ text: "enciende la luz", start: 4, end: 5 }]);
    const different = await omi(user.uid, "session_other", [{ text: "Omi por favor enciende todas las luces", start: 6, end: 8 }]);
    expect(await missingPrefix.json()).toEqual({ ok: true, matched: false, reason: "no_command_match" });
    expect(await different.json()).toEqual({ ok: true, matched: false, reason: "no_command_match" });
    const jobs = await env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE uid = ?").bind(user.uid).first<{ count: number }>();
    expect(jobs?.count).toBe(0);
  });

  it("no activa un comando desactivado", async () => {
    const user = await login("omi_disabled_command");
    await createBridge(user);
    await seedCommand(user.uid, { enabled: 0 });
    const response = await omi(user.uid, "session_disabled_command", [{ text: "Omi enciende la luz" }]);
    expect(await response.json()).toEqual({ ok: true, matched: false, reason: "no_commands" });
  });

  it("mantiene aislados a los usuarios", async () => {
    const a = await login("omi_isolated_a");
    const b = await login("omi_isolated_b");
    await createBridge(a);
    await createBridge(b);
    await seedCommand(a.uid, { id: "cmd_isolated_a" });
    await seedCommand(b.uid, { id: "cmd_isolated_b", entity_id: "light.otra", entity_name: "Otra" });
    await omi(a.uid, "session_a", [{ text: "Omi enciende la luz", start: 1, end: 2 }]);
    const counts = await env.DB.prepare("SELECT uid, COUNT(*) AS count FROM jobs GROUP BY uid ORDER BY uid").all();
    expect(counts.results).toEqual([{ uid: a.uid, count: 1 }]);
  });

  it("encola el service_data configurado sin consultar cachés", async () => {
    const user = await login("omi_service_data");
    await createBridge(user);
    await seedCommand(user.uid, { service_data: { brightness_pct: 30, transition: 1 } });
    const response = await omi(user.uid, "session_data", [{ text: "Omi, enciende la luz.", start: 1, end: 2 }]);
    expect(response.status).toBe(200);
    const job = await env.DB.prepare("SELECT payload FROM jobs WHERE uid = ? LIMIT 1").bind(user.uid).first<{ payload: string }>();
    expect(JSON.parse(job?.payload ?? "{}").service_data).toEqual({ brightness_pct: 30, transition: 1 });
  });

  it("acepta wrappers de segments y payloads basados en words", async () => {
    const wrapped = await login("omi_wrapped_segments");
    await createBridge(wrapped);
    await seedCommand(wrapped.uid);
    const wrappedResponse = await omi(wrapped.uid, null, {
      data: { segments: [{ text: "Omi," }, { text: "enciende la luz." }] },
    });
    expect(await wrappedResponse.json()).toMatchObject({ ok: true, matched: true });

    const words = await login("omi_words");
    await createBridge(words);
    await seedCommand(words.uid, { id: "cmd_words" });
    const wordsResponse = await omi(words.uid, null, {
      words: [{ word: "Omi" }, { word: "enciende" }, { word: "la" }, { word: "luz" }],
    });
    expect(await wordsResponse.json()).toMatchObject({ ok: true, matched: true });
  });

  it("responde de forma útil a un payload sin texto", async () => {
    const user = await login("omi_no_transcript");
    const response = await omi(user.uid, null, { segments: [], event: { type: "ping" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, matched: false, reason: "no_transcript" });
  });

  it("responde con JSON controlado a un payload JSON malformado", async () => {
    const user = await login("omi_malformed");
    const response = await call(`/webhook/omi?token=test-omi-webhook-token-32-bytes-long&uid=${user.uid}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ ok: false, error: "JSON no válido" });
  });

  it("requiere el token privado del webhook", async () => {
    const user = await login("omi_webhook_security");
    const missingToken = await call(`/webhook/omi?uid=${user.uid}&session_id=s1`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "[]",
    });
    expect(missingToken.status).toBe(401);
  });
});
