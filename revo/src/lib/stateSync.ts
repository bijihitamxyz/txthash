/**
 * Shared Server-Client State Synchronization (src/lib/stateSync.ts)
 * Synchronizes active bot configuration, encrypted credentials, and open positions
 * between the frontend store and a server-side encrypted state cache
 * with an in-memory singleton (globalThis.__EXNESS_BOT_STATE__) so the internal scheduler
 * continues trading and trailing 24/7 even if the browser tab is refreshed or closed.
 * Fully Termux/Android and Vercel Serverless compatible with safe /tmp fallback.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  getDataDir,
  safeMkdirSync,
  getNemesisMemoryStore,
  readDataFileAsync,
  writeDataFileAsync,
} from './dataStore';
import {
  encryptCredential,
  decryptCredential,
  StoredCredentials,
  DEFAULT_CREDENTIALS,
  AccountMode,
} from './cryptoVault';
import { ManagedPosition } from '@/core/trailingManager';

export type TargetMarket = 'GOLD' | 'FOREX' | 'BOTH';

export interface StateTelemetryItem {
  id: string;
  timestamp: number;
  symbol: string;
  category: 'RISK' | 'SIGNAL' | 'AI' | 'ORDER' | 'TRAILING' | 'INFO';
  message: string;
}

export interface BotRuntimeState {
  activeRoom?: 'FOREX' | 'CRYPTO';
  isAutoTrading: boolean;
  isRunning: boolean;
  cryptoIsAutoTrading: boolean;
  cryptoMarginUsdt?: number;
  cryptoLeverage?: number;
  cryptoMarginMode?: 'ISOLATED' | 'CROSS';
  cryptoMaxConcurrentCoins?: number;
  accountMode: AccountMode;
  targetMarket: TargetMarket;
  selectedSymbol: string;
  isMultiPairMode: boolean;
  scannedSymbols: string[];
  lotSize: number;
  maxPositions: number;
  stopLossPips?: number;
  takeProfitPips?: number;
  slPips: number;
  tpPips: number;
  aiConfidenceThreshold: number;
  enablePartialClose: boolean;
  positions: ManagedPosition[];
  credentials: StoredCredentials;
  dailyRealizedLossUsd: number;
  dailyRealizedPnL: number;
  lastTickTimestamp: number;
  circuitBreakerTriggered: boolean;
  telemetryLogs: StateTelemetryItem[];
  kronosPrediction?: any;
  kronosBySymbol?: Record<string, any>;
  latestAiVerdict?: {
    symbol: string;
    decision: string;
    confidence_score: number;
    dynamicThreshold: number;
    source: string;
    reasoning: string;
    timestamp: number;
  } | null;
  quotes?: Record<string, { symbol: string; bid: number; ask: number; spreadPips: number; timestamp: number }>;
  accountInfo?: {
    connected: boolean;
    balance: number;
    equity: number;
    margin: number;
    freeMargin: number;
    mode: string;
    accountId: string;
    server: string;
    isLiveExness: boolean;
  } | null;
  entryScannerState?: string;
}

export const DEFAULT_STATE: BotRuntimeState = {
  activeRoom: 'FOREX',
  isAutoTrading: false,
  isRunning: false,
  cryptoIsAutoTrading: false,
  cryptoMarginUsdt: 25.0,
  cryptoLeverage: 10,
  cryptoMarginMode: 'ISOLATED',
  cryptoMaxConcurrentCoins: 5,
  accountMode: 'DEMO',
  targetMarket: 'GOLD',
  selectedSymbol: 'XAUUSDm',
  isMultiPairMode: false,
  scannedSymbols: ['XAUUSDm', 'EURUSDm', 'GBPUSDm', 'USDJPYm'],
  lotSize: 0.10,
  maxPositions: 2,
  stopLossPips: 25,
  takeProfitPips: 50,
  slPips: 25,
  tpPips: 50,
  aiConfidenceThreshold: 70,
  enablePartialClose: true,
  positions: [],
  credentials: { ...DEFAULT_CREDENTIALS },
  dailyRealizedLossUsd: 0,
  dailyRealizedPnL: 0,
  lastTickTimestamp: 0,
  circuitBreakerTriggered: false,
  telemetryLogs: [],
  kronosPrediction: null,
  kronosBySymbol: {},
  latestAiVerdict: null,
  quotes: {},
  accountInfo: null,
  entryScannerState: 'IDLE',
};

declare global {
  // eslint-disable-next-line no-var
  var __EXNESS_BOT_STATE__: BotRuntimeState | undefined;
}

function getStateFilePath(): string {
  try {
    const dataDir = getDataDir();
    return path.join(dataDir, 'exness-bot-state.enc');
  } catch {
    return '/tmp/exness-bot-state.enc';
  }
}

const PERSIST_MIN_INTERVAL_MS = Number(process.env.STATE_PERSIST_INTERVAL_MS || 5000);

class StateSyncManager {
  private inMemoryState: BotRuntimeState = {
    ...DEFAULT_STATE,
    positions: [],
  };
  private isLoadedFromDisk = false;
  private lastPersistAt = 0;
  private persistTimer: NodeJS.Timeout | null = null;
  private persistInFlight = false;

  constructor() {
    try {
      const targetFile = getStateFilePath();
      const dir = path.dirname(targetFile);
      safeMkdirSync(dir);
    } catch {}
  }

  public async getRuntimeState(): Promise<BotRuntimeState> {
    if (!this.isLoadedFromDisk) {
      await this.loadFromDisk();
    }
    if (globalThis.__EXNESS_BOT_STATE__) {
      this.inMemoryState = {
        ...this.inMemoryState,
        ...globalThis.__EXNESS_BOT_STATE__,
      };
    }
    return { ...this.inMemoryState };
  }

  public async updateRuntimeState(partial: Partial<BotRuntimeState>): Promise<BotRuntimeState> {
    if (!this.isLoadedFromDisk) {
      await this.loadFromDisk();
    }

    // Merge partial state
    this.inMemoryState = {
      ...this.inMemoryState,
      ...partial,
      credentials: partial.credentials
        ? { ...this.inMemoryState.credentials, ...partial.credentials }
        : this.inMemoryState.credentials,
      quotes: partial.quotes
        ? { ...(this.inMemoryState.quotes || {}), ...partial.quotes }
        : this.inMemoryState.quotes,
      kronosBySymbol: partial.kronosBySymbol
        ? { ...(this.inMemoryState.kronosBySymbol || {}), ...partial.kronosBySymbol }
        : this.inMemoryState.kronosBySymbol,
    };

    // Synchronize isRunning <-> isAutoTrading
    if (partial.isRunning !== undefined && partial.isAutoTrading === undefined) {
      this.inMemoryState.isAutoTrading = Boolean(partial.isRunning);
    }
    this.inMemoryState.isRunning = Boolean(this.inMemoryState.isAutoTrading);

    // Synchronize lotSize (lock default at 0.10 if invalid)
    if (typeof this.inMemoryState.lotSize !== 'number' || !isFinite(this.inMemoryState.lotSize) || this.inMemoryState.lotSize <= 0) {
      this.inMemoryState.lotSize = 0.10;
    }
    this.inMemoryState.maxPositions = 2;

    // Synchronize slPips <-> stopLossPips & tpPips <-> takeProfitPips
    if (partial.slPips !== undefined && partial.stopLossPips === undefined) {
      this.inMemoryState.stopLossPips = partial.slPips;
    }
    if (partial.tpPips !== undefined && partial.takeProfitPips === undefined) {
      this.inMemoryState.takeProfitPips = partial.tpPips;
    }
    const resolvedSl = typeof this.inMemoryState.stopLossPips === 'number' && this.inMemoryState.stopLossPips > 0
      ? this.inMemoryState.stopLossPips
      : 25;
    const resolvedTp = typeof this.inMemoryState.takeProfitPips === 'number' && this.inMemoryState.takeProfitPips > 0
      ? this.inMemoryState.takeProfitPips
      : 50;
    this.inMemoryState.stopLossPips = resolvedSl;
    this.inMemoryState.slPips = resolvedSl;
    this.inMemoryState.takeProfitPips = resolvedTp;
    this.inMemoryState.tpPips = resolvedTp;

    // If targetMarket is updated, synchronize scannedSymbols and selectedSymbol (unless selectedSymbol is explicitly specified)
    if (partial.targetMarket) {
      if (partial.targetMarket === 'GOLD') {
        this.inMemoryState.scannedSymbols = partial.scannedSymbols || ['XAUUSDm'];
        this.inMemoryState.selectedSymbol = partial.selectedSymbol || 'XAUUSDm';
        this.inMemoryState.isMultiPairMode = false;
      } else if (partial.targetMarket === 'FOREX') {
        this.inMemoryState.scannedSymbols = partial.scannedSymbols || ['XAUUSDm', 'EURUSDm', 'GBPUSDm', 'USDJPYm'];
        this.inMemoryState.selectedSymbol = partial.selectedSymbol || this.inMemoryState.selectedSymbol || 'XAUUSDm';
        this.inMemoryState.isMultiPairMode = true;
      } else if (partial.targetMarket === 'BOTH') {
        this.inMemoryState.scannedSymbols = partial.scannedSymbols || ['XAUUSDm', 'EURUSDm', 'GBPUSDm', 'USDJPYm'];
        this.inMemoryState.selectedSymbol = partial.selectedSymbol || this.inMemoryState.selectedSymbol || 'XAUUSDm';
        this.inMemoryState.isMultiPairMode = true;
      }
    } else if (partial.selectedSymbol) {
      this.inMemoryState.selectedSymbol = partial.selectedSymbol;
    }

    if (partial.accountMode) {
      this.inMemoryState.credentials.accountMode = partial.accountMode;
    }

    if (partial.positions !== undefined) {
      this.inMemoryState.positions = Array.isArray(partial.positions)
        ? partial.positions.filter((p: any) => p && p.id !== 'F-637' && p.id !== '#F-637')
        : [];
    }

    // Always keep in-memory singleton updated
    globalThis.__EXNESS_BOT_STATE__ = { ...this.inMemoryState };

    const isCriticalChange =
      partial.isAutoTrading !== undefined ||
      partial.isRunning !== undefined ||
      partial.lotSize !== undefined ||
      partial.stopLossPips !== undefined ||
      partial.slPips !== undefined ||
      partial.takeProfitPips !== undefined ||
      partial.tpPips !== undefined ||
      partial.targetMarket !== undefined ||
      partial.enablePartialClose !== undefined;

    try {
      await this.persistToDisk(isCriticalChange);
    } catch {
      // Silently fall back to in-memory globalThis.__EXNESS_BOT_STATE__ singleton without throwing any error
    }

    return { ...this.inMemoryState };
  }

  public addTelemetry(symbol: string, category: StateTelemetryItem['category'], message: string): void {
    const item: StateTelemetryItem = {
      id: `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: Date.now(),
      symbol,
      category,
      message,
    };
    this.inMemoryState.telemetryLogs = [item, ...this.inMemoryState.telemetryLogs.slice(0, 199)];
    if (globalThis.__EXNESS_BOT_STATE__) {
      globalThis.__EXNESS_BOT_STATE__.telemetryLogs = this.inMemoryState.telemetryLogs;
    }
  }

  private async loadFromDisk(): Promise<void> {
    let parsedEnc: any = null;
    try {
      const nemesis = getNemesisMemoryStore();
      const targetFile = getStateFilePath();
      let encrypted: string | null = null;
      if (fs.existsSync(targetFile)) {
        encrypted = await fs.promises.readFile(targetFile, 'utf8');
      } else if (nemesis['exness-bot-state.enc']) {
        encrypted = nemesis['exness-bot-state.enc'];
      }
      if (encrypted && encrypted.trim().length > 0) {
        const decrypted = await decryptCredential(encrypted);
        parsedEnc = JSON.parse(decrypted);
        nemesis['exness-bot-state.enc'] = encrypted;
      }
    } catch {
      // Silently fall back
    }

    let parsedEngineJson: any = null;
    try {
      const rawEngineJson = await readDataFileAsync('engine-state.json', '');
      if (rawEngineJson && rawEngineJson.trim().length > 0) {
        parsedEngineJson = JSON.parse(rawEngineJson);
      }
    } catch {}

    const parsed = parsedEnc || parsedEngineJson;
    if (parsed) {
      const isRun = Boolean(parsedEngineJson?.isRunning ?? parsed.isRunning ?? parsed.isAutoTrading);
      const lot = typeof (parsedEngineJson?.lotSize ?? parsed.lotSize) === 'number' && (parsedEngineJson?.lotSize ?? parsed.lotSize) > 0
        ? (parsedEngineJson?.lotSize ?? parsed.lotSize)
        : 0.10;
      const sl = typeof (parsedEngineJson?.slPips ?? parsed.slPips ?? parsed.stopLossPips) === 'number' && (parsedEngineJson?.slPips ?? parsed.slPips ?? parsed.stopLossPips) > 0
        ? (parsedEngineJson?.slPips ?? parsed.slPips ?? parsed.stopLossPips)
        : 25;
      const tp = typeof (parsedEngineJson?.tpPips ?? parsed.tpPips ?? parsed.takeProfitPips) === 'number' && (parsedEngineJson?.tpPips ?? parsed.tpPips ?? parsed.takeProfitPips) > 0
        ? (parsedEngineJson?.tpPips ?? parsed.tpPips ?? parsed.takeProfitPips)
        : 50;
      const positions = Array.isArray(parsedEngineJson?.positions) && parsedEngineJson.positions.length > 0
        ? parsedEngineJson.positions
        : (Array.isArray(parsed.positions) ? parsed.positions : []);

      this.inMemoryState = {
        ...DEFAULT_STATE,
        ...parsed,
        isAutoTrading: isRun,
        isRunning: isRun,
        lotSize: lot,
        maxPositions: 2,
        stopLossPips: sl,
        slPips: sl,
        takeProfitPips: tp,
        tpPips: tp,
        cryptoIsAutoTrading: false, // strictly default to false on server startup to prevent ghost trades
        cryptoMarginUsdt: typeof parsed.cryptoMarginUsdt === 'number' ? parsed.cryptoMarginUsdt : 25.0,
        cryptoLeverage: typeof parsed.cryptoLeverage === 'number' ? parsed.cryptoLeverage : 10,
        cryptoMarginMode: parsed.cryptoMarginMode || 'ISOLATED',
        cryptoMaxConcurrentCoins: typeof parsed.cryptoMaxConcurrentCoins === 'number' ? parsed.cryptoMaxConcurrentCoins : 5,
        positions,
        credentials: {
          ...DEFAULT_CREDENTIALS,
          ...(parsed.credentials || {}),
        },
      };
      globalThis.__EXNESS_BOT_STATE__ = { ...this.inMemoryState };
      this.isLoadedFromDisk = true;
      return;
    }

    if (globalThis.__EXNESS_BOT_STATE__) {
      this.inMemoryState = {
        ...DEFAULT_STATE,
        ...globalThis.__EXNESS_BOT_STATE__,
        positions: Array.isArray(globalThis.__EXNESS_BOT_STATE__.positions)
          ? globalThis.__EXNESS_BOT_STATE__.positions
          : [],
      };
    } else {
      this.inMemoryState = { ...DEFAULT_STATE, positions: [] };
      globalThis.__EXNESS_BOT_STATE__ = { ...this.inMemoryState };
    }
    this.isLoadedFromDisk = true;
  }

  private async persistToDisk(immediate: boolean = false): Promise<void> {
    // Keep in-memory singleton up to date
    globalThis.__EXNESS_BOT_STATE__ = { ...this.inMemoryState };

    const now = Date.now();
    const elapsed = now - this.lastPersistAt;
    if ((immediate || elapsed >= PERSIST_MIN_INTERVAL_MS) && !this.persistInFlight) {
      await this.writeStateToDisk();
      return;
    }
    if (!this.persistTimer) {
      const delay = immediate ? 50 : Math.max(250, PERSIST_MIN_INTERVAL_MS - elapsed);
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        this.writeStateToDisk().catch(() => {});
      }, delay);
      if (typeof this.persistTimer.unref === 'function') this.persistTimer.unref();
    }
  }

  private async writeStateToDisk(): Promise<void> {
    if (this.persistInFlight) {
      // A write is already running; make sure the latest state is written afterwards
      if (!this.persistTimer) {
        this.persistTimer = setTimeout(() => {
          this.persistTimer = null;
          this.writeStateToDisk().catch(() => {});
        }, 1000);
        if (typeof this.persistTimer.unref === 'function') this.persistTimer.unref();
      }
      return;
    }
    this.persistInFlight = true;
    this.lastPersistAt = Date.now();
    try {
      // 1. Persist clean engine-state.json (for fast VPS restart recovery of isRunning, lotSize, maxPositions, slPips, tpPips, trailing state)
      const engineStatePayload = {
        isRunning: Boolean(this.inMemoryState.isAutoTrading),
        isAutoTrading: Boolean(this.inMemoryState.isAutoTrading),
        lotSize: this.inMemoryState.lotSize || 0.10,
        maxPositions: 2,
        slPips: this.inMemoryState.stopLossPips ?? 25,
        tpPips: this.inMemoryState.takeProfitPips ?? 50,
        targetMarket: this.inMemoryState.targetMarket,
        selectedSymbol: this.inMemoryState.selectedSymbol,
        scannedSymbols: this.inMemoryState.scannedSymbols,
        enablePartialClose: this.inMemoryState.enablePartialClose,
        positions: this.inMemoryState.positions || [],
        updatedAt: Date.now(),
      };
      await writeDataFileAsync('engine-state.json', JSON.stringify(engineStatePayload, null, 2));

      // 2. Persist full encrypted state
      const json = JSON.stringify(this.inMemoryState);
      const encrypted = await encryptCredential(json);
      try {
        const nemesis = getNemesisMemoryStore();
        nemesis['exness-bot-state.enc'] = encrypted;
      } catch {}

      const targetFile = getStateFilePath();
      const dir = path.dirname(targetFile);
      safeMkdirSync(dir);
      // Atomic write (tmp + rename) so a crash/kill mid-write never leaves a corrupted state file
      const tmpFile = `${targetFile}.tmp`;
      await fs.promises.writeFile(tmpFile, encrypted, 'utf8');
      await fs.promises.rename(tmpFile, targetFile);
    } catch {
      // Silently fall back to in-memory globalThis.__EXNESS_BOT_STATE__ singleton without throwing any error
    } finally {
      this.persistInFlight = false;
    }
  }

  public resetState(): void {
    this.inMemoryState = { ...DEFAULT_STATE };
    globalThis.__EXNESS_BOT_STATE__ = { ...DEFAULT_STATE };
    try {
      const nemesis = getNemesisMemoryStore();
      delete nemesis['exness-bot-state.enc'];
    } catch {}
    try {
      const targetFile = getStateFilePath();
      if (fs.existsSync(targetFile)) {
        try {
          fs.unlinkSync(targetFile);
        } catch {}
      }
    } catch {
      // Silently ignore
    }
  }
}

// Global singleton instance for Node.js process (pinned in production too, see globalSingleton.ts)
const globalForStateSync = globalThis as unknown as {
  __exnessStateSyncManager?: StateSyncManager;
};

export const stateSync = globalForStateSync.__exnessStateSyncManager ?? new StateSyncManager();
globalForStateSync.__exnessStateSyncManager = stateSync;

if (typeof globalThis !== 'undefined') {
  (globalThis as any).__emitVaultTelemetry = (category: string, message: string) => {
    stateSync.addTelemetry('VAULT', 'INFO', message);
  };
}
