import { BinanceFuturesClient } from './binanceClient';
import {
  evaluateCryptoSignal,
  evaluateBtcVelocityGuard,
  getCryptoDynamicThreshold,
} from './cryptoSignalEngine';
import { readCentralAiConfig } from './centralAiConfig';
import { dualRoomProtections, idempotencyLocks } from './riskGuard';
import { AssetCategory, enqueueTradeJob } from '@/lib/queue';
import { getActiveMultiUsers, MultiUserTradingProfile } from '@/lib/multiUserStore';
import { stateSync } from '@/lib/stateSync';

export type ConcreteAssetCategory = Exclude<AssetCategory, 'ALL'>;

export const CATEGORY_SYMBOLS: Record<ConcreteAssetCategory, string[]> = {
  L1: [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'ADAUSDT',
    'AVAXUSDT', 'SUIUSDT', 'TONUSDT', 'NEARUSDT', 'APTUSDT',
    'SEIUSDT', 'DOTUSDT', 'ATOMUSDT', 'XRPUSDT', 'TRXUSDT',
  ],
  L2: [
    'ARBUSDT', 'OPUSDT', 'STRKUSDT', 'ZKUSDT', 'POLUSDT',
    'MANTAUSDT', 'METISUSDT', 'IMXUSDT', 'MNTUSDT', 'ZROUSDT',
  ],
  ALT: [
    'LINKUSDT', 'UNIUSDT', 'AAVEUSDT', 'ONDOUSDT', 'PENDLEUSDT',
    'ENAUSDT', 'FETUSDT', 'RENDERUSDT', 'WLDUSDT', 'TAOUSDT',
  ],
  MEME: [
    'DOGEUSDT', '1000PEPEUSDT', 'WIFUSDT', 'BONKUSDT', '1000SHIBUSDT',
    '1000FLOKIUSDT', 'BOMEUSDT', 'POPCATUSDT', 'NEIROUSDT', 'PNUTUSDT',
  ],
};

const ALL_CONCRETE_CATEGORIES: ConcreteAssetCategory[] = ['L1', 'L2', 'ALT', 'MEME'];

/**
 * Deduplicates active categories selected by all active users.
 * If any user selects 'ALL', expands to all concrete categories ['L1', 'L2', 'ALT', 'MEME'].
 */
export function collectActiveCategories(
  users: MultiUserTradingProfile[]
): ConcreteAssetCategory[] {
  const categorySet = new Set<ConcreteAssetCategory>();

  for (const user of users) {
    if (!user.isActive) continue;
    if (user.selectedCategory === 'ALL') {
      for (const cat of ALL_CONCRETE_CATEGORIES) {
        categorySet.add(cat);
      }
      break;
    } else if (ALL_CONCRETE_CATEGORIES.includes(user.selectedCategory)) {
      categorySet.add(user.selectedCategory);
    }
  }

  return Array.from(categorySet);
}

export interface CentralizedAnalysisCycleResult {
  executed: boolean;
  reason?: string;
  activeUsersCount: number;
  activeCategories: ConcreteAssetCategory[];
  analyzedSymbolsCount: number;
  qualifiedSignalsCount: number;
  dispatchedJobsCount: number;
  timestamp: number;
}

/**
 * Centralized Market Analyzer (1 Analisa Pusat):
 * 1. Collects & deduplicates active asset categories across all active users.
 * 2. Runs EA Technical Analysis, Kronos VPS Forecast, and Multi-AI Evaluation ONCE per symbol.
 * 3. Dispatches isolated per-user execution jobs to BullMQ `trade-execution`.
 */
