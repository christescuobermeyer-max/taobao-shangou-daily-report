import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReportGateway, isValidRequestId } from './report-gateway.mjs';

function createClock(start = 1_000_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => { value += ms; },
  };
}

test('request IDs accept bounded safe identifiers only', () => {
  assert.equal(isValidRequestId('5cb5eb64-6b66-4ce7-bbb0-64cc95c8615f'), true);
  assert.equal(isValidRequestId('request_12345678'), true);
  assert.equal(isValidRequestId('short'), false);
  assert.equal(isValidRequestId('../unsafe-request'), false);
  assert.equal(isValidRequestId('a'.repeat(65)), false);
});

test('gateway follows the report lifecycle and exposes minimal public fields', () => {
  const clock = createClock();
  const gateway = createReportGateway({ now: clock.now, llmConcurrency: 3 });
  gateway.register({ key: '1330475849-20260716', shopId: '1330475849', date: '20260716', requestId: 'request_12345678' });
  clock.advance(500);
  gateway.transition('1330475849-20260716', 'fetching_browser');
  clock.advance(300);

  const snapshot = gateway.snapshot('request_12345678');
  assert.equal(snapshot.summary.current, 1);
  assert.equal(snapshot.me.shopId, '1330475849');
  assert.equal(snapshot.me.status, 'fetching_browser');
  assert.equal(snapshot.me.elapsedMs, 800);
  assert.equal(snapshot.me.stageElapsedMs, 300);
  assert.equal(snapshot.me.reportType, 'daily');
  assert.equal(snapshot.me.periodLabel, '昨日');
  assert.deepEqual(Object.keys(snapshot.jobs[0]).sort(), ['elapsedMs', 'isMine', 'periodLabel', 'reportType', 'shopId', 'status', 'statusText']);
  assert.equal(JSON.stringify(snapshot).includes('request_12345678'), false);
  assert.equal(JSON.stringify(snapshot).includes('20260716'), false);
});

test('daily and weekly periods remain distinct and expose their report labels', () => {
  const gateway = createReportGateway();
  gateway.register({
    key: 'daily-1330475849-20260717-20260717',
    shopId: '1330475849',
    beginDate: '20260717',
    endDate: '20260717',
    reportType: 'daily',
    periodLabel: '昨日',
    requestId: 'request_daily_123',
  });
  gateway.register({
    key: 'weekly-1330475849-20260711-20260717',
    shopId: '1330475849',
    beginDate: '20260711',
    endDate: '20260717',
    reportType: 'weekly',
    periodLabel: '近7日',
    requestId: 'request_weekly_1',
  });
  const daily = gateway.snapshot('request_daily_123');
  const weekly = gateway.snapshot('request_weekly_1');
  assert.equal(daily.summary.current, 2);
  assert.equal(daily.me.reportType, 'daily');
  assert.equal(weekly.me.reportType, 'weekly');
  assert.equal(weekly.me.periodLabel, '近7日');
});

test('same shop and date share one execution while each request sees it as mine', () => {
  const gateway = createReportGateway({ llmConcurrency: 3 });
  const first = gateway.register({ key: 'shop-date', shopId: '1330475849', date: '20260716', requestId: 'request_first_1' });
  const second = gateway.register({ key: 'shop-date', shopId: '1330475849', date: '20260716', requestId: 'request_second_2' });

  assert.equal(first.isNew, true);
  assert.equal(second.isNew, false);
  assert.equal(gateway.snapshot('request_first_1').summary.current, 1);
  assert.equal(gateway.snapshot('request_first_1').jobs[0].isMine, true);
  assert.equal(gateway.snapshot('request_second_2').jobs[0].isMine, true);
});

test('gateway rejects invalid state transitions', () => {
  const gateway = createReportGateway();
  gateway.register({ key: 'shop-date', shopId: '1330475849', date: '20260716' });
  assert.throws(() => gateway.transition('shop-date', 'generating_llm'), /状态流转/);
  gateway.transition('shop-date', 'fetching_browser');
  gateway.transition('shop-date', 'waiting_llm');
  gateway.transition('shop-date', 'generating_llm');
  gateway.transition('shop-date', 'completed');
  assert.throws(() => gateway.transition('shop-date', 'failed'), /不存在|状态流转/);
});

