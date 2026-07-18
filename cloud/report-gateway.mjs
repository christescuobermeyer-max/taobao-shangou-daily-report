import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const STATUS_TEXT = Object.freeze({
  waiting_browser: '等待读取',
  fetching_browser: '正在读取',
  waiting_llm: '等待生成',
  generating_llm: '正在生成',
  completed: '已生成',
  failed: '生成失败',
  cache_hit: '已从缓存读取',
});

const NEXT_STATUS = Object.freeze({
  waiting_browser: new Set(['fetching_browser', 'failed', 'cache_hit']),
  fetching_browser: new Set(['waiting_llm', 'failed']),
  waiting_llm: new Set(['generating_llm', 'failed']),
  generating_llm: new Set(['completed', 'failed']),
});

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cache_hit']);
const WAITING_STATUSES = new Set(['waiting_browser', 'waiting_llm']);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidRequestId(value) {
  return REQUEST_ID_PATTERN.test(String(value || ''));
}

function positiveDurations(values) {
  return Array.isArray(values)
    ? values.map(Number).filter((value) => Number.isFinite(value) && value > 0).slice(-100)
    : [];
}

function readDurations(metricsPath) {
  if (!metricsPath || !existsSync(metricsPath)) return [];
  try {
    return positiveDurations(JSON.parse(readFileSync(metricsPath, 'utf8'))?.modelDurationsMs);
  } catch {
    return [];
  }
}

