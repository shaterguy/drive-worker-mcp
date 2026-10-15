import { GOOGLE_CALLBACK_PATH } from './config.ts';

/** Liveness is intentionally separate from auth readiness and user usability. */
export function healthResponse(): Response {
  return Response.json({
    service: 'drive-worker-mcp', version: '0.1.0-dev1', status: 'alive',
    authentication: 'not_ready', user_ready: false,
    google_callback_path: GOOGLE_CALLBACK_PATH,
  }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export function authNotReadyResponse(): Response {
  return Response.json({ error: 'AUTH_NOT_READY', message: 'Authentication setup and verification are incomplete.' }, {
    status: 503, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