test('summary, queue positions, and three-slot estimates match active work', () => {
  const clock = createClock();
  const gateway = createReportGateway({ now: clock.now, llmConcurrency: 3, initialDurationsMs: [40_000, 50_000, 60_000] });
  const ids = ['10000001', '10000002', '10000003', '10000004', '10000005'];
  for (const [index, shopId] of ids.entries()) {
    gateway.register({ key: `key-${shopId}`, shopId, date: '20260716', requestId: `request_${index}_123456` });
    gateway.transition(`key-${shopId}`, 'fetching_browser');
    gateway.transition(`key-${shopId}`, 'waiting_llm');
  }
  for (const shopId of ids.slice(0, 3)) gateway.transition(`key-${shopId}`, 'generating_llm');
  clock.advance(20_000);

  const firstWaiting = gateway.snapshot('request_3_123456');
  const secondWaiting = gateway.snapshot('request_4_123456');
  assert.deepEqual(firstWaiting.summary, {
    current: 5,
    generating: 3,
    waiting: 2,
    llmConcurrency: 3,
    averageGenerationMs: 50_000,
    averageSampleSize: 3,
    hiddenCount: 0,
  });
  assert.equal(firstWaiting.me.queuePosition, 1);
  assert.equal(firstWaiting.me.estimatedRemainingMs, 80_000);
  assert.equal(secondWaiting.me.queuePosition, 2);
  assert.equal(secondWaiting.me.estimatedRemainingMs, 80_000);
});

test('successful model durations persist, restore, and use the latest twenty samples', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'report-gateway-'));
  const metricsPath = join(dir, 'gateway-metrics.json');
  const clock = createClock();
  try {
    const gateway = createReportGateway({ now: clock.now, metricsPath });
    for (let index = 1; index <= 25; index += 1) {
      const key = `key-${index}`;
      gateway.register({ key, shopId: String(10_000_000 + index), date: '20260716' });
      gateway.transition(key, 'fetching_browser');
      gateway.transition(key, 'waiting_llm');
      gateway.transition(key, 'generating_llm');
      clock.advance(index * 1_000);
      gateway.transition(key, 'completed');
    }
    await gateway.flush();
    const persisted = JSON.parse(readFileSync(metricsPath, 'utf8'));
    assert.equal(persisted.modelDurationsMs.length, 25);
    const restored = createReportGateway({ now: clock.now, metricsPath });
    assert.equal(restored.snapshot().summary.averageSampleSize, 20);
    assert.equal(restored.snapshot().summary.averageGenerationMs, 15_500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed and completed executions leave the active list and expire after retention', () => {
  const clock = createClock();
  const gateway = createReportGateway({ now: clock.now, terminalRetentionMs: 1_000 });
  gateway.register({ key: 'failed-key', shopId: '1330475849', date: '20260716', requestId: 'request_failed_1' });
  gateway.transition('failed-key', 'failed', { errorCode: 'MODEL_ERROR' });
  assert.equal(gateway.snapshot('request_failed_1').summary.current, 0);
  assert.equal(gateway.snapshot('request_failed_1').me.status, 'failed');
  clock.advance(1_001);
  assert.equal(gateway.snapshot('request_failed_1').me, null);
});

test('cache hits terminate without entering generation metrics', () => {
  const gateway = createReportGateway({ initialDurationsMs: [10_000, 20_000, 30_000] });
  gateway.register({ key: 'cache-key', shopId: '1330475849', date: '20260716', requestId: 'request_cache_1' });
  gateway.transition('cache-key', 'cache_hit');
  const snapshot = gateway.snapshot('request_cache_1');
  assert.equal(snapshot.summary.current, 0);
  assert.equal(snapshot.summary.averageGenerationMs, 20_000);
  assert.equal(snapshot.me.status, 'cache_hit');
  assert.equal(snapshot.me.statusText, '已从缓存读取');
});
