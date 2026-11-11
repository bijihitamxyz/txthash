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
import { dualRoomProtections } from '@/core/riskGuard';
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

export type BinanceCategory = 'ALL' | 'TOP_MOVERS' | 'L2' | 'L1_DEFI' | 'AI_MEME';

// Categorized symbol lists
export const L2_MODULAR_SYMBOLS = [
  'ARBUSDT', 'OPUSDT', 'STRKUSDT', 'ZKUSDT', 'POLUSDT',
  'TIAUSDT', 'MANTAUSDT', 'METISUSDT', 'ZROUSDT', 'IMXUSDT'
];

export const L1_DEFI_SYMBOLS = [
  'SOLUSDT', 'SUIUSDT', 'SEIUSDT', 'APTUSDT', 'AVAXUSDT',
  'INJUSDT', 'ONDOUSDT', 'PENDLEUSDT', 'ENAUSDT', 'NEARUSDT',
  'LINKUSDT', 'ADAUSDT', 'DOTUSDT'
];

export const AI_MEME_SYMBOLS = [
  'FETUSDT', 'RENDERUSDT', 'WLDUSDT', 'DOGEUSDT', '1000PEPEUSDT',
  'WIFUSDT', 'BONKUSDT', '1000SHIBUSDT', '1000FLOKIUSDT', 'TAOUSDT'
];

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
  recordTradePnL: (realizedPnl: number) => void;
  resetCalendarHistory: () => void;

  // 7. Positions & Trade Execution
  positions: BinancePosition[];
  lastVerdict: Record<string, CryptoSignalVerdict>;
  telemetryLogs: BinanceTelemetryItem[];
  addTelemetryLog: (symbol: string, category: BinanceTelemetryItem['category'], message: string) => void;
  clearTelemetry: () => void;

  // Action Methods
  fetchSymbolsAndTickers: (forceExchangeInfo?: boolean) => Promise<void>;
  fetchKlines: (symbol: string) => Promise<void>;
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
        const creds = activeExchange === 'BITGET' ? get().bitgetConfig : get().binanceConfig;
        const configured = isCryptoVaultConfigured(
          {
            activeCryptoExchange: activeExchange,
            binance: get().binanceConfig,
            bitget: get().bitgetConfig,
            updatedAt: Date.now(),
          },
          activeExchange
        );
        set({
          apiKey: creds.apiKey || '',
          apiSecret: creds.secretKey || '',
          isTestnet: creds.accountType === 'DEMO',
          isVaultConfigured: configured,
          positions: [],
        });
        get().fetchSymbolsAndTickers(true);
        if (configured) {
          get().fetchAccountInfo();
        }
      },
      binanceConfig: { apiKey: '', secretKey: '', accountType: 'DEMO' },
      bitgetConfig: { apiKey: '', secretKey: '', passphrase: '', accountType: 'REAL' },
      apiKey: '',
      apiSecret: '',
      isTestnet: false,
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
      isPnlCalendarOpen: false,
      openPnlCalendar: () => set({ isPnlCalendarOpen: true }),
      closePnlCalendar: () => set({ isPnlCalendarOpen: false }),

      recordTradePnL: (realizedPnl: number) => {
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
      },

      resetCalendarHistory: () => {
        set({
          dailyPnl: 0,
          dailyPnlPercent: 0,
          dailyPnlHistory: {},
        });
        get().addTelemetryLog('GUARD', 'INFO', 'Binance Futures Daily PnL calendar history reset to $0.00');
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
              ? fetch(`/api/binance?action=EXCHANGE_INFO&exchange=${ex}&isTestnet=${isTest}`)
              : null,
            fetch(`/api/binance?action=TICKERS&exchange=${ex}&isTestnet=${isTest}`),
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
            set({
              tickers: newTickers,
              positions: updatedPositions,
              unrealizedProfit: Number(totalUnrealized.toFixed(2)),
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
          const res = await fetch(`/api/binance?action=KLINES&symbol=${symbol}&interval=${tf}&limit=100&exchange=${ex}&isTestnet=${isTest}`);
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

            // Evaluate 2-Stage Trailing Stop via trailingManager
            const trailingAction = evaluateCryptoPositionTrailing({
              symbol: pos.symbol,
              side: isLong ? 'BUY' : 'SELL',
              entryPrice: pos.entryPrice,
              currentPrice: curPrice,
              quantity: absAmt,
              partialClosed: pos.partialClosed,
              currentSl: pos.trailingStopPrice || pos.stopLossPrice,
              atr14: curPrice * 0.012,
              exchange: state.activeExchange,
            });

            // Stage 1: 50% Partial Close & Breakeven Stop
            if (trailingAction.action === 'PARTIAL_CLOSE' && !pos.partialClosed) {
              const originalPosAmt = pos.positionAmt;
              const closeQty = trailingAction.closeQuantity || (absAmt * 0.5);
              const realizedPnl = isLong
                ? (curPrice - pos.entryPrice) * closeQty
                : (pos.entryPrice - curPrice) * closeQty;

              state.recordTradePnL(realizedPnl);
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
              state.recordTradePnL(realizedPnl);
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
          // Priority: User's customWatchlist -> or dynamically selected Top Liquid / L2s
          let scanQueue = state.customWatchlist.length > 0 ? [...state.customWatchlist] : [...L2_MODULAR_SYMBOLS];
          // Ensure active chart pair is evaluated if selected
          if (state.selectedSymbol && !scanQueue.includes(state.selectedSymbol)) {
            scanQueue.unshift(state.selectedSymbol);
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
            const klineRes = await fetch(`/api/binance?action=KLINES&symbol=${sym}&interval=5m&limit=60&exchange=${ex}&isTestnet=${isTest}`);
            const klineJson = await klineRes.json();
            if (!klineJson.success || !Array.isArray(klineJson.klines)) continue;

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
            // Any verified signal scoring >= dynamic threshold (when Risk Guard is clear) MUST execute!
            const isSignalQualified = (verdict.approved || verdict.score >= cryptoDynamicThreshold || effectiveScore >= cryptoDynamicThreshold) &&
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

        state.recordTradePnL(realizedPnl);
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
          let totalPanicPnl = 0;
          for (const pos of currentPositions) {
            const curPrice = tickers[pos.symbol]?.lastPrice || pos.markPrice || pos.entryPrice;
            const isLong = pos.positionAmt > 0;
            const qty = Math.abs(pos.positionAmt);
            totalPanicPnl += isLong ? (curPrice - pos.entryPrice) * qty : (pos.entryPrice - curPrice) * qty;
          }
          state.recordTradePnL(totalPanicPnl);
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
        customWatchlist: state.customWatchlist,
        selectedSymbol: state.selectedSymbol,
        timeframe: state.timeframe,
        isTestnet: state.isTestnet,
        dailyPnlHistory: state.dailyPnlHistory,
        isAutoTrading: state.isAutoTrading,
      }),
      onRehydrateStorage: () => (rehydratedState) => {
        if (rehydratedState) {
          rehydratedState.isScanning = false;
          rehydratedState.isPanicClosing = false;
          rehydratedState.isAutoTrading = Boolean(rehydratedState.isAutoTrading);
        }
      },
    }
  )
);
