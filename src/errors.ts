export class ServiceError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'ServiceError'; this.code = code; }
}
export function fail(code: string): never { throw new ServiceError(code); }
export function safeError(error: unknown): { code: string } {
  return { code: error instanceof ServiceError ? error.code : 'INTERNAL_ERROR' };
}
