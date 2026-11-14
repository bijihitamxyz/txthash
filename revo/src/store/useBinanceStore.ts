import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  BinanceSymbolFilter,
  Binance24hTicker,
  BinanceKline,
  BinancePosition,
  FALLBACK_SYMBOLS,
  formatQuantityByStepSize,
} from '@/core/binanceClient';
import {
  evaluateCryptoSignal,
  evaluateBtcVelocityGuard,
  getCryptoDynamicThreshold,
  CryptoSignalVerdict,
} from '@/core/cryptoSignalEngine';
import { dualRoomProtections, idempotencyLocks } from '@/core/riskGuard';
import { evaluateCryptoPositionTrailing } from '@/core/trailingManager';
import {
  CryptoExchange,
  CryptoAccountType,
  CryptoExchangeCredentials,
  CryptoVaultData,
  DEFAULT_CRYPTO_VAULT,
  saveCryptoVaultToLocalStorage,
  loadCryptoVaultFromLocalStorage,
  isCryptoVaultConfigured,
  encryptCredential,
  decryptCredential,
} from '@/lib/cryptoVault';

export interface BinanceTelemetryItem {
  id: string;
  timestamp: number;
  symbol: string;
  category: 'GUARD' | 'SIGNAL' | 'AI' | 'ORDER' | 'LOCK' | 'INFO';
  message: string;
}

export type CryptoTradeAction =
  | 'OPEN_AUTO'
  | 'OPEN_MANUAL'
  | 'PARTIAL_CLOSE'
  | 'CLOSE_MANUAL'
  | 'CLOSE_SL'
  | 'CLOSE_BE'
  | 'PANIC_CLOSE';

export interface CryptoTradeHistoryItem {
  id: string;
  timestamp: number;
  date: string; // YYYY-MM-DD linked to dailyPnlHistory[date]
  symbol: string;
  exchange: CryptoExchange;
  side: 'LONG' | 'SHORT';
  action: CryptoTradeAction;
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  leverage: number;
  marginUsdt: number;
  realizedPnl?: number;
  setupName?: string;
  note?: string;
}

export type CoinCategory = 'MEME' | 'L1' | 'L2' | 'ALT';
export type TargetCategory = 'ALL' | CoinCategory;
export type BinanceCategory = 'ALL' | 'TOP_MOVERS' | CoinCategory;

// Categorized symbol lists (MEME, L1, L2, ALT)
export const MEME_SYMBOLS = [
  'DOGEUSDT', '1000PEPEUSDT', 'PEPEUSDT', 'WIFUSDT', 'BONKUSDT',
  '1000SHIBUSDT', 'SHIBUSDT', '1000FLOKIUSDT', 'FLOKIUSDT', 'BOMEUSDT',
  'MEMEUSDT', 'POPCATUSDT', 'NEIROUSDT', 'TURBOUSDT', 'PNUTUSDT',
  'BRETTUSDT', 'PEOPLEUSDT', 'ORDIUSDT', '1000SATSUSDT', 'MOODENGUSDT',
  'ACTUSDT', 'HIPPOUSDT', 'SPXUSDT', 'PENGUUSDT', 'FARTCOINUSDT',
];

export const L1_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'ADAUSDT',
  'AVAXUSDT', 'SUIUSDT', 'TONUSDT', 'NEARUSDT', 'APTUSDT',
  'SEIUSDT', 'DOTUSDT', 'ATOMUSDT', 'XRPUSDT', 'TRXUSDT',
  'KASUSDT', 'FTMUSDT', 'SONICUSDT', 'INJUSDT', 'TIAUSDT',
  'ALGOUSDT', 'HBARUSDT', 'ICPUSDT', 'ETCUSDT', 'LTCUSDT',
];

export const L2_SYMBOLS = [
  'ARBUSDT', 'OPUSDT', 'STRKUSDT', 'ZKUSDT', 'POLUSDT',
  'MATICUSDT', 'MANTAUSDT', 'METISUSDT', 'IMXUSDT', 'MNTUSDT',
  'BLASTUSDT', 'SCRUSDT', 'ZROUSDT', 'LINEAUSDT', 'TAIKOUSDT',
];

export const ALT_SYMBOLS = [
  'LINKUSDT', 'UNIUSDT', 'AAVEUSDT', 'ONDOUSDT', 'PENDLEUSDT',
  'ENAUSDT', 'FETUSDT', 'RENDERUSDT', 'WLDUSDT', 'TAOUSDT',
  'BCHUSDT', 'FILUSDT', 'GALAUSDT', 'SANDUSDT', 'RUNEUSDT',
  'JUPUSDT', 'PYTHUSDT', 'CRVUSDT', 'SNXUSDT', 'MKRUSDT',
  'LDOUSDT', 'GMXUSDT', 'DYDXUSDT', 'STXUSDT', 'ENSUSDT',
];

// Backwards-compatible aliases
export const L2_MODULAR_SYMBOLS = L2_SYMBOLS;
export const L1_DEFI_SYMBOLS = L1_SYMBOLS;
export const AI_MEME_SYMBOLS = MEME_SYMBOLS;

const MEME_SET = new Set(MEME_SYMBOLS);
const L1_SET = new Set(L1_SYMBOLS);
const L2_SET = new Set(L2_SYMBOLS);

/** Classify a futures symbol into MEME, L1, L2, or ALT (default fallback). */
export function getCoinCategory(symbol: string): CoinCategory {
  const sym = symbol.toUpperCase().trim();
  if (MEME_SET.has(sym)) return 'MEME';
  if (L2_SET.has(sym)) return 'L2';
  if (L1_SET.has(sym)) return 'L1';
  return 'ALT';
}

export const ANCHOR_MAJOR_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'];

const STORAGE_KEY = 'binance_quant_storage_v2';
const VAULT_STORAGE_KEY = 'binance_vault_enc_v2';

function getActiveCredentialsPayload(state: BinanceStoreState) {
  const isBitget = state.activeExchange === 'BITGET';
  const c = isBitget ? state.bitgetConfig : state.binanceConfig;
  const accountType: CryptoAccountType = c?.accountType || (state.isTestnet ? 'DEMO' : 'REAL');
  const isTest = accountType === 'DEMO';
  return {
    apiKey: c?.apiKey || state.apiKey,
    secretKey: c?.secretKey || state.apiSecret,
    apiSecret: c?.secretKey || state.apiSecret,
    passphrase: (c as any)?.passphrase || '',
    accountType,
    isTestnet: isTest,
    exchange: state.activeExchange,
  };
}

