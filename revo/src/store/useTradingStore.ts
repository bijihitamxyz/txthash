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
import {
  ManagedPosition,
  evaluatePositionTrailing,
  sanitizePositionSlTp,
  canAttemptPositionClose,
  markPositionClosingStart,
  markPositionClosingDone,
} from '@/core/trailingManager';
import { getPairProfile, SUPPORTED_SYMBOLS, calculatePnL, evaluatePositionPnL, formatPrice } from '@/core/pairConfig';
import {
  KronosForecastResult,
  KronosHealthResult,
  computeRealTimeKronosForecast,
} from '@/core/kronosService';
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
  XAUUSDm: { price: 4108.90, digits: 2, pip: 0.10 },
  EURUSDm: { price: 1.11592, digits: 5, pip: 0.0001 },
  GBPUSDm: { price: 1.33877, digits: 5, pip: 0.0001 },
  USDJPYm: { price: 157.569, digits: 3, pip: 0.01 },
};

export const SYMBOL_BASELINES = PAIR_BASELINES;

export const LAST_KNOWN_PRICE_KEY = 'exness_last_known_real_prices';

export const lastKnownPrice: Record<string, { price: number; timestamp: number; source?: string }> = {};

export const LAST_VALID_LIVE_PRICE: Record<string, number> = {
  XAUUSDm: 4108.90,
  EURUSDm: 1.11592,
  GBPUSDm: 1.33877,
  USDJPYm: 157.569,
};

export function getValidLivePrice(symbol: string): number {
  if (LAST_VALID_LIVE_PRICE[symbol] && LAST_VALID_LIVE_PRICE[symbol] > 0) {
    return LAST_VALID_LIVE_PRICE[symbol];
  }
  const persisted = getPersistedRealPrice(symbol);
  if (persisted > 0) {
    LAST_VALID_LIVE_PRICE[symbol] = persisted;
    return persisted;
  }
  return PAIR_BASELINES[symbol]?.price || (symbol === 'XAUUSDm' ? 4108.90 : 1.0);
}

export function isValidPriceUpdate(symbol: string, newPrice: number): boolean {
  if (typeof newPrice !== 'number' || isNaN(newPrice) || !isFinite(newPrice) || newPrice <= 0) return false;
  // Specific protective filters for gold against fake fallback seeds
  if (symbol.startsWith('XAU')) {
    if (newPrice < 1500 || newPrice > 10000) return false;
    // Explicitly reject 3875 mock baseline seed that corrupts chart and balance
    if (Math.abs(newPrice - 3875.70) < 1.0) return false;
  } else if (symbol.startsWith('EUR') || symbol.startsWith('GBP')) {
    if (newPrice < 0.5 || newPrice > 2.5) return false;
  } else if (symbol.startsWith('USDJPY')) {
    if (newPrice < 50 || newPrice > 300) return false;
  }
  const lastValid = getValidLivePrice(symbol);
  if (lastValid > 0) {
    const deviation = Math.abs(newPrice - lastValid) / lastValid;
    // Protect against cross-symbol data injection (>15% jump on same symbol tick)
    if (deviation > 0.15) {
      return false;
    }
  }
  return true;
}

export function updateStoreLastKnownPrice(symbol: string, price: number, source: string = 'live'): void {
  if (typeof price === 'number' && price > 0 && !isNaN(price)) {
    if (!isValidPriceUpdate(symbol, price)) return;
    LAST_VALID_LIVE_PRICE[symbol] = price;
    lastKnownPrice[symbol] = { price, timestamp: Date.now(), source };
    savePersistedRealPrice(symbol, price);
    const profile = getPairProfile(symbol);
    PAIR_BASELINES[symbol] = {
      price,
      digits: profile.digits,
      pip: profile.pipValue,
    };
    if (symbol === 'XAUUSDm') {
      LAST_VALID_LIVE_PRICE['XAUUSD'] = price;
      lastKnownPrice['XAUUSD'] = { price, timestamp: Date.now(), source };
    } else if (symbol === 'XAUUSD') {
      LAST_VALID_LIVE_PRICE['XAUUSDm'] = price;
      lastKnownPrice['XAUUSDm'] = { price, timestamp: Date.now(), source };
    }
  }
}

export const INITIAL_QUOTES: Record<string, LiveQuote> = {
  XAUUSDm: { symbol: 'XAUUSDm', bid: 4108.90, ask: 4109.10, spreadPips: 2.0, timestamp: Date.now() },
  EURUSDm: { symbol: 'EURUSDm', bid: 1.11592, ask: 1.11600, spreadPips: 0.8, timestamp: Date.now() },
  GBPUSDm: { symbol: 'GBPUSDm', bid: 1.33877, ask: 1.33885, spreadPips: 0.8, timestamp: Date.now() },
  USDJPYm: { symbol: 'USDJPYm', bid: 157.569, ask: 157.577, spreadPips: 0.8, timestamp: Date.now() },
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
    const p = lastKnownPrice[symbol].price;
    if (!symbol.startsWith('XAU') || (p >= 1500 && Math.abs(p - 3875.70) > 1.0)) {
      return p;
    }
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const raw = window.localStorage.getItem(LAST_KNOWN_PRICE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed[symbol] === 'number' && parsed[symbol] > 0) {
          const val = parsed[symbol];
          if (!symbol.startsWith('XAU') || (val >= 1500 && Math.abs(val - 3875.70) > 1.0)) {
            lastKnownPrice[symbol] = { price: val, timestamp: Date.now(), source: 'localStorage' };
            return val;
          }
        }
      }
    } catch {}
  }
  return PAIR_BASELINES[symbol]?.price || (symbol.startsWith('XAU') ? 4108.90 : 1.0);
}

export function savePersistedRealPrice(symbol: string, price: number): void {
  if (!isValidPriceUpdate(symbol, price)) return;
  if (typeof window !== 'undefined' && window.localStorage && price > 0) {
    try {
      const raw = window.localStorage.getItem(LAST_KNOWN_PRICE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      parsed[symbol] = price;
      window.localStorage.setItem(LAST_KNOWN_PRICE_KEY, JSON.stringify(parsed));
    } catch {}
  }
}

export interface PersistedVerifiedAccount {
  accountId: string;
  server: string;
  balance: number;
  equity: number;
  currency: string;
  mode: AccountMode;
  connected: boolean;
  gatewayHost: string;
  timestamp: number;
}

export const VERIFIED_ACCOUNT_KEY = 'exness_verified_account_cache';

export function getPersistedVerifiedAccount(): PersistedVerifiedAccount | null {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const raw = window.localStorage.getItem(VERIFIED_ACCOUNT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.balance === 'number' && parsed.balance > 0) {
          return parsed;
        }
      }
    } catch {}
  }
  return null;
}

export function savePersistedVerifiedAccount(acc: PersistedVerifiedAccount): void {
  if (typeof window !== 'undefined' && window.localStorage && acc && acc.balance > 0) {
    try {
      window.localStorage.setItem(VERIFIED_ACCOUNT_KEY, JSON.stringify(acc));
    } catch {}
  }
}

export function clearPersistedVerifiedAccount(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.removeItem(VERIFIED_ACCOUNT_KEY);
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
  if (symbol === 'XAUUSDm') price = realPrice > 0 ? realPrice : 4108.90;
  else if (symbol === 'USDJPYm') price = realPrice > 0 ? realPrice : 156.840;
  else if (symbol === 'GBPUSDm') price = realPrice > 0 ? realPrice : 1.29500;
  return { price, digits, pip };
}

function createLocalFallbackCandles(rawSymbol: string, count: number = 50, tf: Timeframe = 'M5'): Candle[] {
  const profile = getPairProfile(rawSymbol);
  const symbol = profile.symbol;
  const base = getSymbolBaselineEntry(symbol, profile.digits, profile.pipValue);

  // Anchor strictly to the LAST KNOWN LIVE price first (e.g. ~4116.85), never to a stale seed (~4076 / 3875)
  const liveAnchor = lastKnownPrice[symbol]?.price || (symbol.startsWith('XAU') ? (lastKnownPrice['XAUUSDm']?.price || lastKnownPrice['XAUUSD']?.price) : 0) || 0;
  let anchor = liveAnchor > 0 ? liveAnchor : (getPersistedRealPrice(symbol) || base.price);
  if (symbol.startsWith('XAU')) {
    if (anchor < 1500 || Math.abs(anchor - 3875.70) < 1.0) {
      anchor = LAST_VALID_LIVE_PRICE.XAUUSDm || 4116.85;
    }
  }
  const now = Date.now();
  const tfMs = timeframeToMs(tf);
  const candles: Candle[] = [];
  // Never let a synthetic candle move more than 0.15% from the previous candle close
  const maxJump = anchor * 0.0015;
  const clampStep = (from: number, to: number) =>
    Math.abs(to - from) > maxJump ? from + (to > from ? maxJump : -maxJump) : to;
  let prevClose = anchor;

  for (let i = 0; i < count; i++) {
    const timestamp = now - ((count - 1 - i) * tfMs);
    const wave = Math.sin((i / count) * Math.PI * 3) * Math.min(base.pip * 1.5, maxJump * 0.5);
    const open = Number(clampStep(prevClose, anchor + wave).toFixed(base.digits));
    const rawClose = i === count - 1 ? anchor : anchor + wave + (i % 2 === 0 ? base.pip * 0.4 : -base.pip * 0.4);
    const close = Number(clampStep(open, rawClose).toFixed(base.digits));
    const high = Number((Math.max(open, close) + Math.min(base.pip * 0.3, maxJump * 0.3)).toFixed(base.digits));
    const low = Number((Math.min(open, close) - Math.min(base.pip * 0.3, maxJump * 0.3)).toFixed(base.digits));
    candles.push({ timestamp, open, high, low, close, volume: 100 + (i % 30) });
    prevClose = close;
  }
  return candles;
}

export interface TradingState {
  // Top-level persisted financial metrics & active positions
  balance: number | null;
  equity: number | null;
  dailyPnl: number | null;
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
  isServerHydrated: boolean;
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
  kronosPrediction: KronosForecastResult | null;
  kronosHealth: KronosHealthResult | null;

  // 5. Active Positions & Telemetry Logs
  telemetryLogs: TelemetryItem[];