function average(values) {
  if (values.length < 3) return null;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function publicJob(execution, requestId, now) {
  return {
    shopId: execution.shopId,
    reportType: execution.reportType,
    periodLabel: execution.periodLabel,
    status: execution.status,
    statusText: STATUS_TEXT[execution.status],
    elapsedMs: Math.max(0, now - execution.submittedAt),
    isMine: Boolean(requestId && execution.requestIds.has(requestId)),
  };
}

export function createReportGateway({
  metricsPath = '',
  llmConcurrency = 3,
  now = Date.now,
  terminalRetentionMs = 5 * 60 * 1000,
  maxTerminal = 100,
  maxPublicJobs = 20,
  initialDurationsMs,
  onPersistError = () => undefined,
} = {}) {
  if (!Number.isInteger(llmConcurrency) || llmConcurrency < 1) throw new Error('模型并发必须是正整数');
  const activeByKey = new Map();
  const byRequestId = new Map();
  const terminal = [];
  let durations = initialDurationsMs === undefined ? readDurations(metricsPath) : positiveDurations(initialDurationsMs);
  let writeSequence = 0;
  let executionSequence = 0;
  let writeChain = Promise.resolve();
  let lastPersistError = null;

  function cleanup(at = now()) {
    while (terminal.length > 0) {
      const oldest = terminal[0];
      if (terminal.length <= maxTerminal && at - oldest.completedAt <= terminalRetentionMs) break;
      terminal.shift();
      for (const requestId of oldest.requestIds) {
        if (byRequestId.get(requestId) === oldest) byRequestId.delete(requestId);
      }
    }
  }

  function queueMetricsWrite() {
    if (!metricsPath) return;
    const payload = JSON.stringify({
      version: 1,
      modelDurationsMs: [...durations],
      updatedAt: new Date(now()).toISOString(),
    }, null, 2);
    const tempPath = `${metricsPath}.tmp-${process.pid}-${++writeSequence}`;
    writeChain = writeChain
      .catch(() => undefined)
      .then(async () => {
        mkdirSync(dirname(metricsPath), { recursive: true, mode: 0o700 });
        await writeFile(tempPath, payload, { mode: 0o600 });
        await rename(tempPath, metricsPath);
        lastPersistError = null;
      })
      .catch((error) => {
        lastPersistError = error;
        onPersistError(error);
      });
  }

  function register({ key, shopId, date, beginDate = date, endDate = date, reportType = 'daily', periodLabel, requestId } = {}) {
    cleanup();
    const normalizedKey = String(key || '').trim();
    const normalizedShopId = String(shopId || '').trim();
    const normalizedBeginDate = String(beginDate || '').trim();
    const normalizedEndDate = String(endDate || '').trim();
    const normalizedType = String(reportType || '').trim();
    const normalizedLabel = String(periodLabel || (normalizedType === 'weekly' ? '近7日' : '昨日')).trim();
    if (!normalizedKey || !/^\d{5,20}$/.test(normalizedShopId)
      || !/^\d{8}$/.test(normalizedBeginDate) || !/^\d{8}$/.test(normalizedEndDate)
      || !['daily', 'weekly'].includes(normalizedType)) {
      throw new Error('网关任务参数无效');
    }
    if (requestId && !isValidRequestId(requestId)) throw new Error('网关 requestId 无效');

    if (requestId && byRequestId.has(requestId)) {
      const existingRequest = byRequestId.get(requestId);
      if (existingRequest.key !== normalizedKey) throw new Error('requestId 已用于其他任务');
      return { execution: existingRequest, isNew: false };
    }

    let execution = activeByKey.get(normalizedKey);
    const isNew = !execution;
    if (!execution) {
      const timestamp = now();
      execution = {
        key: normalizedKey,
        order: ++executionSequence,
        shopId: normalizedShopId,
        date: normalizedEndDate,
        beginDate: normalizedBeginDate,
        endDate: normalizedEndDate,
        reportType: normalizedType,
        periodLabel: normalizedLabel,
        status: 'waiting_browser',
        submittedAt: timestamp,
        stageStartedAt: timestamp,
        browserStartedAt: null,
        llmQueuedAt: null,
        llmStartedAt: null,
        completedAt: null,
        requestIds: new Set(),
        errorCode: null,
      };
      activeByKey.set(normalizedKey, execution);
    }
    if (requestId) {
      execution.requestIds.add(requestId);
      byRequestId.set(requestId, execution);
    }
    return { execution, isNew };
  }

  function transition(key, nextStatus, { errorCode = null } = {}) {
    const normalizedKey = String(key || '');
    const execution = activeByKey.get(normalizedKey);
    if (!execution) throw new Error(`网关任务不存在：${normalizedKey}`);
    if (!NEXT_STATUS[execution.status]?.has(nextStatus)) {
      throw new Error(`网关状态流转无效：${execution.status} -> ${nextStatus}`);
    }
    const timestamp = now();
    execution.status = nextStatus;
    execution.stageStartedAt = timestamp;
    if (nextStatus === 'fetching_browser') execution.browserStartedAt = timestamp;
    if (nextStatus === 'waiting_llm') execution.llmQueuedAt = timestamp;
    if (nextStatus === 'generating_llm') execution.llmStartedAt = timestamp;
    if (nextStatus === 'failed') execution.errorCode = String(errorCode || 'REPORT_ERROR').slice(0, 64);

    if (TERMINAL_STATUSES.has(nextStatus)) {
      execution.completedAt = timestamp;
      activeByKey.delete(normalizedKey);
      terminal.push(execution);
      if (nextStatus === 'completed' && execution.llmStartedAt != null) {
        const duration = timestamp - execution.llmStartedAt;
        if (duration > 0) {
          durations = [...durations, duration].slice(-100);
          queueMetricsWrite();
        }
      }
      cleanup(timestamp);
    }
    return execution;
  }

  function orderedActive() {
    return [...activeByKey.values()].sort((left, right) => left.order - right.order);
  }

  function queuePosition(execution, active) {
    if (!WAITING_STATUSES.has(execution.status)) return 0;
    return active.filter((item) => item.status === execution.status && item.order <= execution.order).length;
  }

  function estimateRemaining(execution, active, averageGenerationMs, at) {
    if (!averageGenerationMs) return null;
    if (execution.status === 'generating_llm') {
      return Math.max(0, averageGenerationMs - (at - execution.stageStartedAt));
    }
    if (execution.status !== 'waiting_llm') return null;

    const slots = active
      .filter((item) => item.status === 'generating_llm')
      .map((item) => Math.max(0, averageGenerationMs - (at - item.stageStartedAt)))
      .slice(0, llmConcurrency);
    while (slots.length < llmConcurrency) slots.push(0);
    const waiting = active.filter((item) => item.status === 'waiting_llm');
    for (const item of waiting) {
      slots.sort((left, right) => left - right);
      const completion = slots[0] + averageGenerationMs;
      slots[0] = completion;
      if (item === execution) return Math.round(completion);
    }
    return null;
  }

  function snapshot(requestId = '') {
    const timestamp = now();
    cleanup(timestamp);
    const active = orderedActive();
    const recentDurations = durations.slice(-20);
    const averageGenerationMs = average(recentDurations);
    const ownExecution = requestId ? byRequestId.get(requestId) || null : null;
    const visibleJobs = active.slice(0, maxPublicJobs);
    const me = ownExecution ? {
      shopId: ownExecution.shopId,
      reportType: ownExecution.reportType,
      periodLabel: ownExecution.periodLabel,
      status: ownExecution.status,
      statusText: STATUS_TEXT[ownExecution.status],
      elapsedMs: Math.max(0, timestamp - ownExecution.submittedAt),
      stageElapsedMs: Math.max(0, timestamp - ownExecution.stageStartedAt),
      queuePosition: queuePosition(ownExecution, active),
      estimatedRemainingMs: estimateRemaining(ownExecution, active, averageGenerationMs, timestamp),
      ...(ownExecution.status === 'failed' ? { errorCode: ownExecution.errorCode } : {}),
    } : null;

    return {
      ok: true,
      serverTime: new Date(timestamp).toISOString(),
      summary: {
        current: active.length,
        generating: active.filter((item) => item.status === 'generating_llm').length,
        waiting: active.filter((item) => WAITING_STATUSES.has(item.status)).length,
        llmConcurrency,
        averageGenerationMs,
        averageSampleSize: recentDurations.length,
        hiddenCount: Math.max(0, active.length - visibleJobs.length),
      },
      me,
      jobs: visibleJobs.map((execution) => publicJob(execution, requestId, timestamp)),
    };
  }

  async function flush() {
    await writeChain;
    if (lastPersistError) throw lastPersistError;
  }

  return { register, transition, snapshot, flush };
}
