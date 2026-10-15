-- Apply only to the dedicated service database, after reviewed auth/tenant migration.
CREATE TABLE IF NOT EXISTS dw_mcp_bindings (
  account_id text PRIMARY KEY REFERENCES dw_mcp_tenants(id),
  manual_folder_id text NOT NULL,
  commands_folder_id text NOT NULL,
  results_folder_id text NOT NULL,
  state_folder_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (manual_folder_id <> commands_folder_id),
  CHECK (results_folder_id <> manual_folder_id AND results_folder_id <> commands_folder_id)
);
CREATE TABLE IF NOT EXISTS dw_mcp_publications (
  account_id text NOT NULL REFERENCES dw_mcp_tenants(id),
  job_id text NOT NULL CHECK (length(job_id) BETWEEN 1 AND 160),
  route text NOT NULL CHECK (route IN ('manual', 'direct')),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  routing_payload_hash text NOT NULL CHECK (routing_payload_hash ~ '^[0-9a-f]{64}$'),
  routing_eligible boolean NOT NULL,
  file_id text NOT NULL UNIQUE,
  folder_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('PREPARING', 'PUBLISHED', 'SUBMITTED', 'UNKNOWN', 'FAILED')),
  provider_created_time text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, job_id),
  CHECK (state <> 'PUBLISHED' OR route = 'manual'),
  CHECK (state <> 'SUBMITTED' OR route = 'direct')
);
