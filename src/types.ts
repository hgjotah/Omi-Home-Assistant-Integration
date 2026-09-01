export interface Env {
  DB: D1Database;
  APP_SECRET: string;
  OMI_WEBHOOK_TOKEN: string;
}

export interface Session {
  uid: string;
  expiresAt: number;
  token: string;
}

export interface BridgeRow {
  id: string;
  uid: string;
  bridge_id: string;
  bridge_secret_hash: string;
  enabled: number;
  last_seen: number | null;
  last_persisted_heartbeat: number | null;
  firmware_version: string | null;
  ip: string | null;
  rssi: number | null;
  ha_ok: number | null;
  created_at: number;
  updated_at: number;
}

export interface CommandRow {
  id: string;
  uid: string;
  phrase: string;
  normalized_phrase: string;
  entity_id: string;
  entity_name: string;
  domain: string;
  service: string;
  service_data: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface JobRow {
  id: string;
  uid: string;
  bridge_id: string;
  type: JobType;
  payload: string;
  status: JobStatus;
  created_at: number;
  claimed_at: number | null;
  completed_at: number | null;
  result: string | null;
  error: string | null;
}

export type JobType =
  | "test_home_assistant"
  | "get_entity_state"
  | "call_service"
  | "sync_entities"
  | "sync_services";

export type JobStatus = "pending" | "claimed" | "completed" | "failed" | "expired";

export interface OmiSegment {
  text: string;
  speaker?: string;
  speakerId?: number;
  is_user?: boolean;
  start?: number;
  end?: number;
}

export interface VoiceUnit {
  text: string;
  normalized: string;
  start?: number;
  end?: number;
  speaker?: string;
}

export interface BridgeAuth {
  bridge: BridgeRow;
  secret: string;
}
