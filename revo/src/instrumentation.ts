/**
 * Next.js Server Lifecycle Instrumentation (src/instrumentation.ts)
 * Automatically invoked once on server startup.
 * Initializes the unified in-process trading engine scheduler safely on Serverless/Edge.
 */

export async function register() {
  try {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
      // Guard against running during production build phase so background timers do not hang next build
      if (process.env.NEXT_PHASE === 'phase-production-build') {
        return;
      }
      const { ensureSchedulerStarted } = await import('@/lib/engineScheduler');
      ensureSchedulerStarted();
      console.log('[Instrumentation] Exness AI Engine In-Process Scheduler registered successfully.');
    }
  } catch (err) {
    console.warn('[Instrumentation] Safely handled scheduler initialization exception:', err);
  }
}
