/**
 * Process-wide singleton helper (src/lib/globalSingleton.ts)
 *
 * Next.js production builds (`next start`) compile instrumentation.ts and each
 * route handler into separate bundles/layers. A plain module-level `new X()`
 * can therefore be instantiated MORE THAN ONCE per Node.js process, which for
 * this app means: duplicated 3s scheduler loops, duplicated REST throttlers
 * (=> HTTP 429 from Exness), duplicated WebSocket streams and split in-memory
 * state. Pinning instances on `globalThis` guarantees exactly one per process
 * in BOTH dev and production.
 */
export function globalSingleton<T>(key: string, factory: () => T): T {
  const g = globalThis as unknown as Record<string, unknown>;
  const k = `__nemesis_singleton_${key}`;
  if (g[k] === undefined) {
    g[k] = factory();
  }
  return g[k] as T;
}

/**
 * Races a promise against a timeout. The underlying work is NOT cancelled, but
 * the caller is released so locks/flags can never stay stuck forever.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
