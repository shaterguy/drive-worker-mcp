import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import scaffold from '../api/index.ts';

const root = new URL('../', import.meta.url);
const install = 'npm ci --ignore-scripts --no-audit --no-fund --registry https://registry.npmjs.org';

test('deployment serves static files only from explicit public output and pins install policy', async () => {
  const config = JSON.parse(await readFile(new URL('vercel.json', root), 'utf8'));
  assert.equal(config.outputDirectory, 'public', 'STATIC_OUTPUT_DIRECTORY_MUST_BE_PUBLIC');
  assert.equal(config.installCommand, install, 'LOCKED_SCRIPT_FREE_INSTALL_COMMAND_REQUIRED');
  assert.deepEqual(Object.keys(config).sort(), ['installCommand', 'outputDirectory', 'rewrites']);
  assert.deepEqual(config.rewrites, [
    { source: '/health', destination: '/api' }, { source: '/mcp', destination: '/api' },
    { source: '/api/auth/:path*', destination: '/api' }, { source: '/.well-known/:path*', destination: '/api' },
    { source: '/sign-in', destination: '/api' }, { source: '/connect', destination: '/api' },
    { source: '/consent', destination: '/api' }
  ]);
});

test('public output contains only the reviewed non-sensitive robots file, with no symlinks', async () => {
  const directory = new URL('public/', root);
  const stat = await lstat(directory);
  assert.equal(stat.isDirectory(), true); assert.equal(stat.isSymbolicLink(), false);
  assert.deepEqual(await readdir(directory), ['robots.txt']);
  const file = new URL('robots.txt', directory), fileStat = await lstat(file);
  assert.equal(fileStat.isFile(), true); assert.equal(fileStat.isSymbolicLink(), false);
  assert.equal(await readFile(file, 'utf8'), 'User-agent: *\nDisallow: /\n');
});

test('scaffold handler denies internal paths and keeps auth unavailable; deployed static routing is a separate live gate', async () => {
  for (const pathname of ['/src/service.ts', '/sql/core.sql', '/verification/green-no-secret-tests.json',
    '/dist/src/service.js', '/package.json', '/package-lock.json', '/.env', '/.git/config']) {
    const response = await scaffold.fetch(new Request(`https://boundary-fixture.invalid${pathname}`));
    assert.equal(response.status, 404, pathname);
  }
  const health = await scaffold.fetch(new Request('https://boundary-fixture.invalid/health'));
  assert.equal(health.status, 200); assert.equal((await health.json()).user_ready, false);
  assert.equal((await scaffold.fetch(new Request('https://boundary-fixture.invalid/mcp'))).status, 503);
});
