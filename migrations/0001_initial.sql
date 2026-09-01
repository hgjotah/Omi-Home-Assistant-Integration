PRAGMA foreign_keys = ON;

CREATE TABLE users (
  uid TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  setup_completed INTEGER NOT NULL DEFAULT 0 CHECK (setup_completed IN (0, 1)),
  last_webhook_at INTEGER,
  last_error TEXT
);

CREATE TABLE bridges (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  bridge_id TEXT NOT NULL UNIQUE,
  bridge_secret_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_seen INTEGER,
  last_persisted_heartbeat INTEGER,
  firmware_version TEXT,
  ip TEXT,
  rssi INTEGER,
  ha_ok INTEGER CHECK (ha_ok IS NULL OR ha_ok IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
);

CREATE INDEX idx_bridges_uid ON bridges(uid);

CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  phrase TEXT NOT NULL,
  normalized_phrase TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  domain TEXT NOT NULL,
  service TEXT NOT NULL,
  service_data TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE,
  UNIQUE (uid, normalized_phrase)
);

CREATE INDEX idx_commands_uid_enabled ON commands(uid, enabled);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  bridge_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('test_home_assistant', 'get_entity_state', 'call_service', 'sync_entities', 'sync_services')),
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'completed', 'failed', 'expired')),
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  completed_at INTEGER,
  result TEXT,
  error TEXT,
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE,
  FOREIGN KEY (bridge_id) REFERENCES bridges(bridge_id) ON DELETE CASCADE
);

CREATE INDEX idx_jobs_bridge_queue ON jobs(bridge_id, status, created_at);
CREATE INDEX idx_jobs_uid_created ON jobs(uid, created_at DESC);

CREATE TABLE entity_cache (
  uid TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  friendly_name TEXT NOT NULL,
  state TEXT NOT NULL,
  icon TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (uid, entity_id),
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
);

CREATE INDEX idx_entity_cache_search ON entity_cache(uid, domain, friendly_name);

CREATE TABLE service_cache (
  uid TEXT NOT NULL,
  domain TEXT NOT NULL,
  service TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  fields_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (uid, domain, service),
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
);

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  command_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  transcript_signature TEXT NOT NULL,
  utterance_key TEXT NOT NULL UNIQUE,
  executed_at INTEGER NOT NULL,
  job_id TEXT,
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE,
  FOREIGN KEY (command_id) REFERENCES commands(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL
);

CREATE INDEX idx_executions_dedupe ON executions(uid, session_id, command_id, executed_at DESC);

-- Staging keeps the live cache consistent if a bridge loses power mid-sync.
CREATE TABLE entity_sync_items (
  job_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  friendly_name TEXT NOT NULL,
  state TEXT NOT NULL,
  icon TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, entity_id),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
);

CREATE TABLE service_sync_items (
  job_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  domain TEXT NOT NULL,
  service TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  fields_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, domain, service),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
);
