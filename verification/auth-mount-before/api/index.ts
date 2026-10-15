import { healthResponse, authNotReadyResponse } from '../src/auth/health.ts';

/** Initial deployment scaffold. Deliberately cannot sign in, issue tokens, or execute tools. */
export default { async fetch(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === '/health' && request.method === 'GET') return healthResponse();
  if (path === '/mcp' || path.startsWith('/api/auth/') || path.startsWith('/.well-known/') ||
      ['/sign-in', '/connect', '/consent'].includes(path)) return authNotReadyResponse();
  return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
} };
