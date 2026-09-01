import { HttpError, cleanText, isRecord } from "./http";

export interface ActionInput {
  domain: string;
  service: string;
  entity_id: string;
  service_data: Record<string, unknown>;
}

export function parseActionInput(body: unknown): ActionInput {
  if (!isRecord(body)) throw new HttpError(400, "Acción no válida");
  const entityId = cleanText(body.entity_id, "entity_id", 255).toLowerCase();
  const domain = cleanText(body.domain, "domain", 80).toLowerCase();
  const service = cleanText(body.service, "service", 100).toLowerCase();
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(entityId) || entityId.split(".")[0] !== domain) {
    throw new HttpError(400, "entity_id no pertenece al dominio indicado");
  }
  if (!/^[a-z0-9_]+$/.test(domain) || !/^[a-z0-9_]+$/.test(service)) {
    throw new HttpError(400, "domain/service no válidos");
  }
  if (!isRecord(body.service_data ?? {})) throw new HttpError(400, "service_data debe ser un objeto JSON");
  const serviceData = body.service_data ?? {};
  const encoded = JSON.stringify(serviceData);
  if (encoded.length > 16_384) throw new HttpError(400, "service_data es demasiado grande");
  return { domain, service, entity_id: entityId, service_data: serviceData as Record<string, unknown> };
}

export function isSensitiveAction(domain: string, service: string): boolean {
  const key = `${domain}.${service}`;
  return new Set([
    "lock.unlock",
    "alarm_control_panel.alarm_disarm",
    "cover.open_cover",
    "cover.open_cover_tilt",
    "button.press",
    "script.turn_on",
    "automation.trigger",
  ]).has(key);
}
