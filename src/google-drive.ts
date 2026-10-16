import { randomUUID } from 'node:crypto';
import type { Drive, DriveFile } from './contracts.ts';
import { fail, isCorrelationId, isUpstreamErrorCode, ServiceError, type UpstreamErrorCode } from './errors.ts';

export interface GoogleDriveOptions {
  getAccessToken(): Promise<string>;
  fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
  sleep?: (milliseconds: number) => Promise<void>;
  diagnostics?: { sink?: (line: string) => unknown; createId?: () => string };
}
const OPERATIONS = ['get_metadata', 'reserve_file_id', 'create_json', 'read_bytes', 'find_exact'] as const;
type Operation = typeof OPERATIONS[number];
const REASONS = Object.freeze({
  insufficientPermissions: 'INSUFFICIENT_SCOPE',
  rateLimitExceeded: 'UPSTREAM_RATE_LIMITED', userRateLimitExceeded: 'UPSTREAM_RATE_LIMITED',
  dailyLimitExceeded: 'UPSTREAM_QUOTA_EXCEEDED', storageQuotaExceeded: 'UPSTREAM_QUOTA_EXCEEDED',
  activeItemCreationLimitExceeded: 'UPSTREAM_QUOTA_EXCEEDED', teamDriveFileLimitExceeded: 'UPSTREAM_QUOTA_EXCEEDED',
  numChildrenInNonRootLimitExceeded: 'UPSTREAM_QUOTA_EXCEEDED',
  insufficientFilePermissions: 'DRIVE_PERMISSION_DENIED', teamDriveMembershipRequired: 'DRIVE_PERMISSION_DENIED',
  appNotAuthorizedToFile: 'DRIVE_APP_NOT_AUTHORIZED', domainPolicy: 'DRIVE_DOMAIN_POLICY',
} satisfies Record<string, UpstreamErrorCode>);
type Reason = keyof typeof REASONS | 'unknown' | 'unparseable';
function forbiddenReason(value: unknown): Reason {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
  const error = (value as Record<string, unknown>).error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return 'unknown';
  const errors = (error as Record<string, unknown>).errors;
  if (!Array.isArray(errors) || !errors.length) return 'unknown';
  const reasons: (keyof typeof REASONS)[] = [];
  for (const entry of errors) {
    if (!entry || typeof entry !== 'object' || typeof entry.reason !== 'string' || !Object.hasOwn(REASONS, entry.reason)) return 'unknown';
    reasons.push(entry.reason as keyof typeof REASONS);
  }
  // Conflicting or unrecognized reasons must not imply a specific permission remedy.
  if (new Set(reasons.map(reason => REASONS[reason])).size !== 1) return 'unknown';
  return reasons.sort()[0]!;
}
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FIELDS = 'id,name,mimeType,parents,trashed,createdTime,modifiedTime,version,md5Checksum,size,capabilities(canAddChildren,canDownload)';
const validId = (id: string) => { if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) fail('UPSTREAM_INVALID'); return id; };
function queryEscape(value: string) { return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
async function bounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const announced = response.headers.get('content-length');
  if (announced && /^\d+$/.test(announced) && Number(announced) > maxBytes) {
    await response.body?.cancel(); fail('UPSTREAM_TOO_LARGE');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); fail('UPSTREAM_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}
export class GoogleDrive implements Drive {
  readonly options: GoogleDriveOptions;
  constructor(options: GoogleDriveOptions) { this.options = options; }
  private upstreamError(operation: Operation, status: number, reason: Reason, code: UpstreamErrorCode) {
    const safeCode = isUpstreamErrorCode(code) ? code : 'UPSTREAM_UNAVAILABLE';
    let correlation_id: string | undefined;
    try {
      const id = (this.options.diagnostics?.createId ?? randomUUID)();
      if (isCorrelationId(id)) correlation_id = id;
    } catch { /* Correlation is best effort; the classified failure remains authoritative. */ }
    const error = new ServiceError(safeCode, { code: safeCode, ...(correlation_id ? { correlation_id } : {}) });
    try {
      if (correlation_id && OPERATIONS.includes(operation) && Number.isInteger(status) && status >= 100 && status <= 599) {
        const safeReason = reason === 'unknown' || reason === 'unparseable' || Object.hasOwn(REASONS, reason) ? reason : 'unknown';
        const line = JSON.stringify({ event: 'dwmcp_upstream_v1', operation, http_status: status,
          reason: safeReason, code: safeCode, correlation_id });
        if (Buffer.byteLength(line) <= 512) {
          const pending = (this.options.diagnostics?.sink ?? (value => console.info(value)))(line);
          if (pending instanceof Promise) void pending.catch(() => {});
        }
      }
    } catch { /* No raw error or fallback log; logging cannot change the operation's outcome. */ }
    return error;
  }
  async request(operation: Operation, url: string, init: RequestInit = {}) {
    // No caller-defined URL, redirect, custom host or credential-bearing query is accepted.
    const u = new URL(url);
    if (u.origin !== 'https://www.googleapis.com' || ![API, UPLOAD].some(base => url.startsWith(base + '/'))) fail('UPSTREAM_INVALID');
    const send = this.options.fetch ?? fetch;
    const sleep = this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = await this.options.getAccessToken();
      if (!token) fail('GOOGLE_REAUTH_REQUIRED');
      let response: Response;
      try {
        const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${token}`);
        response = await send(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000),
          headers });
      } catch {
        if (attempt === 2) fail('UPSTREAM_UNAVAILABLE');
        await sleep(250 * 2 ** attempt); continue;
      }
      if (response.status === 429 || response.status >= 500) {
        const after = response.headers.get('retry-after');
        const retryMs = after && /^\d+$/.test(after) ? Number(after) * 1000
          : after ? Math.max(0, Date.parse(after) - Date.now()) : 250 * 2 ** attempt;
        await response.body?.cancel();
        if (attempt === 2 || !Number.isFinite(retryMs) || retryMs > 10000) {
          throw this.upstreamError(operation, response.status, 'unknown', response.status === 429 ? 'UPSTREAM_RATE_LIMITED' : 'UPSTREAM_UNAVAILABLE');
        }
        await sleep(retryMs); continue;
      }
      return response;
    }
    return fail('UPSTREAM_UNAVAILABLE');
  }
  async checked(response: Response, operation: Operation) {
    if (response.ok) return response;
    let code: UpstreamErrorCode = response.status === 401 ? 'GOOGLE_REAUTH_REQUIRED'
      : response.status === 403 ? 'UPSTREAM_FORBIDDEN_UNKNOWN'
      : response.status === 404 ? 'DRIVE_NOT_FOUND'
      : response.status === 409 ? 'DRIVE_FILE_EXISTS' : 'UPSTREAM_UNAVAILABLE';
    let reason: Reason = 'unknown';
    if (response.status === 403) {
      try {
        reason = forbiddenReason(JSON.parse(Buffer.from(await bounded(response, 16384)).toString('utf8')));
        if (reason !== 'unknown' && reason !== 'unparseable') code = REASONS[reason];
      } catch { reason = 'unparseable'; }
    } else await response.body?.cancel();
    throw this.upstreamError(operation, response.status, reason, code);
  }
  async json(response: Response, operation: Operation): Promise<Record<string, unknown>> {
    await this.checked(response, operation);
    try {
      const parsed: unknown = JSON.parse(Buffer.from(await bounded(response, 1024 * 1024)).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('UPSTREAM_INVALID');
      return parsed as Record<string, unknown>;
    }
    catch (e) { if (e instanceof ServiceError) throw e; return fail('UPSTREAM_INVALID'); }
  }
  async getMetadata(fileId: string): Promise<DriveFile | null> {
    const response = await this.request('get_metadata', `${API}/files/${validId(fileId)}?${new URLSearchParams({ fields: FIELDS, supportsAllDrives: 'true' })}`);
    if (response.status === 404) { await response.body?.cancel(); return null; }
    const obj = await this.json(response, 'get_metadata');
    if (obj.id !== fileId || typeof obj.name !== 'string' || typeof obj.mimeType !== 'string') fail('UPSTREAM_INVALID');
    return obj as unknown as DriveFile;
  }
  async reserveFileId() {
    const obj = await this.json(await this.request('reserve_file_id', `${API}/files/generateIds?count=1&space=drive&type=files`), 'reserve_file_id');
    if (!Array.isArray(obj.ids) || obj.ids.length !== 1 || typeof obj.ids[0] !== 'string') fail('UPSTREAM_INVALID');
    return validId(obj.ids[0]);
  }
  async createJson(fileId: string, folderId: string, name: string, json: string) {
    validId(fileId); validId(folderId);
    if (!name.endsWith('.json') || name.includes('\r') || name.includes('\n') || Buffer.byteLength(json) > 256 * 1024) fail('INVALID_COMMAND');
    const boundary = 'dwmcp_' + randomUUID().replaceAll('-', '');
    const metadata = JSON.stringify({ id: fileId, name, parents: [folderId], mimeType: 'application/json' });
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}\r\n--${boundary}--\r\n`;
    const response = await this.request('create_json', `${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id`, {
      method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body });
    await this.checked(response, 'create_json'); await response.body?.cancel();
  }
  async readBytes(fileId: string, maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 32 * 1024 * 1024) fail('UPSTREAM_INVALID');
    const response = await this.request('read_bytes', `${API}/files/${validId(fileId)}?alt=media&supportsAllDrives=true`);
    await this.checked(response, 'read_bytes'); return bounded(response, maxBytes);
  }
  async findExact(folderId: string, name: string): Promise<DriveFile[]> {
    validId(folderId);
    const files: DriveFile[] = []; let pageToken = '';
    // Two matches are sufficient to prove conflict; bounded pages fail closed if incomplete.
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({ q: `'${queryEscape(folderId)}' in parents and trashed=false and name='${queryEscape(name)}'`,
        spaces: 'drive', pageSize: '2', fields: `nextPageToken,incompleteSearch,files(${FIELDS})`,
        supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
      if (pageToken) params.set('pageToken', pageToken);
      const data = await this.json(await this.request('find_exact', `${API}/files?${params}`), 'find_exact');
      if (data.incompleteSearch === true || !Array.isArray(data.files)) fail('RESULT_CONFLICT');
      for (const file of data.files) {
        if (!file || typeof file !== 'object' || typeof file.id !== 'string' || typeof file.name !== 'string') fail('UPSTREAM_INVALID');
        files.push(file as DriveFile); if (files.length >= 2) return files;
      }
      if (!data.nextPageToken) return files;
      if (typeof data.nextPageToken !== 'string') fail('UPSTREAM_INVALID');
      pageToken = data.nextPageToken;
    }
    return fail('RESULT_CONFLICT');
  }
}