export function getTodayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface BinanceStoreState {
  // 1. Sizing & Risk Controls
  marginUsdt: number; // default $3.00
  setMarginUsdt: (val: number) => void;
  leverage: number; // default 10x
  setLeverage: (val: number) => void;
  marginMode: 'ISOLATED' | 'CROSS'; // default ISOLATED
  setMarginMode: (mode: 'ISOLATED' | 'CROSS') => void;
  maxConcurrentCoins: number; // 1 to 5, default 3
  setMaxConcurrentCoins: (val: number) => void;

  // 2. Engine & Scanning Loop
  isAutoTrading: boolean; // default false (Engine Idle)
  setIsAutoTrading: (active: boolean) => void;
  toggleAutoTrading: () => void;
  isScanning: boolean;
  isPanicClosing: boolean;
  syncConfigToServer: () => void;
  lastScanTime: number;
  lastScanStatus: string;

  // 3. 300+ Pairs Market Discovery & Filtering
  allSymbols: BinanceSymbolFilter[];
  tickers: Record<string, Binance24hTicker>;
  selectedCategory: BinanceCategory;
  setSelectedCategory: (cat: BinanceCategory) => void;
  targetCategory: TargetCategory;
  setTargetCategory: (cat: TargetCategory) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  customWatchlist: string[];
  toggleWatchlistCoin: (symbol: string) => void;
  selectedSymbol: string;
  setSelectedSymbol: (symbol: string) => void;
  timeframe: string;
  setTimeframe: (tf: string) => void;
  klines: Record<string, BinanceKline[]>;

  // 4. BTC Dump/Pump Correlation Guard
  btcVelocityPct: number;
  btcDumpBlocked: boolean;
  btcPumpBlocked: boolean;
  btcGuardStatus: string;

  // 5. Crypto API Vault Credentials (AES-256 for Binance & Bitget)
  activeExchange: CryptoExchange;
  setActiveExchange: (exchange: CryptoExchange) => void;
  binanceConfig: CryptoExchangeCredentials;
  bitgetConfig: CryptoExchangeCredentials;
  apiKey: string;
  apiSecret: string;
  isTestnet: boolean;
  isVaultConfigured: boolean;
  isVaultModalOpen: boolean;
  openVaultModal: () => void;
  closeVaultModal: () => void;
  saveCryptoCredentials: (
    exchange: CryptoExchange,
    creds: CryptoExchangeCredentials,
    activateNow?: boolean
  ) => Promise<void>;
  saveCredentials: (apiKey: string, apiSecret: string, isTestnet: boolean) => Promise<void>;
  clearCredentials: (exchange?: CryptoExchange) => Promise<void>;
  loadSavedCredentials: () => Promise<void>;

  // 6. Account & Daily PnL
  walletBalance: number;
  unrealizedProfit: number;
  marginBalance: number;
  availableBalance: number;
  dailyPnl: number;
  dailyPnlPercent: number;
  dailyPnlHistory: Record<string, { date: string; pnl: number; trades: number; wins: number; losses: number }>;
  isPnlCalendarOpen: boolean;
  openPnlCalendar: () => void;
  closePnlCalendar: () => void;
  recordTradePnL: (
    realizedPnl: number,
    tradeMeta?: Omit<CryptoTradeHistoryItem, 'id' | 'timestamp' | 'date' | 'realizedPnl'>
  ) => void;
  resetCalendarHistory: () => void;

  // 6b. Crypto Entry & Trade History Log (linked to Daily PnL)
  tradeHistory: CryptoTradeHistoryItem[];
  recordTradeEntry: (
    entry: Omit<CryptoTradeHistoryItem, 'id' | 'timestamp' | 'date'> & { timestamp?: number; date?: string }
  ) => void;
  clearTradeHistory: () => void;

  // 7. Positions & Trade Execution
  positions: BinancePosition[];
  lastVerdict: Record<string, CryptoSignalVerdict>;
  telemetryLogs: BinanceTelemetryItem[];
  addTelemetryLog: (symbol: string, category: BinanceTelemetryItem['category'], message: string) => void;
  clearTelemetry: () => void;

  // Action Methods
  fetchSymbolsAndTickers: (forceExchangeInfo?: boolean) => Promise<void>;
  fetchKlines: (symbol: string) => Promise<void>;
  upsertLiveKline: (symbol: string, kline: BinanceKline, livePrice?: number) => void;
  fetchAccountInfo: () => Promise<void>;
  executeScannerTick: () => Promise<void>;
  executeManualTrade: (symbol: string, side: 'LONG' | 'SHORT') => Promise<void>;
  closePosition: (symbol: string, quantityToClose?: number) => Promise<void>;
  panicCloseAll: () => Promise<void>;
}

