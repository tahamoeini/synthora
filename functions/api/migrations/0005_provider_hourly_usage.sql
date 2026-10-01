CREATE TABLE IF NOT EXISTS provider_hourly_usage (
  provider TEXT NOT NULL,
  hour_key INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  last_requested_at INTEGER NOT NULL,
  PRIMARY KEY (provider, hour_key)
);

CREATE INDEX IF NOT EXISTS provider_hourly_last_requested_idx
  ON provider_hourly_usage (provider, last_requested_at);
