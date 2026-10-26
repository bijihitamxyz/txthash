/**
 * Standalone 24/7 CLI Daemon Heartbeat Worker (src/scripts/daemonRunner.ts)
 * Lightweight worker for running continuously in Android Termux, PM2, or Linux systemd.
 * Triggers /api/engine-tick so Smart Adaptive Hybrid signals, 2-Stage Trailing Stops,
 * and Auto Partial Closes continue 24/7 when the web dashboard tab is closed.
 */

const BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const TICK_INTERVAL_MS = Number(process.env.TICK_INTERVAL_MS) || 3000;
const EXNESS_ACCOUNT_ID = process.env.EXNESS_ACCOUNT_ID || '';
const EXNESS_SERVER = process.env.EXNESS_SERVER || 'Exness-MT5Real';
const EXNESS_TOKEN = process.env.EXNESS_TOKEN || '';
const SYMBOLS = (process.env.SCAN_SYMBOLS || 'XAUUSDm,EURUSDm,GBPUSDm,USDJPYm').split(',');

let isRunning = true;
let tickCount = 0;

console.log('=============================================================');
console.log('🤖 EXNESS QUANT AI SMART HYBRID AUTO-TRADER | 24/7 DAEMON');
console.log(`🌐 Target Endpoint: ${BASE_URL}/api/engine-tick`);
console.log(`⏱️ Heartbeat Frequency: ${TICK_INTERVAL_MS}ms`);
console.log(`💼 Server / Gateway: ${EXNESS_SERVER}`);
console.log(`📊 Instruments Monitored: ${SYMBOLS.join(', ')}`);
console.log('=============================================================\n');

async function runHeartbeatTick() {
  tickCount++;
  const timeTag = new Date().toISOString().replace('T', ' ').substring(0, 19);

  try {
    const payload = {
      credentials: {
        accountId: EXNESS_ACCOUNT_ID,
        server: EXNESS_SERVER,
        token: EXNESS_TOKEN,
      },
      symbols: SYMBOLS,
      timeframe: 'M5',
      orderVolume: 0.01,
      enablePartialClose: true,
    };

    const res = await fetch(`${BASE_URL}/api/engine-tick`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error(`[${timeTag}] [Tick #${tickCount}] Engine HTTP Error: ${res.status} ${res.statusText}`);
      return;
    }

    const json = await res.json();
    if (json.telemetry && Array.isArray(json.telemetry)) {
      for (const t of json.telemetry) {
        const tStr = new Date(t.timestamp).toLocaleTimeString();
        console.log(`[${tStr}] [${t.symbol}] [${t.category}] ${t.message}`);
      }
    }

    if (json.orders && json.orders.length > 0) {
      console.log(`🎯 [ALERT] Executed ${json.orders.length} order(s) in tick #${tickCount}!`);
    }

    if (json.circuitBreakerTriggered) {
      console.warn(`🚨 [CIRCUIT BREAKER] Trading engine paused by risk limits.`);
    }
  } catch (err: any) {
    console.error(`[${timeTag}] [Tick #${tickCount}] Connection exception:`, err.message);
  }
}

async function loop() {
  while (isRunning) {
    await runHeartbeatTick();
    await new Promise((resolve) => setTimeout(resolve, TICK_INTERVAL_MS));
  }
}

process.on('SIGINT', () => {
  console.log('\n🛑 SIGINT received. Shutting down daemon runner cleanly...');
  isRunning = false;
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 SIGTERM received. Stopping daemon runner...');
  isRunning = false;
  process.exit(0);
});

loop();
