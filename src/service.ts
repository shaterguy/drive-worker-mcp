import { createHash } from 'node:crypto';
import type { Binding, Command, Dependencies, Drive, DriveFile, Principal, Publication, Route, ToolScope } from './contracts.ts';
import { fail, ServiceError } from './errors.ts';
import { canonical, digest, pageText, redact } from './output.ts';

export const LIMITS = Object.freeze({ commandBytes: 256 * 1024, resultBytes: 1024 * 1024,
  logBytes: 8 * 1024 * 1024, pageBytes: 64 * 1024 });
const FOLDER = 'application/vnd.google-apps.folder';
const STATUSES = new Set(['CLAIMED', 'RUNNING', 'DONE', 'FAILED', 'ERROR', 'TIMED_OUT', 'INVALID']);
const COMMAND_KEYS = new Set(['job_id', 'command', 'cwd', 'timeout_ms', 'shell', 'env', 'stdin', 'target_server']);
const FILE_ID = /^[A-Za-z0-9_-]{1,256}$/;
function record(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(error);
  return value as Record<string, unknown>;
}
function exactKeys(obj: Record<string, unknown>, allowed: Set<string>, error: string) {
  if (Object.keys(obj).some(key => !allowed.has(key))) fail(error);
}
function str(value: unknown, max: number, error: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.includes('\0')
    || Buffer.byteLength(value) > max) fail(error);
  return value;
}
function jobId(value: unknown) {
  const id = str(value, 160, 'INVALID_COMMAND');
  if (!/^[A-Za-z0-9._:-]+$/.test(id) || id === '.' || id === '..') fail('INVALID_COMMAND');
  return id;
}
function jsonMime(mime: string) { return mime.toLowerCase().split(';')[0]?.trim() === 'application/json'; }
export function normalizeCommand(input: unknown, route: Route) {
  const obj = record(input, 'INVALID_COMMAND'); exactKeys(obj, COMMAND_KEYS, 'INVALID_COMMAND');
  const id = jobId(obj.job_id);
  if (route === 'manual' && !id.includes('MANUAL')) fail('INVALID_COMMAND');
  const cwd = str(obj.cwd, 4096, 'INVALID_COMMAND');
  if (!cwd.startsWith('/')) fail('INVALID_COMMAND');
  if (!Number.isSafeInteger(obj.timeout_ms) || Number(obj.timeout_ms) < 0 || Number(obj.timeout_ms) > 86400000) fail('INVALID_COMMAND');
  const body: Command = { schema: 'drive-worker-command-v1', job_id: id,
    command: str(obj.command, 128 * 1024, 'INVALID_COMMAND'), cwd, timeout_ms: Number(obj.timeout_ms) };
  if (obj.shell !== undefined) body.shell = str(obj.shell, 4096, 'INVALID_COMMAND');
  if (obj.stdin !== undefined) body.stdin = str(obj.stdin, 64 * 1024, 'INVALID_COMMAND', true);
  if (obj.target_server !== undefined) body.target_server = str(obj.target_server, 128, 'INVALID_COMMAND');
  if (obj.env !== undefined) {
    const env = record(obj.env, 'INVALID_COMMAND');
    if (Object.keys(env).length > 128) fail('INVALID_COMMAND');
    for (const [key, value] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) fail('INVALID_COMMAND');
      str(value, 16 * 1024, 'INVALID_COMMAND', true);
    }
    body.env = Object.fromEntries(Object.entries(env)) as Record<string, string>;
  }
  const json = canonical(body);
  if (Buffer.byteLength(json) > LIMITS.commandBytes) fail('INVALID_COMMAND');
  const { target_server: _target, ...routingPayload } = body;
  return { body, json, hash: digest(json), routingPayloadHash: digest(canonical(routingPayload)),
    routingEligible: body.target_server === undefined || body.target_server.trim().toUpperCase() === 'AUTO' };
}
function link(id: string) { return `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`; }
function fileInFolder(meta: DriveFile | null, folder: string, name: string, json = false): meta is DriveFile {
  return !!meta && FILE_ID.test(meta.id) && !meta.trashed && meta.name === name
    && meta.parents?.length === 1 && meta.parents[0] === folder && (!json || jsonMime(meta.mimeType));
}
function publicationReply(p: Publication) {
  return { job_id: p.jobId, route: p.route, publication_status: p.state, command_file_id: p.fileId,
    command_url: link(p.fileId), execution_status: p.route === 'manual' ? 'AWAITING_MANUAL' : 'SUBMITTED_UNCONFIRMED',
    execution_observed: false };
}
export class DriveWorkerService {
  readonly deps: Dependencies;
  readonly logLimit: number;
  constructor(deps: Dependencies) {
    if (!(deps.cursorKey instanceof Uint8Array) || deps.cursorKey.byteLength < 32
      || typeof deps.assertActiveGrant !== 'function') fail('SERVICE_NOT_CONFIGURED');
    this.deps = deps;
    this.logLimit = deps.maxLogBytes ?? LIMITS.logBytes;
    if (!Number.isSafeInteger(this.logLimit) || this.logLimit < LIMITS.pageBytes || this.logLimit > 32 * 1024 * 1024) fail('SERVICE_NOT_CONFIGURED');
  }
  async authorize(principal: Principal, scope: ToolScope) {
    if (!principal?.accountId || !principal.grantId || !principal.clientId) fail('AUTH_REQUIRED');
    if (!principal.scopes?.has(scope)) fail('INSUFFICIENT_SCOPE');
    // This must execute for every invocation; a JWT validity check alone cannot observe revocation.
    try { await this.deps.assertActiveGrant(principal); }
    catch { fail('AUTH_REQUIRED'); }
  }
  async context(p: Principal) {
    const binding = await this.deps.store.getBinding(p.accountId);
    if (!binding) fail('FOLDER_BINDING_REQUIRED');
    if (binding.accountId !== p.accountId || binding.manualFolderId === binding.commandsFolderId
      || binding.resultsFolderId === binding.manualFolderId || binding.resultsFolderId === binding.commandsFolderId
      || ![binding.manualFolderId, binding.commandsFolderId, binding.resultsFolderId].every(id => FILE_ID.test(id))) fail('FOLDER_UNAVAILABLE');
    return { binding, drive: await this.deps.driveForAccount(p.accountId) };
  }
  async folder(drive: Drive, id: string, write: boolean) {
    const meta = await drive.getMetadata(id);
    if (!meta || meta.id !== id || meta.trashed || meta.mimeType !== FOLDER
      || (write && meta.capabilities?.canAddChildren !== true)) fail('FOLDER_UNAVAILABLE');
  }
  publishManual(p: Principal, input: unknown) { return this.publish(p, input, 'manual'); }
  submitDirect(p: Principal, input: unknown) { return this.publish(p, input, 'direct'); }
  async publish(p: Principal, input: unknown, route: Route) {
    await this.authorize(p, route === 'manual' ? 'manual:publish' : 'jobs:submit');
    const command = normalizeCommand(input, route);
    const { drive, binding } = await this.context(p);
    const folderId = route === 'manual' ? binding.manualFolderId : binding.commandsFolderId;
    await this.folder(drive, folderId, true);
    let pub = await this.deps.store.getPublication(p.accountId, command.body.job_id);
    if (!pub) {
      const fileId = await drive.reserveFileId();
      if (!FILE_ID.test(fileId)) fail('UPSTREAM_INVALID');
      // No Drive write happens until this immutable ID is durably reserved.
      pub = await this.deps.store.reservePublication({ accountId: p.accountId, jobId: command.body.job_id,
        route, contentHash: command.hash, routingPayloadHash: command.routingPayloadHash,
        routingEligible: command.routingEligible, createdTime: null, fileId, folderId, state: 'PREPARING' });
    }
    if (pub.accountId !== p.accountId || pub.jobId !== command.body.job_id || pub.route !== route || pub.contentHash !== command.hash) fail('IDEMPOTENCY_CONFLICT');
    if (pub.state === 'PUBLISHED' || pub.state === 'SUBMITTED') return publicationReply(pub);
    if (pub.folderId !== folderId) fail('IDEMPOTENCY_CONFLICT');
    try {
      let meta = await drive.getMetadata(pub.fileId);
      let createError: unknown;
      if (!meta) {
        try { await drive.createJson(pub.fileId, folderId, `${pub.jobId}.json`, command.json); }
        catch (e) { createError = e; }
        meta = await drive.getMetadata(pub.fileId);
      }
      if (!meta && createError instanceof ServiceError && ['GOOGLE_REAUTH_REQUIRED', 'INSUFFICIENT_SCOPE',
        'DRIVE_PERMISSION_DENIED', 'UPSTREAM_RATE_LIMITED'].includes(createError.code)) throw createError;
      if (!fileInFolder(meta, folderId, `${pub.jobId}.json`, true) || meta.id !== pub.fileId || !meta.createdTime
        || !Number.isFinite(Date.parse(meta.createdTime))) fail('SUBMISSION_OUTCOME_UNKNOWN');
      const text = await this.stableRead(drive, meta, LIMITS.commandBytes, 'SUBMISSION_OUTCOME_UNKNOWN');
      if (digest(text) !== pub.contentHash) fail('SUBMISSION_OUTCOME_UNKNOWN');
      pub = await this.deps.store.setPublicationState(p.accountId, pub.jobId, route === 'manual' ? 'PUBLISHED' : 'SUBMITTED', meta.createdTime);
      return publicationReply(pub);
    } catch (e) {
      try { await this.deps.store.setPublicationState(p.accountId, pub.jobId, 'UNKNOWN'); } catch { /* Preserve the original durable reservation. */ }
      if (e instanceof ServiceError && ['GOOGLE_REAUTH_REQUIRED', 'INSUFFICIENT_SCOPE',
        'DRIVE_PERMISSION_DENIED', 'UPSTREAM_RATE_LIMITED'].includes(e.code)) throw e;
      fail('SUBMISSION_OUTCOME_UNKNOWN');
    }
  }
  text(value: unknown, max = 16384): string | null {
    if (typeof value !== 'string') return null;
    const clean = redact(this.deps.redact ? this.deps.redact(value) : value);
    const bytes = Buffer.from(clean);
    if (bytes.length <= max) return clean;
    let end = max - Buffer.byteLength('[TRUNCATED]');
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString('utf8') + '[TRUNCATED]';
  }
  async stableRead(drive: Drive, meta: DriveFile, max: number, error = 'RESULT_INVALID') {
    let bytes: Uint8Array;
    try { bytes = await drive.readBytes(meta.id, max); }
    catch (e) {
      if (e instanceof ServiceError && e.code === 'UPSTREAM_TOO_LARGE') fail(error === 'CURSOR_INVALID' ? 'LOG_TOO_LARGE' : 'RESULT_TOO_LARGE');
      throw e;
    }
    const after = await drive.getMetadata(meta.id);
    const identity = (f: DriveFile) => canonical({ id: f.id, name: f.name, mimeType: f.mimeType,
      parents: f.parents ?? [], trashed: f.trashed ?? false, version: f.version ?? '', modifiedTime: f.modifiedTime ?? '', size: f.size ?? '' });
    if (!after || identity(after) !== identity(meta)) fail(error);
    if (meta.md5Checksum && createHash('md5').update(bytes).digest('hex') !== meta.md5Checksum) fail(error);
    return Buffer.from(bytes).toString('utf8');
  }
  async verifyResultCommand(drive: Drive, binding: Binding, pub: Publication | null, result: Record<string, unknown>) {
    if (!pub || result.command_file_id === undefined || result.command_file_id === null) return 'not_available';
    if (result.command_file_id === pub.fileId) return 'exact';
    if (!pub.routingEligible || !pub.createdTime || typeof result.command_file_id !== 'string'
      || !FILE_ID.test(result.command_file_id)) fail('RESULT_INVALID');
    const meta = await drive.getMetadata(result.command_file_id);
    if (!meta || meta.trashed || !jsonMime(meta.mimeType) || meta.parents?.length !== 1
      || meta.parents[0] !== binding.commandsFolderId) fail('RESULT_INVALID');
    const raw = await this.stableRead(drive, meta, LIMITS.commandBytes);
    let routed: Record<string, unknown>;
    try { routed = record(JSON.parse(raw.replace(/^\uFEFF/, '')), 'RESULT_INVALID'); }
    catch { return fail('RESULT_INVALID'); }
    const target = routed.target_server;
    if (typeof target !== 'string' || !target.trim() || target.trim().toUpperCase() === 'AUTO'
      || routed.origin_command_file_id !== pub.fileId || routed.origin_command_created_at !== pub.createdTime
      || routed.job_id !== pub.jobId) fail('RESULT_INVALID');
    const safeTarget = target.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
    if (meta.name !== `${pub.jobId}.target-${safeTarget}.json`) fail('RESULT_INVALID');
    const { target_server: _target, origin_command_file_id: _origin, origin_command_created_at: _created, ...payload } = routed;
    if (digest(canonical(payload)) !== pub.routingPayloadHash) fail('RESULT_INVALID');
    return 'verified_routed_copy';
  }
  async loadResult(p: Principal, id: string) {
    const { binding, drive } = await this.context(p);
    await this.folder(drive, binding.resultsFolderId, false);
    const matches = await drive.findExact(binding.resultsFolderId, `${id}.json`);
    if (matches.length > 1) fail('RESULT_CONFLICT');
    const pub = await this.deps.store.getPublication(p.accountId, id);
    const meta = matches[0];
    if (!meta) return { binding, drive, pub, result: null, meta: null, linkage: 'not_available' };
    // Never trust only the search result's parent/name: re-read its exact metadata.
    const current = await drive.getMetadata(meta.id);
    if (!fileInFolder(current, binding.resultsFolderId, `${id}.json`, true)) fail('RESULT_INVALID');
    let result: Record<string, unknown>;
    try { result = record(JSON.parse((await this.stableRead(drive, current, LIMITS.resultBytes)).replace(/^\uFEFF/, '')), 'RESULT_INVALID'); }
    catch (e) { if (e instanceof ServiceError) throw e; return fail('RESULT_INVALID'); }
    if (result.schema !== 'drive-worker-result-v1' || result.job_id !== id || typeof result.status !== 'string'
      || !STATUSES.has(result.status)) fail('RESULT_INVALID');
    const linkage = await this.verifyResultCommand(drive, binding, pub, result);
    return { binding, drive, pub, result, meta: current, linkage };
  }
  summary(id: string, loaded: Awaited<ReturnType<DriveWorkerService['loadResult']>>): Record<string, unknown> {
    const observed_at = (this.deps.now?.() ?? new Date()).toISOString();
    if (!loaded.result || !loaded.meta) {
      if (!loaded.pub) fail('RESULT_NOT_FOUND');
      return { ...publicationReply(loaded.pub), source: 'publication', observed_at,
        execution_status: loaded.pub.state === 'UNKNOWN' || loaded.pub.state === 'PREPARING' || loaded.pub.state === 'FAILED' ? 'SUBMISSION_OUTCOME_UNKNOWN'
          : loaded.pub.route === 'manual' ? 'AWAITING_MANUAL' : 'SUBMITTED_UNCONFIRMED' };
    }
    const r = loaded.result;
    return { job_id: id, source: 'worker_result', observed_at, execution_status: r.status,
      publication_status: loaded.pub?.state ?? null, result_file_id: loaded.meta.id, result_url: link(loaded.meta.id),
      publication_linkage: loaded.linkage, executor_host: this.text(r.executor_host, 256),
      execution_outcome_uncertain: r.execution_outcome_uncertain === true,
      error: this.text(r.error, 4096), reason: this.text(r.reason, 4096),
      exit_code: typeof r.exit_code === 'number' && Number.isSafeInteger(r.exit_code) ? r.exit_code : null,
      signal: this.text(r.signal, 128), stdout_tail: this.text(r.stdout_tail), stderr_tail: this.text(r.stderr_tail) };
  }
  async getStatus(p: Principal, input: unknown) {
    await this.authorize(p, 'jobs:read');
    const obj = record(input, 'INVALID_COMMAND'); exactKeys(obj, new Set(['job_id']), 'INVALID_COMMAND');
    const id = jobId(obj.job_id); return this.summary(id, await this.loadResult(p, id));
  }
  async getResult(p: Principal, input: unknown) {
    await this.authorize(p, 'jobs:read');
    const obj = record(input, 'INVALID_COMMAND'); exactKeys(obj, new Set(['job_id', 'stream', 'cursor', 'limit']), 'INVALID_COMMAND');
    const id = jobId(obj.job_id); const stream = obj.stream === undefined ? 'summary' : obj.stream;
    if (typeof stream !== 'string' || !['summary', 'stdout', 'stderr'].includes(stream)) fail('INVALID_COMMAND');
    const limit = obj.limit === undefined ? 8192 : obj.limit;
    if (!Number.isSafeInteger(limit) || Number(limit) < 256 || Number(limit) > LIMITS.pageBytes) fail('INVALID_COMMAND');
    if (obj.cursor !== undefined && typeof obj.cursor !== 'string') fail('CURSOR_INVALID');
    if (stream === 'summary' && obj.cursor !== undefined) fail('CURSOR_INVALID');
    const loaded = await this.loadResult(p, id);
    if (!loaded.result || !loaded.meta) fail('RESULT_NOT_FOUND');
    const summary = this.summary(id, loaded);
    if (stream === 'summary') return { ...summary, stream, text: null, next_cursor: null };
    const fileId = loaded.result[`${String(stream)}_file_id`];
    if (typeof fileId !== 'string' || !FILE_ID.test(fileId)) fail('RESULT_NOT_FOUND');
    const meta = await loaded.drive.getMetadata(fileId);
    if (!fileInFolder(meta, loaded.binding.resultsFolderId, `${id}.${String(stream)}.txt`)
      || meta.mimeType.toLowerCase().split(';')[0]?.trim() !== 'text/plain') fail('RESULT_INVALID');
    if (meta.size && (!/^\d+$/.test(meta.size) || Number(meta.size) > this.logLimit)) fail('LOG_TOO_LARGE');
    const raw = await this.stableRead(loaded.drive, meta, this.logLimit, 'CURSOR_INVALID');
    const text = redact(this.deps.redact ? this.deps.redact(raw) : raw);
    const binding = digest(canonical({ account: p.accountId, job: id, stream, file: fileId,
      result: loaded.meta.id, resultVersion: loaded.meta.version ?? loaded.meta.modifiedTime ?? '',
      fileVersion: meta.version ?? meta.modifiedTime ?? '', content: digest(text), sanitizer: 1 }));
    const { stdout_tail: _stdout, stderr_tail: _stderr, error: _error, reason: _reason, ...pageSummary } = summary;
    return { ...pageSummary, stream, ...pageText(text, binding, this.deps.cursorKey, Number(limit), obj.cursor as string | undefined) };
  }
}
