import { Worker, Job } from 'bullmq';
import crypto from 'crypto';
import {
  TRADE_EXECUTION_QUEUE_NAME,
  TradeExecutionJobData,
  getRedisConnectionOptions,
  getRedisClient,
} from '@/lib/queue';
import { getDecryptedUserCredentials } from '@/lib/multiUserStore';
import {
  BinanceFuturesClient,
  FALLBACK_SYMBOLS,
  formatQuantityByStepSize,
} from '@/core/binanceClient';
import { BitgetFuturesService } from '@/services/bitgetService';
import { idempotencyLocks } from '@/core/riskGuard';
import { stateSync } from '@/lib/stateSync';

const STALE_SIGNAL_MAX_AGE_MS = 10_000; // 10 seconds
const STALE_SIGNAL_MAX_DRIFT_PCT = 0.003; // 0.3%
const USER_LOCK_TTL_MS = 15_000;
const USER_LOCK_WAIT_TIMEOUT_MS = 12_000;

// In-process per-user FIFO queue to serialize jobs for the same userId inside this worker process
const localUserQueues = new Map<string, Promise<void>>();

async function withLocalUserMutex<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = localUserQueues.get(userId) ?? Promise.resolve();
  let releaseNext!: () => void;
  const next = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  localUserQueues.set(
    userId,
    prev.then(() => next).catch(() => next)
  );

  await prev;
  try {
    return await fn();
  } finally {
    releaseNext();
  }
}

/**
 * Distributed per-userId Redis lock + local mutex so a single user never
 * executes two orders concurrently (prevents 6/5 concurrent position race conditions).
 */
