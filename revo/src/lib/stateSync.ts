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
import { getDataDir, safeMkdirSync, getNemesisMemoryStore } from './dataStore';
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
  stopLossPips?: number;
  takeProfitPips?: number;
  aiConfidenceThreshold: number;
  enablePartialClose: boolean;
  positions: ManagedPosition[];
  credentials: StoredCredentials;
  dailyRealizedLossUsd: number;
  dailyRealizedPnL: number;
  lastTickTimestamp: number;
  circuitBreakerTriggered: boolean;
  telemetryLogs: StateTelemetryItem[];
}

export const DEFAULT_STATE: BotRuntimeState = {
  activeRoom: 'FOREX',
  isAutoTrading: false,
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
  stopLossPips: 25,
  takeProfitPips: 50,
  aiConfidenceThreshold: 70,
  enablePartialClose: true,
  positions: [],
  credentials: { ...DEFAULT_CREDENTIALS },
  dailyRealizedLossUsd: 0,
  dailyRealizedPnL: 0,
  lastTickTimestamp: 0,
  circuitBreakerTriggered: false,
  telemetryLogs: [],
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
    };

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

    try {
      await this.persistToDisk();
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
        const parsed = JSON.parse(decrypted);
        this.inMemoryState = {
          ...DEFAULT_STATE,
          ...parsed,
          isAutoTrading: Boolean(parsed.isAutoTrading),
          cryptoIsAutoTrading: false, // strictly default to false on server startup to prevent ghost trades
          cryptoMarginUsdt: typeof parsed.cryptoMarginUsdt === 'number' ? parsed.cryptoMarginUsdt : 25.0,
          cryptoLeverage: typeof parsed.cryptoLeverage === 'number' ? parsed.cryptoLeverage : 10,
          cryptoMarginMode: parsed.cryptoMarginMode || 'ISOLATED',
          cryptoMaxConcurrentCoins: typeof parsed.cryptoMaxConcurrentCoins === 'number' ? parsed.cryptoMaxConcurrentCoins : 5,
          positions: Array.isArray(parsed.positions) ? parsed.positions : [],
          credentials: {
            ...DEFAULT_CREDENTIALS,
            ...(parsed.credentials || {}),
          },
        };
        globalThis.__EXNESS_BOT_STATE__ = { ...this.inMemoryState };
        nemesis['exness-bot-state.enc'] = encrypted;
        this.isLoadedFromDisk = true;
        return;
      }
    } catch {
      // Silently fall back to in-memory globalThis.__EXNESS_BOT_STATE__ singleton without throwing any error
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

  private async persistToDisk(): Promise<void> {
    // Keep in-memory singleton up to date
    globalThis.__EXNESS_BOT_STATE__ = { ...this.inMemoryState };

    // Debounced/coalesced disk write: encrypting (PBKDF2 100k) + rewriting the whole state file on
    // EVERY 3s tick burns CPU on small VPS instances. In-memory state is always authoritative;
    // the disk copy is only for restart recovery, so writing at most every PERSIST_MIN_INTERVAL_MS is enough.
    const now = Date.now();
    const elapsed = now - this.lastPersistAt;
    if (elapsed >= PERSIST_MIN_INTERVAL_MS && !this.persistInFlight) {
      await this.writeStateToDisk();
      return;
    }
    if (!this.persistTimer) {
      const delay = Math.max(250, PERSIST_MIN_INTERVAL_MS - elapsed);
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
