import IORedis, { RedisOptions } from 'ioredis';
import { Queue, JobsOptions } from 'bullmq';

export const TRADE_EXECUTION_QUEUE_NAME = 'trade-execution';

export type AssetCategory = 'L1' | 'L2' | 'ALT' | 'MEME' | 'ALL';

export interface TradeExecutionJobData {
  jobId: string;
  userId: string;
  exchange: 'BINANCE' | 'BITGET';
  symbol: string;
  category: Exclude<AssetCategory, 'ALL'>;
  side: 'BUY' | 'SELL';
  signalPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  confidence: number;
  dynamicThreshold: number;
  candleTimestamp: number;
  signalTimestamp: number;
  marginUsdt: number;
  leverage: number;
  marginMode: 'ISOLATED' | 'CROSS';
  maxConcurrentCoins: number;
  reasoning?: string;
}

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;

export function getRedisConnectionOptions(): RedisOptions {
  return {
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
    retryStrategy: (times: number) => Math.min(times * 500, 5000),
  };
}

const globalForQueue = globalThis as unknown as {
  __nemesisRedisClient?: IORedis;
  __nemesisTradeQueue?: Queue<TradeExecutionJobData>;
};

export function createRedisConnection(): IORedis {
  const client = new IORedis(getRedisConnectionOptions());
  client.on('error', (err) => {
    // Prevent unhandled error events from crashing the Next.js server when Redis is offline
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[Redis] Connection warning:', err.message);
    }
  });
  return client;
}

export function getRedisClient(): IORedis {
  if (!globalForQueue.__nemesisRedisClient) {
    globalForQueue.__nemesisRedisClient = createRedisConnection();
  }
  return globalForQueue.__nemesisRedisClient;
}

export const DEFAULT_TRADE_JOB_OPTIONS: JobsOptions = {
  removeOnComplete: 100,
  removeOnFail: 200,
  attempts: 2,
  backoff: {
    type: 'exponential',
    delay: 500,
  },
};

export function getTradeExecutionQueue(): Queue<TradeExecutionJobData> {
  if (!globalForQueue.__nemesisTradeQueue) {
    globalForQueue.__nemesisTradeQueue = new Queue<TradeExecutionJobData>(
      TRADE_EXECUTION_QUEUE_NAME,
      {
        connection: getRedisConnectionOptions(),
        defaultJobOptions: DEFAULT_TRADE_JOB_OPTIONS,
      }
    );
  }
  return globalForQueue.__nemesisTradeQueue;
}

export async function enqueueTradeJob(
  data: TradeExecutionJobData,
  opts?: JobsOptions
) {
  const queue = getTradeExecutionQueue();
  return queue.add(`exec-${data.userId}-${data.symbol}`, data, {
    ...DEFAULT_TRADE_JOB_OPTIONS,
    jobId: data.jobId,
    ...opts,
  });
}

export async function pingRedis(timeoutMs: number = 1500): Promise<{
  online: boolean;
  latencyMs: number;
  error?: string;
}> {
  const client = getRedisClient();
  const start = Date.now();

  try {
    const pingPromise = (async () => {
      if (client.status === 'wait') {
        await client.connect();
      }
      return client.ping();
    })();

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Redis ping timeout')), timeoutMs)
    );

    const pong = await Promise.race([pingPromise, timeoutPromise]);
    return {
      online: pong === 'PONG',
      latencyMs: Math.max(1, Date.now() - start),
    };
  } catch (err: any) {
    return {
      online: false,
      latencyMs: 0,
      error: err?.message || 'Redis unreachable',
    };
  }
}