async function withUserExecutionLock<T>(
  userId: string,
  fn: () => Promise<T>
): Promise<T> {
  return withLocalUserMutex(userId, async () => {
    const redis = getRedisClient();
    if (redis.status === 'wait') {
      await redis.connect();
    }

    const lockKey = `lock:trade:user:${userId}`;
    const lockToken = crypto.randomUUID();
    const deadline = Date.now() + USER_LOCK_WAIT_TIMEOUT_MS;
    let acquired = false;

    while (Date.now() < deadline) {
      const res = await redis.set(lockKey, lockToken, 'PX', USER_LOCK_TTL_MS, 'NX');
      if (res === 'OK') {
        acquired = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!acquired) {
      throw new Error(`Timeout acquiring per-user execution lock for ${userId}`);
    }

    try {
      return await fn();
    } finally {
      const releaseLua = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      await redis.eval(releaseLua, 1, lockKey, lockToken).catch(() => {});
    }
  });
}

async function fetchLiveMarketPrice(
  exchange: 'BINANCE' | 'BITGET',
  symbol: string,
  isTestnet: boolean
): Promise<number> {
  if (exchange === 'BITGET') {
    const bitget = new BitgetFuturesService('', '', '', isTestnet ? 'DEMO' : 'REAL');
    const tickers = await bitget.get24hrTickers();
    const ticker = tickers[symbol];
    return ticker?.lastPrice || 0;
  }

  const binance = new BinanceFuturesClient('', '', isTestnet);
  const prem = await binance.getPremiumIndex(symbol);
  return prem?.markPrice || 0;
}

export async function processTradeJob(job: Job<TradeExecutionJobData>) {
  const data = job.data;
  const {
    userId,
    exchange,
    symbol,
    side,
    signalPrice,
    stopLossPrice,
    takeProfitPrice,
    confidence,
    dynamicThreshold,
    candleTimestamp,
    signalTimestamp,
    marginUsdt,
    leverage,
    marginMode,
    maxConcurrentCoins,
  } = data;

  return withUserExecutionLock(userId, async () => {
    // 1. Stale Signal Protection: Time Delay (> 10s)
    const signalAgeMs = Date.now() - signalTimestamp;
    if (signalAgeMs > STALE_SIGNAL_MAX_AGE_MS) {
      const reason = `STALE_SIGNAL_AGE (${signalAgeMs}ms > ${STALE_SIGNAL_MAX_AGE_MS}ms)`;
      console.warn(`[TradeWorker] Aborting ${symbol} for user ${userId}: ${reason}`);
      return { skipped: true, reason };
    }

    // 2. Decrypt user API Key & Secret
    const creds = await getDecryptedUserCredentials(userId);
    if (!creds || !creds.apiKey || !creds.secretKey) {
      const reason = 'MISSING_OR_INVALID_CREDENTIALS';
      console.warn(`[TradeWorker] Aborting ${symbol} for user ${userId}: ${reason}`);
      return { skipped: true, reason };
    }

    const isTestnet = creds.accountType === 'DEMO';

    // 3. Stale Signal Protection: Price Drift (> 0.3%)
    const livePrice = await fetchLiveMarketPrice(exchange, symbol, isTestnet);
    if (livePrice <= 0 || signalPrice <= 0) {
      return { skipped: true, reason: 'INVALID_PRICE' };
    }

    const priceDrift = Math.abs(livePrice - signalPrice) / signalPrice;
    if (priceDrift > STALE_SIGNAL_MAX_DRIFT_PCT) {
      const driftPct = (priceDrift * 100).toFixed(3);
      const reason = `STALE_SIGNAL_PRICE_DRIFT (${driftPct}% > 0.30%)`;
      console.warn(`[TradeWorker] Aborting ${symbol} for user ${userId}: ${reason}`);
      return { skipped: true, reason };
    }

    // 4. Re-check open positions & execute order under per-user lock
    const notional = marginUsdt * leverage;
    const spec = FALLBACK_SYMBOLS.find((s) => s.symbol === symbol);
    const rawQty = notional / livePrice;
    const qty = spec
      ? formatQuantityByStepSize(rawQty, spec.stepSize, spec.quantityPrecision)
      : Number(rawQty.toFixed(3)).toString();

    if (!(parseFloat(qty) > 0)) {
      return { skipped: true, reason: 'QUANTITY_TOO_SMALL' };
    }

    if (exchange === 'BITGET') {
      if (!creds.passphrase) {
        return { skipped: true, reason: 'MISSING_BITGET_PASSPHRASE' };
      }
      const bitget = new BitgetFuturesService(
        creds.apiKey,
        creds.secretKey,
        creds.passphrase,
        creds.accountType
      );
      const openPositions = await bitget.getOpenPositions();
      if (
        openPositions.length >= maxConcurrentCoins ||
        openPositions.some((p) => p.symbol === symbol)
      ) {
        return { skipped: true, reason: 'MAX_POSITIONS_OR_DUPLICATE_SYMBOL' };
      }

      await bitget.placeMarketOrder({
        symbol,
        side,
        size: qty,
        price: livePrice,
        margin: marginUsdt,
        leverage,
        marginMode: marginMode === 'CROSS' ? 'crossed' : 'isolated',
        stopLossPrice,
        takeProfitPrice,
      });
    } else {
      const binance = new BinanceFuturesClient(creds.apiKey, creds.secretKey, isTestnet);
      const accountInfo = await binance.getAccountInfo();
      const openPositions = accountInfo.positions || [];
      if (
        openPositions.length >= maxConcurrentCoins ||
        openPositions.some((p) => p.symbol === symbol)
      ) {
        return { skipped: true, reason: 'MAX_POSITIONS_OR_DUPLICATE_SYMBOL' };
      }

      await binance.placeMarketOrderWithProtection({
        symbol,
        side,
        quantity: qty,
        leverage,
        marginMode: marginMode === 'CROSS' ? 'CROSSED' : 'ISOLATED',
        stopLossPrice,
        takeProfitPrice,
      });
    }

    if (candleTimestamp > 0) {
      idempotencyLocks.recordExecutedCandle(
        `WORKER_${userId}_${exchange}_${symbol}`,
        'M5',
        candleTimestamp,
        side
      );
    }

    stateSync.addTelemetry(
      symbol,
      'ORDER',
      `⚡ [BULLMQ WORKER:${userId}] Executed ${side} ${symbol} on ${exchange} (${qty} | $${marginUsdt} @ ${leverage}x | Conf ${confidence}% >= ${dynamicThreshold}%)`
    );

    return {
      executed: true,
      userId,
      exchange,
      symbol,
      side,
      quantity: qty,
      livePrice,
    };
  });
}

export function startTradeWorker(): Worker<TradeExecutionJobData> {
  const worker = new Worker<TradeExecutionJobData>(
    TRADE_EXECUTION_QUEUE_NAME,
    processTradeJob,
    {
      connection: getRedisConnectionOptions(),
      concurrency: 5,
    }
  );

  worker.on('completed', (job, result) => {
    console.log(
      `[TradeWorker] Job ${job.id} (${job.data.userId} ${job.data.symbol}) completed:`,
      result
    );
  });

  worker.on('failed', (job, err) => {
    console.error(
      `[TradeWorker] Job ${job?.id} (${job?.data?.userId} ${job?.data?.symbol}) failed:`,
      err.message
    );
  });

  return worker;
}

// Allow running directly via: node --experimental-strip-types src/workers/tradeWorker.ts
const isDirectRun =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1]?.includes('tradeWorker');

if (isDirectRun) {
  console.log('🚀 Starting BullMQ Isolated User Execution Worker (concurrency: 5)...');
  const worker = startTradeWorker();

  const shutdown = async () => {
    console.log('\n🛑 Shutting down TradeWorker...');
    await worker.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
