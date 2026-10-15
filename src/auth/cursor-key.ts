import { hkdfSync } from 'node:crypto';
import { AuthBoundaryError, type AuthConfig } from './config.ts';

/** Standard KDF, solely for the existing application pagination MAC. Never OAuth signing. */
export function deriveCursorKey(config: Pick<AuthConfig, 'secret' | 'resource'>): Uint8Array {
  const info = `drive-worker-mcp/cursor/v1\0${config.resource}`;
  if (Buffer.byteLength(config.secret) < 32 || Buffer.byteLength(info) > 1024) {
    throw new AuthBoundaryError('AUTH_CONFIGURATION_INVALID');
  }
  return new Uint8Array(hkdfSync('sha256', config.secret,
    'drive-worker-mcp/hkdf-sha256/v1', info, 32));
}
