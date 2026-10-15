export type Route = 'manual' | 'direct';
export type PublicationState = 'PREPARING' | 'PUBLISHED' | 'SUBMITTED' | 'UNKNOWN' | 'FAILED';
export type ToolScope = 'manual:publish' | 'jobs:submit' | 'jobs:read';
/** Construct only after issuer, audience, expiry, resource and revocation validation. */
export interface Principal { accountId: string; grantId: string; clientId: string; scopes: ReadonlySet<ToolScope> }
export interface Binding {
  accountId: string; manualFolderId: string; commandsFolderId: string;
  resultsFolderId: string; stateFolderId?: string;
}
export interface Command {
  schema: 'drive-worker-command-v1'; job_id: string; command: string;
  cwd: string; timeout_ms: number; shell?: string;
  env?: Record<string, string>; stdin?: string; target_server?: string;
}
export interface Publication {
  accountId: string; jobId: string; route: Route; contentHash: string;
  fileId: string; folderId: string; state: PublicationState;
  routingEligible: boolean; routingPayloadHash: string; createdTime: string | null;
}
export interface Store {
  getBinding(accountId: string): Promise<Binding | null>;
  getPublication(accountId: string, jobId: string): Promise<Publication | null>;
  /** Atomic insert-if-absent, returning the persisted winner. Never replaces an existing row. */
  reservePublication(candidate: Publication): Promise<Publication>;
  /** Must never downgrade a confirmed publication to PREPARING, UNKNOWN or FAILED. */
  setPublicationState(accountId: string, jobId: string, state: PublicationState, createdTime?: string): Promise<Publication>;
}
export interface DriveFile {
  id: string; name: string; mimeType: string; parents?: string[]; trashed?: boolean;
  createdTime?: string; modifiedTime?: string; size?: string;
  version?: string; md5Checksum?: string;
  capabilities?: { canAddChildren?: boolean; canDownload?: boolean };
}
export interface Drive {
  getMetadata(fileId: string): Promise<DriveFile | null>;
  reserveFileId(): Promise<string>;
  /** Only creates a new file with this pre-generated ID. Never patches or moves files. */
  createJson(fileId: string, folderId: string, name: string, json: string): Promise<void>;
  /** Must enforce limit during the response stream, not after allocating the full body. */
  readBytes(fileId: string, maxBytes: number): Promise<Uint8Array>;
  /** Exact direct-parent/name query. Returns up to two matches or an explicit conflict. */
  findExact(folderId: string, name: string): Promise<DriveFile[]>;
}
export interface Dependencies {
  store: Store;
  /** Always obtains an API client bound to this authenticated account, with no owner fallback. */
  driveForAccount(accountId: string): Promise<Drive>;
  assertActiveGrant(principal: Principal): Promise<void>;
  cursorKey: Uint8Array;
  maxLogBytes?: number;
  now?: () => Date;
  /** Credential values supplied by the secure auth boundary; never persisted or logged here. */
  redact?: (text: string) => string;
}
