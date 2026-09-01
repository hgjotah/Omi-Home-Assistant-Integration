import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { bridgeHeaders, call, createBridge, login, next } from "./helpers";

async function queueSync(uid: string, bridgeId: string, type: "sync_entities" | "sync_services", id: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO jobs (id, uid, bridge_id, type, payload, status, created_at) VALUES (?, ?, ?, ?, '{}', 'pending', ?)",
  ).bind(id, uid, bridgeId, type, Date.now()).run();
}

async function bridgePost(path: string, bridge: { bridge_id: string; bridge_secret: string }, body: unknown): Promise<Response> {
  return call(path, { method: "POST", headers: bridgeHeaders(bridge), body: JSON.stringify(body) });
}

describe("sincronización consistente", () => {
  it("publica entidades por chunks solo al completar", async () => {
    const user = await login("omi_sync_entities");
    const bridge = await createBridge(user);
    await env.DB.prepare(
      "INSERT INTO entity_cache (uid, entity_id, domain, friendly_name, state, updated_at) VALUES (?, 'sensor.old', 'sensor', 'Anterior', '1', ?)",
    ).bind(user.uid, Date.now()).run();
    await queueSync(user.uid, bridge.bridge_id, "sync_entities", "job_sync_entities");
    expect((await (await next(bridge)).json() as any).job.id).toBe("job_sync_entities");
    expect((await bridgePost("/api/bridge/sync/entities/start", bridge, { job_id: "job_sync_entities" })).status).toBe(200);
    expect((await bridgePost("/api/bridge/sync/entities/chunk", bridge, {
      job_id: "job_sync_entities",
      items: [{ entity_id: "light.habitacion", domain: "light", state: "off", friendly_name: "Luz habitación", icon: "mdi:lightbulb" }],
    })).status).toBe(200);
    expect(await env.DB.prepare("SELECT entity_id FROM entity_cache WHERE uid = ?").bind(user.uid).first()).toEqual({ entity_id: "sensor.old" });
    expect((await bridgePost("/api/bridge/sync/entities/complete", bridge, { job_id: "job_sync_entities", count: 1 })).status).toBe(200);
    const entities = await env.DB.prepare("SELECT entity_id, state FROM entity_cache WHERE uid = ?").bind(user.uid).all();
    expect(entities.results).toEqual([{ entity_id: "light.habitacion", state: "off" }]);
  });

  it("una sincronización incompleta no toca la caché viva", async () => {
    const user = await login("omi_sync_incomplete");
    const bridge = await createBridge(user);
    await env.DB.prepare(
      "INSERT INTO entity_cache (uid, entity_id, domain, friendly_name, state, updated_at) VALUES (?, 'sensor.safe', 'sensor', 'Seguro', 'ok', ?)",
    ).bind(user.uid, Date.now()).run();
    await queueSync(user.uid, bridge.bridge_id, "sync_entities", "job_sync_bad");
    await next(bridge);
    await bridgePost("/api/bridge/sync/entities/start", bridge, { job_id: "job_sync_bad" });
    await bridgePost("/api/bridge/sync/entities/chunk", bridge, {
      job_id: "job_sync_bad", items: [{ entity_id: "sensor.new", domain: "sensor", state: "2", friendly_name: "Nuevo" }],
    });
    const complete = await bridgePost("/api/bridge/sync/entities/complete", bridge, { job_id: "job_sync_bad", count: 2 });
    expect(complete.status).toBe(409);
    const live = await env.DB.prepare("SELECT entity_id FROM entity_cache WHERE uid = ?").bind(user.uid).first();
    expect(live).toEqual({ entity_id: "sensor.safe" });
  });

  it("sincroniza acciones reales y conserva fields", async () => {
    const user = await login("omi_sync_services");
    const bridge = await createBridge(user);
    await queueSync(user.uid, bridge.bridge_id, "sync_services", "job_sync_services");
    await next(bridge);
    await bridgePost("/api/bridge/sync/services/start", bridge, { job_id: "job_sync_services" });
    await bridgePost("/api/bridge/sync/services/chunk", bridge, {
      job_id: "job_sync_services",
      items: [{ domain: "light", service: "turn_on", name: "Encender", description: "Enciende una luz", fields: { brightness_pct: { required: false, selector: { number: { min: 0, max: 100 } } } } }],
    });
    const complete = await bridgePost("/api/bridge/sync/services/complete", bridge, { job_id: "job_sync_services", count: 1 });
    expect(complete.status).toBe(200);
    const cached = await env.DB.prepare("SELECT domain, service, fields_json FROM service_cache WHERE uid = ?").bind(user.uid).first<any>();
    expect(cached.domain).toBe("light");
    expect(JSON.parse(cached.fields_json).brightness_pct.selector.number.max).toBe(100);
  });

  it("no permite que otro bridge escriba chunks de la sincronización", async () => {
    const a = await login("omi_sync_owner_a");
    const b = await login("omi_sync_owner_b");
    const bridgeA = await createBridge(a);
    const bridgeB = await createBridge(b);
    await queueSync(a.uid, bridgeA.bridge_id, "sync_entities", "job_sync_owner");
    await next(bridgeA);
    const response = await bridgePost("/api/bridge/sync/entities/start", bridgeB, { job_id: "job_sync_owner" });
    expect(response.status).toBe(404);
  });
});
