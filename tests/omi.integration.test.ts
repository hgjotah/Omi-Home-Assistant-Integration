import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, createBridge, login, omi, seedCommand } from "./helpers";

describe("Omi Real-Time Transcript", () => {
  it("deduplica la transcripción incremental y no exige is_user", async () => {
    const user = await login("omi_incremental");
    await createBridge(user);
    await seedCommand(user.uid);

    await omi(user.uid, "session_incremental", [{ text: "Omi", is_user: false, speaker: "SPEAKER_01", start: 10, end: 10.2 }]);
    await omi(user.uid, "session_incremental", [{ text: "Omi enciende", is_user: false, speaker: "SPEAKER_01", start: 10, end: 10.8 }]);
    await omi(user.uid, "session_incremental", [{ text: "Omi enciende la luz", is_user: false, speaker: "SPEAKER_01", start: 10, end: 11.4 }]);
    await omi(user.uid, "session_incremental", [{ text: "Omi enciende la luz", is_user: false, speaker: "SPEAKER_01", start: 10, end: 11.4 }]);

    const jobs = await env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE uid = ?").bind(user.uid).first<{ count: number }>();
    const executions = await env.DB.prepare("SELECT COUNT(*) AS count FROM executions WHERE uid = ?").bind(user.uid).first<{ count: number }>();
    expect(jobs?.count).toBe(1);
    expect(executions?.count).toBe(1);
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

  it("no activa sin Omi, con una frase muy distinta ni con comando desactivado", async () => {
    const user = await login("omi_disabled");
    await createBridge(user);
    await seedCommand(user.uid, { enabled: 0 });
    await omi(user.uid, "session_disabled", [{ text: "Omi enciende la luz", start: 1, end: 2 }]);
    await omi(user.uid, "session_disabled", [{ text: "enciende la luz", start: 4, end: 5 }]);
    await omi(user.uid, "session_disabled", [{ text: "Creo que después voy a encender las luces", start: 6, end: 8 }]);
    const jobs = await env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE uid = ?").bind(user.uid).first<{ count: number }>();
    expect(jobs?.count).toBe(0);
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

  it("requiere el token opcional de app privada y el payload oficial array", async () => {
    const user = await login("omi_webhook_security");
    const missingToken = await call(`/webhook/omi?uid=${user.uid}&session_id=s1`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "[]",
    });
    expect(missingToken.status).toBe(401);
    const wrongShape = await call(`/webhook/omi?token=test-omi-webhook-token-32-bytes-long&uid=${user.uid}&session_id=s1`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ segments: [] }),
    });
    expect(wrongShape.status).toBe(400);
  });
});
