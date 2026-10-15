import { AuthBoundaryError, type AuthConfig } from './config.ts';

export function assertRequestOrigin(request: Request, config: Pick<AuthConfig, 'origin'>): void {
  const url = new URL(request.url);
  const expected = new URL(config.origin);
  // Proxies may supply forwarding headers; none are an authority source here.
  if (url.origin !== config.origin || url.username || url.password || url.hash) throw new AuthBoundaryError('INVALID_HOST');
  const host = request.headers.get('host');
  if (host !== null && host.toLowerCase() !== expected.host) throw new AuthBoundaryError('INVALID_HOST');
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== config.origin) throw new AuthBoundaryError('INVALID_ORIGIN');
}

/** Enforce while streaming, including missing or misleading Content-Length. */
export async function boundedRequest(request: Request, limit = 1024 * 1024): Promise<Request> {
  const encoding = request.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') throw new AuthBoundaryError('INVALID_REQUEST');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new AuthBoundaryError('REQUEST_TOO_LARGE');
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); throw new AuthBoundaryError('REQUEST_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new Request(request, { body: bytes });
}

export function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
