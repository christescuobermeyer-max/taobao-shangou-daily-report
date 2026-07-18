import test from 'node:test';
import assert from 'node:assert/strict';
import { createConcurrencyLimiter, createKeyedDeduper } from './async-control.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('concurrency limiter never runs more than the configured limit', async () => {
  const limiter = createConcurrencyLimiter(3);
  const gates = Array.from({ length: 6 }, () => deferred());
  let active = 0;
  let maximumActive = 0;

  const tasks = gates.map((gate) => limiter.run(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await gate.promise;
    active -= 1;
  }));

  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(limiter.stats(), { limit: 3, active: 3, pending: 3 });
  gates.slice(0, 3).forEach((gate) => gate.resolve());
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(limiter.stats(), { limit: 3, active: 3, pending: 0 });
  gates.slice(3).forEach((gate) => gate.resolve());
  await Promise.all(tasks);
  assert.equal(maximumActive, 3);
  assert.deepEqual(limiter.stats(), { limit: 3, active: 0, pending: 0 });
});

test('concurrency limiter continues after a task rejects', async () => {
  const limiter = createConcurrencyLimiter(1);
  const order = [];
  const first = limiter.run(async () => {
    order.push('first');
    throw new Error('failed');
  });
  const second = limiter.run(async () => { order.push('second'); });

  await assert.rejects(first, /failed/);
  await second;
  assert.deepEqual(order, ['first', 'second']);
});

test('keyed deduper runs one operation for concurrent requests with the same key', async () => {
  const deduper = createKeyedDeduper();
  const gate = deferred();
  let calls = 0;
  const operation = async () => {
    calls += 1;
    await gate.promise;
    return 'report';
  };
  const first = deduper.run('1330475849-20260716', operation);
  const second = deduper.run('1330475849-20260716', operation);
  gate.resolve();

  assert.deepEqual(await Promise.all([first, second]), ['report', 'report']);
  assert.equal(calls, 1);
  assert.equal(deduper.size(), 0);
});

test('keyed deduper clears a failed operation so it can be retried', async () => {
  const deduper = createKeyedDeduper();
  let calls = 0;
  await assert.rejects(
    deduper.run('shop-date', async () => {
      calls += 1;
      throw new Error('temporary');
    }),
    /temporary/,
  );
  assert.equal(await deduper.run('shop-date', async () => {
    calls += 1;
    return 'ok';
  }), 'ok');
  assert.equal(calls, 2);
});
