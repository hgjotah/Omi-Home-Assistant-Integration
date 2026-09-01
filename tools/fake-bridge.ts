#!/usr/bin/env node

export {};

interface Config {
  url: string;
  bridgeId: string;
  bridgeSecret: string;
  once: boolean;
}

interface Job {
  id: string;
  type: "test_home_assistant" | "get_entity_state" | "call_service" | "sync_entities" | "sync_services";
  payload: Record<string, unknown>;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function config(): Config {
  const url = argument("url") ?? process.env.WORKER_URL;
  const bridgeId = argument("bridge-id") ?? process.env.BRIDGE_ID;
  const bridgeSecret = argument("bridge-secret") ?? process.env.BRIDGE_SECRET;
  if (!url || !bridgeId || !bridgeSecret) {
    console.error("Uso: npm run fake-bridge -- --url http://localhost:8787 --bridge-id br_... --bridge-secret ... [--once]");
    process.exit(2);
  }
  return { url: url.replace(/\/$/, ""), bridgeId, bridgeSecret, once: process.argv.includes("--once") };
}

async function request(cfg: Config, path: string, body: unknown): Promise<any> {
  const response = await fetch(`${cfg.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bridge-id": cfg.bridgeId,
      authorization: `Bearer ${cfg.bridgeSecret}`,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${data.error ?? "error"}`);
  return data;
}

async function result(cfg: Config, job: Job, success: boolean, message: string, extra: Record<string, unknown> = {}): Promise<void> {
  await request(cfg, "/api/bridge/result", {
    job_id: job.id,
    success,
    message,
    upstream_http_code: success ? 200 : 500,
    ...extra,
  });
}

async function execute(cfg: Config, job: Job): Promise<void> {
  console.log(`Job ${job.id}: ${job.type}`);
  if (job.type === "test_home_assistant") {
    await result(cfg, job, true, "API running. (simulado)");
    return;
  }
  if (job.type === "get_entity_state") {
    await result(cfg, job, true, "Estado simulado", { state: "off" });
    return;
  }
  if (job.type === "call_service") {
    await result(cfg, job, true, "OK; ejecución simulada", { previous_state: "off", state: "on" });
    return;
  }
  if (job.type === "sync_entities") {
    await request(cfg, "/api/bridge/sync/entities/start", { job_id: job.id });
    const items = [
      { entity_id: "light.fake_bridge", domain: "light", state: "off", friendly_name: "Luz de prueba", icon: "mdi:lightbulb" },
      { entity_id: "sensor.fake_temperature", domain: "sensor", state: "21.5", friendly_name: "Temperatura simulada", icon: "mdi:thermometer" },
    ];
    await request(cfg, "/api/bridge/sync/entities/chunk", { job_id: job.id, items });
    await request(cfg, "/api/bridge/sync/entities/complete", { job_id: job.id, count: items.length });
    return;
  }
  if (job.type === "sync_services") {
    await request(cfg, "/api/bridge/sync/services/start", { job_id: job.id });
    const items = [
      {
        domain: "light",
        service: "turn_on",
        name: "Turn on",
        description: "Enciende una luz (simulado)",
        fields: { brightness_pct: { name: "Brillo", selector: { number: { min: 0, max: 100, step: 1, mode: "slider" } } } },
      },
      { domain: "light", service: "turn_off", name: "Turn off", description: "Apaga una luz (simulado)", fields: {} },
    ];
    await request(cfg, "/api/bridge/sync/services/chunk", { job_id: job.id, items });
    await request(cfg, "/api/bridge/sync/services/complete", { job_id: job.id, count: items.length });
  }
}

async function main(): Promise<void> {
  const cfg = config();
  console.log(`Fake bridge conectado a ${cfg.url} como ${cfg.bridgeId}. El secreto no se muestra.`);
  do {
    try {
      const response = await request(cfg, "/api/bridge/next", {
        firmware: "fake-bridge/1.0.0",
        ip: "192.168.1.250",
        rssi: -42,
        ha_ok: true,
      });
      if (response.job) await execute(cfg, response.job as Job);
      else console.log("Sin trabajo");
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Error desconocido");
      if (cfg.once) process.exitCode = 1;
    }
    if (!cfg.once) await new Promise((resolve) => setTimeout(resolve, 1_500));
  } while (!cfg.once);
}

await main();
