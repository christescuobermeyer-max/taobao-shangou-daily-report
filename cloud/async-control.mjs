export function createConcurrencyLimiter(limit) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('并发限制必须是正整数');
  }

  let active = 0;
  const pending = [];

  const drain = () => {
    while (active < limit && pending.length > 0) {
      const job = pending.shift();
      active += 1;
      const waitMs = Date.now() - job.queuedAt;
      Promise.resolve()
        .then(() => job.task({ waitMs }))
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };

  return {
    run(task) {
      if (typeof task !== 'function') throw new Error('限流任务必须是函数');
      return new Promise((resolvePromise, reject) => {
        pending.push({ task, resolve: resolvePromise, reject, queuedAt: Date.now() });
        drain();
      });
    },
    stats() {
      return { limit, active, pending: pending.length };
    },
  };
}

export function createKeyedDeduper() {
  const inFlight = new Map();

  return {
    run(key, task) {
      const normalizedKey = String(key);
      if (inFlight.has(normalizedKey)) return inFlight.get(normalizedKey);
      const operation = Promise.resolve().then(task);
      const tracked = operation.finally(() => {
        if (inFlight.get(normalizedKey) === tracked) inFlight.delete(normalizedKey);
      });
      inFlight.set(normalizedKey, tracked);
      return tracked;
    },
    size() {
      return inFlight.size;
    },
  };
}
