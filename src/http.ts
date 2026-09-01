const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

export function methodNotAllowed(allowed: string[]): Response {
  return json(
    { ok: false, error: "Método no permitido" },
    405,
    { allow: allowed.join(", ") },
  );
}

export async function readJson<T>(request: Request, maxBytes = 32_768): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "Content-Type debe ser application/json");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "Payload demasiado grande");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new HttpError(413, "Payload demasiado grande");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "JSON no válido");
  }
}

export function securityHeaders(response: Response): Response {
  const result = new Response(response.body, response);
  result.headers.set("x-frame-options", "DENY");
  result.headers.set("referrer-policy", "no-referrer");
  result.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  result.headers.set("x-content-type-options", "nosniff");
  if ((result.headers.get("content-type") ?? "").includes("text/html")) {
    result.headers.set(
      "content-security-policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
  }
  return result;
}

interface Bucket {
  start: number;
  count: number;
}

const buckets = new Map<string, Bucket>();

/** Best-effort per-isolate limiter. It adds no D1 write to the 1.5 s bridge path. */
export function rateLimit(key: string, limit: number, windowMs = 60_000): boolean {
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || now - current.start >= windowMs) {
    buckets.set(key, { start: now, count: 1 });
    if (buckets.size > 2_000) {
      for (const [bucketKey, bucket] of buckets) {
        if (now - bucket.start > windowMs * 2) buckets.delete(bucketKey);
      }
    }
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

export function clientKey(request: Request, namespace: string): string {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  return `${namespace}:${ip}`;
}

export function cleanText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new HttpError(400, `${field} debe ser texto`);
  const result = value.trim();
  if (!result || result.length > maxLength) {
    throw new HttpError(400, `${field} debe tener entre 1 y ${maxLength} caracteres`);
  }
  return result;
}

export function optionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return cleanText(value, field, maxLength);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
