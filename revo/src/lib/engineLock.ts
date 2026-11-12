/**
 * Process-wide Forex Engine Execution Lock (src/lib/engineLock.ts)
 *
 * The forex engine can be triggered from 3 places: the in-process scheduler
 * (every 3s), the browser dashboard (POST /api/engine-tick) and the optional
 * CLI daemon. Running them concurrently doubles Exness REST traffic through the
 * single 1.2s-spaced throttler queue (=> requests pile up, everything "freezes")
 * and risks duplicate orders. This lock guarantees only ONE engine cycle runs
 * at a time. A stale holder (> maxHoldMs) is taken over automatically so a hung
 * cycle can never block the engine forever.
 */
import { globalSingleton } from './globalSingleton';

interface EngineLockState {
  holder: string | null;
  since: number;
  token: number;
}

const lockState = globalSingleton<EngineLockState>('forexEngineLock', () => ({
  holder: null,
  since: 0,
  token: 0,
}));

export const ENGINE_LOCK_MAX_HOLD_MS = Number(process.env.ENGINE_LOCK_MAX_HOLD_MS || 90_000);

/** Returns a release token (> 0) when acquired, or 0 if another cycle is running. */
export function tryAcquireEngineLock(holder: string): number {
  const now = Date.now();
  if (lockState.holder && now - lockState.since < ENGINE_LOCK_MAX_HOLD_MS) {
    return 0;
  }
  if (lockState.holder) {
    console.warn(
      `[EngineLock] Taking over stale lock held by "${lockState.holder}" for ${now - lockState.since}ms (> ${ENGINE_LOCK_MAX_HOLD_MS}ms).`
    );
  }
  lockState.token += 1;
  lockState.holder = holder;
  lockState.since = now;
  return lockState.token;
}

export function releaseEngineLock(token: number): void {
  // Only the current owner may release (a stale owner finishing late must not free a newer lock)
  if (token > 0 && lockState.token === token) {
    lockState.holder = null;
    lockState.since = 0;
  }
}

export function getEngineLockInfo(): { holder: string | null; heldForMs: number } {
  return {
    holder: lockState.holder,
    heldForMs: lockState.holder ? Date.now() - lockState.since : 0,
  };
}
