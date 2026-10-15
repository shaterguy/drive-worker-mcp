import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { awaitAuthContext } from '../src/auth/bootstrap.ts';

test('auth context must resolve; immediate rejection is sanitized', async () => {
  await awaitAuthContext(Promise.resolve({}), 100);
  await assert.rejects(awaitAuthContext(Promise.reject(new Error('synthetic unsafe detail')), 100),
    { message: 'AUTH_UNAVAILABLE' });
});
test('auth context timeout rejects safely and consumes a later context rejection', async () => {
  let rejectContext: (reason: unknown) => void = () => { throw new Error('FIXTURE_PROMISE_NOT_INITIALIZED'); };
  const context = new Promise<unknown>((_resolve, reject) => { rejectContext = reject; });
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', record);
  try {
    await assert.rejects(awaitAuthContext(context, 1), { message: 'AUTH_UNAVAILABLE' });
    rejectContext(new Error('synthetic late provider detail'));
    await setImmediate();
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', record); }
});
