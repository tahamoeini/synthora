CREATE TABLE IF NOT EXISTS api_session_issuance (
  client_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (client_hash, window_start)
);

CREATE INDEX IF NOT EXISTS api_session_issuance_window_idx ON api_session_issuance (window_start);