  // 6. Strategy Parameters
  lotSize: number;
  stopLossPips: number;
  takeProfitPips: number;
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
  setStopLossPips: (pips: number) => Promise<void>;
  setTakeProfitPips: (pips: number) => Promise<void>;
  setAiConfidenceThreshold: (val: number) => void;
  setEnablePartialClose: (enabled: boolean) => void;
  setCredentials: (creds: Partial<StoredCredentials>) => Promise<void>;
  openApiKeyModal: () => void;
  closeApiKeyModal: () => void;
  isVaultModalOpen: boolean;
  openVaultModal: () => void;
  closeVaultModal: () => void;
  isAiModalOpen: boolean;
  openAiModal: () => void;
  closeAiModal: () => void;
  openTestOrder: (side: 'BUY' | 'SELL') => Promise<void>;
  modifyPosition: (positionId: string, stopLoss?: number, takeProfit?: number) => Promise<void>;
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
  fetchKronosPrediction: (symbol?: string, tf?: Timeframe) => Promise<void>;
  checkKronosHealth: () => Promise<void>;
  executeLiveTickStream: () => Promise<void>;
  executeEngineTick: (syntheticSignal?: { symbol: string; side: 'BUY' | 'SELL' }) => Promise<void>;
  closePosition: (positionId: string, volume?: number) => Promise<void>;
  panicCloseAll: () => Promise<void>;
  loadVaultOnStartup: () => Promise<void>;
  loadSavedVault: () => Promise<void>;
  hydrateFromServer: () => Promise<void>;
  syncWithServerState: () => Promise<void>;
}

const defaultCredentials: StoredCredentials = { ...DEFAULT_CREDENTIALS };
const defaultAccountMode: AccountMode = 'DEMO';
const defaultBalance: number | null = null;
const defaultEquity: number | null = null;
const defaultDailyPnl: number | null = null;
const defaultDailyPnlHistory: Record<string, { pnl: number; trades: number; wins: number; losses: number }> = {};
const defaultPositions: ManagedPosition[] = [];
const defaultIsAutoTrading = false;
const defaultTargetMarket: TargetMarket = 'GOLD';
const defaultFocusSymbol = 'XAUUSDm';
const defaultSelectedSymbol = 'XAUUSDm';
const defaultIsMultiPairMode = false;
const defaultScannedSymbols = ['XAUUSDm'];
const defaultTimeframe: Timeframe = 'M5';
const defaultLotSize = 0.10;
const defaultAiConfidence = 70;
const defaultPartialClose = true;

