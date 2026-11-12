/**
 * PM2 Production Ecosystem Configuration for VPS (ecosystem.config.cjs)
 *
 * CRITICAL VPS SETTINGS:
 * 1. instances: 1 (STRICTLY FORK MODE)
 *    NEVER run trading engines in cluster mode! Cluster mode spawns multiple Node processes,
 *    causing duplicate schedulers, duplicate orders, and Exness HTTP 429 rate limit bans.
 * 2. max_memory_restart: '1G'
 *    Automatically restarts cleanly if memory creeps up on a low-RAM VPS.
 * 3. exp_backoff_restart_delay: 100
 *    Prevents tight restart loops if a network interface drops.
 */

module.exports = {
  apps: [
    {
      name: 'nemesis-x',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1024M',
      exp_backoff_restart_delay: 100,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        // Optional optimizations
        NEXT_TELEMETRY_DISABLED: '1',
      },
    },
  ],
};
