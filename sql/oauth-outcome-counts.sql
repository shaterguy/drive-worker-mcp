-- Optional operational counters. Apply independently of authentication migrations.
CREATE TABLE IF NOT EXISTS dw_mcp_oauth_hourly_counts (
  utc_hour integer NOT NULL CHECK (utc_hour >= 0),
  hour_slot smallint GENERATED ALWAYS AS ((utc_hour % 720)::smallint) STORED,
  operation text NOT NULL CHECK (operation IN ('code', 'refresh', 'revoke')),
  http_status smallint NOT NULL CHECK (http_status BETWEEN 200 AND 599),
  occurrences integer NOT NULL CHECK (occurrences > 0),
  CHECK (operation = 'revoke' OR http_status >= 400),
  PRIMARY KEY (hour_slot, operation, http_status)
);

-- A quiet slot can retain its previous counter until reused. Queries see only the last 720 hours.
CREATE OR REPLACE VIEW dw_mcp_oauth_recent_counts AS
  SELECT to_timestamp(utc_hour::bigint * 3600) AS bucket_start, operation, http_status, occurrences
  FROM dw_mcp_oauth_hourly_counts
  WHERE utc_hour BETWEEN floor(extract(epoch FROM current_timestamp)/3600)::integer - 719
    AND floor(extract(epoch FROM current_timestamp)/3600)::integer;
