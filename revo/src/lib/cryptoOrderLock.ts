/**
 * Global FIFO async mutex for crypto order execution.
 * Prevents concurrent race conditions (e.g., opening 6/5 positions when multiple
 * signals or scanner ticks fire simultaneously).
 */

type LockQueueItem = () => void;

const globalForLock = globalThis as unknown as {
  __cryptoOrderMutex?: {
    locked: boolean;
    queue: LockQueueItem[];
  };
};

const mutex = (globalForLock.__cryptoOrderMutex ??= {
  locked: false,
  queue: [],
});

export async function withCryptoOrderLock<T>(fn: () => Promise<T>): Promise<T> {
  if (mutex.locked) {
    await new Promise<void>((resolve) => {
      mutex.queue.push(resolve);
    });
  }
  mutex.locked = true;
  try {
    return await fn();
  } finally {
    const next = mutex.queue.shift();
    if (next) {
      next();
    } else {
      mutex.locked = false;
    }
  }
}