export const useBinanceStore = create<BinanceStoreState>()(
  persist(
    (set, get) => ({
      // Sizing defaults (User margin setting strictly synchronized with backend)
      marginUsdt: 25.00,
      setMarginUsdt: (val) => {
        set({ marginUsdt: Math.max(1, Math.min(500, Number(val) || 25.00)) });
        get().syncConfigToServer();
      },
      leverage: 10,
      setLeverage: (val) => {
        set({ leverage: Math.max(2, Math.min(50, Number(val) || 10)) });
        get().syncConfigToServer();
      },
      marginMode: 'ISOLATED',
      setMarginMode: (marginMode) => {
        set({ marginMode });
        get().syncConfigToServer();
      },
      maxConcurrentCoins: 5,
      setMaxConcurrentCoins: (val) => {
        set({ maxConcurrentCoins: Math.max(1, Math.min(5, Number(val) || 5)) });
        get().syncConfigToServer();
      },

      // Engine defaults - strictly starts idle
      isAutoTrading: false,
      isScanning: false,
      isPanicClosing: false,

      syncConfigToServer: () => {
        const state = get();
        fetch('/api/binance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'SYNC_STATE',
            isAutoTrading: state.isAutoTrading,
            marginUsdt: state.marginUsdt,
            leverage: state.leverage,
            marginMode: state.marginMode,
            maxConcurrentCoins: state.maxConcurrentCoins,
          }),
        }).catch(() => {});
      },

      setIsAutoTrading: (isAutoTrading) => {
        set({ isAutoTrading, isScanning: isAutoTrading ? get().isScanning : false });
        get().syncConfigToServer();
      },
      toggleAutoTrading: (forceState?: boolean) => {
        const next = typeof forceState === 'boolean' ? forceState : !get().isAutoTrading;
        set({ isAutoTrading: next, isScanning: false });
        const exName = get().activeExchange === 'BITGET' ? 'BITGET' : 'BINANCE';
        get().addTelemetryLog(
          'ENGINE',
          'INFO',
          next ? `🚀 ${exName} AUTO-TRADING STARTED (Altcoins & L2 24/7 Engine Active)` : `⏸️ ${exName} AUTO-TRADING STOPPED (Engine Idle)`
        );

        // Sync to backend scheduler immediately so it stops/starts scanning & orders
        get().syncConfigToServer();

        if (next) {
          get().executeScannerTick();
        }
      },
      lastScanTime: 0,
      lastScanStatus: 'Engine Idle',

      // Market Discovery
      allSymbols: FALLBACK_SYMBOLS,
      tickers: {},
      selectedCategory: 'TOP_MOVERS',
      setSelectedCategory: (selectedCategory) => set({ selectedCategory }),
      targetCategory: 'ALL',
      setTargetCategory: (targetCategory) => set({ targetCategory }),
      searchQuery: '',
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      customWatchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'ARBUSDT', 'SUIUSDT', 'OPUSDT'],
      toggleWatchlistCoin: (sym) => {
        const list = get().customWatchlist;
        const next = list.includes(sym) ? list.filter((s) => s !== sym) : [...list, sym];
        set({ customWatchlist: next });
      },
      selectedSymbol: 'BTCUSDT',
      setSelectedSymbol: (selectedSymbol) => {
        set({ selectedSymbol });
        get().fetchKlines(selectedSymbol);
      },
      timeframe: 'M5',
      setTimeframe: (timeframe) => {
        set({ timeframe });
        get().fetchKlines(get().selectedSymbol);
      },
      klines: {},

      // BTC Guard
      btcVelocityPct: 0,
      btcDumpBlocked: false,
      btcPumpBlocked: false,
      btcGuardStatus: 'BTC Guard: Monitoring',

      // Crypto API Vault (Binance & Bitget)
      activeExchange: 'BINANCE',
      setActiveExchange: (activeExchange) => {
        set({ activeExchange });
        const binanceCfg = get().binanceConfig;
        const bitgetCfg = get().bitgetConfig;
        const creds = activeExchange === 'BITGET' ? bitgetCfg : binanceCfg;
        const nextVault: CryptoVaultData = {
          activeCryptoExchange: activeExchange,
          binance: binanceCfg,
          bitget: bitgetCfg,
          updatedAt: Date.now(),
        };
        const configured = isCryptoVaultConfigured(nextVault, activeExchange);

        // Persist active exchange to both localStorage vault and server vault
        saveCryptoVaultToLocalStorage(nextVault).catch(() => {});
        fetch('/api/binance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'SAVE_SERVER_VAULT', vault: nextVault }),
        }).catch(() => {});

        set({
          apiKey: creds.apiKey || '',
          apiSecret: creds.secretKey || '',
          isTestnet: creds.accountType === 'DEMO',
          isVaultConfigured: configured,
          positions: [],
        });
        get().fetchSymbolsAndTickers(true);
        get().fetchKlines(get().selectedSymbol);
        if (configured) {
          get().fetchAccountInfo();
        }
      },
      binanceConfig: { apiKey: '', secretKey: '', accountType: 'DEMO' },
      bitgetConfig: { apiKey: '', secretKey: '', passphrase: '', accountType: 'REAL' },
      apiKey: '',
      apiSecret: '',
      isTestnet: true,
      isVaultConfigured: false,
      isVaultModalOpen: false,
      openVaultModal: () => set({ isVaultModalOpen: true }),
      closeVaultModal: () => set({ isVaultModalOpen: false }),

      saveCryptoCredentials: async (exchange, creds, activateNow = true) => {
        const currentVault = (await loadCryptoVaultFromLocalStorage()) || { ...DEFAULT_CRYPTO_VAULT };
        const updatedVault: CryptoVaultData = {
          ...currentVault,
          activeCryptoExchange: activateNow ? exchange : currentVault.activeCryptoExchange,
          binance: exchange === 'BINANCE' ? { ...currentVault.binance, ...creds } : currentVault.binance,
          bitget: exchange === 'BITGET' ? { ...currentVault.bitget, ...creds } : currentVault.bitget,
          updatedAt: Date.now(),
        };

        await saveCryptoVaultToLocalStorage(updatedVault);

        // Sync to server storage safely
        fetch('/api/binance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'SAVE_SERVER_VAULT', vault: updatedVault }),
        }).catch(() => {});

        const activeEx = updatedVault.activeCryptoExchange;
        const activeCreds = activeEx === 'BITGET' ? updatedVault.bitget : updatedVault.binance;
        const configured = isCryptoVaultConfigured(updatedVault, activeEx);

        set({
          activeExchange: activeEx,
          binanceConfig: updatedVault.binance,
          bitgetConfig: updatedVault.bitget,
          apiKey: activeCreds.apiKey || '',
          apiSecret: activeCreds.secretKey || '',
          isTestnet: activeCreds.accountType === 'DEMO',
          isVaultConfigured: configured,
        });

        get().addTelemetryLog(
          'VAULT',
          'INFO',
          `🔐 [VAULT] ${exchange} (${creds.accountType}) AES-256 credentials securely saved & activated as primary engine.`
        );
      },

      saveCredentials: async (apiKey, apiSecret, isTestnet) => {
        await get().saveCryptoCredentials(
          'BINANCE',
          {
            apiKey,
            secretKey: apiSecret,
            accountType: isTestnet ? 'DEMO' : 'REAL',
          },
          true
        );
      },

      clearCredentials: async (exchange) => {
        const targetExchange = exchange || get().activeExchange;
        const currentVault = (await loadCryptoVaultFromLocalStorage()) || { ...DEFAULT_CRYPTO_VAULT };
        const updatedVault: CryptoVaultData = {
          ...currentVault,
          binance: targetExchange === 'BINANCE'
            ? { apiKey: '', secretKey: '', accountType: 'DEMO' }
            : currentVault.binance,
          bitget: targetExchange === 'BITGET'
            ? { apiKey: '', secretKey: '', passphrase: '', accountType: 'REAL' }
            : currentVault.bitget,
          updatedAt: Date.now(),
        };

        await saveCryptoVaultToLocalStorage(updatedVault);

        fetch('/api/binance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'SAVE_SERVER_VAULT', vault: updatedVault }),
        }).catch(() => {});

        const activeEx = updatedVault.activeCryptoExchange;
        const activeCreds = activeEx === 'BITGET' ? updatedVault.bitget : updatedVault.binance;
        const configured = isCryptoVaultConfigured(updatedVault, activeEx);

        set({
          binanceConfig: updatedVault.binance,
          bitgetConfig: updatedVault.bitget,
          apiKey: activeCreds.apiKey || '',
          apiSecret: activeCreds.secretKey || '',
          isTestnet: activeCreds.accountType === 'DEMO',
          isVaultConfigured: configured,
          ...(configured ? {} : { positions: [], walletBalance: 0, unrealizedProfit: 0, marginBalance: 0, availableBalance: 0 }),
        });

        get().addTelemetryLog('VAULT', 'INFO', `[SECURITY] ${targetExchange} credentials cleared from vault.`);
      },

      loadSavedCredentials: async () => {
        if (typeof window === 'undefined') return;
        try {
          let vault = await loadCryptoVaultFromLocalStorage();
          if (!vault || (!isCryptoVaultConfigured(vault, 'BINANCE') && !isCryptoVaultConfigured(vault, 'BITGET'))) {
            try {
              const srvRes = await fetch('/api/binance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'LOAD_SERVER_VAULT' }),
              });
              if (srvRes.ok) {
                const srvData = await srvRes.json();
                if (srvData.success && srvData.vault) {
                  vault = srvData.vault as CryptoVaultData;
                  await saveCryptoVaultToLocalStorage(vault);
                }
              }
            } catch {}
          } else {
            fetch('/api/binance', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'SAVE_SERVER_VAULT', vault }),
            }).catch(() => {});
          }

          if (vault) {
            const activeEx = vault.activeCryptoExchange || 'BINANCE';
            const activeCreds = activeEx === 'BITGET' ? vault.bitget : vault.binance;
            const configured = isCryptoVaultConfigured(vault, activeEx);

            set({
              activeExchange: activeEx,
              binanceConfig: vault.binance || { apiKey: '', secretKey: '', accountType: 'DEMO' },
              bitgetConfig: vault.bitget
                ? { ...vault.bitget, accountType: vault.bitget.accountType === 'DEMO' ? 'DEMO' : 'REAL' }
                : { apiKey: '', secretKey: '', passphrase: '', accountType: 'REAL' },
              apiKey: activeCreds?.apiKey || '',
              apiSecret: activeCreds?.secretKey || '',
              isTestnet: activeCreds?.accountType === 'DEMO',
              isVaultConfigured: configured,
            });

            if (configured) {
              get().fetchSymbolsAndTickers(true);
              get().fetchKlines(get().selectedSymbol);
              get().fetchAccountInfo();
            }
          }

          // Ensure backend and client auto-trading state are strictly aligned
          try {
            const stateRes = await fetch('/api/binance?action=GET_STATE');
            if (stateRes.ok) {
              const stateData = await stateRes.json();
              if (stateData.success && typeof stateData.isAutoTrading === 'boolean') {
                const currentLocal = get().isAutoTrading;
                // If local scan button is currently inactive (e.g. after refresh), enforce server idle to stop background scanning
                if (!currentLocal && stateData.isAutoTrading) {
                  await fetch('/api/binance', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'SYNC_STATE', isAutoTrading: false }),
                  });
                } else if (currentLocal !== stateData.isAutoTrading) {
                  set({ isAutoTrading: stateData.isAutoTrading, isScanning: false });
                }
              }
            }
          } catch {}
        } catch (e) {
          console.warn('Failed to load crypto credentials from vault:', e);
        }
      },

      // Account & PnL (synced strictly from live exchange API — no dummy balance)
      walletBalance: 0,
      unrealizedProfit: 0,
      marginBalance: 0,
      availableBalance: 0,
      dailyPnl: 0,
      dailyPnlPercent: 0,
      dailyPnlHistory: {},
      tradeHistory: [],
      isPnlCalendarOpen: false,
      openPnlCalendar: () => set({ isPnlCalendarOpen: true }),
      closePnlCalendar: () => set({ isPnlCalendarOpen: false }),

      recordTradeEntry: (entry) => {
        const ts = entry.timestamp ?? Date.now();
        const dateStr = entry.date ?? getTodayDateString();
        const newItem: CryptoTradeHistoryItem = {
          ...entry,
          id: `tr_${ts}_${Math.random().toString(36).slice(2, 7)}`,
          timestamp: ts,
          date: dateStr,
        };
        set((state) => ({
          tradeHistory: [newItem, ...state.tradeHistory].slice(0, 200),
        }));
      },

      clearTradeHistory: () => {
        set({ tradeHistory: [] });
        get().addTelemetryLog('INFO', 'INFO', 'Crypto Entry & Trade History log cleared.');
      },

      recordTradePnL: (realizedPnl: number, tradeMeta) => {
        const today = getTodayDateString();
        const history = { ...get().dailyPnlHistory };
        const record = history[today] || { date: today, pnl: 0, trades: 0, wins: 0, losses: 0 };
        record.pnl = Number((record.pnl + realizedPnl).toFixed(2));
        record.trades += 1;
        if (realizedPnl >= 0) record.wins += 1;
        else record.losses += 1;

        history[today] = record;
        const baseBal = get().walletBalance > 0 ? get().walletBalance : 100.0;
        const pnlPct = Number(((record.pnl / baseBal) * 100).toFixed(2));

        set({
          dailyPnl: record.pnl,
          dailyPnlPercent: pnlPct,
          dailyPnlHistory: history,
        });

        if (tradeMeta) {
          get().recordTradeEntry({
            ...tradeMeta,
            realizedPnl: Number(realizedPnl.toFixed(2)),
            date: today,
          });
        }
      },

      resetCalendarHistory: () => {
        set({
          dailyPnl: 0,
          dailyPnlPercent: 0,
          dailyPnlHistory: {},
          tradeHistory: [],
        });
        get().addTelemetryLog('GUARD', 'INFO', 'Binance Futures Daily PnL & Entry History reset to $0.00');
      },

      // Positions & Logs
      positions: [],
      lastVerdict: {},
      telemetryLogs: [],
      addTelemetryLog: (symbol, category, message) => {
        const item: BinanceTelemetryItem = {
          id: `${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          timestamp: Date.now(),
          symbol,
          category,
          message,
        };
        set((state) => ({
          telemetryLogs: [item, ...state.telemetryLogs.slice(0, 99)],
        }));
      },
      clearTelemetry: () => set({ telemetryLogs: [] }),

      // Methods
      fetchSymbolsAndTickers: async (forceExchangeInfo = false) => {
        const ex = get().activeExchange || 'BINANCE';
        const isTest = get().isTestnet;
        const currentSymbols = get().allSymbols;
        const needsExchangeInfo = forceExchangeInfo || !currentSymbols || currentSymbols.length <= FALLBACK_SYMBOLS.length;

        try {
          const promises: [Promise<Response> | null, Promise<Response>] = [
            needsExchangeInfo
              ? fetch(`/api/binance?action=EXCHANGE_INFO&exchange=${ex}&isTestnet=${isTest}`, { cache: 'no-store' })
              : null,
            fetch(`/api/binance?action=TICKERS&exchange=${ex}&isTestnet=${isTest}`, { cache: 'no-store' }),
          ];

          const [infoRes, tickRes] = await Promise.all([
            promises[0] ? promises[0] : Promise.resolve(null),
            promises[1],
          ]);

          if (infoRes) {
            const infoJson = await infoRes.json();
            if (infoJson.success && Array.isArray(infoJson.symbols) && infoJson.symbols.length > 0) {
              set({ allSymbols: infoJson.symbols });
            }
          }

          const tickJson = await tickRes.json();
          if (tickJson.success && tickJson.tickers) {
            const newTickers = tickJson.tickers;
            const updatedPositions = get().positions.map((pos) => {
              const ticker = newTickers[pos.symbol];
              if (!ticker || !ticker.lastPrice) return pos;
              const curPrice = ticker.lastPrice;
              const isLong = pos.positionAmt > 0;
              const size = Math.abs(pos.positionAmt);
              const pnl = isLong ? (curPrice - pos.entryPrice) * size : (pos.entryPrice - curPrice) * size;
              return {
                ...pos,
                markPrice: curPrice,
                unRealizedProfit: Number(pnl.toFixed(4)),
                highestPriceSinceEntry: Math.max(pos.highestPriceSinceEntry || curPrice, curPrice),
                lowestPriceSinceEntry: Math.min(pos.lowestPriceSinceEntry || curPrice, curPrice),
              };
            });
            const totalUnrealized = updatedPositions.reduce((sum, p) => sum + (p.unRealizedProfit || 0), 0);
            const activeSym = get().selectedSymbol;
            const activeTicker = newTickers[activeSym];
            const existingKlines = get().klines[activeSym];
            let nextKlinesMap = get().klines;
            if (activeTicker?.lastPrice > 0 && Array.isArray(existingKlines) && existingKlines.length > 0) {
              const lastBar = existingKlines[existingKlines.length - 1];
              const livePrice = activeTicker.lastPrice;
              if (lastBar && livePrice !== lastBar.close) {
                const updatedLast: BinanceKline = {
                  ...lastBar,
                  close: livePrice,
                  high: Math.max(lastBar.high, livePrice),
                  low: Math.min(lastBar.low, livePrice),
                };
                nextKlinesMap = {
                  ...nextKlinesMap,
                  [activeSym]: [...existingKlines.slice(0, -1), updatedLast],
                };
              }
            }
            set({
              tickers: newTickers,
              positions: updatedPositions,
              unrealizedProfit: Number(totalUnrealized.toFixed(2)),
              klines: nextKlinesMap,
            });
          }
        } catch (e) {
          console.warn(`Error fetching symbols/tickers from /api/binance (${ex}):`, e);
        }
      },

      fetchKlines: async (symbol) => {
        const tf = get().timeframe || 'M5';
        const ex = get().activeExchange || 'BINANCE';
        const isTest = get().isTestnet;
        try {
          const res = await fetch(
            `/api/binance?action=KLINES&symbol=${symbol}&interval=${tf}&limit=100&exchange=${ex}&isTestnet=${isTest}`,
            { cache: 'no-store' }
          );
          const json = await res.json();
          if (json.success && Array.isArray(json.klines)) {
            set((state) => ({
              klines: { ...state.klines, [symbol]: json.klines },
            }));
          }
        } catch (e) {
          console.warn(`Error fetching klines for ${symbol}:`, e);
        }
      },

      upsertLiveKline: (symbol, kline, livePrice) => {
        set((state) => {
          const existing = state.klines[symbol] || [];
          let nextBars: BinanceKline[];
          if (existing.length === 0) {
            nextBars = [kline];
          } else {
            const last = existing[existing.length - 1];
            if (kline.timestamp === last.timestamp) {
              nextBars = [...existing.slice(0, -1), kline];
            } else if (kline.timestamp > last.timestamp) {
              nextBars = [...existing.slice(-99), kline];
            } else {
              return state;
            }
          }

          const priceToSync = typeof livePrice === 'number' && livePrice > 0 ? livePrice : kline.close;
          const prevTicker = state.tickers[symbol];
          const nextTickers =
            priceToSync > 0
              ? {
                  ...state.tickers,
                  [symbol]: {
                    ...(prevTicker || {
                      symbol,
                      priceChangePercent: 0,
                      highPrice: kline.high,
                      lowPrice: kline.low,
                      volume: kline.volume,
                      quoteVolume: 0,
                    }),
                    lastPrice: priceToSync,
                  },
                }
              : state.tickers;

          return {
            klines: { ...state.klines, [symbol]: nextBars },
            tickers: nextTickers,
          };
        });
      },

      fetchAccountInfo: async () => {
        if (get().isPanicClosing) return;
        const { activeExchange, binanceConfig, bitgetConfig, isVaultConfigured } = get();
        if (!isVaultConfigured) return;

        const currentCreds = activeExchange === 'BITGET' ? bitgetConfig : binanceConfig;
        if (!currentCreds.apiKey) return;

        try {
          const res = await fetch('/api/binance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'ACCOUNT',
              exchange: activeExchange,
              credentials: {
                apiKey: currentCreds.apiKey,
                secretKey: currentCreds.secretKey,
                apiSecret: currentCreds.secretKey,
                passphrase: (currentCreds as any).passphrase || '',
                accountType: currentCreds.accountType,
                isTestnet: currentCreds.accountType === 'DEMO',
              },
            }),
          });
          const json = await res.json();
          if (json.success && json.data) {
            const data = json.data;
            const currentPositions = get().positions;
            const remotePositions: BinancePosition[] = Array.isArray(data.positions) ? data.positions : [];
            const mergedMap = new Map<string, BinancePosition>();

            // Use strictly remote positions from exchange as source of truth
            for (const rp of remotePositions) {
              if (!rp || !rp.symbol) continue;
              const existing = currentPositions.find((p) => p.symbol === rp.symbol);
              if (existing) {
                mergedMap.set(rp.symbol, {
                  ...existing,
                  ...rp,
                  initialQuantity: existing.initialQuantity || Math.abs(rp.positionAmt),
                  partialClosed: existing.partialClosed || false,
                  isBreakevenLocked: existing.isBreakevenLocked || false,
                  takeProfit1Price: existing.takeProfit1Price ?? rp.takeProfit1Price,
                  stopLossPrice: existing.stopLossPrice ?? rp.stopLossPrice,
                  trailingStopPrice: existing.trailingStopPrice ?? rp.trailingStopPrice,
                  highestPriceSinceEntry: existing.highestPriceSinceEntry || rp.entryPrice,
                  lowestPriceSinceEntry: existing.lowestPriceSinceEntry || rp.entryPrice,
                  openTime: existing.openTime || Date.now(),
                });
              } else {
                mergedMap.set(rp.symbol, {
                  ...rp,
                  initialQuantity: Math.abs(rp.positionAmt),
                  partialClosed: false,
                  isBreakevenLocked: false,
                  highestPriceSinceEntry: rp.entryPrice,
                  lowestPriceSinceEntry: rp.entryPrice,
                  openTime: Date.now(),
                });
              }
            }

            // Continuously compute mark price and unrealized PnL from latest live tickers
            const tickers = get().tickers;
            const updatedPositions = Array.from(mergedMap.values()).map((pos) => {
              const ticker = tickers[pos.symbol];
              const curPrice = ticker?.lastPrice && ticker.lastPrice > 0 ? ticker.lastPrice : (pos.markPrice || pos.entryPrice);
              const isLong = pos.positionAmt > 0;
              const size = Math.abs(pos.positionAmt);
              const pnl = isLong ? (curPrice - pos.entryPrice) * size : (pos.entryPrice - curPrice) * size;

              return {
                ...pos,
                markPrice: curPrice,
                unRealizedProfit: Number(pnl.toFixed(4)),
                highestPriceSinceEntry: Math.max(pos.highestPriceSinceEntry || curPrice, curPrice),
                lowestPriceSinceEntry: Math.min(pos.lowestPriceSinceEntry || curPrice, curPrice),
              };
            });

            const totalUnrealized = updatedPositions.reduce((sum, p) => sum + (p.unRealizedProfit || 0), 0);
            const calcWalletBal = typeof data.totalWalletBalance === 'number' ? data.totalWalletBalance : get().walletBalance;
            const calcAvailBal = typeof data.availableBalance === 'number' ? data.availableBalance : calcWalletBal;

            set({
              walletBalance: Number(calcWalletBal.toFixed(2)),
              unrealizedProfit: Number(totalUnrealized.toFixed(2)),
              marginBalance: Number((calcWalletBal + totalUnrealized).toFixed(2)),
              availableBalance: Number(calcAvailBal.toFixed(2)),
              positions: updatedPositions,
            });
          }
        } catch (e) {
          console.warn('Error fetching account info from /api/binance:', e);
        }
      },

      executeScannerTick: async () => {
        const state = get();
        if (!state.isAutoTrading || state.isPanicClosing) {
          if (state.isScanning) set({ isScanning: false });
          return;
        }
        if (state.isScanning) return;
        set({ isScanning: true, lastScanTime: Date.now() });

        try {
          // Step 1: Monitor BTCUSDT 5m Velocity Guard
          let btcGuard = { dumpBlocked: false, pumpBlocked: false, velocityPct: 0 };
          try {
            const ex = state.activeExchange || 'BINANCE';
            const isTest = state.isTestnet;
            const btcRes = await fetch(`/api/binance?action=KLINES&symbol=BTCUSDT&interval=5m&limit=10&exchange=${ex}&isTestnet=${isTest}`);
            const btcJson = await btcRes.json();
            if (btcJson.success && btcJson.klines) {
              const guardRes = evaluateBtcVelocityGuard(btcJson.klines);
              btcGuard = guardRes;
              set({
                btcVelocityPct: guardRes.velocityPct,
                btcDumpBlocked: guardRes.dumpBlocked,
                btcPumpBlocked: guardRes.pumpBlocked,
                btcGuardStatus: guardRes.statusText,
              });
              if (guardRes.dumpBlocked) {
                state.addTelemetryLog('BTCUSDT', 'GUARD', guardRes.statusText);
              }
            }
          } catch (e) {
            console.warn('Could not check BTC Guard velocity:', e);
          }

          // Step 2: Manage Open Positions for Asymmetric Winrate Lock (50% Stage-1 Partial Close & Stage-2 Trailing Stop)
          const currentPositions = [...state.positions];
          const tickers = state.tickers;

          for (let i = 0; i < currentPositions.length; i++) {
            const pos = currentPositions[i];
            const ticker = tickers[pos.symbol];
            if (!ticker) continue;
            const curPrice = ticker.lastPrice;
            const isLong = pos.positionAmt > 0;
            const absAmt = Math.abs(pos.positionAmt);

            // Update highest / lowest price
            pos.highestPriceSinceEntry = Math.max(pos.highestPriceSinceEntry || curPrice, curPrice);
            pos.lowestPriceSinceEntry = Math.min(pos.lowestPriceSinceEntry || curPrice, curPrice);

            const posAtr = state.lastVerdict[pos.symbol]?.indicators?.atr14 || curPrice * 0.008;
            const protectiveFallbackSl = isLong ? pos.entryPrice * 0.982 : pos.entryPrice * 1.018;
            const effectiveSl = pos.trailingStopPrice || pos.stopLossPrice || protectiveFallbackSl;
            if (!pos.stopLossPrice) pos.stopLossPrice = protectiveFallbackSl;

            // Evaluate 2-Stage Trailing Stop via trailingManager
            const trailingAction = evaluateCryptoPositionTrailing({
              symbol: pos.symbol,
              side: isLong ? 'BUY' : 'SELL',
              entryPrice: pos.entryPrice,
              currentPrice: curPrice,
              quantity: absAmt,
              partialClosed: pos.partialClosed,
              currentSl: effectiveSl,
              atr14: posAtr,
              exchange: state.activeExchange,
            });

            // Stage 1: 50% Partial Close & Breakeven Stop
            if (trailingAction.action === 'PARTIAL_CLOSE' && !pos.partialClosed) {
              const originalPosAmt = pos.positionAmt;
              const closeQty = trailingAction.closeQuantity || (absAmt * 0.5);
              const realizedPnl = isLong
                ? (curPrice - pos.entryPrice) * closeQty
                : (pos.entryPrice - curPrice) * closeQty;

              state.recordTradePnL(realizedPnl, {
                symbol: pos.symbol,
                exchange: state.activeExchange,
                side: isLong ? 'LONG' : 'SHORT',
                action: 'PARTIAL_CLOSE',
                entryPrice: pos.entryPrice,
                exitPrice: curPrice,
                quantity: closeQty,
                leverage: pos.leverage || state.leverage,
                marginUsdt: pos.isolatedMargin ? Number((pos.isolatedMargin * 0.5).toFixed(2)) : Number((state.marginUsdt * 0.5).toFixed(2)),
                note: 'Stage-1 50% Partial Close -> BE+ Locked',
              });
              dualRoomProtections.recordProfitHit(pos.symbol, 'crypto');
              const remainingAbs = Math.max(0, absAmt - closeQty);
              pos.positionAmt = isLong ? remainingAbs : -remainingAbs;
              pos.partialClosed = true;
              pos.isBreakevenLocked = true;
              pos.stopLossPrice = trailingAction.newSlPrice || (isLong ? pos.entryPrice * 1.0008 : pos.entryPrice * 0.9992);
              pos.trailingStopPrice = pos.stopLossPrice;

              state.addTelemetryLog(
                pos.symbol,
                'LOCK',
                trailingAction.reason || `🎯 STAGE-1 PARTIAL CLOSE: 50% Closed (+$${realizedPnl.toFixed(2)} USDT Locked). Stop Loss moved to Breakeven+ ($${pos.stopLossPrice.toFixed(4)}). Zero Risk Moonbag Active!`
              );

              if (state.isVaultConfigured) {
                // 1. Partial close 50% on exchange
                fetch('/api/binance', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    action: 'CLOSE_POSITION',
                    exchange: state.activeExchange,
                    isTestnet: state.isTestnet,
                    credentials: getActiveCredentialsPayload(state),
                    payload: { symbol: pos.symbol, positionAmt: originalPosAmt, quantityToClose: closeQty },
                  }),
                }).catch(() => {});

                // 2. Route Stage-1 Breakeven SL update to exchange
                fetch('/api/binance', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    action: 'UPDATE_TRAILING_STOP',
                    exchange: state.activeExchange,
                    isTestnet: state.isTestnet,
                    credentials: getActiveCredentialsPayload(state),
                    payload: {
                      symbol: pos.symbol,
                      triggerPrice: pos.stopLossPrice,
                      holdSide: isLong ? 'long' : 'short',
                      side: isLong ? 'BUY' : 'SELL',
                      planType: 'pos_loss',
                    },
                  }),
                }).catch(() => {});
              }
            } else if (trailingAction.action === 'MODIFY_SL' && trailingAction.newSlPrice) {
              // Stage 2: Adaptive ATR Trailing Stop
              pos.trailingStopPrice = trailingAction.newSlPrice;
              pos.stopLossPrice = trailingAction.newSlPrice;
              state.addTelemetryLog(
                pos.symbol,
                'LOCK',
                trailingAction.reason || `🚀 STAGE-2 TRAILING SL: Advanced trailing stop to $${pos.stopLossPrice.toFixed(4)} on ${pos.symbol}`
              );

              if (state.isVaultConfigured) {
                fetch('/api/binance', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    action: 'UPDATE_TRAILING_STOP',
                    exchange: state.activeExchange,
                    isTestnet: state.isTestnet,
                    credentials: getActiveCredentialsPayload(state),
                    payload: {
                      symbol: pos.symbol,
                      triggerPrice: trailingAction.newSlPrice,
                      holdSide: isLong ? 'long' : 'short',
                      side: isLong ? 'BUY' : 'SELL',
                      planType: 'pos_loss',
                    },
                  }),
                }).catch(() => {});
              }
            }

            // Check Breakeven+ Stop Loss or Hard SL Circuit Breaker hit
            const slHit = trailingAction.action === 'HARD_SL_CLOSE' || (pos.stopLossPrice ? (isLong ? curPrice <= pos.stopLossPrice : curPrice >= pos.stopLossPrice) : false);
            if (slHit) {
              const remainingQty = absAmt;
              const realizedPnl = isLong
                ? (curPrice - pos.entryPrice) * remainingQty
                : (pos.entryPrice - curPrice) * remainingQty;
              state.recordTradePnL(realizedPnl, {
                symbol: pos.symbol,
                exchange: state.activeExchange,
                side: isLong ? 'LONG' : 'SHORT',
                action: pos.isBreakevenLocked ? 'CLOSE_BE' : 'CLOSE_SL',
                entryPrice: pos.entryPrice,
                exitPrice: curPrice,
                quantity: remainingQty,
                leverage: pos.leverage || state.leverage,
                marginUsdt: pos.isolatedMargin || state.marginUsdt,
                note: pos.isBreakevenLocked ? 'Breakeven+ Trailing Exit' : 'Stop Loss Exit',
              });
              dualRoomProtections.recordStopLossHit(
                pos.symbol,
                'crypto',
                pos.isBreakevenLocked ? 'BREAKEVEN_HIT' : 'STOP_LOSS'
              );
              state.addTelemetryLog(
                pos.symbol,
                'ORDER',
                `${pos.isBreakevenLocked ? '🛡️ BREAKEVEN+ HIT' : '🛑 STOP LOSS HIT'}: Closed remaining ${pos.symbol} at $${curPrice} (PnL: ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)})`
              );

              if (state.isVaultConfigured) {
                fetch('/api/binance', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    action: 'CLOSE_POSITION',
                    exchange: state.activeExchange,
                    isTestnet: state.isTestnet,
                    credentials: getActiveCredentialsPayload(state),
                    payload: { symbol: pos.symbol, positionAmt: pos.positionAmt, quantityToClose: remainingQty },
                  }),
                })
                  .then(() => {
                    setTimeout(() => get().fetchAccountInfo(), 1000);
                  })
                  .catch(() => {});
              }

              currentPositions.splice(i, 1);
              i--;
              continue;
            }
          }
          set({ positions: currentPositions });

          // Step 3: Determine Coins to Scan
          // If user selected a specific targetCategory (MEME, L1, L2, ALT), prioritize liquid pairs from that category.
          // Otherwise, use user's customWatchlist or high-liquidity majors.
          let scanQueue: string[];
          if (state.targetCategory && state.targetCategory !== 'ALL') {
            const catPool = state.allSymbols
              .filter((s) => getCoinCategory(s.symbol) === state.targetCategory)
              .map((s) => s.symbol);
            const fallbackPool =
              state.targetCategory === 'MEME'
                ? MEME_SYMBOLS
                : state.targetCategory === 'L1'
                ? L1_SYMBOLS
                : state.targetCategory === 'L2'
                ? L2_SYMBOLS
                : ALT_SYMBOLS;
            const pool = catPool.length > 0 ? catPool : fallbackPool;
            scanQueue = [...pool].sort(
              (a, b) => (state.tickers[b]?.quoteVolume || 0) - (state.tickers[a]?.quoteVolume || 0)
            );
            if (
              state.selectedSymbol &&
              getCoinCategory(state.selectedSymbol) === state.targetCategory &&
              !scanQueue.includes(state.selectedSymbol)
            ) {
              scanQueue.unshift(state.selectedSymbol);
            }
          } else {
            scanQueue =
              state.customWatchlist.length > 0
                ? [...state.customWatchlist]
                : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
            // Ensure active chart pair is evaluated if selected
            if (state.selectedSymbol && !scanQueue.includes(state.selectedSymbol)) {
              scanQueue.unshift(state.selectedSymbol);
            }
          }
          // Limit to max 6 coins per scan tick to keep Termux lightning fast
          scanQueue = scanQueue.slice(0, 6);

          // Check concurrent coins limit
          if (currentPositions.length >= state.maxConcurrentCoins) {
            set({ lastScanStatus: `Max Concurrent Trades (${state.maxConcurrentCoins}) reached. Monitoring open locks.` });
            return;
          }

          // Step 4: Scan and Evaluate Signals
          for (const sym of scanQueue) {
            // Strictly abort if auto-trading is toggled off / inactive or panic closing
            if (!get().isAutoTrading || get().isPanicClosing) break;

            // Skip if already in position
            if (currentPositions.some((p) => p.symbol === sym)) continue;

            // Dual-Room Freqtrade Protection Guard Check (Cooldown & Consecutive Loss Lock)
            const protectionCheck = dualRoomProtections.checkSymbolProtection(sym, 'crypto');
            if (!protectionCheck.allowed) {
              state.addTelemetryLog(sym, 'GUARD', protectionCheck.reason!);
              continue;
            }

            // Funding Settlement Spike Window Check (+/- 5m around 00:00, 08:00, 16:00 UTC)
            const fundingCheck = dualRoomProtections.checkFundingWindowVolatility();
            if (fundingCheck.inFundingWindow) {
              state.addTelemetryLog(sym, 'GUARD', fundingCheck.message);
            }

            const ex = state.activeExchange || 'BINANCE';
            const isTest = state.isTestnet;
            const klineRes = await fetch(`/api/binance?action=KLINES&symbol=${sym}&interval=5m&limit=220&exchange=${ex}&isTestnet=${isTest}`);
            const klineJson = await klineRes.json();
            if (!klineJson.success || !Array.isArray(klineJson.klines) || klineJson.klines.length < 50) continue;

            const c0Ts = klineJson.klines[klineJson.klines.length - 1]?.timestamp || 0;
            const lockSym = `CRYPTO_${ex}_${sym}`;
            if (c0Ts > 0 && idempotencyLocks.isCandleLocked(lockSym, 'M5', c0Ts)) {
              continue;
            }

            const verdict = await evaluateCryptoSignal({
              symbol: sym,
              klines: klineJson.klines,
              fundingRate: 0.0001,
              btcGuard,
              enableAiJudge: true,
            });

            set((s) => ({ lastVerdict: { ...s.lastVerdict, [sym]: verdict } }));

            if (verdict.aiVerdict) {
              state.addTelemetryLog(
                sym,
                'AI',
                `Multi-AI Consensus [${verdict.aiVerdict.modelUsed}]: ${verdict.aiVerdict.decision} (${verdict.aiVerdict.confidence}%) — ${verdict.aiVerdict.reasoning}`
              );
            }

            const cryptoDynamicThreshold = verdict.dynamicThreshold || getCryptoDynamicThreshold({
              efficiencyRatio: verdict.indicators?.efficiencyRatio,
              pocMagnetAligned: verdict.indicators?.pocMagnetAligned,
            });

            const effectiveScore = verdict.aiVerdict ? verdict.aiVerdict.confidence : verdict.score;
            const aiApproved = verdict.aiVerdict ? verdict.aiVerdict.decision === 'EXECUTE' : true;
            const isSignalQualified =
              verdict.approved &&
              aiApproved &&
              effectiveScore >= cryptoDynamicThreshold &&
              !verdict.btcGuardBlocked;

            const erVal = verdict.indicators?.efficiencyRatio ?? 0.50;
            const pocLabel = verdict.indicators?.pocMagnetAligned ? 'Kronos POC Aligned' : 'Normal POC';
            const govDecision = isSignalQualified ? 'EXECUTE' : 'REJECT';
            state.addTelemetryLog(
              sym,
              'AI',
              `[AUTO-GOVERNANCE] AI Score: ${effectiveScore}% vs Dynamic Threshold: ${cryptoDynamicThreshold}% (Regime ER=${erVal.toFixed(2)}, ${pocLabel}) -> ${govDecision}`
            );

            if (isSignalQualified && get().isAutoTrading && !get().isPanicClosing) {
              state.addTelemetryLog(
                sym,
                'SIGNAL',
                `🔥 CRYPTO ${verdict.setupName || 'CONFLUENCE'} [Score ${verdict.score}/100 | AI ${effectiveScore}% >= ${cryptoDynamicThreshold}%]: ${verdict.side} qualified. SL: $${verdict.stopLossPrice} | TP1: $${verdict.takeProfit1Price}`
              );

              if (!state.isVaultConfigured) {
                state.addTelemetryLog(
                  sym,
                  'GUARD',
                  `⚠️ [${state.activeExchange}] Signal ${verdict.side} #${sym} dilewati: API Key belum dikonfigurasi di Vault.`
                );
                continue;
              }

              // Calculate Notional & Coin Quantity using stepSize
              const margin = state.marginUsdt;
              const lev = state.leverage;
              const notional = margin * lev;
              const filter = state.allSymbols.find((f) => f.symbol === sym);
              const step = filter?.stepSize || '0.1';
              const prec = filter?.quantityPrecision || 1;
              const rawQty = notional / verdict.entryPrice;
              const formattedQty = formatQuantityByStepSize(rawQty, step, prec);
              const qtyNum = parseFloat(formattedQty);

              if (qtyNum <= 0) continue;

              try {
                const orderRes = await fetch('/api/binance', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    action: 'PLACE_ORDER',
                    exchange: state.activeExchange,
                    isTestnet: state.isTestnet,
                    credentials: getActiveCredentialsPayload(state),
                    payload: {
                      symbol: sym,
                      side: verdict.side === 'LONG' ? 'BUY' : 'SELL',
                      type: 'MARKET',
                      quantity: formattedQty,
                      price: verdict.entryPrice,
                      margin,
                      leverage: lev,
                      marginMode: state.marginMode,
                      stopPrice: verdict.stopLossPrice ? String(verdict.stopLossPrice) : undefined,
                      takeProfitPrice: verdict.takeProfit1Price ? String(verdict.takeProfit1Price) : undefined,
                    },
                  }),
                });
                const orderJson = await orderRes.json();
                if (!orderRes.ok || !orderJson.success) {
                  state.addTelemetryLog(
                    sym,
                    'GUARD',
                    `❌ [${state.activeExchange}] Order ${verdict.side} #${sym} gagal: ${orderJson.error || orderJson.message || 'Exchange rejected order'}`
                  );
                  continue;
                }

                if (c0Ts > 0) {
                  idempotencyLocks.recordExecutedCandle(lockSym, 'M5', c0Ts, verdict.side === 'LONG' ? 'BUY' : 'SELL');
                }

                state.recordTradeEntry({
                  symbol: sym,
                  exchange: state.activeExchange,
                  side: verdict.side,
                  action: 'OPEN_AUTO',
                  entryPrice: verdict.entryPrice,
                  quantity: qtyNum,
                  leverage: lev,
                  marginUsdt: margin,
                  setupName: verdict.setupName,
                  note: `Score ${verdict.score}/${verdict.dynamicThreshold || 65}% | SL $${verdict.stopLossPrice} | TP1 $${verdict.takeProfit1Price}`,
                });

                state.addTelemetryLog(
                  sym,
                  'ORDER',
                  `⚡ EXECUTED ${verdict.side} #${sym} on ${state.activeExchange}: ${formattedQty} coins (Margin: $${margin.toFixed(2)} at ${lev}x ${state.marginMode})`
                );

                await get().fetchAccountInfo();
              } catch (orderErr: any) {
                state.addTelemetryLog(
                  sym,
                  'GUARD',
                  `❌ [${state.activeExchange}] Order ${verdict.side} #${sym} network error: ${orderErr?.message || 'Failed'}`
                );
              }

              // Check if concurrent limit reached
              if (get().positions.length >= state.maxConcurrentCoins) break;
            }
          }

          set({ lastScanStatus: `Scanned ${scanQueue.length} coins. Active positions: ${get().positions.length}` });
        } catch (e: any) {
          console.warn('Scanner tick error:', e);
        } finally {
          set({ isScanning: false });
        }
      },

      executeManualTrade: async (symbol, side) => {
        const state = get();
        if (!state.isVaultConfigured) {
          state.addTelemetryLog(
            symbol,
            'GUARD',
            `❌ [${state.activeExchange}] Tidak dapat membuka order manual: API Key belum dikonfigurasi di Vault.`
          );
          return;
        }

        const ticker = state.tickers[symbol];
        const price = ticker?.lastPrice || 0;
        if (price <= 0) {
          state.addTelemetryLog(symbol, 'GUARD', `❌ [${state.activeExchange}] Harga live ${symbol} belum tersedia.`);
          return;
        }
        const margin = state.marginUsdt;
        const lev = state.leverage;
        const notional = margin * lev;
        const filter = state.allSymbols.find((f) => f.symbol === symbol);
        const step = filter?.stepSize || '0.1';
        const prec = filter?.quantityPrecision || 1;
        const formattedQty = formatQuantityByStepSize(notional / price, step, prec);
        const qtyNum = parseFloat(formattedQty);

        if (qtyNum <= 0) return;

        const isLong = side === 'LONG';
        const atrApprox = price * 0.015;
        const stopLossPrice = isLong ? price - 1.5 * atrApprox : price + 1.5 * atrApprox;
        const takeProfit1Price = isLong ? price + 0.7 * (1.5 * atrApprox) : price - 0.7 * (1.5 * atrApprox);

        try {
          const res = await fetch('/api/binance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'ORDER',
              exchange: state.activeExchange,
              isTestnet: state.isTestnet,
              credentials: getActiveCredentialsPayload(state),
              payload: {
                symbol,
                side: isLong ? 'BUY' : 'SELL',
                type: 'MARKET',
                quantity: formattedQty,
                price,
                margin,
                leverage: lev,
                marginMode: state.marginMode,
                stopPrice: stopLossPrice ? String(stopLossPrice) : undefined,
                takeProfitPrice: takeProfit1Price ? String(takeProfit1Price) : undefined,
              },
            }),
          });
          const json = await res.json();
          if (!res.ok || !json.success) {
            state.addTelemetryLog(
              symbol,
              'GUARD',
              `❌ [${state.activeExchange}] Manual ${side} ${symbol} ditolak: ${json.error || json.message || 'Order failed'}`
            );
            return;
          }

          state.recordTradeEntry({
            symbol,
            exchange: state.activeExchange,
            side,
            action: 'OPEN_MANUAL',
            entryPrice: price,
            quantity: qtyNum,
            leverage: lev,
            marginUsdt: margin,
            note: `Manual Market ${side} (${lev}x ${state.marginMode})`,
          });

          state.addTelemetryLog(
            symbol,
            'ORDER',
            `✅ MANUAL ${side} ${symbol} (${state.activeExchange}): ${formattedQty} coins at $${price} (Margin $${margin.toFixed(2)}, ${lev}x ${state.marginMode})`
          );
          await get().fetchAccountInfo();
        } catch (err: any) {
          state.addTelemetryLog(
            symbol,
            'GUARD',
            `❌ [${state.activeExchange}] Manual ${side} ${symbol} error: ${err?.message || 'Network error'}`
          );
        }
      },

      closePosition: async (symbol, quantityToClose) => {
        const state = get();
        const pos = state.positions.find((p) => p.symbol === symbol);
        if (!pos) return;

        const ticker = state.tickers[symbol];
        const curPrice = ticker?.lastPrice || pos.entryPrice;
        const isLong = pos.positionAmt > 0;
        const totalAbs = Math.abs(pos.positionAmt);
        const qty = quantityToClose && quantityToClose < totalAbs ? quantityToClose : totalAbs;

        const realizedPnl = isLong
          ? (curPrice - pos.entryPrice) * qty
          : (pos.entryPrice - curPrice) * qty;

        state.recordTradePnL(realizedPnl, {
          symbol,
          exchange: state.activeExchange,
          side: isLong ? 'LONG' : 'SHORT',
          action: quantityToClose && quantityToClose < totalAbs ? 'PARTIAL_CLOSE' : 'CLOSE_MANUAL',
          entryPrice: pos.entryPrice,
          exitPrice: curPrice,
          quantity: qty,
          leverage: pos.leverage || state.leverage,
          marginUsdt: pos.isolatedMargin || state.marginUsdt,
          note: 'Manual Position Close',
        });
        state.addTelemetryLog(
          symbol,
          'ORDER',
          `Manual Close ${symbol}: ${qty} coins at $${curPrice} (PnL: ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)})`
        );

        if (!quantityToClose || quantityToClose >= totalAbs) {
          set({ positions: state.positions.filter((p) => p.symbol !== symbol) });
        } else {
          set({
            positions: state.positions.map((p) =>
              p.symbol === symbol
                ? { ...p, positionAmt: isLong ? p.positionAmt - qty : p.positionAmt + qty, partialClosed: true }
                : p
            ),
          });
        }

        if (state.isVaultConfigured) {
          fetch('/api/binance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'CLOSE_POSITION',
              exchange: state.activeExchange,
              isTestnet: state.isTestnet,
              credentials: getActiveCredentialsPayload(state),
              payload: { symbol, positionAmt: pos.positionAmt, quantityToClose: qty },
            }),
          })
            .then(() => {
              setTimeout(() => get().fetchAccountInfo(), 1000);
            })
            .catch(() => {});
        }
      },

      panicCloseAll: async () => {
        const state = get();
        const currentPositions = [...state.positions];
        state.addTelemetryLog('PANIC', 'ORDER', `🚨 PANIC CLOSE ALL: Liquidating ${currentPositions.length} positions across ${state.activeExchange}! Execution lock active (5s).`);

        if (currentPositions.length > 0) {
          const tickers = state.tickers;
          for (const pos of currentPositions) {
            const curPrice = tickers[pos.symbol]?.lastPrice || pos.markPrice || pos.entryPrice;
            const isLong = pos.positionAmt > 0;
            const qty = Math.abs(pos.positionAmt);
            const posPnl = isLong ? (curPrice - pos.entryPrice) * qty : (pos.entryPrice - curPrice) * qty;
            state.recordTradePnL(posPnl, {
              symbol: pos.symbol,
              exchange: state.activeExchange,
              side: isLong ? 'LONG' : 'SHORT',
              action: 'PANIC_CLOSE',
              entryPrice: pos.entryPrice,
              exitPrice: curPrice,
              quantity: qty,
              leverage: pos.leverage || state.leverage,
              marginUsdt: pos.isolatedMargin || state.marginUsdt,
              note: 'Panic Close All Liquidation',
            });
          }
        }

        // 1. Immediately set execution lock for 5s, turn off auto-trading & scanning, and clear positions array
        set({
          isPanicClosing: true,
          isAutoTrading: false,
          isScanning: false,
          positions: [],
        });

        setTimeout(() => {
          set({ isPanicClosing: false });
        }, 5000);

        // 2. Dispatch PANIC_CLOSE to backend to clear server exchange and simulated ledger
        fetch('/api/binance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'PANIC_CLOSE',
            exchange: state.activeExchange,
            isTestnet: state.isTestnet,
            credentials: getActiveCredentialsPayload(state),
            payload: { positions: currentPositions },
          }),
        })
          .then(() => {
            setTimeout(() => {
              if (!get().isPanicClosing) {
                get().fetchAccountInfo();
              }
            }, 2500);
          })
          .catch(() => {});
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        activeExchange: state.activeExchange,
        marginUsdt: state.marginUsdt,
        leverage: state.leverage,
        marginMode: state.marginMode,
        maxConcurrentCoins: state.maxConcurrentCoins,
        selectedCategory: state.selectedCategory,
        targetCategory: state.targetCategory,
        customWatchlist: state.customWatchlist,
        selectedSymbol: state.selectedSymbol,
        timeframe: state.timeframe,
        isTestnet: state.isTestnet,
        dailyPnlHistory: state.dailyPnlHistory,
        tradeHistory: state.tradeHistory,
        isAutoTrading: state.isAutoTrading,
      }),
      onRehydrateStorage: () => (rehydratedState) => {
        if (rehydratedState) {
          rehydratedState.isScanning = false;
          rehydratedState.isPanicClosing = false;
          rehydratedState.isAutoTrading = Boolean(rehydratedState.isAutoTrading);
          const cat = rehydratedState.selectedCategory as string;
          if (cat === 'L1_DEFI') rehydratedState.selectedCategory = 'L1';
          else if (cat === 'AI_MEME') rehydratedState.selectedCategory = 'MEME';
          if (!rehydratedState.targetCategory) rehydratedState.targetCategory = 'ALL';
        }
      },
    }
  )
);
