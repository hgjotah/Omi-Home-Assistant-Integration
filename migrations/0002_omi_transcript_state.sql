CREATE TABLE omi_transcript_state (
  uid TEXT NOT NULL,
  session_key TEXT NOT NULL,
  transcript TEXT NOT NULL,
  start REAL,
  end REAL,
  speaker TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (uid, session_key),
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
);

CREATE INDEX idx_omi_transcript_state_updated ON omi_transcript_state(updated_at);