export async function runCentralizedMarketAnalysisCycle(): Promise<CentralizedAnalysisCycleResult> {
  const now = Date.now();
  const centralAi = await readCentralAiConfig();

  if (
    centralAi.engineSwitches?.emergencyKillSwitch ||
    centralAi.engineSwitches?.cryptoMaintenance
  ) {
    return {
      executed: false,
      reason: 'EMERGENCY_OR_MAINTENANCE',
      activeUsersCount: 0,
      activeCategories: [],
      analyzedSymbolsCount: 0,
      qualifiedSignalsCount: 0,
      dispatchedJobsCount: 0,
      timestamp: now,
    };
  }

  const activeUsers = await getActiveMultiUsers();
  if (activeUsers.length === 0) {
    return {
      executed: false,
      reason: 'NO_ACTIVE_USERS',
      activeUsersCount: 0,
      activeCategories: [],
      analyzedSymbolsCount: 0,
      qualifiedSignalsCount: 0,
      dispatchedJobsCount: 0,
      timestamp: now,
    };
  }

  const activeCategories = collectActiveCategories(activeUsers);
  if (activeCategories.length === 0) {
    return {
      executed: false,
      reason: 'NO_ACTIVE_CATEGORIES',
      activeUsersCount: activeUsers.length,
      activeCategories: [],
      analyzedSymbolsCount: 0,
      qualifiedSignalsCount: 0,
      dispatchedJobsCount: 0,
      timestamp: now,
    };
  }

  // Build deduplicated list of (symbol -> category) to analyze ONCE per cycle
  const symbolCategoryMap = new Map<string, ConcreteAssetCategory>();
  for (const cat of activeCategories) {
    for (const sym of CATEGORY_SYMBOLS[cat]) {
      if (!symbolCategoryMap.has(sym)) {
        symbolCategoryMap.set(sym, cat);
      }
    }
  }

  // Public market data client (no user secrets required for klines)
  const marketClient = new BinanceFuturesClient('', '', false);

  let btcGuard: { dumpBlocked: boolean; pumpBlocked: boolean; statusText: string } | undefined;
  try {
    const btcKlines = await marketClient.getKlines('BTCUSDT', '5m', 60);
    if (btcKlines && btcKlines.length >= 10) {
      btcGuard = evaluateBtcVelocityGuard(btcKlines);
    }
  } catch (err: any) {
    console.warn('[CentralAnalyzer] BTC velocity guard fetch failed:', err?.message);
  }

  let analyzedSymbolsCount = 0;
  let qualifiedSignalsCount = 0;
  let dispatchedJobsCount = 0;

  for (const [symbol, category] of symbolCategoryMap.entries()) {
    const protectionCheck = dualRoomProtections.checkSymbolProtection(symbol, 'crypto');
    if (!protectionCheck.allowed) continue;

    try {
      const klines = await marketClient.getKlines(symbol, '5m', 220);
      if (!klines || klines.length < 50) continue;

      analyzedSymbolsCount++;
      const candleTimestamp = klines[klines.length - 1]?.timestamp || 0;
      const centralLockSym = `CENTRAL_${symbol}`;
      if (
        candleTimestamp > 0 &&
        idempotencyLocks.isCandleLocked(centralLockSym, 'M5', candleTimestamp)
      ) {
        continue;
      }

      // Single centralized EA + Kronos + Multi-AI evaluation per symbol
      const verdict = await evaluateCryptoSignal({
        symbol,
        klines,
        timeframe: 'M5',
        fundingRate: 0.0001,
        btcGuard,
        enableAiJudge: true,
      });

      const cryptoDynamicThreshold =
        verdict.dynamicThreshold ||
        getCryptoDynamicThreshold({
          efficiencyRatio: verdict.indicators?.efficiencyRatio,
          pocMagnetAligned: verdict.indicators?.pocMagnetAligned,
        });
      const dynamicThreshold =
        centralAi.autoAdaptiveThreshold !== false
          ? cryptoDynamicThreshold
          : (centralAi.confidenceThreshold || cryptoDynamicThreshold);

      const effectiveConfidence = verdict.aiVerdict
        ? verdict.aiVerdict.confidence
        : verdict.score;
      const aiApproved = verdict.aiVerdict
        ? verdict.aiVerdict.decision === 'EXECUTE'
        : true;
      const isQualified =
        verdict.approved &&
        aiApproved &&
        effectiveConfidence >= dynamicThreshold &&
        !verdict.btcGuardBlocked &&
        verdict.entryPrice > 0;

      if (!isQualified) continue;

      qualifiedSignalsCount++;
      const side: 'BUY' | 'SELL' = verdict.side === 'LONG' ? 'BUY' : 'SELL';
      const signalTimestamp = Date.now();

      if (candleTimestamp > 0) {
        idempotencyLocks.recordExecutedCandle(centralLockSym, 'M5', candleTimestamp, side);
      }

      // Fan out: dispatch separate BullMQ jobs for matching active users
      const matchingUsers = activeUsers.filter(
        (u) => u.selectedCategory === 'ALL' || u.selectedCategory === category
      );

      for (const user of matchingUsers) {
        const jobId = `trade:${user.userId}:${symbol}:${candleTimestamp || signalTimestamp}`;
        await enqueueTradeJob({
          jobId,
          userId: user.userId,
          exchange: user.exchange,
          symbol,
          category,
          side,
          signalPrice: verdict.entryPrice,
          stopLossPrice: verdict.stopLossPrice,
          takeProfitPrice: verdict.takeProfit1Price,
          confidence: effectiveConfidence,
          dynamicThreshold,
          candleTimestamp,
          signalTimestamp,
          marginUsdt: user.marginUsdt,
          leverage: user.leverage,
          marginMode: user.marginMode,
          maxConcurrentCoins: user.maxConcurrentCoins,
          reasoning: verdict.aiVerdict?.reasoning,
        });
        dispatchedJobsCount++;
      }

      stateSync.addTelemetry(
        symbol,
        'AI',
        `📡 [CENTRAL ANALYZER] Qualified ${side} on ${symbol} (${category}) @ $${verdict.entryPrice} | Conf ${effectiveConfidence}% >= ${dynamicThreshold}% -> Dispatched ${matchingUsers.length} user job(s)`
      );
    } catch (err: any) {
      console.warn(`[CentralAnalyzer] Error analyzing ${symbol}:`, err?.message);
    }
  }

  return {
    executed: true,
    activeUsersCount: activeUsers.length,
    activeCategories,
    analyzedSymbolsCount,
    qualifiedSignalsCount,
    dispatchedJobsCount,
    timestamp: Date.now(),
  };
}
