/**
 * Next.js Server Lifecycle Instrumentation (src/instrumentation.ts)
 * Automatically invoked once on server startup.
 * Initializes the unified in-process trading engine scheduler.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureSchedulerStarted } = await import('@/lib/engineScheduler');
    ensureSchedulerStarted();
    console.log('[Instrumentation] Exness AI Engine In-Process Scheduler registered successfully.');
  }
}
