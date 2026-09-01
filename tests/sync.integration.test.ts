import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, bridgeHeaders, call, createBridge, login, next } from "./helpers";

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

  it("sanea cada entidad, ignora solo la inválida y usa el conteo real del Worker", async () => {
    const user = await login("omi_sync_tolerant");
    const bridge = await createBridge(user);
    await env.DB.prepare(
      "INSERT INTO entity_cache (uid, entity_id, domain, friendly_name, state, updated_at) VALUES (?, 'sensor.safe', 'sensor', 'Seguro', 'ok', ?)",
    ).bind(user.uid, Date.now()).run();
    await queueSync(user.uid, bridge.bridge_id, "sync_entities", "job_sync_tolerant");
    await next(bridge);
    await bridgePost("/api/bridge/sync/entities/start", bridge, { job_id: "job_sync_tolerant" });
    const longName = "Nombre".repeat(60);
    const longState = "x".repeat(800);
    const chunk = await bridgePost("/api/bridge/sync/entities/chunk", bridge, {
      job_id: "job_sync_tolerant",
      items: [
        { entity_id: "light.habitacion", domain: "light", state: "on", friendly_name: "Habitación", icon: "mdi:lightbulb" },
        { entity_id: "sensor.name_null", domain: "sensor", state: "off", friendly_name: null, icon: null },
        { entity_id: "sensor.name_empty", domain: "sensor", state: "off", friendly_name: "" },
        { entity_id: "sensor.name_long", domain: "sensor", state: "off", friendly_name: longName },
        { entity_id: "sensor.icon_object", domain: "sensor", state: "off", friendly_name: "Icono", icon: { bad: true } },
        { entity_id: "sensor.state_null", domain: "sensor", state: null, friendly_name: "Estado nulo" },
        { entity_id: "sensor.state_number", domain: "sensor", state: 42, friendly_name: "Estado número" },
        { entity_id: "sensor.state_long", domain: "sensor", state: longState, friendly_name: "Estado largo" },
        { entity_id: "light.wrong_domain", domain: "sensor", state: "off", friendly_name: "Dominio derivado" },
        { entity_id: "binary_sensor.boolean", domain: "wrong", state: true, friendly_name: false },
        { entity_id: "sensor.state_object", state: { nested: "value" }, friendly_name: ["unexpected"], icon: ["mdi:test"] },
        { entity_id: "completamente inválido", domain: "sensor", state: "off", friendly_name: "Se ignora" },
      ],
    });
    expect(chunk.status).toBe(200);
    expect(await chunk.json()).toEqual({ ok: true, received: 12, accepted: 11, skipped: 1 });

    const live = await env.DB.prepare("SELECT entity_id FROM entity_cache WHERE uid = ?").bind(user.uid).first();
    expect(live).toEqual({ entity_id: "sensor.safe" });

    const complete = await bridgePost("/api/bridge/sync/entities/complete", bridge, { job_id: "job_sync_tolerant", count: 12 });
    expect(complete.status).toBe(200);
    expect(await complete.json()).toEqual({ ok: true, synced: 11, skipped: 1, received: 12 });

    const cached = await env.DB.prepare(
      "SELECT entity_id, domain, friendly_name, state, icon FROM entity_cache WHERE uid = ? ORDER BY entity_id",
    ).bind(user.uid).all<Record<string, unknown>>();
    expect(cached.results).toHaveLength(11);
    const byId = new Map(cached.results.map((item) => [item.entity_id, item]));
    expect(byId.get("light.habitacion")).toMatchObject({ domain: "light", state: "on", friendly_name: "Habitación", icon: "mdi:lightbulb" });
    expect(byId.get("sensor.name_null")?.friendly_name).toBe("sensor.name_null");
    expect(byId.get("sensor.name_empty")?.friendly_name).toBe("sensor.name_empty");
    expect(String(byId.get("sensor.name_long")?.friendly_name)).toHaveLength(255);
    expect(byId.get("sensor.icon_object")?.icon).toBeNull();
    expect(byId.get("sensor.state_null")?.state).toBe("unknown");
    expect(byId.get("sensor.state_number")?.state).toBe("42");
    expect(String(byId.get("sensor.state_long")?.state)).toHaveLength(500);
    expect(byId.get("light.wrong_domain")?.domain).toBe("light");
    expect(byId.get("binary_sensor.boolean")).toMatchObject({ domain: "binary_sensor", friendly_name: "binary_sensor.boolean", state: "true" });
    expect(byId.get("sensor.state_object")).toMatchObject({ state: "{\"nested\":\"value\"}", friendly_name: "sensor.state_object", icon: null });

    const job = await env.DB.prepare("SELECT status, result FROM jobs WHERE id = 'job_sync_tolerant'").first<{ status: string; result: string }>();
    expect(job?.status).toBe("completed");
    expect(JSON.parse(job?.result ?? "{}")).toEqual({ synced: 11, skipped: 1, received: 12 });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM entity_sync_items WHERE job_id = 'job_sync_tolerant'").first<{ count: number }>())?.count).toBe(0);
  });

  it("completa 619 entidades con casos problemáticos sin vaciar la caché", async () => {
    const user = await login("omi_sync_619");
    const bridge = await createBridge(user);
    await env.DB.prepare(
      "INSERT INTO entity_cache (uid, entity_id, domain, friendly_name, state, updated_at) VALUES (?, 'sensor.previous_cache', 'sensor', 'Anterior', 'ok', ?)",
    ).bind(user.uid, Date.now()).run();
    await queueSync(user.uid, bridge.bridge_id, "sync_entities", "job_sync_619");
    await next(bridge);
    expect((await bridgePost("/api/bridge/sync/entities/start", bridge, { job_id: "job_sync_619" })).status).toBe(200);

    const items: unknown[] = Array.from({ length: 619 }, (_, index) => ({
      entity_id: `sensor.bulk_${index}`,
      domain: index === 200 ? "light" : "sensor",
      state: index === 300 ? { quality: "odd" } : index,
      friendly_name: index === 400 ? null : `Entidad ${index}`,
      icon: index === 500 ? { unexpected: true } : "mdi:gauge",
    }));
    items[18] = { domain: "sensor", state: "missing id" };
    items[311] = { entity_id: "bad id", state: "invalid" };

    let accepted = 0;
    let skipped = 0;
    for (let offset = 0; offset < items.length; offset += 100) {
      const response = await bridgePost("/api/bridge/sync/entities/chunk", bridge, {
        job_id: "job_sync_619",
        items: items.slice(offset, offset + 100),
      });
      expect(response.status).toBe(200);
      const result = await response.json() as { accepted: number; skipped: number };
      accepted += result.accepted;
      skipped += result.skipped;
    }
    expect({ accepted, skipped }).toEqual({ accepted: 617, skipped: 2 });
    expect(await env.DB.prepare("SELECT entity_id FROM entity_cache WHERE uid = ?").bind(user.uid).first()).toEqual({ entity_id: "sensor.previous_cache" });

    const complete = await bridgePost("/api/bridge/sync/entities/complete", bridge, { job_id: "job_sync_619", count: 619 });
    expect(complete.status).toBe(200);
    expect(await complete.json()).toEqual({ ok: true, synced: 617, skipped: 2, received: 619 });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM entity_cache WHERE uid = ?").bind(user.uid).first<{ count: number }>())?.count).toBe(617);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM entity_sync_items WHERE job_id = 'job_sync_619'").first<{ count: number }>())?.count).toBe(0);

    const bootstrap = await api(user, "/api/bootstrap");
    const dashboard = await bootstrap.json() as any;
    expect(dashboard.counts.entities).toBe(617);
    expect(dashboard.sync.entities).toMatchObject({ status: "completed", result: { synced: 617, skipped: 2, received: 619 } });
  }, 30_000);

  it("conserva la caché si no acepta ninguna entidad y limpia staging fallido antiguo", async () => {
    const user = await login("omi_sync_all_invalid");
    const bridge = await createBridge(user);
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO entity_cache (uid, entity_id, domain, friendly_name, state, updated_at) VALUES (?, 'sensor.safe_cache', 'sensor', 'Caché segura', 'ok', ?)",
    ).bind(user.uid, now).run();
    await env.DB.prepare(
      "INSERT INTO jobs (id, uid, bridge_id, type, payload, status, created_at, completed_at, error) VALUES ('job_old_failed', ?, ?, 'sync_entities', '{}', 'failed', ?, ?, 'fallo antiguo')",
    ).bind(user.uid, bridge.bridge_id, now - 2 * 24 * 60 * 60_000, now - 2 * 24 * 60 * 60_000).run();
    await env.DB.prepare(
      "INSERT INTO entity_sync_items (job_id, uid, entity_id, domain, friendly_name, state, updated_at) VALUES ('job_old_failed', ?, 'sensor.stale', 'sensor', 'Stale', 'old', ?)",
    ).bind(user.uid, now).run();
    await queueSync(user.uid, bridge.bridge_id, "sync_entities", "job_all_invalid");
    await next(bridge);
    await bridgePost("/api/bridge/sync/entities/start", bridge, { job_id: "job_all_invalid" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM entity_sync_items WHERE job_id = 'job_old_failed'").first<{ count: number }>())?.count).toBe(0);

    const chunk = await bridgePost("/api/bridge/sync/entities/chunk", bridge, {
      job_id: "job_all_invalid",
      items: [{ entity_id: null, state: "bad" }],
    });
    expect(await chunk.json()).toEqual({ ok: true, received: 1, accepted: 0, skipped: 1 });
    const complete = await bridgePost("/api/bridge/sync/entities/complete", bridge, { job_id: "job_all_invalid", count: 1 });
    expect(complete.status).toBe(422);
    expect(await env.DB.prepare("SELECT entity_id FROM entity_cache WHERE uid = ?").bind(user.uid).first()).toEqual({ entity_id: "sensor.safe_cache" });

    const failure = await bridgePost("/api/bridge/result", bridge, {
      job_id: "job_all_invalid",
      success: false,
      message: "No se aceptó ninguna entidad; se conserva la caché anterior",
      upstream_http_code: 422,
    });
    expect(failure.status).toBe(200);
    expect((await env.DB.prepare("SELECT status FROM jobs WHERE id = 'job_all_invalid'").first<{ status: string }>())?.status).toBe("failed");
  });

  it("elimina staging del job cuando el bridge informa un fallo", async () => {
    const user = await login("omi_sync_failed_cleanup");
    const bridge = await createBridge(user);
    await queueSync(user.uid, bridge.bridge_id, "sync_entities", "job_failed_cleanup");
    await next(bridge);
    await bridgePost("/api/bridge/sync/entities/start", bridge, { job_id: "job_failed_cleanup" });
    await bridgePost("/api/bridge/sync/entities/chunk", bridge, {
      job_id: "job_failed_cleanup",
      items: [{ entity_id: "sensor.partial", state: "ok", friendly_name: "Parcial" }],
    });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM entity_sync_items WHERE job_id = 'job_failed_cleanup'").first<{ count: number }>())?.count).toBe(1);

    const result = await bridgePost("/api/bridge/result", bridge, {
      job_id: "job_failed_cleanup",
      success: false,
      message: "Cloudflare POST /api/bridge/sync/entities/chunk HTTP 400: detalle",
      upstream_http_code: 400,
    });
    expect(result.status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM entity_sync_items WHERE job_id = 'job_failed_cleanup'").first<{ count: number }>())?.count).toBe(0);
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
