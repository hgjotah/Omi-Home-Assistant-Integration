import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, bridgeHeaders, call, createBridge, login, next } from "./helpers";

describe("setup, autenticación y cola del bridge", () => {
  it("health es mínimo y setup-status usa el formato exacto de Omi", async () => {
    const health = await call("/health");
    expect(await health.json()).toEqual({ ok: true });
    const user = await login("omi_user_setup");
    let status = await call(`/setup-status?uid=${user.uid}`);
    expect(await status.json()).toEqual({ is_setup_completed: false });
    const bridge = await createBridge(user);
    await next(bridge, { ha_ok: true });
    status = await call(`/setup-status?uid=${user.uid}`);
    expect(await status.json()).toEqual({ is_setup_completed: true });
  });

  it("requiere Bridge ID y Bearer correctos", async () => {
    const user = await login("omi_user_auth");
    const bridge = await createBridge(user);
    const missing = await call("/api/bridge/next", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(missing.status).toBe(401);
    const wrong = await call("/api/bridge/next", {
      method: "POST",
      headers: { ...bridgeHeaders(bridge), authorization: `Bearer ${"x".repeat(43)}` },
      body: "{}",
    });
    expect(wrong.status).toBe(401);
  });

  it("no acepta el secreto de otro usuario/bridge", async () => {
    const first = await login("omi_user_a");
    const second = await login("omi_user_b");
    const bridgeA = await createBridge(first);
    const bridgeB = await createBridge(second);
    const response = await call("/api/bridge/next", {
      method: "POST",
      headers: { ...bridgeHeaders(bridgeA), "x-bridge-id": bridgeB.bridge_id },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("reclama un job una sola vez y conserva service_data", async () => {
    const user = await login("omi_user_jobs");
    const bridge = await createBridge(user);
    const queued = await api(user, "/api/actions/test", "POST", {
      domain: "light",
      service: "turn_on",
      entity_id: "light.habitacion",
      service_data: { brightness_pct: 70 },
    });
    expect(queued.status).toBe(202);
    const first = await (await next(bridge)).json() as any;
    expect(first.job.type).toBe("call_service");
    expect(first.job.payload.service_data).toEqual({ brightness_pct: 70 });
    const second = await (await next(bridge)).json() as any;
    expect(second).toEqual({ ok: true, job: null });
  });

  it("no entrega jobs pendientes expirados", async () => {
    const user = await login("omi_user_expired");
    const bridge = await createBridge(user);
    await env.DB.prepare(
      "INSERT INTO jobs (id, uid, bridge_id, type, payload, status, created_at) VALUES ('job_old', ?, ?, 'test_home_assistant', '{}', 'pending', ?)",
    ).bind(user.uid, bridge.bridge_id, Date.now() - 10 * 60_000).run();
    const response = await (await next(bridge)).json() as any;
    expect(response.job).toBeNull();
  });

  it("solo el bridge propietario puede completar el job", async () => {
    const first = await login("omi_result_a");
    const second = await login("omi_result_b");
    const bridgeA = await createBridge(first);
    const bridgeB = await createBridge(second);
    const queued = await (await api(first, "/api/actions/test-home-assistant", "POST", {})).json() as any;
    await next(bridgeA);
    const denied = await call("/api/bridge/result", {
      method: "POST", headers: bridgeHeaders(bridgeB), body: JSON.stringify({ job_id: queued.job_id, success: true, message: "OK" }),
    });
    expect(denied.status).toBe(404);
    const completed = await call("/api/bridge/result", {
      method: "POST", headers: bridgeHeaders(bridgeA), body: JSON.stringify({ job_id: queued.job_id, success: true, message: "API running.", upstream_http_code: 200 }),
    });
    expect(completed.status).toBe(200);
    const job = await (await api(first, `/api/jobs/${queued.job_id}`)).json() as any;
    expect(job.job.status).toBe("completed");
  });

  it("protege mutaciones web con CSRF", async () => {
    const user = await login("omi_csrf");
    const response = await call("/api/bridges", {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "application/json", "x-csrf-token": "wrong" },
      body: "{}",
    });
    expect(response.status).toBe(403);
  });
});
