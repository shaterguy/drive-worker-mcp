import type { Binding, Publication, PublicationState, Store } from './contracts.ts';
import { fail } from './errors.ts';

export interface SqlClient { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
const COLUMNS = `account_id AS "accountId", job_id AS "jobId", route, content_hash AS "contentHash",
  routing_payload_hash AS "routingPayloadHash", routing_eligible AS "routingEligible",
  file_id AS "fileId", folder_id AS "folderId", state, provider_created_time AS "createdTime"`;
function publication(row: Record<string, unknown> | undefined): Publication {
  if (!row || typeof row.accountId !== 'string' || typeof row.jobId !== 'string'
    || typeof row.fileId !== 'string' || typeof row.contentHash !== 'string') fail('STORE_UNAVAILABLE');
  return row as unknown as Publication;
}
export class PostgresStore implements Store {
  readonly db: SqlClient;
  constructor(db: SqlClient) { this.db = db; }
  async getBinding(accountId: string): Promise<Binding | null> {
    const { rows } = await this.db.query(`SELECT account_id AS "accountId", manual_folder_id AS "manualFolderId",
      commands_folder_id AS "commandsFolderId", results_folder_id AS "resultsFolderId", state_folder_id AS "stateFolderId"
      FROM dw_mcp_bindings WHERE account_id=$1`, [accountId]);
    const row = rows[0]; if (!row) return null;
    const binding = { accountId: String(row.accountId), manualFolderId: String(row.manualFolderId),
      commandsFolderId: String(row.commandsFolderId), resultsFolderId: String(row.resultsFolderId) };
    return row.stateFolderId == null ? binding : { ...binding, stateFolderId: String(row.stateFolderId) };
  }
  async getPublication(accountId: string, jobId: string): Promise<Publication | null> {
    const { rows } = await this.db.query(`SELECT ${COLUMNS} FROM dw_mcp_publications WHERE account_id=$1 AND job_id=$2`, [accountId, jobId]);
    return rows[0] ? publication(rows[0]) : null;
  }
  async reservePublication(p: Publication): Promise<Publication> {
    const { rows } = await this.db.query(`INSERT INTO dw_mcp_publications
      (account_id,job_id,route,content_hash,routing_payload_hash,routing_eligible,file_id,folder_id,state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PREPARING')
      ON CONFLICT (account_id,job_id) DO NOTHING RETURNING ${COLUMNS}`,
    [p.accountId, p.jobId, p.route, p.contentHash, p.routingPayloadHash, p.routingEligible, p.fileId, p.folderId]);
    if (rows[0]) return publication(rows[0]);
    // A separate READ COMMITTED statement sees the winner after the conflicting INSERT committed.
    const winner = await this.getPublication(p.accountId, p.jobId);
    if (!winner) fail('STORE_UNAVAILABLE');
    return winner;
  }
  async setPublicationState(accountId: string, jobId: string, state: PublicationState, createdTime?: string): Promise<Publication> {
    const { rows } = await this.db.query(`UPDATE dw_mcp_publications SET
      state=CASE WHEN state IN ('PUBLISHED','SUBMITTED') THEN state ELSE $3 END,
      provider_created_time=COALESCE(provider_created_time,$4), updated_at=now()
      WHERE account_id=$1 AND job_id=$2 RETURNING ${COLUMNS}`, [accountId, jobId, state, createdTime ?? null]);
    return publication(rows[0]);
  }
}
