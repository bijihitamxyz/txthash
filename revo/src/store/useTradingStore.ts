/**
 * Zustand Global State Store (src/store/useTradingStore.ts)
 * Synchronized with server-side stateSync for 24/7 background execution.
 * Universal Exness account support (Exness Demo vs Exness Real) with zero fake sandbox mode.
 * Persistent state storage across browser refresh via Zustand persist & localStorage.
 * Ultra-simple beginner-friendly controls:
 * 1. Account Mode (Exness Demo vs Real)
 * 2. Target Market (Gold, Forex Majors, or Both)
 * 3. Lot per Entry (0.01)
 * 4. START / STOP AUTO-TRADING
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { AccountInfo, LiveQuote } from '@/core/exnessClient';
import { Candle, Timeframe, timeframeToMs, resampleCandles } from '@/core/indicatorEngine';
import { ManagedPosition, evaluatePositionTrailing } from '@/core/trailingManager';
import { getPairProfile, SUPPORTED_SYMBOLS, calculatePnL, evaluatePositionPnL } from '@/core/pairConfig';
import {
  StoredCredentials,
  DEFAULT_CREDENTIALS,
  AccountMode,
  getActiveExnessCredentials,
  isVaultConfigured,
  loadVaultFromLocalStorage,
  saveVaultToLocalStorage,
} from '@/lib/cryptoVault';
import { TargetMarket } from '@/lib/stateSync';

export interface TelemetryItem {
  id: string;
  timestamp: number;
  symbol: string;
  category: 'RISK' | 'SIGNAL' | 'AI' | 'ORDER' | 'TRAILING' | 'INFO';
  message: string;
}

const LOCAL_STORAGE_KEY = 'exness-quant-storage-v9';

let hasLoadedSavedVault = false;
let isFetchingCandlesLock = false;
let lastCandlesFetchTime = 0;
let lastCandlesFetchSymbol = '';
let candlesDebounceTimer: ReturnType<typeof setTimeout> | null = null;

let isSyncingLock = false;
let lastSyncTime = 0;

let isFetchingAccountLock = false;
let lastAccountFetchTime = 0;

let isFetchingQuoteLock = false;
const inFlightQuotes = new Set<string>();
const lastQuoteFetchTimes: Record<string, number> = {};

export const PAIR_BASELINES: Record<string, { price: number; digits: number; pip: number }> = {
  XAUUSDm: { price: 4018.00, digits: 2, pip: 0.10 },
  EURUSDm: { price: 1.08500, digits: 5, pip: 0.0001 },
  GBPUSDm: { price: 1.29500, digits: 5, pip: 0.0001 },
  USDJPYm: { price: 156.840, digits: 3, pip: 0.01 },
};

export const SYMBOL_BASELINES = PAIR_BASELINES;

export const LAST_KNOWN_PRICE_KEY = 'exness_last_known_real_prices';

export const lastKnownPrice: Record<string, { price: number; timestamp: number; source?: string }> = {};

export function updateStoreLastKnownPrice(symbol: string, price: number, source: string = 'live'): void {
  if (typeof price === 'number' && price > 0 && !isNaN(price)) {
    lastKnownPrice[symbol] = { price, timestamp: Date.now(), source };
    savePersistedRealPrice(symbol, price);
    const profile = getPairProfile(symbol);
    PAIR_BASELINES[symbol] = {
      price,
      digits: profile.digits,
      pip: profile.pipValue,
    };
  }
}

export const INITIAL_QUOTES: Record<string, LiveQuote> = {
  XAUUSDm: { symbol: 'XAUUSDm', bid: 4018.00, ask: 4018.16, spreadPips: 1.6, timestamp: Date.now() },
  EURUSDm: { symbol: 'EURUSDm', bid: 1.08500, ask: 1.08508, spreadPips: 0.8, timestamp: Date.now() },
  GBPUSDm: { symbol: 'GBPUSDm', bid: 1.29500, ask: 1.29508, spreadPips: 0.8, timestamp: Date.now() },
  USDJPYm: { symbol: 'USDJPYm', bid: 156.840, ask: 156.848, spreadPips: 0.8, timestamp: Date.now() },
};

export const SYMBOL_PRICES_STORAGE_KEY = 'exness_symbol_prices';

export function getPersistedSymbolPrices(): Record<string, { bid: number; ask: number }> {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const raw = window.localStorage.getItem(SYMBOL_PRICES_STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
  }
  const gold = getPersistedRealPrice('XAUUSDm');
  const eu = getPersistedRealPrice('EURUSDm');
  const gbp = getPersistedRealPrice('GBPUSDm');
  const jpy = getPersistedRealPrice('USDJPYm');
  return {
    XAUUSDm: { bid: gold, ask: Number((gold + 0.16).toFixed(2)) },
    EURUSDm: { bid: eu, ask: Number((eu + 0.00008).toFixed(5)) },
    GBPUSDm: { bid: gbp, ask: Number((gbp + 0.00008).toFixed(5)) },
    USDJPYm: { bid: jpy, ask: Number((jpy + 0.008).toFixed(3)) },
  };
}

export function savePersistedSymbolPrices(prices: Record<string, { bid: number; ask: number }>): void {
  if (typeof window !== 'undefined' && window.localStorage && prices) {
    try {
      window.localStorage.setItem(SYMBOL_PRICES_STORAGE_KEY, JSON.stringify(prices));
    } catch {}
  }
}

export function getPersistedRealPrice(symbol: string): number {
  if (lastKnownPrice[symbol] && lastKnownPrice[symbol].price > 0) {
    return lastKnownPrice[symbol].price;
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const raw = window.localStorage.getItem(LAST_KNOWN_PRICE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed[symbol] === 'number' && parsed[symbol] > 0) {
          lastKnownPrice[symbol] = { price: parsed[symbol], timestamp: Date.now(), source: 'localStorage' };
          return parsed[symbol];
        }
      }
    } catch {}
  }
  return PAIR_BASELINES[symbol]?.price || (symbol === 'XAUUSDm' ? 4018.00 : 1.0);
}

export function savePersistedRealPrice(symbol: string, price: number): void {
  if (typeof window !== 'undefined' && window.localStorage && price > 0) {
    try {
      const raw = window.localStorage.getItem(LAST_KNOWN_PRICE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      parsed[symbol] = price;
      window.localStorage.setItem(LAST_KNOWN_PRICE_KEY, JSON.stringify(parsed));
    } catch {}
  }
}

export function getLocalDateString(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getSymbolBaselineEntry(symbol: string, digits: number, pip: number) {
  const realPrice = lastKnownPrice[symbol]?.price || getPersistedRealPrice(symbol);
  const existing = PAIR_BASELINES[symbol];
  if (existing) {
    if (realPrice > 0) existing.price = realPrice;
    return existing;
  }
  let price = realPrice > 0 ? realPrice : 1.08500;
  if (symbol === 'XAUUSDm') price = realPrice > 0 ? realPrice : 4018.00;
  else if (symbol === 'USDJPYm') price = realPrice > 0 ? realPrice : 156.840;
  else if (symbol === 'GBPUSDm') price = realPrice > 0 ? realPrice : 1.29500;
  return { price, digits, pip };
}

function createLocalFallbackCandles(rawSymbol: string, count: number = 50, tf: Timeframe = 'M5'): Candle[] {
  const profile = getPairProfile(rawSymbol);
  const symbol = profile.symbol;
  const base = getSymbolBaselineEntry(symbol, profile.digits, profile.pipValue);

  const anchor = getPersistedRealPrice(symbol) || base.price;
  const now = Date.now();
  const tfMs = timeframeToMs(tf);
  const candles: Candle[] = [];
  let cur = anchor;
  const vol = base.pip * (symbol === 'XAUUSDm' ? 6 : 3.5);

  for (let i = count - 1; i >= 0; i--) {
    const timestamp = now - (i * tfMs);
    const meanReversion = (anchor - cur) * 0.05;
    const delta = ((Math.random() - 0.495) * vol) + meanReversion;
    const open = cur;
    let close = Number((open + delta).toFixed(base.digits));

    // Clamp maximum tick-to-tick delta to realistic micro-movements (<= 0.15%)
    const maxJump = cur * 0.0015;
    if (Math.abs(close - cur) > maxJump) {
      close = Number((cur + Math.sign(close - cur) * maxJump).toFixed(base.digits));
    }

    const wickHigh = Math.random() * vol * 0.7;
    const wickLow = Math.random() * vol * 0.7;
    const high = Number((Math.max(open, close) + wickHigh).toFixed(base.digits));
    const low = Number((Math.min(open, close) - wickLow).toFixed(base.digits));
    candles.push({ timestamp, open, high, low, close, volume: Math.floor(Math.random() * 200) + 50 });
    cur = close;
  }
  return candles;
}

export interface TradingState {
  // Top-level persisted financial metrics & active positions
  balance: number;
  equity: number;
  dailyPnl: number;
  dailyPnlHistory: Record<string, { pnl: number; trades: number; wins: number; losses: number }>;
  openPositions: ManagedPosition[];
  positions: ManagedPosition[];

  // 1. Account Mode Switcher (Exness Demo vs Exness Real)
  accountMode: AccountMode;

  // 2. Target Market & Timeframe Selector
  targetMarket: TargetMarket;
  focusSymbol: string;
  selectedSymbol: string;
  isMultiPairMode: boolean;
  scannedSymbols: string[];
  timeframe: Timeframe;

  // 3. Engine Control
  isAutoTrading: boolean;
  isTickRunning: boolean;
  isFetchingCandles: boolean;
  isSyncing: boolean;
  tickIntervalMs: number;
  lastTickTime: number | null;

  // 4. Live Market & Financial Metrics
  accountInfo: AccountInfo | null;
  quotes: Record<string, LiveQuote>;
  symbolPrices: Record<string, { bid: number; ask: number }>;
  candles: Candle[];

  // 5. Active Positions & Telemetry Logs
  telemetryLogs: TelemetryItem[];

  // 6. Strategy Parameters
  lotSize: number;
  aiConfidenceThreshold: number;
  enablePartialClose: boolean;

  // 7. BYOK Credentials Vault & Modal Controls
  credentials: StoredCredentials;
  isApiKeyModalOpen: boolean;
  isPnlCalendarModalOpen: boolean;

  // Actions
  setAccountMode: (mode: AccountMode) => Promise<void>;
  setTargetMarket: (market: TargetMarket) => Promise<void>;
  setFocusSymbol: (symbol: string) => void;
  setSelectedSymbol: (symbol: string) => void;
  setTimeframe: (tf: Timeframe) => void;
  toggleAutoTrading: (forceState?: boolean) => Promise<void>;
  stopAutoTrading: () => Promise<void>;
  setLotSize: (size: number) => Promise<void>;
  setAiConfidenceThreshold: (val: number) => void;
  setEnablePartialClose: (enabled: boolean) => void;
  setCredentials: (creds: Partial<StoredCredentials>) => Promise<void>;
  openApiKeyModal: () => void;
  closeApiKeyModal: () => void;
  openPnlCalendarModal: () => void;
  closePnlCalendarModal: () => void;
  recordTradePnL: (pnl: number, targetDate?: string) => void;
  addTelemetryLog: (symbol: string, category: TelemetryItem['category'], message: string) => void;
  clearTelemetry: () => void;
  resetPositions: () => void;
  resetDemoAccount: () => void;
  resetCalendarHistory: () => void;
  getSymbolQuote: (sym: string) => LiveQuote;

  // Async API Dispatchers
  fetchAccountInfo: () => Promise<void>;
  fetchCandles: (symbol?: string) => Promise<void>;
  fetchQuote: (symbol?: string) => Promise<void>;
  executeLiveTickStream: () => Promise<void>;
  executeEngineTick: (syntheticSignal?: { symbol: string; side: 'BUY' | 'SELL' }) => Promise<void>;
  closePosition: (positionId: string, volume?: number) => Promise<void>;
  panicCloseAll: () => Promise<void>;
  loadVaultOnStartup: () => Promise<void>;
  loadSavedVault: () => Promise<void>;
  syncWithServerState: () => Promise<void>;
}

const defaultCredentials: StoredCredentials = { ...DEFAULT_CREDENTIALS };
const defaultAccountMode: AccountMode = 'DEMO';
const defaultBalance = 100.00;
const defaultEquity = 100.00;
const defaultDailyPnl = 0.00;
const defaultDailyPnlHistory: Record<string, { pnl: number; trades: number; wins: number; losses: number }> = {};
const defaultPositions: ManagedPosition[] = [];
const defaultIsAutoTrading = false;
const defaultTargetMarket: TargetMarket = 'GOLD';
const defaultFocusSymbol = 'XAUUSDm';
const defaultSelectedSymbol = 'XAUUSDm';
const defaultIsMultiPairMode = false;
const defaultScannedSymbols = ['XAUUSDm'];
const defaultTimeframe: Timeframe = 'M5';
const defaultLotSize = 0.01;
const defaultAiConfidence = 70;
const defaultPartialClose = true;

const defaultAccountInfo: AccountInfo = {
  accountNumber: '',
  server: 'Exness-MT5Trial17',
  currency: 'USD',
  balance: 100.00,
  equity: 100.00,
  margin: 0,
  freeMargin: 100.00,
  marginLevelPct: 1000,
  dailyRealizedPnL: 0.00,
  dailyRealizedLossUsd: 0,
  latencyMs: 0,
  connected: false,
  mode: 'DEMO',
};

export const useTradingStore = create<TradingState>()(
  persist(
    (set, get) => ({
      // Top-level persisted state
      balance: defaultBalance,
      equity: defaultEquity,
      dailyPnl: defaultDailyPnl,
      dailyPnlHistory: defaultDailyPnlHistory,
      openPositions: defaultPositions,
      positions: defaultPositions,

      accountMode: defaultAccountMode,
      targetMarket: defaultTargetMarket,
      focusSymbol: defaultFocusSymbol,
      selectedSymbol: defaultSelectedSymbol,
      isMultiPairMode: defaultIsMultiPairMode,
      scannedSymbols: defaultScannedSymbols,
      timeframe: defaultTimeframe,

      isAutoTrading: defaultIsAutoTrading,
      isTickRunning: false,
      isFetchingCandles: false,
      isSyncing: false,
      tickIntervalMs: 3000,
      lastTickTime: null,

      accountInfo: defaultAccountInfo,
      quotes: { ...INITIAL_QUOTES },
      symbolPrices: getPersistedSymbolPrices(),
      candles: createLocalFallbackCandles(defaultFocusSymbol, 50, defaultTimeframe),
      getSymbolQuote: (sym: string) => {
        const p = getPairProfile(sym);
        const q = get().quotes[p.symbol];
        if (q && q.bid > 0) return q;
        const sp = get().symbolPrices?.[p.symbol] || getPersistedSymbolPrices()?.[p.symbol];
        if (sp && sp.bid > 0) {
          return {
            symbol: p.symbol,
            bid: sp.bid,
            ask: sp.ask,
            spreadPips: Number(((sp.ask - sp.bid) / p.pipValue).toFixed(1)),
            timestamp: Date.now(),
          };
        }
        const lastReal = lastKnownPrice[p.symbol]?.price || getPersistedRealPrice(p.symbol) || PAIR_BASELINES[p.symbol]?.price;
        const basePrice = lastReal > 0 ? lastReal : (p.symbol === 'XAUUSDm' ? 4018.00 : 1.0);
        const spreadPips = p.symbol === 'XAUUSDm' ? 1.6 : 0.8;
        const spreadPrice = spreadPips * p.pipValue;
        return {
          symbol: p.symbol,
          bid: Number((basePrice - spreadPrice / 2).toFixed(p.digits)),
          ask: Number((basePrice + spreadPrice / 2).toFixed(p.digits)),
          spreadPips,
          timestamp: Date.now(),
        };
      },

      telemetryLogs: [],

      lotSize: defaultLotSize,
      aiConfidenceThreshold: defaultAiConfidence,
      enablePartialClose: defaultPartialClose,

      credentials: defaultCredentials,
      isApiKeyModalOpen: false,
      isPnlCalendarModalOpen: false,

      openApiKeyModal: () => set({ isApiKeyModalOpen: true }),
      closeApiKeyModal: () => set({ isApiKeyModalOpen: false }),
      openPnlCalendarModal: () => set({ isPnlCalendarModalOpen: true }),
      closePnlCalendarModal: () => set({ isPnlCalendarModalOpen: false }),

      recordTradePnL: (pnl: number, targetDate?: string) => {
        const target = targetDate || getLocalDateString();
        const current = get().dailyPnlHistory || {};
        const existing = current[target] || { pnl: 0, trades: 0, wins: 0, losses: 0 };
        const updatedPnl = Number((existing.pnl + pnl).toFixed(2));
        const updatedTrades = existing.trades + 1;
        const updatedWins = existing.wins + (pnl > 0 ? 1 : 0);
        const updatedLosses = existing.losses + (pnl < 0 ? 1 : 0);

        const updatedHistory = {
          ...current,
          [target]: {
            pnl: updatedPnl,
            trades: updatedTrades,
            wins: updatedWins,
            losses: updatedLosses,
          },
        };

        const todayStr = getLocalDateString();
        const todayPnl = updatedHistory[todayStr]?.pnl ?? 0;

        const activeCreds = getActiveExnessCredentials(get().credentials);
        const initBal = activeCreds.initialBalance > 0 ? activeCreds.initialBalance : 100.00;
        const prevBal = get().balance > 0 ? get().balance : initBal;
        const updatedBal = Number((prevBal + pnl).toFixed(2));

        const curPositions = get().openPositions || get().positions || [];
        const totalUnrealized = curPositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
        const updatedEquity = curPositions.length === 0 ? updatedBal : Number((updatedBal + totalUnrealized).toFixed(2));

        set((prev) => ({
          balance: updatedBal,
          equity: updatedEquity,
          dailyPnlHistory: updatedHistory,
          dailyPnl: todayPnl,
          accountInfo: prev.accountInfo
            ? {
                ...prev.accountInfo,
                balance: updatedBal,
                equity: updatedEquity,
                dailyRealizedPnL: todayPnl,
              }
            : prev.accountInfo,
        }));
      },

      setAccountMode: async (mode) => {
        const creds = { ...get().credentials, accountMode: mode };
        const activeCreds = getActiveExnessCredentials(creds);
        const hasCreds = isVaultConfigured(creds);
        const initBal = activeCreds.initialBalance > 0 ? activeCreds.initialBalance : 100.00;
        const serverName = activeCreds.server || (mode === 'REAL' ? 'Exness-MT5Real' : 'Exness-MT5Trial17');

        const curPositions = get().openPositions || get().positions || [];
        const todayDateStr = getLocalDateString();
        const curHistory = get().dailyPnlHistory || {};
        const curDailyPnl = curHistory[todayDateStr]?.pnl ?? 0;
        const cumPnl = Number(
          Object.values(curHistory).reduce((sum, item: any) => sum + (item?.pnl || 0), 0).toFixed(2)
        );
        const hasHistory = Object.keys(curHistory).length > 0 || cumPnl !== 0 || curDailyPnl !== 0;

        let curBal: number;
        if (hasHistory) {
          curBal = get().balance > 0 && Math.abs(get().balance - initBal) > 0.001
            ? get().balance
            : Number((initBal + cumPnl).toFixed(2));
        } else {
          curBal = get().balance > 0 ? get().balance : (get().accountInfo?.balance || initBal);
        }

        const totalUnrealized = curPositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
        const curEquity = curPositions.length === 0 ? curBal : Number((curBal + totalUnrealized).toFixed(2));

        // Update store state & financial metrics synchronously (<1ms)
        set(() => ({
          accountMode: mode,
          credentials: creds,
          positions: curPositions,
          openPositions: curPositions,
          balance: hasCreds ? curBal : 0,
          equity: hasCreds ? curEquity : 0,
          dailyPnl: hasCreds ? curDailyPnl : 0,
          accountInfo: hasCreds
            ? {
                accountNumber: activeCreds.accountId || '',
                server: serverName,
                currency: 'USD',
                balance: curBal,
                equity: curEquity,
                margin: get().accountInfo?.margin || 0,
                freeMargin: Number(Math.max(0, curEquity - (get().accountInfo?.margin || 0)).toFixed(2)),
                marginLevelPct: get().accountInfo?.marginLevelPct || 1000,
                dailyRealizedPnL: curDailyPnl,
                dailyRealizedLossUsd: get().accountInfo?.dailyRealizedLossUsd || 0,
                latencyMs: 12,
                connected: true,
                mode,
              }
            : {
                accountNumber: '',
                server: serverName,
                currency: 'USD',
                balance: 0,
                equity: 0,
                margin: 0,
                freeMargin: 0,
                marginLevelPct: 0,
                dailyRealizedPnL: 0,
                dailyRealizedLossUsd: 0,
                latencyMs: 0,
                connected: false,
                mode,
              },
        }));

        await saveVaultToLocalStorage(creds);

        get().addTelemetryLog(
          'ACCOUNT',
          'INFO',
          `Switched to Exness ${mode === 'REAL' ? 'Real (Live Account)' : 'Demo (Trial Account)'}`
        );

        // Reset throttle lock so immediate account verification can proceed
        lastAccountFetchTime = 0;
        isFetchingAccountLock = false;

        // Sync with backend server
        try {
          await fetch('/api/exness', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'sync-state',
              payload: {
                accountMode: mode,
                credentials: creds,
                isAutoTrading: get().isAutoTrading,
                positions: get().openPositions || get().positions || [],
              },
            }),
          });
        } catch {}

        get().fetchAccountInfo();
      },

      setTargetMarket: async (market) => {
        if (get().targetMarket === market) return;

        let selected = 'XAUUSDm';
        let isMulti = false;
        let scanned = ['XAUUSDm'];

        if (market === 'GOLD') {
          selected = 'XAUUSDm';
          isMulti = false;
          scanned = ['XAUUSDm'];
        } else if (market === 'FOREX') {
          selected = 'EURUSDm';
          isMulti = true;
          scanned = ['EURUSDm', 'GBPUSDm', 'USDJPYm'];
        } else if (market === 'BOTH') {
          selected = 'XAUUSDm';
          isMulti = true;
          scanned = ['XAUUSDm', 'EURUSDm', 'GBPUSDm', 'USDJPYm'];
        }

        if (candlesDebounceTimer) {
          clearTimeout(candlesDebounceTimer);
          candlesDebounceTimer = null;
        }
        isFetchingCandlesLock = false;

        // Synchronously generate initial seed candles & quote for new market symbol (<1ms)
        const profile = getPairProfile(selected);
        const initialCandles = createLocalFallbackCandles(selected, 50, get().timeframe || 'M5');
        const lastClose = initialCandles[initialCandles.length - 1].close;
        const spreadPips = selected === 'XAUUSDm' ? 1.6 : 0.8;
        const spreadPrice = spreadPips * profile.pipValue;
        const seedQuote: LiveQuote = {
          symbol: selected,
          bid: Number((lastClose - spreadPrice / 2).toFixed(profile.digits)),
          ask: Number((lastClose + spreadPrice / 2).toFixed(profile.digits)),
          spreadPips,
          timestamp: Date.now(),
        };

        set((prev) => ({
          targetMarket: market,
          focusSymbol: selected,
          selectedSymbol: selected,
          isMultiPairMode: isMulti,
          scannedSymbols: scanned,
          candles: initialCandles,
          quotes: {
            ...prev.quotes,
            [selected]: prev.quotes[selected] || seedQuote,
          },
        }));

        get().addTelemetryLog(
          'SYSTEM',
          'INFO',
          `Target Market set to: ${
            market === 'GOLD'
              ? 'Gold Only (XAUUSDm)'
              : market === 'FOREX'
              ? 'Forex Majors (EUR/GBP/JPY)'
              : 'Both Simultaneously (Multi-Pair Scanner)'
          }`
        );

        // Immediately trigger non-blocking candle & quote fetch without waiting for backend sync roundtrips
        get().fetchCandles(selected);
        get().fetchQuote(selected);

        const payload = {
          targetMarket: market,
          focusSymbol: selected,
          selectedSymbol: selected,
          isMultiPairMode: isMulti,
          scannedSymbols: scanned,
          orderVolume: get().lotSize,
          isAutoTrading: get().isAutoTrading,
          positions: get().openPositions || get().positions || [],
        };

        // Non-blocking background sync with endpoints
        fetch('/api/exness', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'sync-state',
            payload,
          }),
        }).catch(() => {});

        fetch('/api/engine-tick', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {});
      },

      setFocusSymbol: (symbol: string) => {
        const profile = getPairProfile(symbol);
        const sym = profile.symbol;
        if (get().focusSymbol === sym && get().selectedSymbol === sym && get().candles.length > 0) return;

        if (candlesDebounceTimer) {
          clearTimeout(candlesDebounceTimer);
          candlesDebounceTimer = null;
        }
        isFetchingCandlesLock = false;

        // Immediately generate/seed initial candles for new symbol synchronously (<1ms)
        const initialCandles = createLocalFallbackCandles(sym, 50, get().timeframe || 'M5');
        const lastClose = initialCandles[initialCandles.length - 1].close;
        const spreadPips = sym === 'XAUUSDm' ? 1.6 : 0.8;
        const spreadPrice = spreadPips * profile.pipValue;
        const seedQuote: LiveQuote = {
          symbol: sym,
          bid: Number((lastClose - spreadPrice / 2).toFixed(profile.digits)),
          ask: Number((lastClose + spreadPrice / 2).toFixed(profile.digits)),
          spreadPips,
          timestamp: Date.now(),
        };

        set((prev) => ({
          focusSymbol: sym,
          selectedSymbol: sym,
          candles: initialCandles,
          quotes: {
            ...prev.quotes,
            [sym]: prev.quotes[sym] || seedQuote,
          },
        }));

        get().addTelemetryLog(sym, 'INFO', `Chart focused on ${profile.name} (${sym})`);

        // Immediately trigger non-blocking candle & quote fetch
        get().fetchCandles(sym);
        get().fetchQuote(sym);

        // Non-blocking background sync focused symbol to backend
        fetch('/api/exness', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'sync-state',
            payload: { selectedSymbol: sym, focusSymbol: sym },
          }),
        }).catch(() => {});
      },

      setSelectedSymbol: (symbol: string) => {
        get().setFocusSymbol(symbol);
      },

      setTimeframe: (tf: Timeframe) => {
        if (get().timeframe === tf) return;
        const currentCandles = get().candles;
        const targetSymbol = get().focusSymbol || get().selectedSymbol || 'XAUUSDm';
        const profile = getPairProfile(targetSymbol);

        // Instantly resample or generate initial candles for target timeframe (<1ms)
        let updatedCandles: Candle[] = [];
        if (currentCandles.length >= 2) {
          updatedCandles = resampleCandles(currentCandles, tf, profile.digits);
        } else {
          updatedCandles = createLocalFallbackCandles(targetSymbol, 50, tf);
        }

        set({
          timeframe: tf,
          candles: updatedCandles,
        });

        get().addTelemetryLog(targetSymbol, 'INFO', `Chart timeframe switched to ${tf}`);

        // Fetch fresh live candles for selected timeframe from API
        get().fetchCandles(targetSymbol);
      },

      stopAutoTrading: async () => {
        return get().toggleAutoTrading(false);
      },

      toggleAutoTrading: async (forceState?: boolean) => {
        const next = typeof forceState === 'boolean' ? forceState : !get().isAutoTrading;
        // Stop Auto-Trading ONLY sets isAutoTrading: false to halt scanning.
        // It must NEVER delete, wipe, or purge active openPositions.
        // Existing positions remain active and managed by trailing stop/TP/SL until closed by user action or TP/SL hit.
        set({ isAutoTrading: next });

        const activeCreds = getActiveExnessCredentials(get().credentials);

        get().addTelemetryLog(
          'SYSTEM',
          next ? 'ORDER' : 'INFO',
          next
            ? `🟢 AUTO-TRADING STARTED! Trading Exness ${activeCreds.mode} on ${get().targetMarket} (${get().lotSize} Lot).`
            : '🔴 AUTO-TRADING STOPPED by user. Existing positions remain active and managed.'
        );

        try {
          await fetch('/api/exness', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'sync-state',
              payload: {
                isAutoTrading: next,
                positions: get().openPositions || get().positions || [],
              },
            }),
          });
        } catch {}
      },

      setLotSize: async (size) => {
        const valid = Math.max(0.01, Number(size.toFixed(2)));
        set({ lotSize: valid });
        try {
          await fetch('/api/exness', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'sync-state',
              payload: { lotSize: valid },
            }),
          });
        } catch {}
        try {
          await fetch('/api/engine-tick', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              orderVolume: valid,
            }),
          });
        } catch {}
      },

      setAiConfidenceThreshold: (val) => set({ aiConfidenceThreshold: val }),
      setEnablePartialClose: (enabled) => set({ enablePartialClose: enabled }),

      setCredentials: async (newCreds) => {
        const updated: StoredCredentials = {
          ...get().credentials,
          ...newCreds,
          updatedAt: Date.now(),
        };
        const activeCreds = getActiveExnessCredentials(updated);
        const hasCreds = isVaultConfigured(updated);
        const initBal = activeCreds.initialBalance > 0 ? activeCreds.initialBalance : 100.00;
        const serverName = activeCreds.server || (updated.accountMode === 'REAL' ? 'Exness-MT5Real' : 'Exness-MT5Trial17');

        const curPositions = get().openPositions || get().positions || [];
        const todayDateStr = getLocalDateString();
        const curHistory = get().dailyPnlHistory || {};
        const curDailyPnl = curHistory[todayDateStr]?.pnl ?? 0;
        const cumPnl = Number(
          Object.values(curHistory).reduce((sum, item: any) => sum + (item?.pnl || 0), 0).toFixed(2)
        );
        const hasHistory = Object.keys(curHistory).length > 0 || cumPnl !== 0 || curDailyPnl !== 0;

        let curBal: number;
        if (hasHistory) {
          curBal = get().balance > 0 && Math.abs(get().balance - initBal) > 0.001
            ? get().balance
            : Number((initBal + cumPnl).toFixed(2));
        } else {
          curBal = get().balance > 0 ? get().balance : initBal;
        }

        const totalUnrealized = curPositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
        const curEquity = curPositions.length === 0 ? curBal : Number((curBal + totalUnrealized).toFixed(2));

        set((prev) => ({
          credentials: updated,
          accountMode: updated.accountMode,
          positions: curPositions,
          openPositions: curPositions,
          balance: hasCreds ? curBal : 0,
          equity: hasCreds ? curEquity : 0,
          dailyPnl: hasCreds ? curDailyPnl : 0,
          accountInfo: hasCreds
            ? {
                accountNumber: activeCreds.accountId || '',
                server: serverName,
                currency: 'USD',
                balance: curBal,
                equity: curEquity,
                margin: prev.accountInfo?.margin || 0,
                freeMargin: Number(Math.max(0, curEquity - (prev.accountInfo?.margin || 0)).toFixed(2)),
                marginLevelPct: prev.accountInfo?.marginLevelPct || 1000,
                dailyRealizedPnL: curDailyPnl,
                dailyRealizedLossUsd: prev.accountInfo?.dailyRealizedLossUsd || 0,
                latencyMs: 12,
                connected: true,
                mode: updated.accountMode,
              }
            : {
                ...prev.accountInfo,
                accountNumber: '',
                server: serverName,
                balance: 0,
                equity: 0,
                connected: false,
                mode: updated.accountMode,
              },
        }));
        await saveVaultToLocalStorage(updated);

        try {
          await fetch('/api/exness', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'sync-state',
              payload: {
                credentials: updated,
                accountMode: updated.accountMode,
                isAutoTrading: get().isAutoTrading,
                positions: get().openPositions || get().positions || [],
              },
            }),
          });
        } catch {}

        get().addTelemetryLog('SECURITY', 'INFO', 'Credentials encrypted with AES-256-GCM and saved to Vault');
        lastAccountFetchTime = 0;
        isFetchingAccountLock = false;
        get().fetchAccountInfo();
      },

      resetPositions: () => {
        const curBal = get().balance > 0 ? get().balance : (get().accountInfo?.balance || 100.0);
        set((prev) => ({
          positions: [],
          openPositions: [],
          equity: curBal,
          accountInfo: prev.accountInfo
            ? {
                ...prev.accountInfo,
                equity: curBal,
                freeMargin: curBal,
                margin: 0,
              }
            : prev.accountInfo,
        }));
      },

      resetDemoAccount: () => {
        const initBal = 100.00;
        set((prev) => ({
          balance: initBal,
          equity: initBal,
          dailyPnl: 0.00,
          dailyPnlHistory: {},
          positions: [],
          openPositions: [],
          accountInfo: prev.accountInfo
            ? {
                ...prev.accountInfo,
                balance: initBal,
                equity: initBal,
                margin: 0,
                freeMargin: initBal,
                dailyRealizedPnL: 0,
                dailyRealizedLossUsd: 0,
              }
            : prev.accountInfo,
        }));

        get().addTelemetryLog('ACCOUNT', 'INFO', 'Demo account ledger cleanly reset to $100.00');

        fetch('/api/exness', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'sync-state',
            payload: {
              currentBalance: initBal,
              dailyPnl: 0,
              positions: [],
              dailyRealizedLossUsd: 0,
            },
          }),
        }).catch(() => {});
      },

      resetCalendarHistory: () => {
        set((prev) => ({
          dailyPnl: 0.00,
          dailyPnlHistory: {},
          accountInfo: prev.accountInfo
            ? {
                ...prev.accountInfo,
                dailyRealizedPnL: 0,
                dailyRealizedLossUsd: 0,
              }
            : prev.accountInfo,
        }));

        get().addTelemetryLog('ACCOUNT', 'INFO', 'Daily Realized PnL calendar history cleanly reset to $0.00');

        fetch('/api/exness', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'sync-state',
            payload: {
              dailyPnl: 0,
              dailyRealizedLossUsd: 0,
            },
          }),
        }).catch(() => {});
      },

      openApiKeyModal: () => set({ isApiKeyModalOpen: true }),
      closeApiKeyModal: () => set({ isApiKeyModalOpen: false }),

      addTelemetryLog: (symbol, category, message) => {
        const item: TelemetryItem = {
          id: `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          timestamp: Date.now(),
          symbol,
          category,
          message,
        };
        set((state) => ({
          telemetryLogs: [item, ...state.telemetryLogs.slice(0, 249)],
        }));
      },

      clearTelemetry: () => set({ telemetryLogs: [] }),

      fetchAccountInfo: async () => {
        const now = Date.now();
        if (isFetchingAccountLock || (now - lastAccountFetchTime < 1000)) {
          return;
        }
        lastAccountFetchTime = now;
        isFetchingAccountLock = true;

        const state = get();
        const activeCreds = getActiveExnessCredentials(state.credentials);
        const hasVaultCreds = isVaultConfigured(state.credentials);
        const accountId = activeCreds.accountId || '30000143146';
        const serverName = activeCreds.server || (state.accountMode === 'REAL' ? 'Exness-Real' : 'Exness-Trial');
        const todayDateStr = getLocalDateString();
        const curHistory = state.dailyPnlHistory || {};
        const liveDailyPnl = curHistory[todayDateStr]?.pnl ?? state.dailyPnl ?? 0;

        // STRICT: If no vault credentials or API key is empty, strictly zero out metrics and disconnect
        if (!hasVaultCreds || !activeCreds.apiKey) {
          set({
            balance: 0,
            equity: 0,
            dailyPnl: 0,
            positions: [],
            openPositions: [],
            accountInfo: {
              accountNumber: accountId,
              server: serverName,
              currency: 'USD',
              balance: 0,
              equity: 0,
              margin: 0,
              freeMargin: 0,
              marginLevelPct: 0,
              dailyRealizedPnL: 0,
              dailyRealizedLossUsd: 0,
              latencyMs: 0,
              connected: false,
              mode: activeCreds.mode || 'REAL',
              isLiveExness: false,
            },
          });
          isFetchingAccountLock = false;
          return;
        }

        try {
          const res = await fetch('/api/exness', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${activeCreds.apiKey}`,
              'x-api-key': activeCreds.apiKey,
            },
            body: JSON.stringify({
              action: 'GET_ACCOUNT',
              credentials: {
                accountId,
                server: serverName,
                apiKey: activeCreds.apiKey,
                token: activeCreds.apiKey,
                password: activeCreds.password,
                secret: activeCreds.secret,
                initialBalance: activeCreds.initialBalance,
                currentBalance: state.balance > 0 ? state.balance : undefined,
              },
              payload: {
                currentBalance: state.balance > 0 ? state.balance : undefined,
                dailyPnl: liveDailyPnl,
                positions: state.openPositions || state.positions || [],
              },
            }),
          });
          const json = await res.json();
          if ((json.success || json.ok) && json.data) {
            const data = json.data;
            const isLiveExness = Boolean(data.isLiveExness);
            const liveBal = isLiveExness && typeof data.balance === 'number'
              ? Number(data.balance)
              : (state.balance > 0 ? state.balance : activeCreds.initialBalance);

            // SINGLE AUTHORITATIVE SOURCE OF TRUTH:
            // useTradingStore is the single authority for openPositions, balance, and equity.
            // Only genuine live Exness broker positions (isLiveExness) may overwrite openPositions.
            // For Demo or simulated accounts, NEVER overwrite local openPositions with server mock positions!
            const sourcePositions = (isLiveExness && Array.isArray(data.openPositions))
              ? data.openPositions
              : (get().openPositions || get().positions || []);

            const currentQuotes = get().quotes;
            const currentPrices = get().symbolPrices || {};

            const openPositions = sourcePositions.map((pos) => {
              const q = currentQuotes[pos.symbol] || currentPrices[pos.symbol];
              if (!q) return pos;
              const curPrice = pos.side === 'BUY' ? q.bid : q.ask;
              const prevValid = pos.currentPrice || pos.entryPrice;
              // Discard anomalous ticks jumping by > 50 pips in 5 seconds
              const profile = getPairProfile(pos.symbol);
              if (prevValid > 0 && Math.abs(curPrice - prevValid) / profile.pipValue > 50) {
                return pos;
              }
              const res = evaluatePositionPnL(pos, q);
              return { ...pos, currentPrice: curPrice, unrealizedPnl: res.pnlUsd };
            });

            const totalUnrealized = openPositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
            const strictEquity = isLiveExness && data.equity !== undefined
              ? Number(data.equity)
              : (openPositions.length === 0 ? liveBal : Number((liveBal + totalUnrealized).toFixed(2)));

            set({
              balance: liveBal,
              equity: strictEquity,
              dailyPnl: liveDailyPnl,
              positions: openPositions,
              openPositions: openPositions,
              accountInfo: {
                accountNumber: data.accountNumber || accountId,
                server: data.server || serverName,
                currency: data.currency || 'USD',
                balance: liveBal,
                equity: strictEquity,
                margin: Number(data.margin ?? 0),
                freeMargin: Number(data.freeMargin ?? Math.max(0, strictEquity - (data.margin ?? 0))),
                marginLevelPct: Number(data.marginLevelPct ?? (data.margin > 0 ? (strictEquity / data.margin) * 100 : 1000)),
                dailyRealizedPnL: Number(data.dailyRealizedPnL ?? liveDailyPnl),
                dailyRealizedLossUsd: Number(data.dailyRealizedLossUsd ?? 0),
                latencyMs: Number(data.latencyMs ?? 15),
                connected: Boolean(data.connected),
                mode: data.mode || (state.accountMode || 'REAL'),
                isLiveExness,
              },
            });
          }
        } catch {
          // Retain state silently on transient network timeout
        } finally {
          isFetchingAccountLock = false;
        }
      },

      fetchCandles: async (symbol) => {
        const rawTarget = symbol || get().focusSymbol || get().selectedSymbol || 'XAUUSDm';
        const profile = getPairProfile(rawTarget);
        const targetSymbol = profile.symbol;
        const now = Date.now();

        // Release in-flight fetch lock when symbol has changed
        if (targetSymbol !== lastCandlesFetchSymbol) {
          isFetchingCandlesLock = false;
        }

        // In-flight request lock + 500ms debounce guard per symbol
        const isSameSymbol = targetSymbol === lastCandlesFetchSymbol;
        const isWithinDebounce = (now - lastCandlesFetchTime) < 500;

        if (isSameSymbol && (isFetchingCandlesLock || isWithinDebounce)) {
          if (!candlesDebounceTimer) {
            candlesDebounceTimer = setTimeout(() => {
              candlesDebounceTimer = null;
              if (get().candles.length === 0 || (get().focusSymbol || get().selectedSymbol) !== targetSymbol) {
                get().fetchCandles(targetSymbol);
              }
            }, 500);
          }
          return;
        }

        if (candlesDebounceTimer) {
          clearTimeout(candlesDebounceTimer);
          candlesDebounceTimer = null;
        }

        lastCandlesFetchTime = now;
        lastCandlesFetchSymbol = targetSymbol;
        isFetchingCandlesLock = true;
        set({ isFetchingCandles: true });

        const state = get();
        const activeCreds = getActiveExnessCredentials(state.credentials);

        try {
          const res = await fetch('/api/exness', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'candles',
              symbol: targetSymbol,
              credentials: {
                accountId: activeCreds.accountId,
                server: activeCreds.server,
                token: activeCreds.apiKey,
                password: activeCreds.password,
                initialBalance: activeCreds.initialBalance,
              },
              payload: { timeframe: get().timeframe || 'M5', limit: 250 },
            }),
          });
          const json = await res.json();
          const currentActive = get().focusSymbol || get().selectedSymbol;

          // Discard stale responses if user switched symbols while fetch was in-flight
          if (currentActive === targetSymbol && (json.success || json.ok) && Array.isArray(json.data) && json.data.length > 0) {
            const lastC = json.data[json.data.length - 1];
            const expectedPrice = getPersistedRealPrice(targetSymbol);
            if (expectedPrice > 0 && Math.abs(lastC.close - expectedPrice) / expectedPrice > 0.15) {
              console.warn(`[CandleSanity] Discarding candles for ${targetSymbol} due to major price deviation: ${lastC.close} vs expected ${expectedPrice}`);
            } else {
              savePersistedRealPrice(targetSymbol, lastC.close);
              set({ candles: json.data });
              return;
            }
          }
        } catch (err) {
          console.warn(`Live candles fetch error/delayed for ${targetSymbol}, applying resilient fallback:`, err);
        } finally {
          isFetchingCandlesLock = false;
          set({ isFetchingCandles: false });
        }

        // Resilient fallback: ensure chart always renders clean realistic candles immediately
        const currentActive = get().focusSymbol || get().selectedSymbol;
        if (currentActive === targetSymbol && get().candles.length === 0) {
          const fallback = createLocalFallbackCandles(targetSymbol, 50, get().timeframe || 'M5');
          set({ candles: fallback });
        }
      },

      fetchQuote: async (symbol) => {
        const rawTarget = symbol || get().focusSymbol || get().selectedSymbol || 'XAUUSDm';
        const profile = getPairProfile(rawTarget);
        const targetSymbol = profile.symbol;
        const now = Date.now();

        // In-flight request lock + 200ms debounce per symbol
        if (inFlightQuotes.has(targetSymbol) || (now - (lastQuoteFetchTimes[targetSymbol] || 0) < 200)) {
          return;
        }

        inFlightQuotes.add(targetSymbol);
        lastQuoteFetchTimes[targetSymbol] = now;

        const state = get();
        const activeCreds = getActiveExnessCredentials(state.credentials);
        try {
          const res = await fetch('/api/exness', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'quote',
              symbol: targetSymbol,
              credentials: {
                accountId: activeCreds.accountId,
                server: activeCreds.server,
                token: activeCreds.apiKey,
                password: activeCreds.password,
                initialBalance: activeCreds.initialBalance,
              },
            }),
          });
          if (res.ok) {
            const json = await res.json();
            if (json.success && json.data) {
              const newQuote: LiveQuote = json.data;

              // Anchor lastKnownPrice[targetSymbol] to active open position prices to prevent infinite tick rejection spam
              const curPositions = (get().openPositions || get().positions || []).filter((p) => p.symbol === targetSymbol);
              if (curPositions.length > 0) {
                const refPos = curPositions[curPositions.length - 1];
                const refPrice = refPos.currentPrice || refPos.entryPrice;
                if (refPrice > 0 && Math.abs((lastKnownPrice[targetSymbol]?.price || refPrice) - refPrice) / profile.pipValue > 50) {
                  updateStoreLastKnownPrice(targetSymbol, refPrice, 'position_anchor');
                }
              }

              // Price Sanity Guard:
              // 1. If quote tick jumps by > 50 pips in 5 seconds from last known price, discard anomalous tick
              const lastKnown = lastKnownPrice[targetSymbol]?.price || getPersistedRealPrice(targetSymbol);
              if (lastKnown > 0) {
                const jumpPips = Math.abs(newQuote.bid - lastKnown) / profile.pipValue;
                if (jumpPips > 50) {
                  // Resolve deadlock: if active open positions exist around this bid, re-anchor immediately
                  if (curPositions.length > 0) {
                    const refPos = curPositions[0];
                    const refPrice = refPos.currentPrice || refPos.entryPrice;
                    if (Math.abs(newQuote.bid - refPrice) / profile.pipValue <= 50) {
                      updateStoreLastKnownPrice(targetSymbol, newQuote.bid, 'position_anchor');
                    } else {
                      console.warn(`[AnomalousTickGuard] Store discarding tick for ${targetSymbol}: bid ${newQuote.bid} jumps ${jumpPips.toFixed(1)} pips (> 50 pips) from last known ${lastKnown}`);
                      return;
                    }
                  } else {
                    console.warn(`[AnomalousTickGuard] Store discarding tick for ${targetSymbol}: bid ${newQuote.bid} jumps ${jumpPips.toFixed(1)} pips (> 50 pips) from last known ${lastKnown}`);
                    return;
                  }
                }
              }

              // 2. If quote tick jumps by > 50 pips from active open position current/entry price, discard anomalous tick
              for (const pos of curPositions) {
                const refPrice = pos.currentPrice || pos.entryPrice;
                if (refPrice > 0) {
                  const entryDevPips = Math.abs(newQuote.bid - refPrice) / profile.pipValue;
                  if (entryDevPips > 50) {
                    console.warn(`[AnomalousTickGuard] Store discarding tick for ${targetSymbol}: bid ${newQuote.bid} jumps ${entryDevPips.toFixed(1)} pips (> 50 pips) from position price ${refPrice}`);
                    return;
                  }
                }
              }

              // Overwrite PAIR_BASELINES and lastKnownPrice immediately with live price
              const midPrice = (newQuote.bid + newQuote.ask) / 2;
              PAIR_BASELINES[targetSymbol] = { price: midPrice, digits: profile.digits, pip: profile.pipValue };
              updateStoreLastKnownPrice(targetSymbol, midPrice, 'live');
              savePersistedRealPrice(targetSymbol, midPrice);

              set((prev) => {
                const updatedQuotes = {
                  ...prev.quotes,
                  [targetSymbol]: newQuote,
                };
                const updatedSymbolPrices = {
                  ...(prev.symbolPrices || {}),
                  [targetSymbol]: { bid: newQuote.bid, ask: newQuote.ask },
                };
                savePersistedSymbolPrices(updatedSymbolPrices);

                // Single source of truth: synchronize latest candle close/tick
                let updatedCandles = prev.candles;
                const isCurrentActive = targetSymbol === (prev.focusSymbol || prev.selectedSymbol || 'XAUUSDm');
                if (isCurrentActive && prev.candles.length > 0) {
                  const lastCandle = { ...prev.candles[prev.candles.length - 1] };
                  let liveTick = newQuote.bid;

                  const currentTf = prev.timeframe || 'M5';
                  const barBoundaryMs = timeframeToMs(currentTf);
                  if (now - lastCandle.timestamp > barBoundaryMs) {
                    const newCandle: Candle = {
                      timestamp: now,
                      open: liveTick,
                      high: liveTick,
                      low: liveTick,
                      close: liveTick,
                      volume: 1,
                    };
                    updatedCandles = [...prev.candles.slice(prev.candles.length >= 250 ? 1 : 0), newCandle];
                  } else {
                    lastCandle.close = liveTick;
                    lastCandle.high = Math.max(lastCandle.high, liveTick);
                    lastCandle.low = Math.min(lastCandle.low, liveTick);
                    lastCandle.volume = (lastCandle.volume || 1) + 1;
                    updatedCandles = [...prev.candles.slice(0, -1), lastCandle];
                  }
                }

                // Single source of truth: recalculate unrealizedPnL for all open positions using live quotes
                const balance = prev.balance > 0 ? prev.balance : (prev.accountInfo?.balance ?? (activeCreds.initialBalance > 0 ? activeCreds.initialBalance : 100.0));
                const sourcePositions = prev.openPositions || prev.positions || [];
                const updatedPositions = sourcePositions.map((pos) => {
                  const q = updatedQuotes[pos.symbol] || prev.quotes[pos.symbol];
                  if (!q) return pos;
                  const curPrice = pos.side === 'BUY' ? q.bid : q.ask;
                  const prevValid = pos.currentPrice || pos.entryPrice;
                  // Discard anomalous ticks jumping by > 50 pips in 5 seconds
                  const posProfile = getPairProfile(pos.symbol);
                  if (prevValid > 0 && Math.abs(curPrice - prevValid) / posProfile.pipValue > 50) {
                    return pos;
                  }
                  const res = evaluatePositionPnL(pos, q);
                  return {
                    ...pos,
                    currentPrice: curPrice,
                    unrealizedPnl: res.pnlUsd,
                  };
                });

                const totalUnrealized = updatedPositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
                const calculatedEquity = updatedPositions.length === 0 ? balance : Number((balance + totalUnrealized).toFixed(2));

                return {
                  quotes: updatedQuotes,
                  symbolPrices: updatedSymbolPrices,
                  candles: updatedCandles,
                  positions: updatedPositions,
                  openPositions: updatedPositions,
                  equity: calculatedEquity,
                  accountInfo: prev.accountInfo
                    ? {
                        ...prev.accountInfo,
                        equity: calculatedEquity,
                        freeMargin: Number(Math.max(0, calculatedEquity - (prev.accountInfo.margin || 0)).toFixed(2)),
                      }
                    : prev.accountInfo,
                };
              });
            }
          }
        } catch {
          // Silent: retain last valid cached quote state
        } finally {
          inFlightQuotes.delete(targetSymbol);
        }
      },

      executeLiveTickStream: async () => {
        const state = get();
        const activeSym = state.focusSymbol || state.selectedSymbol || 'XAUUSDm';
        const openPositions = state.openPositions || state.positions || [];
        const openSyms = openPositions.map((p) => p.symbol);
        const symbolsToFetch = Array.from(new Set([activeSym, ...openSyms]));

        // Continuously update live bid / ask for active symbol and all open positions
        await Promise.all(symbolsToFetch.map((sym) => get().fetchQuote(sym)));

        // Advance Tight ATR Trailing Stop smoothly in real time
        const freshState = get();
        const currentOpenPositions = freshState.openPositions || freshState.positions || [];
        if (currentOpenPositions.length === 0) return;

        let hasModifiedPosition = false;
        const updatedPositions: ManagedPosition[] = [];

        for (const pos of currentOpenPositions) {
          const profile = getPairProfile(pos.symbol);
          const q = freshState.quotes[pos.symbol] || freshState.symbolPrices?.[pos.symbol];
          if (!q) {
            updatedPositions.push(pos);
            continue;
          }

          const isBuy = pos.side === 'BUY';
          const curPrice = isBuy ? q.bid : q.ask;
          const prevValid = pos.currentPrice || pos.entryPrice;

          // Discard anomalous tick jumping by > 50 pips in 5 seconds
          if (prevValid > 0 && Math.abs(curPrice - prevValid) / profile.pipValue > 50) {
            updatedPositions.push(pos);
            continue;
          }

          // Check Take Profit hit
          if (pos.currentTp > 0 && (isBuy ? curPrice >= pos.currentTp : curPrice <= pos.currentTp)) {
            const pnlData = evaluatePositionPnL(pos, q);
            const realizedPnl = Number(pnlData.pnlUsd.toFixed(2));
            get().addTelemetryLog(pos.symbol, 'ORDER', `[TAKE PROFIT HIT] #${pos.id} ${pos.side} @ ${curPrice} (+$${realizedPnl.toFixed(2)})`);
            get().recordTradePnL(realizedPnl);
            fetch('/api/exness', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'CLOSE_POSITION',
                credentials: { accountId: getActiveExnessCredentials(freshState.credentials).accountId },
                payload: { positionId: pos.id, symbol: pos.symbol },
              }),
            }).catch(() => {});
            hasModifiedPosition = true;
            continue;
          }

          // Check Stop Loss / Trailing Stop hit
          if (pos.currentSl > 0 && (isBuy ? curPrice <= pos.currentSl : curPrice >= pos.currentSl)) {
            const pnlData = evaluatePositionPnL(pos, q);
            const realizedPnl = Number(pnlData.pnlUsd.toFixed(2));
            get().addTelemetryLog(pos.symbol, 'ORDER', `[STOP LOSS / TRAILING STOP HIT] #${pos.id} ${pos.side} @ ${curPrice} (${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)})`);
            get().recordTradePnL(realizedPnl);
            fetch('/api/exness', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'CLOSE_POSITION',
                credentials: { accountId: getActiveExnessCredentials(freshState.credentials).accountId },
                payload: { positionId: pos.id, symbol: pos.symbol },
              }),
            }).catch(() => {});
            hasModifiedPosition = true;
            continue;
          }

          // Compute ATR(14) and Middle BB for advancing Tight ATR Trailing Stop
          let middleBB = curPrice;
          let atr14 = profile.pipValue * (pos.symbol === 'XAUUSDm' ? 15 : 10);
          if (pos.symbol === (freshState.focusSymbol || freshState.selectedSymbol) && freshState.candles.length >= 20) {
            try {
              const { computeIndicatorSnapshot } = await import('@/core/indicatorEngine');
              const ind = computeIndicatorSnapshot(freshState.candles, profile.preset.rsiPeriod, profile.preset.bbPeriod, profile.preset.bbStdDev);
              middleBB = ind.c0.middleBB;
              atr14 = ind.c0.atr14;
            } catch {}
          }

          const trailingAction = evaluatePositionTrailing({
            position: pos,
            currentBid: q.bid,
            currentAsk: q.ask,
            middleBB,
            atr14,
            pairProfile: profile,
            enablePartialClose: freshState.enablePartialClose,
          });

          if (trailingAction.type === 'HARD_SL_CLOSE') {
            const pnlData = evaluatePositionPnL(pos, q);
            const realizedPnl = Number(pnlData.pnlUsd.toFixed(2));
            get().addTelemetryLog(pos.symbol, 'RISK', trailingAction.reason);
            get().recordTradePnL(realizedPnl);
            fetch('/api/exness', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'CLOSE_POSITION',
                credentials: { accountId: getActiveExnessCredentials(freshState.credentials).accountId },
                payload: { positionId: pos.id, symbol: pos.symbol },
              }),
            }).catch(() => {});
            hasModifiedPosition = true;
            continue;
          }

          if (trailingAction.type === 'PARTIAL_CLOSE' || trailingAction.type === 'PARTIAL_AND_MODIFY_SL') {
            get().addTelemetryLog(pos.symbol, 'TRAILING', trailingAction.reason);
            const closeVol = trailingAction.closeVolume || (pos.volume * 0.5);
            const partialPnl = Number(evaluatePositionPnL({ ...pos, volume: closeVol }, q).pnlUsd.toFixed(2));
            get().recordTradePnL(partialPnl);
            pos.volume = trailingAction.remainingVolume || (pos.volume - closeVol);
            pos.partialClosed = true;
            pos.trailingStatus = trailingAction.statusUpdate;
            fetch('/api/exness', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'CLOSE_POSITION',
                credentials: { accountId: getActiveExnessCredentials(freshState.credentials).accountId },
                payload: { positionId: pos.id, volumeToClose: closeVol, symbol: pos.symbol },
              }),
            }).catch(() => {});
            hasModifiedPosition = true;
          }

          if (trailingAction.type === 'MODIFY_SL' || trailingAction.type === 'PARTIAL_AND_MODIFY_SL') {
            if (trailingAction.newSlPrice && trailingAction.newSlPrice !== pos.currentSl) {
              get().addTelemetryLog(pos.symbol, 'TRAILING', trailingAction.reason);
              pos.currentSl = trailingAction.newSlPrice;
              pos.trailingStatus = trailingAction.statusUpdate;
              fetch('/api/exness', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: 'MODIFY_POSITION',
                  credentials: { accountId: getActiveExnessCredentials(freshState.credentials).accountId },
                  payload: { positionId: pos.id, stopLoss: trailingAction.newSlPrice, symbol: pos.symbol },
                }),
              }).catch(() => {});
              hasModifiedPosition = true;
            }
          }

          updatedPositions.push(pos);
        }

        if (hasModifiedPosition) {
          const balance = freshState.balance > 0 ? freshState.balance : 100.0;
          const totalUnrealized = updatedPositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
          const calculatedEquity = updatedPositions.length === 0 ? balance : Number((balance + totalUnrealized).toFixed(2));
          set({
            positions: updatedPositions,
            openPositions: updatedPositions,
            equity: calculatedEquity,
          });
        }
      },

      executeEngineTick: async (syntheticSignal) => {
        const state = get();
        // Engine tick must strictly only run when isAutoTrading is true
        if (!state.isAutoTrading) {
          return;
        }
        if (state.isTickRunning) return;

        set({ isTickRunning: true });
        const symbolsToScan = state.targetMarket === 'GOLD'
          ? ['XAUUSDm']
          : (state.targetMarket === 'FOREX'
              ? ['EURUSDm', 'GBPUSDm', 'USDJPYm']
              : (state.isMultiPairMode ? state.scannedSymbols : [state.selectedSymbol]));
        const activeCreds = getActiveExnessCredentials(state.credentials);
        const previousPositions = state.openPositions || state.positions || [];

        try {
          const res = await fetch('/api/engine-tick', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              credentials: {
                accountId: activeCreds.accountId,
                server: activeCreds.server,
                token: activeCreds.apiKey,
                password: activeCreds.password,
                initialBalance: activeCreds.initialBalance,
              },
              symbols: symbolsToScan,
              targetMarket: state.targetMarket,
              timeframe: state.timeframe || 'M5',
              orderVolume: state.lotSize,
              enablePartialClose: state.enablePartialClose,
              aiConfig: {
                baseUrl: state.credentials.aiBaseUrl,
                apiKey: state.credentials.aiApiKey,
                model: state.credentials.aiModel,
                confidenceThreshold: state.aiConfidenceThreshold,
              },
              activePositions: state.openPositions || state.positions,
              dailyRealizedLossUsd: state.accountInfo?.dailyRealizedLossUsd || 0,
              syntheticSignal,
            }),
          });

          const json = await res.json();
          if (json.telemetry && Array.isArray(json.telemetry)) {
            for (const t of json.telemetry) {
              get().addTelemetryLog(t.symbol, t.category, t.message);
            }
          }

          // Automatically record realized PnL from closed trades returned by engine (TP, SL, Trailing Stop, Partial Close)
          if (json.closedTrades && Array.isArray(json.closedTrades)) {
            for (const ct of json.closedTrades) {
              if (typeof ct.pnl === 'number') {
                get().recordTradePnL(ct.pnl);
              }
            }
          }

          // Positions diff detection: auto-record any positions closed on server without explicit closedTrades entry
          if (json.positions && Array.isArray(json.positions)) {
            for (const oldP of previousPositions) {
              const stillOpen = json.positions.find((np: ManagedPosition) => np.id === oldP.id);
              if (!stillOpen) {
                const alreadyHandled = json.closedTrades?.some((ct: any) => ct.id === oldP.id);
                if (!alreadyHandled) {
                  const quote = get().quotes[oldP.symbol];
                  const pnlData = quote
                    ? evaluatePositionPnL(oldP, quote)
                    : { pnlUsd: oldP.unrealizedPnl || 0 };
                  get().recordTradePnL(Number(pnlData.pnlUsd.toFixed(2)));
                }
              } else if (stillOpen.volume < oldP.volume) {
                const alreadyHandled = json.closedTrades?.some((ct: any) => ct.id === oldP.id && ct.reason === 'PARTIAL_CLOSE');
                if (!alreadyHandled) {
                  const closedVol = Number((oldP.volume - stillOpen.volume).toFixed(2));
                  const quote = get().quotes[oldP.symbol];
                  const pnlData = quote
                    ? evaluatePositionPnL({ ...oldP, volume: closedVol }, quote)
                    : { pnlUsd: (oldP.unrealizedPnl || 0) * (closedVol / oldP.volume) };
                  get().recordTradePnL(Number(pnlData.pnlUsd.toFixed(2)));
                }
              }
            }
          }

          // Client-side Zustand store remains single source of truth for active positions in Demo mode.
          // Never blindly overwrite client openPositions with stale server positions to prevent resurrection.
          if (get().isAutoTrading) {
            const currentClientPositions = get().openPositions || get().positions || [];
            let mergedPositions = [...currentClientPositions];

            // 1. If engine placed new orders, add them strictly if matching targetMarket and not already present
            if (json.orders && Array.isArray(json.orders)) {
              for (const ord of json.orders) {
                if (ord && ord.orderId && !mergedPositions.some((p) => p.id === ord.orderId)) {
                  // Enforce targetMarket strictly: GOLD restricts to XAUUSDm only
                  if (get().targetMarket === 'GOLD' && ord.symbol !== 'XAUUSDm') {
                    continue;
                  }
                  mergedPositions.push({
                    id: ord.orderId,
                    symbol: ord.symbol,
                    side: ord.side,
                    volume: ord.volume,
                    initialVolume: ord.volume,
                    entryPrice: ord.fillPrice,
                    currentPrice: ord.fillPrice,
                    currentSl: ord.stopLoss || 0,
                    currentTp: ord.takeProfit || 0,
                    highestPrice: ord.fillPrice,
                    lowestPrice: ord.fillPrice,
                    openTime: Date.now(),
                    partialClosed: false,
                    trailingStatus: 'INITIAL',
                  });
                }
              }
            }

            // 2. If trades closed on server, remove them from active positions
            if (json.closedTrades && Array.isArray(json.closedTrades)) {
              const closedIds = new Set(json.closedTrades.map((ct: any) => ct.id));
              mergedPositions = mergedPositions.filter((p) => !closedIds.has(p.id));
            }

            // 3. Update trailing stop modifications from server for remaining active positions
            if (json.positions && Array.isArray(json.positions)) {
              for (const sPos of json.positions) {
                const targetPos = mergedPositions.find((p) => p.id === sPos.id);
                if (targetPos) {
                  if (sPos.currentSl !== undefined) targetPos.currentSl = sPos.currentSl;
                  if (sPos.currentTp !== undefined) targetPos.currentTp = sPos.currentTp;
                  if (sPos.volume !== undefined) targetPos.volume = sPos.volume;
                  if (sPos.partialClosed !== undefined) targetPos.partialClosed = sPos.partialClosed;
                  if (sPos.trailingStatus) targetPos.trailingStatus = sPos.trailingStatus;
                }
              }
            }

            const balance = get().balance > 0 ? get().balance : (get().accountInfo?.balance ?? (activeCreds.initialBalance > 0 ? activeCreds.initialBalance : 100.0));
            const currentQuotes = get().quotes;
            const mappedPositions = mergedPositions.map((pos: ManagedPosition) => {
              const q = currentQuotes[pos.symbol];
              if (!q) return pos;
              const curPrice = pos.side === 'BUY' ? q.bid : q.ask;
              const prevValid = pos.currentPrice || pos.entryPrice;
              if (prevValid > 0 && Math.abs(curPrice - prevValid) / prevValid > 0.05) {
                return pos;
              }
              const res = evaluatePositionPnL(pos, q);
              return { ...pos, currentPrice: curPrice, unrealizedPnl: res.pnlUsd };
            });

            const totalUnrealized = mappedPositions.reduce((sum: number, p: ManagedPosition) => sum + (p.unrealizedPnl || 0), 0);
            const dynamicEquity = mappedPositions.length === 0 ? balance : Number((balance + totalUnrealized).toFixed(2));
            set((prev) => ({
              positions: mappedPositions,
              openPositions: mappedPositions,
              equity: dynamicEquity,
              accountInfo: prev.accountInfo
                ? {
                    ...prev.accountInfo,
                    equity: dynamicEquity,
                    freeMargin: Number(Math.max(0, dynamicEquity - (mappedPositions.length === 0 ? 0 : (prev.accountInfo.margin || 0))).toFixed(2)),
                    margin: mappedPositions.length === 0 ? 0 : prev.accountInfo.margin,
                  }
                : prev.accountInfo,
            }));
          }

          if (json.circuitBreakerTriggered) {
            set({ isAutoTrading: false, positions: [], openPositions: [] });
            get().addTelemetryLog('CIRCUIT_BREAKER', 'RISK', '🚨 EMERGENCY SHUTDOWN: Daily Drawdown limit reached.');
          }

          set({ lastTickTime: Date.now() });

          // Refresh account & quote data for currently active focus symbol
          const curSym = get().focusSymbol || get().selectedSymbol;
          get().fetchAccountInfo();
          get().fetchQuote(curSym);
          if (Date.now() - lastCandlesFetchTime > 60000) {
            get().fetchCandles(curSym);
          }
        } catch {
          // Silently handle engine tick errors without throwing
        } finally {
          set({ isTickRunning: false });
        }
      },

      closePosition: async (positionId, volume) => {
        const state = get();
        const activeCreds = getActiveExnessCredentials(state.credentials);
        try {
          const pos = (state.openPositions || state.positions).find((p) => p.id === positionId);
          if (!pos) return;

          const quote = state.quotes[pos.symbol];
          const closeVol = volume && volume < pos.volume ? volume : pos.volume;
          const pnlData = quote
            ? evaluatePositionPnL({ ...pos, volume: closeVol }, quote)
            : { pnlUsd: (pos.unrealizedPnl || 0) * (closeVol / pos.volume) };
          const realizedPnl = Number(pnlData.pnlUsd.toFixed(2));

          const res = await fetch('/api/exness', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${activeCreds.apiKey}`,
              'x-api-key': activeCreds.apiKey,
            },
            body: JSON.stringify({
              action: 'CLOSE_POSITION',
              credentials: {
                accountId: activeCreds.accountId || '30000143146',
                server: activeCreds.server,
                apiKey: activeCreds.apiKey,
                token: activeCreds.apiKey,
                password: activeCreds.password,
                initialBalance: activeCreds.initialBalance,
              },
              payload: { positionId, volumeToClose: volume, symbol: pos?.symbol },
            }),
          });

          const json = await res.json();
          if (json.success) {
            // Automatically record realized PnL into dailyPnlHistory
            get().recordTradePnL(realizedPnl);

            get().addTelemetryLog('ORDER', 'INFO', json.data?.message || `Position #${positionId} closed`);
            if (!volume || volume >= pos.volume) {
              const remaining = (get().openPositions || get().positions).filter((p) => p.id !== positionId);
              const curBal = get().balance > 0 ? get().balance : 100.0;
              const totalUnrealized = remaining.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
              const calculatedEquity = remaining.length === 0 ? curBal : Number((curBal + totalUnrealized).toFixed(2));
              set((prev) => ({
                positions: remaining,
                openPositions: remaining,
                equity: calculatedEquity,
                accountInfo: prev.accountInfo
                  ? {
                      ...prev.accountInfo,
                      equity: calculatedEquity,
                      freeMargin: Number(Math.max(0, calculatedEquity - (remaining.length === 0 ? 0 : (prev.accountInfo.margin || 0))).toFixed(2)),
                      margin: remaining.length === 0 ? 0 : prev.accountInfo.margin,
                    }
                  : prev.accountInfo,
              }));
            } else {
              const updated = (get().openPositions || get().positions).map((p) => {
                if (p.id === positionId) {
                  return {
                    ...p,
                    volume: Number((p.volume - closeVol).toFixed(2)),
                    partialClosed: true,
                  };
                }
                return p;
              });
              const curBal = get().balance > 0 ? get().balance : 100.0;
              const totalUnrealized = updated.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
              const calculatedEquity = updated.length === 0 ? curBal : Number((curBal + totalUnrealized).toFixed(2));
              set((prev) => ({
                positions: updated,
                openPositions: updated,
                equity: calculatedEquity,
                accountInfo: prev.accountInfo
                  ? {
                      ...prev.accountInfo,
                      equity: calculatedEquity,
                      freeMargin: Number(Math.max(0, calculatedEquity - (prev.accountInfo.margin || 0)).toFixed(2)),
                    }
                  : prev.accountInfo,
              }));
            }
            get().fetchAccountInfo();
          }
        } catch (err) {
          console.error('Error closing position:', err);
        }
      },

      panicCloseAll: async () => {
        const state = get();
        const activeCreds = getActiveExnessCredentials(state.credentials);
        try {
          const curPositions = state.openPositions || state.positions;
          get().addTelemetryLog('PANIC', 'RISK', `🚨 INITIATING EMERGENCY PANIC CLOSE on all ${curPositions.length} open positions!`);

          // Calculate and record realized dollar PnL for each position closed
          for (const pos of curPositions) {
            const quote = state.quotes[pos.symbol];
            const pnlData = quote
              ? evaluatePositionPnL(pos, quote)
              : { pnlUsd: pos.unrealizedPnl || 0 };
            const realizedPnl = Number(pnlData.pnlUsd.toFixed(2));
            get().recordTradePnL(realizedPnl);
          }

          const res = await fetch('/api/exness', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${activeCreds.apiKey}`,
              'x-api-key': activeCreds.apiKey,
            },
            body: JSON.stringify({
              action: 'PANIC_CLOSE',
              credentials: {
                accountId: activeCreds.accountId || '30000143146',
                server: activeCreds.server,
                apiKey: activeCreds.apiKey,
                token: activeCreds.apiKey,
                password: activeCreds.password,
                initialBalance: activeCreds.initialBalance,
              },
              payload: { positions: curPositions },
            }),
          });

          const json = await res.json();
          if (json.success) {
            get().addTelemetryLog('PANIC', 'INFO', json.data.message);
            const curBal = get().balance > 0 ? get().balance : 100.0;
            set((prev) => ({
              positions: [],
              openPositions: [],
              isAutoTrading: false,
              equity: curBal,
              accountInfo: prev.accountInfo
                ? {
                    ...prev.accountInfo,
                    equity: curBal,
                    freeMargin: curBal,
                    margin: 0,
                  }
                : prev.accountInfo,
            }));
            get().fetchAccountInfo();
          }
        } catch (err) {
          console.error('Panic close failed:', err);
        }
      },

      syncWithServerState: async () => {
        const now = Date.now();
        if (isSyncingLock || (now - lastSyncTime < 500)) {
          return;
        }
        lastSyncTime = now;
        isSyncingLock = true;
        set({ isSyncing: true });

        try {
          // SINGLE AUTHORITATIVE SOURCE OF TRUTH:
          // Local useTradingStore openPositions is authoritative.
          // Synchronize local positions & financial ledger state TO the server.
          const localPositions = get().openPositions || get().positions || [];
          const curBal = get().balance > 0 ? get().balance : (get().accountInfo?.balance || 100.0);

          const res = await fetch('/api/exness', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'sync-state',
              payload: {
                positions: localPositions,
                currentBalance: curBal,
                dailyPnl: get().dailyPnl,
                isAutoTrading: get().isAutoTrading,
              },
            }),
          });
          const json = await res.json();
          if (json.success && json.data) {
            const d = json.data;
            if (d.circuitBreakerTriggered) {
              set({ isAutoTrading: false, positions: [], openPositions: [] });
            }
          }
        } catch {
        } finally {
          isSyncingLock = false;
          set({ isSyncing: false });
        }
      },

      loadVaultOnStartup: async () => {
        if (hasLoadedSavedVault) return;
        hasLoadedSavedVault = true;

        if (typeof useTradingStore?.persist?.rehydrate === 'function') {
          await useTradingStore.persist.rehydrate();
        }

        const saved = await loadVaultFromLocalStorage();
        if (saved) {
          const activeCreds = getActiveExnessCredentials(saved);
          const hasCreds = isVaultConfigured(saved);
          const initBal = activeCreds.initialBalance > 0 ? activeCreds.initialBalance : 100.00;
          const serverName = activeCreds.server || (saved.accountMode === 'REAL' ? 'Exness-MT5Real' : 'Exness-MT5Trial17');

          // Read rehydrated state from store
          const state = get();
          const curHistory = state.dailyPnlHistory || {};
          const todayDateStr = getLocalDateString();
          const curDailyPnl = curHistory[todayDateStr]?.pnl ?? state.dailyPnl ?? 0;
          const cumPnl = Number(
            Object.values(curHistory).reduce((sum: number, item: any) => sum + (item?.pnl || 0), 0).toFixed(2)
          );
          const hasTradingHistory = Object.keys(curHistory).length > 0 || cumPnl !== 0 || curDailyPnl !== 0;

          const curPositions = (Array.isArray(state.openPositions) && state.openPositions.length > 0)
            ? state.openPositions
            : (Array.isArray(state.positions) && state.positions.length > 0 ? state.positions : []);

          // Automatic sanity check on startup: only reset if strictly negative balance
          const isCorrupted = typeof state.balance === 'number' && state.balance < 0;

          let resolvedBal: number;
          let safeDailyPnl = curDailyPnl;
          const savedPrices = get().symbolPrices || getPersistedSymbolPrices();
          const initializedPositions = isCorrupted
            ? []
            : curPositions.map((pos) => {
                const quoteObj = savedPrices[pos.symbol];
                const prevPrice = quoteObj ? (pos.side === 'BUY' ? quoteObj.bid : quoteObj.ask) : pos.entryPrice;
                const validPrice = prevPrice > 0 ? prevPrice : pos.entryPrice;
                const q = quoteObj || { bid: validPrice, ask: validPrice };
                const evaluated = evaluatePositionPnL(pos, q);
                return { ...pos, currentPrice: validPrice, unrealizedPnl: evaluated.pnlUsd };
              });
          let safePositions = initializedPositions;

          if (isCorrupted) {
            resolvedBal = initBal;
            safeDailyPnl = 0.00;
            safePositions = [];
            set({
              balance: initBal,
              equity: initBal,
              dailyPnl: 0.00,
              dailyPnlHistory: {},
              positions: [],
              openPositions: [],
            });
          } else if (hasTradingHistory) {
            if (state.balance > 0 && Math.abs(state.balance - initBal) > 0.001) {
              resolvedBal = state.balance;
            } else {
              resolvedBal = Number((initBal + cumPnl).toFixed(2));
            }
          } else {
            resolvedBal = state.balance > 0 ? state.balance : (state.accountInfo?.balance || initBal);
          }

          const totalUnrealized = safePositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
          const resolvedEquity = safePositions.length === 0 ? resolvedBal : Number((resolvedBal + totalUnrealized).toFixed(2));

          // Immediately sync balance, equity, and connection status into store (<1ms)
          set((prev) => ({
            credentials: saved,
            accountMode: saved.accountMode || prev.accountMode || 'DEMO',
            positions: safePositions,
            openPositions: safePositions,
            balance: resolvedBal,
            equity: resolvedEquity,
            dailyPnl: safeDailyPnl,
            accountInfo: hasCreds
              ? {
                  accountNumber: activeCreds.accountId || prev.accountInfo?.accountNumber || '',
                  server: serverName,
                  currency: 'USD',
                  balance: resolvedBal,
                  equity: resolvedEquity,
                  margin: prev.accountInfo?.margin ?? 0,
                  freeMargin: Number(Math.max(0, resolvedEquity - (prev.accountInfo?.margin ?? 0)).toFixed(2)),
                  marginLevelPct: prev.accountInfo?.marginLevelPct ?? 1000,
                  dailyRealizedPnL: safeDailyPnl,
                  dailyRealizedLossUsd: prev.accountInfo?.dailyRealizedLossUsd ?? 0,
                  latencyMs: 12,
                  connected: true,
                  mode: saved.accountMode || prev.accountMode || 'DEMO',
                }
              : prev.accountInfo,
          }));

          get().addTelemetryLog('SECURITY', 'INFO', `Decrypted credentials loaded from AES-256 Vault (${saved.accountMode || 'DEMO'} Mode)`);

          // Reset throttle lock so immediate live account verification succeeds
          lastAccountFetchTime = 0;
          isFetchingAccountLock = false;

          // Sync with backend server (passing resolved balance and positions)
          fetch('/api/exness', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'sync-state',
              payload: {
                credentials: saved,
                accountMode: saved.accountMode || get().accountMode,
                isAutoTrading: get().isAutoTrading,
                positions: curPositions,
                currentBalance: resolvedBal,
                dailyPnl: curDailyPnl,
              },
            }),
          }).catch(() => {});

          await get().fetchAccountInfo();
        }
      },

      loadSavedVault: async () => {
        return get().loadVaultOnStartup();
      },
    }),
    {
      name: LOCAL_STORAGE_KEY,
      storage: createJSONStorage(() => (typeof window !== 'undefined' ? localStorage : {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      })),
      skipHydration: true,
      partialize: (state) => ({
        balance: state.balance,
        equity: state.equity,
        dailyPnl: state.dailyPnl,
        dailyPnlHistory: state.dailyPnlHistory || {},
        openPositions: state.openPositions || state.positions || [],
        positions: state.openPositions || state.positions || [],
        symbolPrices: state.symbolPrices || {},
        // Note: isAutoTrading is strictly excluded from localStorage persistence
        accountMode: state.accountMode,
        targetMarket: state.targetMarket,
        focusSymbol: state.focusSymbol,
        selectedSymbol: state.selectedSymbol,
        timeframe: state.timeframe,
        isMultiPairMode: state.isMultiPairMode,
        scannedSymbols: state.scannedSymbols,
        lotSize: state.lotSize,
        aiConfidenceThreshold: state.aiConfidenceThreshold,
        enablePartialClose: state.enablePartialClose,
        credentials: state.credentials,
        accountInfo: state.accountInfo,
      }),
      onRehydrateStorage: () => (rehydratedState) => {
        if (rehydratedState) {
          // Strictly force isAutoTrading to false on page load / refresh
          rehydratedState.isAutoTrading = false;
          rehydratedState.dailyPnlHistory = rehydratedState.dailyPnlHistory || {};
          const savedPrices = rehydratedState.symbolPrices && Object.keys(rehydratedState.symbolPrices).length > 0
            ? rehydratedState.symbolPrices
            : getPersistedSymbolPrices();
          rehydratedState.symbolPrices = savedPrices;

          const valid = Array.isArray(rehydratedState.openPositions)
            ? rehydratedState.openPositions
            : (Array.isArray(rehydratedState.positions) ? rehydratedState.positions : []);
          rehydratedState.openPositions = valid;
          rehydratedState.positions = valid;

          const todayStr = getLocalDateString();
          let todayPnl = rehydratedState.dailyPnlHistory[todayStr]?.pnl ?? rehydratedState.dailyPnl ?? 0;

          const cumPnl = Number(
            Object.values(rehydratedState.dailyPnlHistory).reduce(
              (sum: number, item: any) => sum + (item?.pnl || 0),
              0
            ).toFixed(2)
          );

          const activeCreds = getActiveExnessCredentials(rehydratedState.credentials || defaultCredentials);
          const initBal = activeCreds.initialBalance > 0 ? activeCreds.initialBalance : 100.00;

          // Automatic sanity check on hydration: only reset if strictly negative balance
          const isCorrupted = typeof rehydratedState.balance === 'number' && rehydratedState.balance < 0;

          if (isCorrupted) {
            rehydratedState.balance = initBal;
            rehydratedState.equity = initBal;
            rehydratedState.dailyPnl = 0.00;
            rehydratedState.dailyPnlHistory = {};
            rehydratedState.openPositions = [];
            rehydratedState.positions = [];
            todayPnl = 0.00;
          } else {
            const hasTradingHistory = Object.keys(rehydratedState.dailyPnlHistory).length > 0 || cumPnl !== 0 || todayPnl !== 0;
            if (hasTradingHistory) {
              if (typeof rehydratedState.balance === 'number' && rehydratedState.balance > 0 && Math.abs(rehydratedState.balance - initBal) > 0.001) {
                // Valid persisted adjusted balance preserved
              } else {
                rehydratedState.balance = Number((initBal + cumPnl).toFixed(2));
              }
            } else if (typeof rehydratedState.balance !== 'number' || rehydratedState.balance <= 0) {
              rehydratedState.balance = initBal;
            }

            // Hydrate currentPrice and recompute unrealizedPnl for open positions
            if (rehydratedState.openPositions.length > 0) {
              rehydratedState.openPositions = rehydratedState.openPositions.map((pos: any) => {
                const quoteObj = savedPrices[pos.symbol];
                const prevPrice = quoteObj ? (pos.side === 'BUY' ? quoteObj.bid : quoteObj.ask) : pos.entryPrice;
                const validPrice = prevPrice > 0 ? prevPrice : pos.entryPrice;
                const q = quoteObj || { bid: validPrice, ask: validPrice };
                const evaluated = evaluatePositionPnL(pos, q);
                return { ...pos, currentPrice: validPrice, unrealizedPnl: evaluated.pnlUsd };
              });
              rehydratedState.positions = rehydratedState.openPositions;
            }
          }

          rehydratedState.dailyPnl = todayPnl;
          const totalUnrealized = rehydratedState.openPositions.reduce((sum: number, p: any) => sum + (p.unrealizedPnl || 0), 0);
          rehydratedState.equity = rehydratedState.openPositions.length === 0
            ? rehydratedState.balance
            : Number((rehydratedState.balance + totalUnrealized).toFixed(2));

          if (rehydratedState.accountInfo) {
            rehydratedState.accountInfo.balance = rehydratedState.balance;
            rehydratedState.accountInfo.equity = rehydratedState.equity;
            rehydratedState.accountInfo.dailyRealizedPnL = todayPnl;
            rehydratedState.accountInfo.margin = rehydratedState.openPositions.length === 0 ? 0 : (rehydratedState.accountInfo.margin || 0);
            rehydratedState.accountInfo.freeMargin = rehydratedState.openPositions.length === 0
              ? rehydratedState.balance
              : Number(Math.max(0, rehydratedState.equity - (rehydratedState.accountInfo.margin || 0)).toFixed(2));
          }
        }
      },
    }
  )
);

// Trigger client rehydration after hydration pass completes
if (typeof window !== 'undefined') {
  setTimeout(() => {
    useTradingStore.persist?.rehydrate?.();
    useTradingStore.setState({ isAutoTrading: false });
  }, 0);
}
