import { ServiceError } from '../src/errors.ts';
import type { Binding, Drive, DriveFile, Publication, PublicationState, Store } from '../src/contracts.ts';

export class FakeStore implements Store {
  bindings = new Map<string, Binding>();
  publications = new Map<string, Publication>();
  failStateOnce = false;
  key(a: string, j: string) { return JSON.stringify([a, j]); }
  async getBinding(a: string) { return this.bindings.get(a) ?? null; }
  async getPublication(a: string, j: string) { return this.publications.get(this.key(a, j)) ?? null; }
  async reservePublication(p: Publication) {
    const k = this.key(p.accountId, p.jobId);
    if (!this.publications.has(k)) this.publications.set(k, { ...p });
    return this.publications.get(k)!;
  }
  async setPublicationState(a: string, j: string, state: PublicationState, createdTime?: string) {
    if (this.failStateOnce) { this.failStateOnce = false; throw new Error('database unavailable'); }
    const p = this.publications.get(this.key(a, j))!;
    if (!['PUBLISHED', 'SUBMITTED'].includes(p.state)) p.state = state;
    if (createdTime && !p.createdTime) p.createdTime = createdTime;
    return { ...p };
  }
}
export class FakeDrive implements Drive {
  files = new Map<string, { meta: DriveFile; bytes: Uint8Array }>();
  writes: string[] = []; reads: string[] = []; reserved = 0; loseResponseOnce = false;
  async reserveFileId() { return `reserved-${++this.reserved}`; }
  async getMetadata(id: string) { return this.files.get(id)?.meta ?? null; }
  async createJson(id: string, parent: string, name: string, text: string) {
    if (this.files.has(id)) throw new ServiceError('DRIVE_FILE_EXISTS');
    this.writes.push(parent);
    this.put(id, name, parent, text, 'application/json');
    if (this.loseResponseOnce) { this.loseResponseOnce = false; throw new Error('lost response'); }
  }
  async readBytes(id: string, max: number) {
    this.reads.push(id);
    const b = this.files.get(id)?.bytes;
    if (!b) throw new ServiceError('DRIVE_NOT_FOUND');
    if (b.length > max) throw new ServiceError('UPSTREAM_TOO_LARGE');
    return b;
  }
  async findExact(parent: string, name: string) {
    return [...this.files.values()].map(x => x.meta)
      .filter(x => x.name === name && x.parents?.includes(parent) && !x.trashed).slice(0, 2);
  }
  folder(id: string, writable = true) {
    this.files.set(id, { meta: { id, name: id, mimeType: 'application/vnd.google-apps.folder',
      trashed: false, capabilities: { canAddChildren: writable } }, bytes: new Uint8Array() });
  }
  put(id: string, name: string, parent: string, text: string, mimeType = 'text/plain') {
    const bytes = new TextEncoder().encode(text);
    this.files.set(id, { meta: { id, name, parents: [parent], mimeType, trashed: false,
      createdTime: '2026-01-01T00:00:00.000Z', modifiedTime: '2026-01-01T00:00:00.000Z',
      size: String(bytes.length) }, bytes });
  }
}