const defaultAccountInfo: AccountInfo = {
  accountNumber: '',
  server: 'Exness-MT5Trial',
  currency: 'USD',
  balance: null,
  equity: null,
  margin: 0,
  freeMargin: null,
  marginLevelPct: 0,
  dailyRealizedPnL: null,
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
      isServerHydrated: false,
      isTickRunning: false,
      isFetchingCandles: false,
      isSyncing: false,
      tickIntervalMs: 3000,
      lastTickTime: null,

      accountInfo: defaultAccountInfo,
      quotes: { ...INITIAL_QUOTES },
      symbolPrices: getPersistedSymbolPrices(),
      candles: createLocalFallbackCandles(defaultFocusSymbol, 50, defaultTimeframe),
      kronosPrediction: null,
      kronosHealth: null,
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
        const basePrice = lastReal > 0 ? lastReal : (p.symbol === 'XAUUSDm' ? 4108.90 : 1.0);
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
      stopLossPips: 25,
      takeProfitPips: 50,
      aiConfidenceThreshold: defaultAiConfidence,
      enablePartialClose: defaultPartialClose,

      credentials: defaultCredentials,
      isApiKeyModalOpen: false,
      isVaultModalOpen: false,
      isAiModalOpen: false,
      isPnlCalendarModalOpen: false,

      openApiKeyModal: () => set({ isApiKeyModalOpen: true, isVaultModalOpen: true }),
      closeApiKeyModal: () => set({ isApiKeyModalOpen: false, isVaultModalOpen: false }),
      openVaultModal: () => set({ isApiKeyModalOpen: true, isVaultModalOpen: true }),
      closeVaultModal: () => set({ isApiKeyModalOpen: false, isVaultModalOpen: false }),
      openAiModal: () => set({ isAiModalOpen: true }),
      closeAiModal: () => set({ isAiModalOpen: false }),
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

        const isLiveAccount = Boolean(get().accountInfo?.isLiveExness || isVaultConfigured(get().credentials));
        const prevBal = get().balance;
        // Never artificially mutate real broker balance on live Exness
        const updatedBal = isLiveAccount
          ? prevBal
          : (prevBal !== null && prevBal > 0 ? Number((prevBal + pnl).toFixed(2)) : null);

        const curPositions = get().openPositions || get().positions || [];
        const totalUnrealized = curPositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
        const updatedEquity = updatedBal !== null
          ? (curPositions.length === 0 ? updatedBal : Number((updatedBal + totalUnrealized).toFixed(2)))
          : null;

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
        const serverName = activeCreds.server || (mode === 'REAL' ? 'Exness-MT5Real' : 'Exness-MT5Trial');

        const curPositions = get().openPositions || get().positions || [];
        const todayDateStr = getLocalDateString();
        const curHistory = get().dailyPnlHistory || {};
        const curDailyPnl = curHistory[todayDateStr]?.pnl ?? 0;

        const isConnected = Boolean(get().accountInfo?.connected);
        const curBal: number | null = isConnected ? (get().accountInfo?.balance ?? get().balance ?? null) : null;
        const totalUnrealized = curPositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
        const curEquity: number | null = isConnected && curBal !== null
          ? (curPositions.length === 0 ? curBal : Number((curBal + totalUnrealized).toFixed(2)))
          : null;

        // Update store state & financial metrics synchronously (<1ms)
        set(() => ({
          accountMode: mode,
          credentials: creds,
          positions: isConnected ? curPositions : [],
          openPositions: isConnected ? curPositions : [],
          balance: curBal,
          equity: curEquity,
          dailyPnl: isConnected && hasCreds ? curDailyPnl : null,
          accountInfo: isConnected
            ? {
                accountNumber: activeCreds.accountId || '',
                server: serverName,
                currency: 'USD',
                balance: curBal,
                equity: curEquity,
                margin: get().accountInfo?.margin || 0,
                freeMargin: curEquity !== null ? Number(Math.max(0, curEquity - (get().accountInfo?.margin || 0)).toFixed(2)) : null,
                marginLevelPct: get().accountInfo?.marginLevelPct || 0,
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
                balance: null,
                equity: null,
                margin: 0,
                freeMargin: null,
                marginLevelPct: 0,
                dailyRealizedPnL: null,
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

        // Immediately trigger non-blocking candle, quote & Kronos prediction fetch
        get().fetchCandles(sym);
        get().fetchQuote(sym);
        get().fetchKronosPrediction(sym, get().timeframe || 'M5');

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

        // Fetch fresh live candles & Kronos forecast for selected timeframe from API
        get().fetchCandles(targetSymbol);
        get().fetchKronosPrediction(targetSymbol, tf);
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

      setStopLossPips: async (pips: number) => {
        const valid = Math.max(5, Math.min(500, Math.round(pips)));
        set({ stopLossPips: valid });
        try {
          await fetch('/api/exness', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'sync-state',
              payload: { stopLossPips: valid },
            }),
          });
        } catch {}
      },

      setTakeProfitPips: async (pips: number) => {
        const valid = Math.max(5, Math.min(1000, Math.round(pips)));
        set({ takeProfitPips: valid });
        try {
          await fetch('/api/exness', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'sync-state',
              payload: { takeProfitPips: valid },
            }),
          });
        } catch {}
      },

      setAiConfidenceThreshold: (val) => set({ aiConfidenceThreshold: val }),
      setEnablePartialClose: (enabled) => {
        set({ enablePartialClose: enabled });
        get().addTelemetryLog(
          'SYSTEM',
          'TRAILING',
          `[EA] 3-Stage Trailing Stop (50% Banked + Breakeven + ATR Lock) set to ${enabled ? 'ACTIVE' : 'OFF'}`
        );
        fetch('/api/exness', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'sync-state',
            payload: { enablePartialClose: enabled },
          }),
        }).catch(() => {});
        fetch('/api/engine-tick', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enablePartialClose: enabled }),
        }).catch(() => {});
      },

      setCredentials: async (newCreds) => {
        const updated: StoredCredentials = {
          ...get().credentials,
          ...newCreds,
          updatedAt: Date.now(),
        };
        const activeCreds = getActiveExnessCredentials(updated);
        const hasCreds = isVaultConfigured(updated);
        const serverName = activeCreds.server || (updated.accountMode === 'REAL' ? 'Exness-MT5Real' : 'Exness-MT5Trial');

        const curPositions = get().openPositions || get().positions || [];
        const todayDateStr = getLocalDateString();
        const curHistory = get().dailyPnlHistory || {};
        const curDailyPnl = curHistory[todayDateStr]?.pnl ?? 0;

        const verified = getPersistedVerifiedAccount();
        const isConnected = Boolean(get().accountInfo?.connected || (hasCreds && verified));
        const curBal: number | null = get().balance ?? verified?.balance ?? (isConnected ? (get().accountInfo?.balance ?? null) : null);
        const totalUnrealized = curPositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
        const curEquity: number | null = (curBal !== null)
          ? (curPositions.length === 0 ? curBal : Number((curBal + totalUnrealized).toFixed(2)))
          : (verified?.equity ?? null);

        set((prev) => ({
          credentials: updated,
          accountMode: updated.accountMode,
          positions: curPositions,
          openPositions: curPositions,
          balance: curBal,
          equity: curEquity,
          dailyPnl: hasCreds ? curDailyPnl : null,
          accountInfo: (isConnected || hasCreds)
            ? {
                accountNumber: activeCreds.accountId || prev.accountInfo?.accountNumber || verified?.accountId || '',
                server: serverName,
                currency: 'USD',
                balance: curBal,
                equity: curEquity,
                margin: prev.accountInfo?.margin || 0,
                freeMargin: curEquity !== null ? Number(Math.max(0, curEquity - (prev.accountInfo?.margin || 0)).toFixed(2)) : null,
                marginLevelPct: prev.accountInfo?.marginLevelPct || 0,
                dailyRealizedPnL: curDailyPnl,
                dailyRealizedLossUsd: prev.accountInfo?.dailyRealizedLossUsd || 0,
                latencyMs: 12,
                connected: Boolean(isConnected || hasCreds),
                mode: updated.accountMode,
                isLiveExness: true,
              }
            : {
                accountNumber: '',
                server: serverName,
                currency: 'USD',
                balance: null,
                equity: null,
                margin: 0,
                freeMargin: null,
                marginLevelPct: 0,
                dailyRealizedPnL: null,
                dailyRealizedLossUsd: 0,
                latencyMs: 0,
                connected: false,
                mode: updated.accountMode,
                isLiveExness: false,
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
                positions: isConnected ? (get().openPositions || get().positions || []) : [],
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
        const isConnected = Boolean(get().accountInfo?.connected);
        const curBal: number | null = isConnected ? (get().balance ?? get().accountInfo?.balance ?? null) : null;
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
        get().addTelemetryLog('ACCOUNT', 'INFO', 'Refreshing real Exness account data...');
        get().fetchAccountInfo();
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
        const accountId = activeCreds.accountId || '30000143146';
        const serverName = activeCreds.server || (state.accountMode === 'REAL' ? 'Exness-MT5Real' : 'Exness-MT5Trial');
        const todayDateStr = getLocalDateString();
        const curHistory = state.dailyPnlHistory || {};
        const liveDailyPnl = curHistory[todayDateStr]?.pnl ?? state.dailyPnl ?? 0;

        try {
          const res = await fetch('/api/exness', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(activeCreds.apiKey ? { 'Authorization': `Bearer ${activeCreds.apiKey}`, 'x-api-key': activeCreds.apiKey } : {}),
            },
            body: JSON.stringify({
              action: 'status',
              credentials: {
                accountId,
                server: serverName,
                apiKey: activeCreds.apiKey,
                token: activeCreds.apiKey,
                password: activeCreds.password,
                secret: activeCreds.secret,
                privateKey: activeCreds.secret,
                mode: activeCreds.mode || state.accountMode || 'DEMO',
                initialBalance: activeCreds.initialBalance,
                currentBalance: state.balance !== null && state.balance > 0 ? state.balance : (getPersistedVerifiedAccount()?.balance ?? undefined),
              },
              payload: {
                currentBalance: state.balance !== null && state.balance > 0 ? state.balance : (getPersistedVerifiedAccount()?.balance ?? undefined),
                dailyPnl: liveDailyPnl,
                positions: (state.openPositions || state.positions || []).filter((p) => p && p.id !== 'F-637' && p.id !== '#F-637'),
              },
            }),
          });

          if (res.ok) {
            const data = await res.json();
            const snap = data.data || data;

            if (snap.connected || data.connected) {
              const liveBal = Number(snap.balance ?? data.balance ?? snap.account?.balance ?? 0);
              const liveEquity = Number(snap.equity ?? data.equity ?? snap.account?.equity ?? liveBal);
              const liveDailyPnL = Number(
                snap.dailyPnl ?? data.dailyPnl ?? snap.account?.dailyRealizedPnL ?? liveDailyPnl
              );

              if (liveBal > 0) {
                savePersistedVerifiedAccount({
                  accountId: snap.accountId || snap.account?.accountNumber || accountId,
                  server: snap.server || snap.account?.server || serverName,
                  balance: liveBal,
                  equity: liveEquity,
                  currency: snap.currency || snap.account?.currency || 'USD',
                  mode: snap.mode || snap.account?.mode || state.accountMode || 'DEMO',
                  connected: true,
                  gatewayHost: 'ap-6756732d.exness-api.com',
                  timestamp: Date.now(),
                });
              }

              // Server positions synchronization:
              // Only update openPositions when the Exness API response explicitly succeeds (ok: true and authenticated: true).
              // If a poll fails, times out, or returns an unauthenticated fallback response, retain the existing openPositions array in state without wiping #6850606!
              const isPositionsResponseExplicitSuccess = Boolean(
                (snap.connected || data.connected) &&
                (snap.positionsSuccess !== false) &&
                !snap.positionsError &&
                (Array.isArray(snap.positions) || Array.isArray(snap.openPositions) || Array.isArray(data.positions) || Array.isArray(data.openPositions))
              );

              const existingPositions = (state.openPositions || state.positions || []).filter(
                (p: any) => p && p.id !== 'F-637' && p.id !== '#F-637'
              );

              let rawServerPositions: any[];
              if (isPositionsResponseExplicitSuccess) {
                const incoming = Array.isArray(snap.positions)
                  ? snap.positions
                  : (Array.isArray(snap.openPositions)
                    ? snap.openPositions
                    : (Array.isArray(data.positions) ? data.positions : data.openPositions));
                // Extra guard: If incoming is empty but we previously had open positions, verify it is truly a successful empty list from broker
                if (incoming.length === 0 && existingPositions.length > 0 && snap.positionsSuccess === false) {
                  rawServerPositions = existingPositions;
                } else {
                  rawServerPositions = incoming;
                }
              } else {
                rawServerPositions = existingPositions;
              }

              const cleanServerPositions: ManagedPosition[] = rawServerPositions.filter(
                (p: any) => p && p.id !== 'F-637' && p.id !== '#F-637'
              );

              const currentQuotes = get().quotes;
              const currentPrices = get().symbolPrices || {};
              const slPipsCfg = state.stopLossPips ?? 25;
              const tpPipsCfg = state.takeProfitPips ?? 50;
              const normTicket = (id: string) => String(id || '').replace(/^#+/, '').trim().toLowerCase();

              const evaluatedPositions = cleanServerPositions.map((rawPos: any) => {
                const matchExisting = existingPositions.find(
                  (ep: any) => normTicket(ep.id) === normTicket(rawPos.id)
                );
                const pos: any = {
                  ...(matchExisting || {}),
                  ...rawPos,
                  currentSl: Number(rawPos.currentSl || rawPos.sl || matchExisting?.currentSl || matchExisting?.virtualSl || 0),
                  currentTp: Number(rawPos.currentTp || rawPos.tp || matchExisting?.currentTp || matchExisting?.virtualTp || 0),
                  virtualSl: Number(rawPos.virtualSl || matchExisting?.virtualSl || rawPos.currentSl || rawPos.sl || 0),
                  virtualTp: Number(rawPos.virtualTp || matchExisting?.virtualTp || rawPos.currentTp || rawPos.tp || 0),
                  trailingStatus: rawPos.trailingStatus && rawPos.trailingStatus !== 'ACTIVE'
                    ? rawPos.trailingStatus
                    : (matchExisting?.trailingStatus || rawPos.trailingStatus || 'ACTIVE'),
                  highestPrice: Number(rawPos.highestPrice || matchExisting?.highestPrice || rawPos.entryPrice || 0),
                  lowestPrice: Number(rawPos.lowestPrice || matchExisting?.lowestPrice || rawPos.entryPrice || 0),
                  isClosing: Boolean(
                    rawPos.isClosing ||
                    (matchExisting?.isClosing && (Date.now() - (matchExisting?.closingStartedAt || 0) < 15000))
                  ),
                  closingStartedAt: rawPos.closingStartedAt || matchExisting?.closingStartedAt,
                };
                const q = currentQuotes[pos.symbol] || currentPrices[pos.symbol];
                const validPrice = getValidLivePrice(pos.symbol);
                const prof = getPairProfile(pos.symbol);
                const safeQ = (q && isValidPriceUpdate(pos.symbol, q.bid))
                  ? q
                  : {
                      symbol: pos.symbol,
                      bid: validPrice,
                      ask: Number((validPrice + (pos.symbol.startsWith('XAU') ? 0.20 : prof.pipValue)).toFixed(prof.digits)),
                      spreadPips: pos.symbol.startsWith('XAU') ? 2.0 : 0.8,
                      timestamp: Date.now(),
                    };
                const curPrice = pos.side === 'BUY' ? safeQ.bid : safeQ.ask;
                sanitizePositionSlTp(pos, curPrice, slPipsCfg, tpPipsCfg);
                const pnlRes = evaluatePositionPnL(pos, safeQ);
                return {
                  ...pos,
                  currentPrice: curPrice,
                  unrealizedPnl: pnlRes.pnlUsd,
                };
              });

              set({
                balance: liveBal,
                equity: liveEquity,
                dailyPnl: liveDailyPnL,
                positions: evaluatedPositions,
                openPositions: evaluatedPositions,
                accountInfo: {
                  accountNumber: snap.accountId || snap.account?.accountNumber || accountId,
                  server: snap.server || snap.account?.server || serverName,
                  currency: snap.currency || snap.account?.currency || 'USD',
                  balance: liveBal,
                  equity: liveEquity,
                  margin: Number(snap.margin ?? snap.account?.margin ?? 0),
                  freeMargin: Number(snap.freeMargin ?? snap.account?.freeMargin ?? Math.max(0, liveEquity - (snap.margin ?? 0))),
                  marginLevelPct: Number(snap.marginLevelPct ?? snap.account?.marginLevelPct ?? 0),
                  dailyRealizedPnL: liveDailyPnL,
                  dailyRealizedLossUsd: Number(snap.dailyRealizedLossUsd ?? snap.account?.dailyRealizedLossUsd ?? 0),
                  latencyMs: Number(snap.latencyMs ?? 14),
                  connected: true,
                  mode: snap.mode || snap.account?.mode || state.accountMode || 'DEMO',
                  isLiveExness: true,
                },
              });
              isFetchingAccountLock = false;
              return;
            } else {
              const persisted = getPersistedVerifiedAccount();
              const hasVault = isVaultConfigured(state.credentials);
              const hasBalance = state.balance !== null && state.balance > 0;
              if (hasVault || persisted || hasBalance) {
                // PRESERVE active balance, equity, and positions during transient poll hiccup on serverless
                const preservedBal = (state.balance !== null && state.balance > 0) ? state.balance : (persisted?.balance ?? null);
                const preservedPositions = (state.openPositions || state.positions || []).filter(
                  (p: any) => p && p.id !== 'F-637' && p.id !== '#F-637'
                );
                const currentQuotes = get().quotes;
                const currentPrices = get().symbolPrices || {};
                const evaluatedPositions = preservedPositions.map((pos: any) => {
                  const q = currentQuotes[pos.symbol] || currentPrices[pos.symbol];
                  const validPrice = getValidLivePrice(pos.symbol);
                  const prof = getPairProfile(pos.symbol);
                  const safeQ = (q && isValidPriceUpdate(pos.symbol, q.bid))
                    ? q
                    : {
                        symbol: pos.symbol,
                        bid: validPrice,
                        ask: Number((validPrice + (pos.symbol.startsWith('XAU') ? 0.20 : prof.pipValue)).toFixed(prof.digits)),
                        spreadPips: pos.symbol.startsWith('XAU') ? 2.0 : 0.8,
                        timestamp: Date.now(),
                      };
                  const curPrice = pos.side === 'BUY' ? safeQ.bid : safeQ.ask;
                  const cloned = { ...pos };
                  sanitizePositionSlTp(cloned, curPrice, state.stopLossPips ?? 25, state.takeProfitPips ?? 50);
                  const pnlRes = evaluatePositionPnL(cloned, safeQ);
                  return {
                    ...cloned,
                    currentPrice: curPrice,
                    unrealizedPnl: pnlRes.pnlUsd,
                  };
                });
                const totalUnrealized = evaluatedPositions.reduce((sum: number, p: any) => sum + (p.unrealizedPnl || 0), 0);
                const preservedEquity = preservedBal !== null
                  ? (evaluatedPositions.length === 0 ? preservedBal : Number((preservedBal + totalUnrealized).toFixed(2)))
                  : (persisted?.equity ?? null);

                set((prev) => ({
                  balance: preservedBal,
                  equity: preservedEquity,
                  positions: evaluatedPositions,
                  openPositions: evaluatedPositions,
                  accountInfo: {
                    ...(prev.accountInfo || defaultAccountInfo),
                    accountNumber: snap?.accountId || prev.accountInfo?.accountNumber || persisted?.accountId || accountId,
                    server: snap?.server || prev.accountInfo?.server || persisted?.server || serverName,
                    currency: snap?.currency || prev.accountInfo?.currency || 'USD',
                    balance: preservedBal,
                    equity: preservedEquity,
                    connected: true,
                    mode: snap?.mode || prev.accountInfo?.mode || state.accountMode || 'DEMO',
                    isLiveExness: true,
                  },
                }));
                isFetchingAccountLock = false;
                return;
              }

              set((prev) => ({
                balance: null,
                equity: null,
                dailyPnl: null,
                positions: [],
                openPositions: [],
                accountInfo: {
                  accountNumber: accountId,
                  server: serverName,
                  currency: 'USD',
                  balance: null,
                  equity: null,
                  margin: 0,
                  freeMargin: null,
                  marginLevelPct: 0,
                  dailyRealizedPnL: null,
                  dailyRealizedLossUsd: 0,
                  latencyMs: 0,
                  connected: false,
                  mode: state.accountMode || 'DEMO',
                  isLiveExness: false,
                  error: data?.error || snap?.error || 'Tidak terhubung ke akun Exness',
                },
              }));
            }
          }
        } catch (err) {
          console.warn('fetchAccountInfo error:', err);
          const persisted = getPersistedVerifiedAccount();
          const hasVault = isVaultConfigured(state.credentials);
          const hasBalance = state.balance !== null && state.balance > 0;
          if (hasVault || persisted || hasBalance) {
            const preservedBal = (state.balance !== null && state.balance > 0) ? state.balance : (persisted?.balance ?? null);
            const preservedPositions = (state.openPositions || state.positions || []).filter(
              (p: any) => p && p.id !== 'F-637' && p.id !== '#F-637'
            );
            const currentQuotes = get().quotes;
            const currentPrices = get().symbolPrices || {};
            const evaluatedPositions = preservedPositions.map((pos: any) => {
              const q = currentQuotes[pos.symbol] || currentPrices[pos.symbol];
              const validPrice = getValidLivePrice(pos.symbol);
              const prof = getPairProfile(pos.symbol);
              const safeQ = (q && isValidPriceUpdate(pos.symbol, q.bid))
                ? q
                : {
                    symbol: pos.symbol,
                    bid: validPrice,
                    ask: Number((validPrice + (pos.symbol.startsWith('XAU') ? 0.20 : prof.pipValue)).toFixed(prof.digits)),
                    spreadPips: pos.symbol.startsWith('XAU') ? 2.0 : 0.8,
                    timestamp: Date.now(),
                  };
              const curPrice = pos.side === 'BUY' ? safeQ.bid : safeQ.ask;
              const cloned = { ...pos };
              sanitizePositionSlTp(cloned, curPrice, state.stopLossPips ?? 25, state.takeProfitPips ?? 50);
              const pnlRes = evaluatePositionPnL(cloned, safeQ);
              return {
                ...cloned,
                currentPrice: curPrice,
                unrealizedPnl: pnlRes.pnlUsd,
              };
            });
            const totalUnrealized = evaluatedPositions.reduce((sum: number, p: any) => sum + (p.unrealizedPnl || 0), 0);
            const preservedEquity = preservedBal !== null
              ? (evaluatedPositions.length === 0 ? preservedBal : Number((preservedBal + totalUnrealized).toFixed(2)))
              : (persisted?.equity ?? null);

            set((prev) => ({
              balance: preservedBal,
              equity: preservedEquity,
              positions: evaluatedPositions,
              openPositions: evaluatedPositions,
              accountInfo: {
                ...(prev.accountInfo || defaultAccountInfo),
                accountNumber: prev.accountInfo?.accountNumber || persisted?.accountId || accountId,
                server: prev.accountInfo?.server || persisted?.server || serverName,
                currency: prev.accountInfo?.currency || 'USD',
                balance: preservedBal,
                equity: preservedEquity,
                connected: true,
                mode: prev.accountInfo?.mode || state.accountMode || 'DEMO',
                isLiveExness: true,
              },
            }));
            isFetchingAccountLock = false;
            return;
          }

          set((prev) => ({
            balance: null,
            equity: null,
            dailyPnl: null,
            positions: [],
            openPositions: [],
            accountInfo: {
              accountNumber: accountId,
              server: serverName,
              currency: 'USD',
              balance: null,
              equity: null,
              margin: 0,
              freeMargin: null,
              marginLevelPct: 0,
              dailyRealizedPnL: null,
              dailyRealizedLossUsd: 0,
              latencyMs: 0,
              connected: false,
              mode: state.accountMode || 'DEMO',
              isLiveExness: false,
              error: 'Tidak terhubung ke akun Exness',
            },
          }));
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
                apiKey: activeCreds.apiKey,
                secret: activeCreds.secret,
                privateKey: activeCreds.secret,
                password: activeCreds.password,
                initialBalance: activeCreds.initialBalance,
                mode: state.accountMode || 'DEMO',
              },
              payload: { timeframe: get().timeframe || 'M5', limit: 250 },
            }),
          });
          const json = await res.json();
          const currentActive = get().focusSymbol || get().selectedSymbol;

          // Discard stale responses if user switched symbols while fetch was in-flight
          if (currentActive === targetSymbol && (json.success || json.ok) && Array.isArray(json.data) && json.data.length > 0) {
            let serverCandles: Candle[] = json.data;
            const lastServerC = serverCandles[serverCandles.length - 1];
            if (lastServerC && lastServerC.close > 0) {
              if (!isValidPriceUpdate(targetSymbol, lastServerC.close)) {
                // Stale or deviated candle data (e.g. 3875 mock seed) - reject to protect chart y-axis
                return;
              }
              savePersistedRealPrice(targetSymbol, lastServerC.close);
              updateStoreLastKnownPrice(targetSymbol, lastServerC.close, 'candles');

              // Synchronize store quote to match real Exness candle close if quote is missing or deviated
              const curQ = get().quotes[targetSymbol];
              const spread = targetSymbol.startsWith('XAU') ? 0.20 : profile.pipValue;
              if (!curQ || curQ.bid <= 0 || Math.abs(curQ.bid - lastServerC.close) > profile.pipValue * 50) {
                set((prev) => ({
                  quotes: {
                    ...prev.quotes,
                    [targetSymbol]: {
                      symbol: targetSymbol,
                      bid: lastServerC.close,
                      ask: Number((lastServerC.close + spread).toFixed(profile.digits)),
                      spreadPips: targetSymbol.startsWith('XAU') ? 2.0 : 0.8,
                      timestamp: lastServerC.timestamp,
                    },
                  },
                }));
              }
            }
            savePersistedRealPrice(targetSymbol, serverCandles[serverCandles.length - 1].close);
            set({ candles: serverCandles });
            get().fetchKronosPrediction(targetSymbol, get().timeframe || 'M5').catch(() => {});
            return;
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
                apiKey: activeCreds.apiKey,
                secret: activeCreds.secret,
                privateKey: activeCreds.secret,
                password: activeCreds.password,
                initialBalance: activeCreds.initialBalance,
                mode: state.accountMode || 'DEMO',
              },
            }),
          });
          if (res.ok) {
            const json = await res.json();
            if (json.success && json.data) {
              const newQuote: LiveQuote = json.data;

              // Basic sanity check: valid non-zero finite bid price and 3% deviation guard
              if (!newQuote || typeof newQuote.bid !== 'number' || isNaN(newQuote.bid) || newQuote.bid <= 0) {
                return;
              }

              const midPrice = (newQuote.bid + newQuote.ask) / 2;
              if (!isValidPriceUpdate(targetSymbol, midPrice)) {
                return;
              }

              // Overwrite PAIR_BASELINES and lastKnownPrice immediately with live price
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
                if (isCurrentActive) {
                  const liveBid = newQuote.bid;
                  const currentTf = prev.timeframe || 'M5';
                  const barBoundaryMs = timeframeToMs(currentTf);

                  if (prev.candles.length === 0) {
                    const fallback = createLocalFallbackCandles(targetSymbol, 50, currentTf);
                    const lastFb = fallback[fallback.length - 1];
                    const fbDelta = liveBid - lastFb.close;
                    updatedCandles = fallback.map((c) => ({
                      ...c,
                      open: Number((c.open + fbDelta).toFixed(profile.digits)),
                      high: Number((c.high + fbDelta).toFixed(profile.digits)),
                      low: Number((c.low + fbDelta).toFixed(profile.digits)),
                      close: Number((c.close + fbDelta).toFixed(profile.digits)),
                    }));
                  } else {
                    const lastCandle = prev.candles[prev.candles.length - 1];
                    const isTickFresh = (now - newQuote.timestamp) < 30000;
                    const isBarRecent = (now - lastCandle.timestamp) <= (barBoundaryMs * 2.5);

                    if (isTickFresh && isBarRecent && now - lastCandle.timestamp >= barBoundaryMs) {
                      const currentBarTime = Math.floor(now / barBoundaryMs) * barBoundaryMs;
                      const prevClose = lastCandle.close;
                      const newCandle: Candle = {
                        timestamp: currentBarTime,
                        open: prevClose,
                        high: Math.max(prevClose, liveBid),
                        low: Math.min(prevClose, liveBid),
                        close: liveBid,
                        volume: 1,
                      };
                      updatedCandles = [...prev.candles.slice(prev.candles.length >= 250 ? 1 : 0), newCandle];
                    } else if (isBarRecent || (now - lastCandle.timestamp < barBoundaryMs)) {
                      const currentCandle = { ...lastCandle };
                      currentCandle.close = liveBid;
                      currentCandle.high = Math.max(currentCandle.high, liveBid);
                      currentCandle.low = Math.min(currentCandle.low, liveBid);
                      currentCandle.volume = (currentCandle.volume || 1) + 1;
                      updatedCandles = [...prev.candles.slice(0, -1), currentCandle];
                    }
                  }
                }

                // Single source of truth: recalculate unrealizedPnL for all open positions using live quotes
                const isConn = Boolean(prev.accountInfo?.connected || isVaultConfigured(prev.credentials));
                const balance: number | null = prev.balance ?? prev.accountInfo?.balance ?? (isConn ? getPersistedVerifiedAccount()?.balance ?? null : null);
                const sourcePositions = (prev.openPositions && prev.openPositions.length > 0)
                  ? prev.openPositions
                  : (prev.positions && prev.positions.length > 0 ? prev.positions : []);
                const updatedPositions = sourcePositions.map((pos) => {
                  const q = updatedQuotes[pos.symbol] || prev.quotes[pos.symbol];
                  if (!q) return pos;
                  const curPrice = pos.side === 'BUY' ? q.bid : q.ask;
                  const res = evaluatePositionPnL(pos, q);
                  return {
                    ...pos,
                    currentPrice: curPrice,
                    unrealizedPnl: res.pnlUsd,
                  };
                });

                const totalUnrealized = updatedPositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
                const calculatedEquity: number | null = balance !== null
                  ? (updatedPositions.length === 0 ? balance : Number((balance + totalUnrealized).toFixed(2)))
                  : null;

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
                        freeMargin: calculatedEquity !== null ? Number(Math.max(0, calculatedEquity - (prev.accountInfo.margin || 0)).toFixed(2)) : null,
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

      checkKronosHealth: async () => {
        try {
          const res = await fetch('/api/kronos', {
            method: 'GET',
            cache: 'no-store',
          });
          if (res.ok) {
            const data = await res.json();
            const vpsReady = Boolean(data.vpsReady);
            const kronosReady = Boolean(data.kronosReady);
            const aiReady = Boolean(data.aiReady);
            set({
              kronosHealth: {
                ok: Boolean(data.ok),
                status: data.status || (vpsReady && kronosReady ? 'healthy' : aiReady ? 'degraded' : 'offline'),
                kronosReady,
                vpsReady,
                aiReady,
                engineStatus: data.engineStatus || (vpsReady ? 'kronos-neural-ready' : 'local-quant-fallback'),
                activeAiCount: Number(data.activeAiCount ?? 0),
                activeAiModels: Array.isArray(data.activeAiModels) ? data.activeAiModels : [],
                vpsStatus: vpsReady ? 'ONLINE' : 'OFFLINE',
                aiModel: data.aiModel || data.model || 'Multi-AI Consensus / Risk Governance',
                engine: data.engine || 'NMSSx-Kronos-MultiAI',
                architecture: data.architecture || 'MULTI-AI CONSENSUS + KRONOS VPS',
                authenticated: Boolean(data.authenticated),
                latencyMs: Number(data.latencyMs ?? 0),
                timestamp: Number(data.timestamp || Date.now()),
              },
            });
          } else {
            set({
              kronosHealth: {
                ok: false,
                status: 'offline',
                kronosReady: false,
                vpsReady: false,
                aiReady: false,
                vpsStatus: 'OFFLINE',
                engine: 'NMSSx-Kronos-MultiAI',
                architecture: 'MULTI-AI CONSENSUS + KRONOS VPS',
                authenticated: false,
                latencyMs: 0,
                timestamp: Date.now(),
              },
            });
          }
        } catch {
          set({
            kronosHealth: {
              ok: false,
              status: 'offline',
              kronosReady: false,
              vpsReady: false,
              aiReady: false,
              vpsStatus: 'OFFLINE',
              engine: 'NMSSx-Kronos-MultiAI',
              architecture: 'MULTI-AI CONSENSUS + KRONOS VPS',
              authenticated: false,
              latencyMs: 0,
              timestamp: Date.now(),
            },
          });
        }
      },

      fetchKronosPrediction: async (symbol, tf) => {
        const state = get();
        const targetSym = getPairProfile(symbol || state.focusSymbol || state.selectedSymbol || 'XAUUSDm').symbol;
        const targetTf: Timeframe = tf || state.timeframe || 'M5';
        const activeCandles = state.candles || [];

        // Immediately compute synchronous local quantitative forecast while awaiting server /api/kronos
        const localPred = computeRealTimeKronosForecast({
          symbol: targetSym,
          timeframe: targetTf,
          candles: activeCandles,
          aiModel: state.kronosHealth?.aiModel || 'Multi-AI Consensus / Risk Governance',
          vpsStatus: state.kronosHealth?.vpsReady ? 'ONLINE' : 'LOCAL_ENGINE',
        });
        set({ kronosPrediction: localPred });

        try {
          const res = await fetch('/api/kronos', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              symbol: targetSym,
              timeframe: targetTf,
              candles: activeCandles.slice(-60),
            }),
          });
          if (res.ok) {
            const data = await res.json();
            const currentActive = get().focusSymbol || get().selectedSymbol || 'XAUUSDm';
            if ((data.ok || data.success) && currentActive === targetSym) {
              set({
                kronosPrediction: {
                  ...localPred,
                  ...data,
                  symbol: targetSym,
                  timeframe: targetTf,
                },
              });
            }
          }
        } catch {}
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

        const liveCreds = getActiveExnessCredentials(freshState.credentials);
        const credsPayload = {
          accountId: liveCreds.accountId || '30000143146',
          server: liveCreds.server,
          apiKey: liveCreds.apiKey,
          token: liveCreds.apiKey,
          secret: liveCreds.secret,
          privateKey: liveCreds.secret,
          password: liveCreds.password,
          mode: liveCreds.mode || freshState.accountMode || 'DEMO',
          initialBalance: liveCreds.initialBalance,
        };

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
          if (curPrice <= 0 || isNaN(curPrice) || !isValidPriceUpdate(pos.symbol, curPrice)) {
            updatedPositions.push(pos);
            continue;
          }
          pos.currentPrice = curPrice;
          sanitizePositionSlTp(pos, curPrice, freshState.stopLossPips ?? 25, freshState.takeProfitPips ?? 50);
          hasModifiedPosition = true;
          const isLiveExness = Boolean(freshState.accountInfo?.isLiveExness || isVaultConfigured(freshState.credentials));

          // Check Take Profit hit
          if (pos.currentTp > 0 && (isBuy ? curPrice >= pos.currentTp : curPrice <= pos.currentTp)) {
            if (!canAttemptPositionClose(pos.id)) {
              updatedPositions.push(pos);
              continue;
            }
            markPositionClosingStart(pos.id);
            pos.isClosing = true;
            pos.closingStartedAt = Date.now();
            const pnlData = evaluatePositionPnL(pos, q);
            const realizedPnl = Number(pnlData.pnlUsd.toFixed(2));
            get().addTelemetryLog(pos.symbol, 'ORDER', `[TAKE PROFIT HIT] #${pos.id} ${pos.side} @ ${curPrice} (+$${realizedPnl.toFixed(2)})`);
            if (!isLiveExness) {
              get().recordTradePnL(realizedPnl);
            }
            fetch('/api/exness', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'CLOSE_POSITION',
                credentials: credsPayload,
                payload: { positionId: pos.id, symbol: pos.symbol },
              }),
            }).then(async (res) => {
              const d = await res.json().catch(() => null);
              const ok = Boolean(res.ok && (d?.ok || d?.success));
              markPositionClosingDone(pos.id, ok);
              if (!ok) {
                pos.isClosing = false;
              }
              get().fetchAccountInfo();
            }).catch(() => {
              markPositionClosingDone(pos.id, false);
              pos.isClosing = false;
            });
            hasModifiedPosition = true;
            if (!isLiveExness) {
              continue;
            } else {
              updatedPositions.push(pos);
              continue;
            }
          }

          // Check Stop Loss / Trailing Stop hit
          if (pos.currentSl > 0 && (isBuy ? curPrice <= pos.currentSl : curPrice >= pos.currentSl)) {
            if (!canAttemptPositionClose(pos.id)) {
              updatedPositions.push(pos);
              continue;
            }
            markPositionClosingStart(pos.id);
            pos.isClosing = true;
            pos.closingStartedAt = Date.now();
            const pnlData = evaluatePositionPnL(pos, q);
            const realizedPnl = Number(pnlData.pnlUsd.toFixed(2));
            get().addTelemetryLog(pos.symbol, 'ORDER', `[STOP LOSS / TRAILING STOP HIT] #${pos.id} ${pos.side} @ ${curPrice} (${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)})`);
            if (!isLiveExness) {
              get().recordTradePnL(realizedPnl);
            }
            fetch('/api/exness', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'CLOSE_POSITION',
                credentials: credsPayload,
                payload: { positionId: pos.id, symbol: pos.symbol },
              }),
            }).then(async (res) => {
              const d = await res.json().catch(() => null);
              const ok = Boolean(res.ok && (d?.ok || d?.success));
              markPositionClosingDone(pos.id, ok);
              if (!ok) {
                pos.isClosing = false;
              }
              get().fetchAccountInfo();
            }).catch(() => {
              markPositionClosingDone(pos.id, false);
              pos.isClosing = false;
            });
            hasModifiedPosition = true;
            if (!isLiveExness) {
              continue;
            } else {
              updatedPositions.push(pos);
              continue;
            }
          }

          // Compute ATR(14), Middle BB, and Expected Market Move for Style 2 Hybrid Trailing Stop
          let middleBB = curPrice;
          let atr14 = profile.pipValue * (pos.symbol === 'XAUUSDm' ? 15 : 10);
          let expectedMovePct: number | undefined;
          let expectedTargetPrice: number | undefined;
          let expectedMoveUsd: number | undefined;
          let pocPrice: number | undefined;
          let vahPrice: number | undefined;
          let valPrice: number | undefined;
          let zScore: number | undefined;
          let currentRsi: number | undefined;
          let bbwExpansionPct: number | undefined;

          if (pos.symbol === (freshState.focusSymbol || freshState.selectedSymbol) && freshState.candles.length >= 20) {
            try {
              const { computeIndicatorSnapshot } = await import('@/core/indicatorEngine');
              const ind = computeIndicatorSnapshot(freshState.candles, profile.preset.rsiPeriod, profile.preset.bbPeriod, profile.preset.bbStdDev);
              middleBB = ind.c0.middleBB;
              atr14 = ind.c0.atr14;
              expectedMovePct = ind.expectedMovePct;
              expectedTargetPrice = ind.expectedTargetPrice;
              expectedMoveUsd = ind.expectedMoveUsd;
              pocPrice = ind.pocPrice;
              vahPrice = ind.vahPrice;
              valPrice = ind.valPrice;
              zScore = ind.c0.zScore;
              currentRsi = ind.c0.rsi;
              bbwExpansionPct = ind.bbwExpansionPct;
            } catch {}
          }

          const kp = freshState.kronosPrediction?.symbol === pos.symbol ? freshState.kronosPrediction : undefined;
          const opposingRegimePct = kp
            ? (isBuy ? (kp.bearishPct ?? 50) : (kp.bullishPct ?? 50))
            : undefined;

          const trailingAction = evaluatePositionTrailing({
            position: pos,
            currentBid: q.bid,
            currentAsk: q.ask,
            middleBB,
            atr14,
            bbwExpansionPct,
            currentRsi,
            pairProfile: profile,
            enablePartialClose: freshState.enablePartialClose,
            stopLossPips: freshState.stopLossPips ?? 25,
            expectedMovePct,
            expectedTargetPrice,
            expectedMoveUsd,
            pocPrice: kp?.pocPrice || pocPrice,
            vahPrice: kp?.vahPrice || vahPrice,
            valPrice: kp?.valPrice || valPrice,
            zScore: kp?.zScore ?? zScore,
            opposingRegimePct,
          });

          if (trailingAction.type === 'HARD_SL_CLOSE') {
            if (!canAttemptPositionClose(pos.id)) {
              updatedPositions.push(pos);
              continue;
            }
            markPositionClosingStart(pos.id);
            pos.isClosing = true;
            pos.closingStartedAt = Date.now();
            const pnlData = evaluatePositionPnL(pos, q);
            const realizedPnl = Number(pnlData.pnlUsd.toFixed(2));
            get().addTelemetryLog(pos.symbol, 'RISK', trailingAction.reason);
            if (!isLiveExness) {
              get().recordTradePnL(realizedPnl);
            }
            fetch('/api/exness', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'CLOSE_POSITION',
                credentials: credsPayload,
                payload: { positionId: pos.id, symbol: pos.symbol },
              }),
            }).then(async (res) => {
              const d = await res.json().catch(() => null);
              const ok = Boolean(res.ok && (d?.ok || d?.success));
              markPositionClosingDone(pos.id, ok);
              if (!ok) {
                pos.isClosing = false;
              }
              get().fetchAccountInfo();
            }).catch(() => {
              markPositionClosingDone(pos.id, false);
              pos.isClosing = false;
            });
            hasModifiedPosition = true;
            if (!isLiveExness) {
              continue;
            } else {
              updatedPositions.push(pos);
              continue;
            }
          }

          if (trailingAction.type === 'PARTIAL_CLOSE' || trailingAction.type === 'PARTIAL_AND_MODIFY_SL') {
            get().addTelemetryLog(pos.symbol, 'TRAILING', trailingAction.reason);
            const closeVol = trailingAction.closeVolume || (pos.volume * 0.5);
            const partialPnl = Number(evaluatePositionPnL({ ...pos, volume: closeVol }, q).pnlUsd.toFixed(2));
            if (!isLiveExness) {
              get().recordTradePnL(partialPnl);
            }
            pos.volume = trailingAction.remainingVolume || (pos.volume - closeVol);
            pos.partialClosed = true;
            pos.trailingStatus = trailingAction.statusUpdate;
            fetch('/api/exness', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'CLOSE_POSITION',
                credentials: credsPayload,
                payload: { positionId: pos.id, volumeToClose: closeVol, symbol: pos.symbol },
              }),
            }).catch(() => {});
            hasModifiedPosition = true;
          }

          if (trailingAction.type === 'MODIFY_SL' || trailingAction.type === 'PARTIAL_AND_MODIFY_SL') {
            if (trailingAction.newSlPrice && trailingAction.newSlPrice !== pos.currentSl) {
              get().addTelemetryLog(pos.symbol, 'TRAILING', trailingAction.reason);
              pos.currentSl = trailingAction.newSlPrice;
              pos.virtualSl = trailingAction.newSlPrice;
              pos.trailingStatus = trailingAction.statusUpdate;
              fetch('/api/exness', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: 'MODIFY_POSITION',
                  credentials: credsPayload,
                  payload: { positionId: pos.id, stopLoss: trailingAction.newSlPrice, symbol: pos.symbol },
                }),
              }).catch(() => {});
              hasModifiedPosition = true;
            }
          }

          updatedPositions.push(pos);
        }

        if (hasModifiedPosition) {
          const isConn = Boolean(freshState.accountInfo?.connected || isVaultConfigured(freshState.credentials));
          const balance = freshState.balance ?? freshState.accountInfo?.balance ?? (isConn ? getPersistedVerifiedAccount()?.balance ?? null : null);
          const totalUnrealized = updatedPositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
          const calculatedEquity = balance !== null
            ? (updatedPositions.length === 0 ? balance : Number((balance + totalUnrealized).toFixed(2)))
            : null;
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
        const currentActive = state.focusSymbol || state.selectedSymbol || 'XAUUSDm';
        const symbolsToScan = state.targetMarket === 'GOLD'
          ? ['XAUUSDm']
          : (state.targetMarket === 'FOREX'
              ? Array.from(new Set([currentActive, 'XAUUSDm', 'EURUSDm', 'GBPUSDm', 'USDJPYm']))
              : (state.isMultiPairMode ? state.scannedSymbols : [currentActive]));
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
                apiKey: activeCreds.apiKey,
                secret: activeCreds.secret,
                privateKey: activeCreds.secret,
                password: activeCreds.password,
                initialBalance: activeCreds.initialBalance,
                mode: state.accountMode || 'DEMO',
              },
              symbols: symbolsToScan,
              targetMarket: state.targetMarket,
              timeframe: state.timeframe || 'M5',
              orderVolume: state.lotSize,
              stopLossPips: state.stopLossPips ?? 25,
              takeProfitPips: state.takeProfitPips ?? 50,
              enablePartialClose: state.enablePartialClose,
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

            const isConn = Boolean(get().accountInfo?.connected);
            const balance: number | null = isConn ? (get().balance ?? get().accountInfo?.balance ?? null) : null;
            const currentQuotes = get().quotes;
            const mappedPositions = mergedPositions.map((pos: ManagedPosition) => {
              const q = currentQuotes[pos.symbol];
              const cloned = { ...pos };
              if (!q) {
                sanitizePositionSlTp(cloned, cloned.currentPrice || cloned.entryPrice, get().stopLossPips ?? 25, get().takeProfitPips ?? 50);
                return cloned;
              }
              const curPrice = cloned.side === 'BUY' ? q.bid : q.ask;
              const prevValid = cloned.currentPrice || cloned.entryPrice;
              if (prevValid > 0 && Math.abs(curPrice - prevValid) / prevValid > 0.05) {
                sanitizePositionSlTp(cloned, prevValid, get().stopLossPips ?? 25, get().takeProfitPips ?? 50);
                return cloned;
              }
              sanitizePositionSlTp(cloned, curPrice, get().stopLossPips ?? 25, get().takeProfitPips ?? 50);
              const res = evaluatePositionPnL(cloned, q);
              return { ...cloned, currentPrice: curPrice, unrealizedPnl: res.pnlUsd };
            });

            const totalUnrealized = mappedPositions.reduce((sum: number, p: ManagedPosition) => sum + (p.unrealizedPnl || 0), 0);
            const dynamicEquity: number | null = balance !== null
              ? (mappedPositions.length === 0 ? balance : Number((balance + totalUnrealized).toFixed(2)))
              : null;
            set((prev) => ({
              positions: isConn ? mappedPositions : [],
              openPositions: isConn ? mappedPositions : [],
              equity: dynamicEquity,
              accountInfo: prev.accountInfo
                ? {
                    ...prev.accountInfo,
                    equity: dynamicEquity,
                    freeMargin: dynamicEquity !== null ? Number(Math.max(0, dynamicEquity - (mappedPositions.length === 0 ? 0 : (prev.accountInfo.margin || 0))).toFixed(2)) : null,
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
          const norm = (id: string) => String(id || '').replace(/^#+/, '').trim().toLowerCase();
          const targetNorm = norm(positionId);
          const allPositions = (state.openPositions || state.positions || []);
          const pos = allPositions.find((p) => norm(p.id) === targetNorm);

          const isPartial = Boolean(volume && pos && volume < pos.volume);
          const closeVol = isPartial ? Number(volume!.toFixed(2)) : (pos ? pos.volume : 0.05);

          if (!isPartial && !canAttemptPositionClose(positionId)) {
            return;
          }

          const quote = pos ? (state.quotes[pos.symbol] || state.symbolPrices?.[pos.symbol]) : undefined;
          const pnlData = (pos && quote)
            ? evaluatePositionPnL({ ...pos, volume: closeVol }, quote)
            : { curPrice: pos?.currentPrice || pos?.entryPrice || 0, pnlUsd: (pos?.unrealizedPnl || 0) * (pos ? (closeVol / pos.volume) : 1) };
          const realizedPnl = Number(pnlData.pnlUsd.toFixed(2));
          const curPrice = pnlData.curPrice;

          // Mark position as isClosing: true while keeping it counted in openPositions.length
          // until the broker confirms the close (prevents 2 Open <-> 3 Open flicker & extra order openings).
          if (!isPartial) {
            markPositionClosingStart(positionId);
            const closingMarked = allPositions.map((p) =>
              norm(p.id) === targetNorm
                ? { ...p, isClosing: true, closingStartedAt: Date.now() }
                : p
            );
            set({
              positions: closingMarked,
              openPositions: closingMarked,
            });
          } else if (pos) {
            get().recordTradePnL(realizedPnl);
            get().addTelemetryLog(
              pos.symbol,
              'ORDER',
              `[ORDER] PARTIAL CLOSE: #${positionId} closed ${closeVol} Lots @ ${curPrice} (${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)})`
            );
            const updated = allPositions.map((p) => {
              if (norm(p.id) === targetNorm) {
                return {
                  ...p,
                  volume: Number((p.volume - closeVol).toFixed(2)),
                  partialClosed: true,
                };
              }
              return p;
            });
            const isConn = Boolean(get().accountInfo?.connected);
            const curBal: number | null = isConn ? (get().balance ?? get().accountInfo?.balance ?? null) : null;
            const totalUnrealized = updated.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
            const calculatedEquity: number | null = curBal !== null ? Number((curBal + totalUnrealized).toFixed(2)) : null;
            set({
              positions: isConn ? updated : [],
              openPositions: isConn ? updated : [],
              equity: calculatedEquity,
            });
          }

          let closeSucceeded = false;
          try {
            const res = await fetch('/api/exness', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${activeCreds.apiKey}`,
                'x-api-key': activeCreds.apiKey,
              },
              body: JSON.stringify({
                action: isPartial ? 'partialClose' : 'closePosition',
                positionId,
                volumeToClose: closeVol,
                symbol: pos?.symbol || 'XAUUSDm',
                credentials: {
                  accountId: activeCreds.accountId || '30000143146',
                  server: activeCreds.server,
                  apiKey: activeCreds.apiKey,
                  token: activeCreds.apiKey,
                  secret: activeCreds.secret,
                  privateKey: activeCreds.secret,
                  password: activeCreds.password,
                  mode: activeCreds.mode || state.accountMode || 'DEMO',
                  initialBalance: activeCreds.initialBalance,
                },
                payload: { positionId, volumeToClose: closeVol, symbol: pos?.symbol },
              }),
            });
            const resData = await res.json().catch(() => null);
            closeSucceeded = Boolean(res.ok && (resData?.ok || resData?.success));
          } catch (err) {
            console.warn('Close position API error:', err);
          }

          if (!isPartial) {
            markPositionClosingDone(positionId, closeSucceeded);
            const latestPositions = (get().openPositions || get().positions || []);
            if (closeSucceeded) {
              get().recordTradePnL(realizedPnl);
              get().addTelemetryLog(
                pos?.symbol || 'XAUUSDm',
                'ORDER',
                `[ORDER] CLOSED #${positionId} ${pos?.side || ''} @ ${curPrice} (${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)})`
              );
              const remaining = latestPositions.filter((p) => norm(p.id) !== targetNorm);
              const isConn = Boolean(get().accountInfo?.connected);
              const curBal: number | null = isConn ? (get().balance ?? get().accountInfo?.balance ?? null) : null;
              const totalUnrealized = remaining.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
              const calculatedEquity: number | null = curBal !== null
                ? (remaining.length === 0 ? curBal : Number((curBal + totalUnrealized).toFixed(2)))
                : null;
              set((prev) => ({
                positions: isConn ? remaining : [],
                openPositions: isConn ? remaining : [],
                equity: calculatedEquity,
                accountInfo: prev.accountInfo
                  ? {
                      ...prev.accountInfo,
                      equity: calculatedEquity,
                      freeMargin: calculatedEquity !== null ? Number(Math.max(0, calculatedEquity - (remaining.length === 0 ? 0 : (prev.accountInfo.margin || 0))).toFixed(2)) : null,
                      margin: remaining.length === 0 ? 0 : prev.accountInfo.margin,
                    }
                  : prev.accountInfo,
              }));
            } else {
              // Broker close did not confirm: unmark isClosing and keep position in openPositions
              const restored = latestPositions.map((p) =>
                norm(p.id) === targetNorm
                  ? { ...p, isClosing: false }
                  : p
              );
              set({
                positions: restored,
                openPositions: restored,
              });
            }
          }

          await get().fetchAccountInfo();
        } catch (err) {
          markPositionClosingDone(positionId, false);
          console.error('Error closing position:', err);
        }
      },

      openTestOrder: async (side: 'BUY' | 'SELL') => {
        const symbol = get().focusSymbol || get().selectedSymbol || 'XAUUSDm';
        const lot = get().lotSize || 0.05;
        const quote = get().quotes[symbol] || get().symbolPrices?.[symbol];
        const profile = getPairProfile(symbol);

        get().addTelemetryLog(symbol, 'ORDER', `Submitting manual test ${side} order: ${lot} lots on ${symbol}...`);

        const activeCreds = getActiveExnessCredentials(get().credentials);
        try {
          const res = await fetch('/api/exness', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(activeCreds.apiKey ? { 'Authorization': `Bearer ${activeCreds.apiKey}`, 'x-api-key': activeCreds.apiKey } : {}),
            },
            body: JSON.stringify({
              action: 'openOrder',
              symbol,
              side,
              lot,
              credentials: {
                accountId: activeCreds.accountId || '30000143146',
                server: activeCreds.server,
                apiKey: activeCreds.apiKey,
                token: activeCreds.apiKey,
                secret: activeCreds.secret,
                privateKey: activeCreds.secret,
                password: activeCreds.password,
                mode: activeCreds.mode || get().accountMode || 'DEMO',
                initialBalance: activeCreds.initialBalance,
              },
              payload: {
                symbol,
                side,
                lot,
                volume: lot,
                stopLoss: quote
                  ? (side === 'BUY'
                      ? Number((quote.bid - 30 * profile.pipValue).toFixed(profile.digits))
                      : Number((quote.ask + 30 * profile.pipValue).toFixed(profile.digits)))
                  : undefined,
                takeProfit: quote
                  ? (side === 'BUY'
                      ? Number((quote.bid + 60 * profile.pipValue).toFixed(profile.digits))
                      : Number((quote.ask - 60 * profile.pipValue).toFixed(profile.digits)))
                  : undefined,
                comment: 'Quant AI Manual Test',
              },
            }),
          });

          const data = await res.json();
          if ((data.success || data.ok) && (data.data || data.order)) {
            const orderRes = data.data || data.order;
            const fallbackPrice = symbol.startsWith('XAU') ? 4108.90 : (symbol.startsWith('USDJPY') ? 157.569 : (symbol.startsWith('GBPUSD') ? 1.33877 : 1.11592));
            const fillPrice = orderRes.fillPrice || (quote ? (side === 'BUY' ? quote.ask : quote.bid) : fallbackPrice);

            // Required telemetry log
            get().addTelemetryLog(
              symbol,
              'ORDER',
              `[ORDER] EXECUTED ${side} ${orderRes.volume || lot} Lots ${symbol} @ ${fillPrice}`
            );

            // Synchronously construct and inject the position into openPositions and positions
            const newPos: ManagedPosition = {
              id: orderRes.orderId || `EXN-${Date.now().toString(36).toUpperCase()}`,
              symbol,
              side,
              volume: orderRes.volume || lot,
              initialVolume: orderRes.volume || lot,
              entryPrice: fillPrice,
              currentPrice: fillPrice,
              currentSl: orderRes.stopLoss || (quote ? (side === 'BUY' ? Number((quote.bid - 30 * profile.pipValue).toFixed(profile.digits)) : Number((quote.ask + 30 * profile.pipValue).toFixed(profile.digits))) : 0),
              currentTp: orderRes.takeProfit || (quote ? (side === 'BUY' ? Number((quote.bid + 60 * profile.pipValue).toFixed(profile.digits)) : Number((quote.ask - 60 * profile.pipValue).toFixed(profile.digits))) : 0),
              highestPrice: fillPrice,
              lowestPrice: fillPrice,
              openTime: orderRes.timestamp || Date.now(),
              partialClosed: false,
              trailingStatus: 'INITIAL',
              unrealizedPnl: 0,
            };

            const existing = (get().openPositions || get().positions || []).filter(
              (p) => p && p.id !== 'F-637' && p.id !== '#F-637'
            );
            const serverPositions = Array.isArray(data.positions) ? data.positions : (Array.isArray(data.openPositions) ? data.openPositions : null);
            const nextPositions: ManagedPosition[] = serverPositions ? serverPositions.filter((p: any) => p && p.id !== 'F-637' && p.id !== '#F-637') : [...existing, newPos];
            const isConn = Boolean(get().accountInfo?.connected);
            const curBal: number | null = isConn ? (get().balance ?? get().accountInfo?.balance ?? null) : null;
            const totalUnrealized = nextPositions.reduce((sum: number, p: ManagedPosition) => sum + (p.unrealizedPnl || 0), 0);
            const nextEquity: number | null = curBal !== null ? Number((curBal + totalUnrealized).toFixed(2)) : null;

            set({
              positions: isConn ? nextPositions : [],
              openPositions: isConn ? nextPositions : [],
              equity: nextEquity,
            });

            await get().fetchAccountInfo();
          } else {
            get().addTelemetryLog(symbol, 'RISK', `❌ Order execution failed: ${data.error || 'Gateway rejected'}`);
          }
        } catch (err: any) {
          get().addTelemetryLog(symbol, 'RISK', `❌ Order connection error: ${err?.message || 'Timeout'}`);
        }
      },

      modifyPosition: async (positionId: string, stopLoss?: number, takeProfit?: number) => {
        try {
          const pos = (get().openPositions || get().positions).find((p) => p.id === positionId);
          const symbol = pos?.symbol || 'XAUUSDm';
          const profile = getPairProfile(symbol);

          // Update local state immediately for responsive UI
          const curPositions = (get().openPositions || get().positions || []).map((p) => {
            if (p.id === positionId) {
              return {
                ...p,
                currentSl: stopLoss !== undefined ? Number(formatPrice(stopLoss, profile.digits)) : p.currentSl,
                currentTp: takeProfit !== undefined ? Number(formatPrice(takeProfit, profile.digits)) : p.currentTp,
              };
            }
            return p;
          });
          set({ positions: curPositions, openPositions: curPositions });

          const res = await fetch('/api/exness', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'modifyPosition',
              positionId,
              stopLoss,
              takeProfit,
              symbol,
              payload: { positionId, stopLoss, takeProfit, symbol },
            }),
          });
          const data = await res.json();
          if (data.success || data.ok) {
            get().addTelemetryLog(
              symbol,
              'ORDER',
              `[ORDER] MODIFIED #${positionId}: SL=${stopLoss ? formatPrice(stopLoss, profile.digits) : 'None'}, TP=${takeProfit ? formatPrice(takeProfit, profile.digits) : 'None'}`
            );
            await get().fetchAccountInfo();
          }
        } catch (err: any) {
          get().addTelemetryLog('ORDER', 'RISK', `Failed to modify position #${positionId}: ${err?.message}`);
        }
      },

      panicCloseAll: async () => {
        const state = get();
        const activeCreds = getActiveExnessCredentials(state.credentials);
        try {
          const curPositions = (state.openPositions || state.positions).filter(
            (p) => p && p.id !== 'F-637' && p.id !== '#F-637'
          );
          if (curPositions.length === 0) return;

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
              action: 'panicClose',
              credentials: {
                accountId: activeCreds.accountId || '30000143146',
                server: activeCreds.server,
                apiKey: activeCreds.apiKey,
                token: activeCreds.apiKey,
                secret: activeCreds.secret,
                privateKey: activeCreds.secret,
                password: activeCreds.password,
                mode: activeCreds.mode || state.accountMode || 'DEMO',
                initialBalance: activeCreds.initialBalance,
              },
              payload: { positions: curPositions },
            }),
          });

          const json = await res.json();
          if (json.success || json.ok) {
            get().addTelemetryLog('PANIC', 'INFO', `[ORDER] PANIC CLOSE: All ${curPositions.length} positions terminated.`);
            const isConn = Boolean(get().accountInfo?.connected);
            const curBal: number | null = isConn ? (get().balance ?? get().accountInfo?.balance ?? null) : null;
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
            await get().fetchAccountInfo();
          }
        } catch (err) {
          console.error('Panic close failed:', err);
        }
      },

      hydrateFromServer: async () => {
        try {
          const res = await fetch('/api/engine-tick', { cache: 'no-store' });
          if (res.ok) {
            const json = await res.json();
            const d = json?.data;
            if (json?.success && d) {
              const serverRunning = Boolean(d.isRunning ?? d.isAutoTrading);
              const serverLot = typeof d.lotSize === 'number' && d.lotSize > 0 ? d.lotSize : 0.10;
              const serverSl = typeof d.slPips === 'number' && d.slPips > 0 ? d.slPips : (typeof d.stopLossPips === 'number' && d.stopLossPips > 0 ? d.stopLossPips : 25);
              const serverTp = typeof d.tpPips === 'number' && d.tpPips > 0 ? d.tpPips : (typeof d.takeProfitPips === 'number' && d.takeProfitPips > 0 ? d.takeProfitPips : 50);
              const serverPositions: ManagedPosition[] = Array.isArray(d.positions)
                ? d.positions.filter((p: any) => p && p.id !== 'F-637' && p.id !== '#F-637')
                : [];

              set((prev) => ({
                isAutoTrading: serverRunning,
                lotSize: serverLot,
                stopLossPips: serverSl,
                takeProfitPips: serverTp,
                targetMarket: d.targetMarket || prev.targetMarket,
                selectedSymbol: d.selectedSymbol || prev.selectedSymbol,
                focusSymbol: d.selectedSymbol || prev.focusSymbol,
                scannedSymbols: Array.isArray(d.scannedSymbols) && d.scannedSymbols.length > 0 ? d.scannedSymbols : prev.scannedSymbols,
                enablePartialClose: d.enablePartialClose !== undefined ? Boolean(d.enablePartialClose) : prev.enablePartialClose,
                ...(serverPositions.length > 0 ? { positions: serverPositions, openPositions: serverPositions } : {}),
                isServerHydrated: true,
              }));
              return;
            }
          }
        } catch {}
        set({ isServerHydrated: true });
      },

      syncWithServerState: async () => {
        if (!get().isServerHydrated) {
          await get().hydrateFromServer();
          return;
        }
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
          const isConn = Boolean(get().accountInfo?.connected);
          const localPositions = isConn ? (get().openPositions || get().positions || []) : [];
          const curBal = isConn ? (get().balance ?? get().accountInfo?.balance ?? null) : null;

          const activeCreds = getActiveExnessCredentials(get().credentials);
          const res = await fetch('/api/exness', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(activeCreds.apiKey ? { 'Authorization': `Bearer ${activeCreds.apiKey}`, 'x-api-key': activeCreds.apiKey } : {}),
            },
            body: JSON.stringify({
              action: 'sync-state',
              credentials: {
                accountId: activeCreds.accountId || '30000143146',
                server: activeCreds.server,
                apiKey: activeCreds.apiKey,
                token: activeCreds.apiKey,
                secret: activeCreds.secret,
                privateKey: activeCreds.secret,
                password: activeCreds.password,
                mode: activeCreds.mode || get().accountMode || 'DEMO',
                initialBalance: activeCreds.initialBalance,
              },
              payload: {
                positions: localPositions,
                currentBalance: curBal,
                dailyPnl: isConn ? get().dailyPnl : null,
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

        // Hydrate authoritative bot state (isRunning, lotSize, slPips, tpPips, active positions) from VPS backend FIRST
        await get().hydrateFromServer();

        let saved = await loadVaultFromLocalStorage();
        if (!saved || !isVaultConfigured(saved)) {
          try {
            const vRes = await fetch('/api/exness/vault');
            if (vRes.ok) {
              const vData = await vRes.json();
              if (vData.success && vData.hasCredentials && vData.credentials) {
                const c = vData.credentials;
                saved = {
                  ...defaultCredentials,
                  accountMode: c.mode || 'DEMO',
                  demoAccountId: c.mode === 'DEMO' ? c.accountId : undefined,
                  demoServer: c.mode === 'DEMO' ? c.server : undefined,
                  demoApiKey: c.mode === 'DEMO' ? (c.apiKey || 'CONFIGURED_VAULT_KEY') : undefined,
                  realAccountId: c.mode === 'REAL' ? c.accountId : undefined,
                  realServer: c.mode === 'REAL' ? c.server : undefined,
                  realApiKey: c.mode === 'REAL' ? (c.apiKey || 'CONFIGURED_VAULT_KEY') : undefined,
                };
              }
            }
          } catch {}
        }

        if (saved) {
          const activeCreds = getActiveExnessCredentials(saved);
          const hasCreds = isVaultConfigured(saved);
          const serverName = activeCreds.server || (saved.accountMode === 'REAL' ? 'Exness-MT5Real' : 'Exness-MT5Trial');

          // Read rehydrated state from store
          const state = get();
          const curHistory = state.dailyPnlHistory || {};
          const todayDateStr = getLocalDateString();
          const curDailyPnl = curHistory[todayDateStr]?.pnl ?? state.dailyPnl ?? 0;

          const rawCurPositions = (Array.isArray(state.openPositions) && state.openPositions.length > 0)
            ? state.openPositions
            : (Array.isArray(state.positions) && state.positions.length > 0 ? state.positions : []);
          const curPositions = rawCurPositions.filter((p) => p && p.id !== 'F-637' && p.id !== '#F-637');

          const verified = getPersistedVerifiedAccount();
          const isConn = Boolean(state.accountInfo?.connected || (hasCreds && verified));
          let resolvedBal: number | null = state.accountInfo?.balance ?? state.balance ?? verified?.balance ?? null;
          if (resolvedBal !== null && (resolvedBal < 0 || resolvedBal === 500 || resolvedBal === 100)) {
            resolvedBal = null;
          }

          const totalUnrealized = curPositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
          const resolvedEquity: number | null = resolvedBal !== null
            ? (curPositions.length === 0 ? resolvedBal : Number((resolvedBal + totalUnrealized).toFixed(2)))
            : (verified?.equity ?? null);
          const resolvedDailyPnl: number | null = (isConn || hasCreds) ? curDailyPnl : null;

          // Immediately sync balance, equity, and connection status into store (<1ms)
          set((prev) => ({
            credentials: saved,
            accountMode: saved.accountMode || prev.accountMode || 'DEMO',
            positions: curPositions,
            openPositions: curPositions,
            balance: resolvedBal,
            equity: resolvedEquity,
            dailyPnl: resolvedDailyPnl,
            accountInfo: (isConn || hasCreds)
              ? {
                  accountNumber: activeCreds.accountId || prev.accountInfo?.accountNumber || verified?.accountId || '',
                  server: serverName,
                  currency: 'USD',
                  balance: resolvedBal,
                  equity: resolvedEquity,
                  margin: prev.accountInfo?.margin ?? 0,
                  freeMargin: resolvedEquity !== null ? Number(Math.max(0, resolvedEquity - (prev.accountInfo?.margin ?? 0)).toFixed(2)) : null,
                  marginLevelPct: prev.accountInfo?.marginLevelPct ?? 0,
                  dailyRealizedPnL: resolvedDailyPnl,
                  dailyRealizedLossUsd: prev.accountInfo?.dailyRealizedLossUsd ?? 0,
                  latencyMs: 12,
                  connected: true,
                  mode: saved.accountMode || prev.accountMode || 'DEMO',
                  isLiveExness: true,
                }
              : {
                  accountNumber: '',
                  server: serverName,
                  currency: 'USD',
                  balance: null,
                  equity: null,
                  margin: 0,
                  freeMargin: null,
                  marginLevelPct: 0,
                  dailyRealizedPnL: null,
                  dailyRealizedLossUsd: 0,
                  latencyMs: 0,
                  connected: false,
                  mode: saved.accountMode || 'DEMO',
                },
          }));

          if (get().telemetryLogs.every((l) => !l.message.includes('AES-256 Vault'))) {
            get().addTelemetryLog('VAULT', 'INFO', `[SECURITY] Decrypted credentials loaded from AES-256 Vault (${saved.accountMode || 'DEMO'} Mode)`);
          }

          // Reset throttle lock so immediate live account verification succeeds
          lastAccountFetchTime = 0;
          isFetchingAccountLock = false;

          // Sync credentials ONLY with backend server (never overwrite authoritative server isAutoTrading or positions on browser mount)
          fetch('/api/exness', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'sync-state',
              payload: {
                credentials: saved,
                accountMode: saved.accountMode || get().accountMode,
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
        isAutoTrading: state.isAutoTrading,
        accountMode: state.accountMode,
        targetMarket: state.targetMarket,
        focusSymbol: state.focusSymbol,
        selectedSymbol: state.selectedSymbol,
        timeframe: state.timeframe,
        isMultiPairMode: state.isMultiPairMode,
        scannedSymbols: state.scannedSymbols,
        lotSize: state.lotSize,
        stopLossPips: state.stopLossPips,
        takeProfitPips: state.takeProfitPips,
        aiConfidenceThreshold: state.aiConfidenceThreshold,
        enablePartialClose: state.enablePartialClose,
        credentials: state.credentials,
        accountInfo: state.accountInfo,
      }),
      onRehydrateStorage: () => (rehydratedState) => {
        if (rehydratedState) {
          // Persist isAutoTrading across tab switches and page loads
          rehydratedState.isAutoTrading = Boolean(rehydratedState.isAutoTrading);
          rehydratedState.dailyPnlHistory = rehydratedState.dailyPnlHistory || {};
          const savedPrices = rehydratedState.symbolPrices && Object.keys(rehydratedState.symbolPrices).length > 0
            ? rehydratedState.symbolPrices
            : getPersistedSymbolPrices();
          rehydratedState.symbolPrices = savedPrices;

          const valid = (Array.isArray(rehydratedState.openPositions)
            ? rehydratedState.openPositions
            : (Array.isArray(rehydratedState.positions) ? rehydratedState.positions : [])
          ).filter((p: any) => p && p.id !== 'F-637' && p.id !== '#F-637');
          rehydratedState.openPositions = valid;
          rehydratedState.positions = valid;

          const verifiedAcc = getPersistedVerifiedAccount();
          const hasVaultCreds = isVaultConfigured(rehydratedState.credentials);
          const isConn = Boolean(rehydratedState.accountInfo?.connected || (hasVaultCreds && verifiedAcc));

          if (!isConn && !hasVaultCreds) {
            rehydratedState.balance = null;
            rehydratedState.equity = null;
            rehydratedState.dailyPnl = null;
            if (rehydratedState.accountInfo) {
              rehydratedState.accountInfo.balance = null;
              rehydratedState.accountInfo.equity = null;
              rehydratedState.accountInfo.freeMargin = null;
              rehydratedState.accountInfo.dailyRealizedPnL = null;
              rehydratedState.accountInfo.connected = false;
              rehydratedState.accountInfo.margin = 0;
            }
          } else {
            if (rehydratedState.balance === null && verifiedAcc && verifiedAcc.balance > 0) {
              rehydratedState.balance = verifiedAcc.balance;
              rehydratedState.equity = verifiedAcc.equity || verifiedAcc.balance;
            }
            if (rehydratedState.accountInfo && (isConn || hasVaultCreds)) {
              rehydratedState.accountInfo.connected = true;
              rehydratedState.accountInfo.balance = rehydratedState.balance;
              rehydratedState.accountInfo.equity = rehydratedState.equity;
              rehydratedState.accountInfo.isLiveExness = true;
            }

            const isCorrupted = typeof rehydratedState.balance === 'number' && (rehydratedState.balance < 0 || rehydratedState.balance === 500 || rehydratedState.balance === 100);
            if (isCorrupted) {
              rehydratedState.balance = verifiedAcc?.balance ?? null;
              rehydratedState.equity = verifiedAcc?.equity ?? null;
              rehydratedState.dailyPnl = null;
            }

            const todayStr = getLocalDateString();
            const todayPnl = rehydratedState.dailyPnlHistory[todayStr]?.pnl ?? rehydratedState.dailyPnl ?? 0;

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

            rehydratedState.dailyPnl = todayPnl;
            const totalUnrealized = rehydratedState.openPositions.reduce((sum: number, p: any) => sum + (p.unrealizedPnl || 0), 0);
            rehydratedState.equity = rehydratedState.balance !== null
              ? (rehydratedState.openPositions.length === 0
                  ? rehydratedState.balance
                  : Number((rehydratedState.balance + totalUnrealized).toFixed(2)))
              : null;

            if (rehydratedState.accountInfo) {
              rehydratedState.accountInfo.balance = rehydratedState.balance;
              rehydratedState.accountInfo.equity = rehydratedState.equity;
              rehydratedState.accountInfo.dailyRealizedPnL = todayPnl;
              rehydratedState.accountInfo.margin = rehydratedState.openPositions.length === 0 ? 0 : (rehydratedState.accountInfo.margin || 0);
              rehydratedState.accountInfo.freeMargin = rehydratedState.equity !== null
                ? (rehydratedState.openPositions.length === 0
                    ? rehydratedState.balance
                    : Number(Math.max(0, rehydratedState.equity - (rehydratedState.accountInfo.margin || 0)).toFixed(2)))
                : null;
            }
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
  }, 0);
}
