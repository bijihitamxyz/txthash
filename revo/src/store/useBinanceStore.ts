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
  CryptoSignalVerdict,
} from '@/core/cryptoSignalEngine';
import { encryptCredential, decryptCredential } from '@/lib/cryptoVault';

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
  'TIAUSDT', 'MANTAUSDT', 'METISUSDT', 'ZROUSDT', 'MANTAUSDT'
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

  // 5. Binance API Vault Credentials (AES-256)
  apiKey: string;
  apiSecret: string;
  isTestnet: boolean;
  isVaultConfigured: boolean;
  isVaultModalOpen: boolean;
  openVaultModal: () => void;
  closeVaultModal: () => void;
  saveCredentials: (apiKey: string, apiSecret: string, isTestnet: boolean) => Promise<void>;
  clearCredentials: () => Promise<void>;
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
  fetchSymbolsAndTickers: () => Promise<void>;
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
      // Sizing defaults
      marginUsdt: 3.00,
      setMarginUsdt: (val) => set({ marginUsdt: Math.max(1, Math.min(500, Number(val) || 3.00)) }),
      leverage: 10,
      setLeverage: (val) => set({ leverage: Math.max(2, Math.min(50, Number(val) || 10)) }),
      marginMode: 'ISOLATED',
      setMarginMode: (marginMode) => set({ marginMode }),
      maxConcurrentCoins: 3,
      setMaxConcurrentCoins: (val) => set({ maxConcurrentCoins: Math.max(1, Math.min(5, Number(val) || 3)) }),

      // Engine defaults - strictly starts idle
      isAutoTrading: false,
      setIsAutoTrading: (isAutoTrading) => set({ isAutoTrading }),
      toggleAutoTrading: () => {
        const next = !get().isAutoTrading;
        set({ isAutoTrading: next });
        get().addTelemetryLog(
          'ENGINE',
          'INFO',
          next ? '🚀 BINANCE AUTO-TRADING STARTED (Altcoins & L2 24/7 Engine Active)' : '⏸️ BINANCE AUTO-TRADING STOPPED (Engine Idle)'
        );
        if (next) {
          get().executeScannerTick();
        }
      },
      isScanning: false,
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

      // API Vault
      apiKey: '',
      apiSecret: '',
      isTestnet: true,
      isVaultConfigured: false,
      isVaultModalOpen: false,
      openVaultModal: () => set({ isVaultModalOpen: true }),
      closeVaultModal: () => set({ isVaultModalOpen: false }),

      saveCredentials: async (apiKey, apiSecret, isTestnet) => {
        set({ apiKey, apiSecret, isTestnet, isVaultConfigured: Boolean(apiKey && apiSecret) });
        if (typeof window !== 'undefined') {
          try {
            const raw = JSON.stringify({ apiKey, apiSecret, isTestnet });
            const encrypted = await encryptCredential(raw);
            localStorage.setItem(VAULT_STORAGE_KEY, encrypted);
          } catch (e) {
            console.warn('Failed to encrypt credentials to localStorage:', e);
          }
        }
      },

      clearCredentials: async () => {
        set({ apiKey: '', apiSecret: '', isVaultConfigured: false });
        if (typeof window !== 'undefined') {
          try {
            localStorage.removeItem(VAULT_STORAGE_KEY);
          } catch {}
        }
        get().addTelemetryLog('VAULT', 'INFO', '[SECURITY] Binance AES-256 API credentials cleared from vault.');
      },

      loadSavedCredentials: async () => {
        if (typeof window === 'undefined') return;
        try {
          const enc = localStorage.getItem(VAULT_STORAGE_KEY);
          if (enc) {
            const dec = await decryptCredential(enc);
            if (dec) {
              const parsed = JSON.parse(dec);
              set({
                apiKey: parsed.apiKey || '',
                apiSecret: parsed.apiSecret || '',
                isTestnet: parsed.isTestnet ?? true,
                isVaultConfigured: Boolean(parsed.apiKey && parsed.apiSecret),
              });
            }
          }
        } catch (e) {
          console.warn('Failed to decrypt credentials from localStorage:', e);
        }
      },

      // Account & PnL
      walletBalance: 100.00,
      unrealizedProfit: 0,
      marginBalance: 100.00,
      availableBalance: 100.00,
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
        const currentBal = Math.max(10, get().walletBalance + realizedPnl);
        const pnlPct = Number(((record.pnl / 100.0) * 100).toFixed(2));

        set({
          walletBalance: Number(currentBal.toFixed(2)),
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
      fetchSymbolsAndTickers: async () => {
        try {
          const [infoRes, tickRes] = await Promise.all([
            fetch('/api/binance?action=EXCHANGE_INFO'),
            fetch('/api/binance?action=TICKERS'),
          ]);

          const infoJson = await infoRes.json();
          const tickJson = await tickRes.json();

          if (infoJson.success && Array.isArray(infoJson.symbols) && infoJson.symbols.length > 0) {
            set({ allSymbols: infoJson.symbols });
          }
          if (tickJson.success && tickJson.tickers) {
            set({ tickers: tickJson.tickers });
          }
        } catch (e) {
          console.warn('Error fetching symbols/tickers from /api/binance:', e);
        }
      },

      fetchKlines: async (symbol) => {
        const tf = get().timeframe || 'M5';
        try {
          const res = await fetch(`/api/binance?action=KLINES&symbol=${symbol}&interval=${tf}&limit=100`);
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
        const { apiKey, apiSecret, isTestnet, isVaultConfigured } = get();
        if (!isVaultConfigured || !apiKey) return;

        try {
          const res = await fetch('/api/binance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'ACCOUNT',
              credentials: { apiKey, apiSecret, isTestnet },
            }),
          });
          const json = await res.json();
          if (json.success && json.data) {
            const data = json.data;
            const newBal = data.totalWalletBalance > 0 ? data.totalWalletBalance : get().walletBalance;

            // Merge local tracking (partialClose, breakeven) into incoming live positions
            const currentPositions = get().positions;
            const mergedPositions = (data.positions || []).map((p: BinancePosition) => {
              const existing = currentPositions.find((cp) => cp.symbol === p.symbol);
              return {
                ...p,
                initialQuantity: existing?.initialQuantity || Math.abs(p.positionAmt),
                partialClosed: existing?.partialClosed || false,
                isBreakevenLocked: existing?.isBreakevenLocked || false,
                takeProfit1Price: existing?.takeProfit1Price,
                stopLossPrice: existing?.stopLossPrice,
                trailingStopPrice: existing?.trailingStopPrice,
                highestPriceSinceEntry: existing?.highestPriceSinceEntry || p.entryPrice,
                lowestPriceSinceEntry: existing?.lowestPriceSinceEntry || p.entryPrice,
              };
            });

            set({
              walletBalance: Number(newBal.toFixed(2)),
              unrealizedProfit: Number((data.totalUnrealizedProfit || 0).toFixed(2)),
              marginBalance: Number((data.totalMarginBalance || newBal).toFixed(2)),
              availableBalance: Number((data.availableBalance || newBal).toFixed(2)),
              positions: mergedPositions,
            });
          }
        } catch (e) {
          console.warn('Error fetching account info from /api/binance:', e);
        }
      },

      executeScannerTick: async () => {
        const state = get();
        if (!state.isAutoTrading || state.isScanning) return;
        set({ isScanning: true, lastScanTime: Date.now() });

        try {
          // Step 1: Monitor BTCUSDT 5m Velocity Guard
          let btcGuard = { dumpBlocked: false, pumpBlocked: false, velocityPct: 0 };
          try {
            const btcRes = await fetch('/api/binance?action=KLINES&symbol=BTCUSDT&interval=5m&limit=10');
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

          // Step 2: Manage Open Positions for Asymmetric Winrate Lock
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

            // Check TP1 (60% Partial Close) hit!
            // Strictly guard: MUST be in net positive profit (>= 0.6R / minProfit) and target must be beyond entryPrice
            if (!pos.partialClosed) {
              const riskDist = pos.stopLossPrice
                ? Math.abs(pos.entryPrice - pos.stopLossPrice)
                : pos.entryPrice * 0.005;
              const minProfitDist = Math.max(pos.entryPrice * 0.0015, 0.6 * riskDist);

              const isLongProfit = isLong && curPrice > pos.entryPrice + minProfitDist;
              const isShortProfit = !isLong && curPrice < pos.entryPrice - minProfitDist;

              const tp1TargetValid = pos.takeProfit1Price
                ? (isLong ? pos.takeProfit1Price > pos.entryPrice + minProfitDist : pos.takeProfit1Price < pos.entryPrice - minProfitDist)
                : false;

              const tp1Hit = (isLongProfit && ((tp1TargetValid && curPrice >= (pos.takeProfit1Price || 0)) || curPrice >= pos.entryPrice + 0.6 * riskDist)) ||
                             (isShortProfit && ((tp1TargetValid && curPrice <= (pos.takeProfit1Price || 0)) || curPrice <= pos.entryPrice - 0.6 * riskDist));

              if (tp1Hit) {
                // Execute 60% Partial Close
                const closeQty = absAmt * 0.60;
                const realizedPnl = isLong
                  ? (curPrice - pos.entryPrice) * closeQty
                  : (pos.entryPrice - curPrice) * closeQty;

                state.recordTradePnL(realizedPnl);
                pos.partialClosed = true;
                pos.isBreakevenLocked = true;
                // Move SL to Breakeven+
                pos.stopLossPrice = isLong
                  ? pos.entryPrice * 1.0008 // fee buffer
                  : pos.entryPrice * 0.9992;

                state.addTelemetryLog(
                  pos.symbol,
                  'LOCK',
                  `🎯 TP1 HIT (+0.7R/VWAP): 60% Closed (+$${realizedPnl.toFixed(2)} USDT Locked). Stop Loss moved to Breakeven+ ($${pos.stopLossPrice.toFixed(4)}). Zero Risk Moonbag Active!`
                );

                // Call exchange API if credentials configured
                if (state.isVaultConfigured) {
                  fetch('/api/binance', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      action: 'CLOSE_POSITION',
                      credentials: { apiKey: state.apiKey, apiSecret: state.apiSecret, isTestnet: state.isTestnet },
                      payload: { symbol: pos.symbol, positionAmt: pos.positionAmt, quantityToClose: closeQty },
                    }),
                  }).catch(() => {});
                }
              }
            }

            // Check Breakeven+ Stop Loss hit
            if (pos.stopLossPrice) {
              const slHit = isLong ? curPrice <= pos.stopLossPrice : curPrice >= pos.stopLossPrice;
              if (slHit) {
                const remainingQty = absAmt;
                const realizedPnl = isLong
                  ? (curPrice - pos.entryPrice) * remainingQty
                  : (pos.entryPrice - curPrice) * remainingQty;
                state.recordTradePnL(realizedPnl);
                state.addTelemetryLog(
                  pos.symbol,
                  'ORDER',
                  `${pos.isBreakevenLocked ? '🛡️ BREAKEVEN+ HIT' : '🛑 STOP LOSS HIT'}: Closed remaining ${pos.symbol} at $${curPrice} (PnL: ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)})`
                );
                currentPositions.splice(i, 1);
                i--;
                continue;
              }
            }
          }
          set({ positions: currentPositions });

          // Step 3: Determine Coins to Scan
          // Priority: User's customWatchlist -> or dynamically selected Top Liquid / L2s
          let scanQueue = state.customWatchlist.length > 0 ? state.customWatchlist : L2_MODULAR_SYMBOLS;
          // Limit to max 6 coins per scan tick to keep Termux lightning fast
          scanQueue = scanQueue.slice(0, 6);

          // Check concurrent coins limit
          if (currentPositions.length >= state.maxConcurrentCoins) {
            set({ lastScanStatus: `Max Concurrent Trades (${state.maxConcurrentCoins}) reached. Monitoring open locks.` });
            return;
          }

          // Step 4: Scan and Evaluate Signals
          for (const sym of scanQueue) {
            // Skip if already in position
            if (currentPositions.some((p) => p.symbol === sym)) continue;

            const klineRes = await fetch(`/api/binance?action=KLINES&symbol=${sym}&interval=5m&limit=60`);
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

            if (verdict.approved && (verdict.score >= 80)) {
              state.addTelemetryLog(
                sym,
                'SIGNAL',
                `🔥 5-INDICATOR CONFLUENCE [${verdict.score}/100]: ${verdict.side} qualified. SL: $${verdict.stopLossPrice} | TP1: $${verdict.takeProfit1Price}`
              );

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

              const newPos: BinancePosition = {
                symbol: sym,
                positionAmt: verdict.side === 'LONG' ? qtyNum : -qtyNum,
                entryPrice: verdict.entryPrice,
                markPrice: verdict.entryPrice,
                unRealizedProfit: 0,
                liquidationPrice: verdict.side === 'LONG' ? verdict.entryPrice * (1 - 0.9 / lev) : verdict.entryPrice * (1 + 0.9 / lev),
                leverage: lev,
                marginType: state.marginMode === 'ISOLATED' ? 'isolated' : 'cross',
                isolatedMargin: margin,
                initialQuantity: qtyNum,
                partialClosed: false,
                isBreakevenLocked: false,
                takeProfit1Price: verdict.takeProfit1Price,
                stopLossPrice: verdict.stopLossPrice,
                highestPriceSinceEntry: verdict.entryPrice,
                lowestPriceSinceEntry: verdict.entryPrice,
              };

              // Add position
              set((s) => ({ positions: [...s.positions, newPos] }));

              state.addTelemetryLog(
                sym,
                'ORDER',
                `⚡ EXECUTED ${verdict.side} #${sym}: ${formattedQty} coins (Margin: $${margin.toFixed(2)} at ${lev}x ${state.marginMode})`
              );

              // Send live order to Binance if vault configured
              if (state.isVaultConfigured) {
                fetch('/api/binance', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    action: 'ORDER',
                    credentials: { apiKey: state.apiKey, apiSecret: state.apiSecret, isTestnet: state.isTestnet },
                    payload: {
                      symbol: sym,
                      side: verdict.side === 'LONG' ? 'BUY' : 'SELL',
                      type: 'MARKET',
                      quantity: formattedQty,
                    },
                  }),
                }).catch(() => {});
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
        const ticker = state.tickers[symbol];
        const price = ticker?.lastPrice || 1.0;
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

        const newPos: BinancePosition = {
          symbol,
          positionAmt: isLong ? qtyNum : -qtyNum,
          entryPrice: price,
          markPrice: price,
          unRealizedProfit: 0,
          liquidationPrice: isLong ? price * (1 - 0.9 / lev) : price * (1 + 0.9 / lev),
          leverage: lev,
          marginType: state.marginMode === 'ISOLATED' ? 'isolated' : 'cross',
          isolatedMargin: margin,
          initialQuantity: qtyNum,
          partialClosed: false,
          isBreakevenLocked: false,
          takeProfit1Price,
          stopLossPrice,
          highestPriceSinceEntry: price,
          lowestPriceSinceEntry: price,
        };

        set((s) => ({ positions: [...s.positions, newPos] }));

        state.addTelemetryLog(
          symbol,
          'ORDER',
          `MANUAL ${side} ${symbol}: ${formattedQty} coins at $${price} (Margin $${margin.toFixed(2)}, ${lev}x ${state.marginMode})`
        );

        if (state.isVaultConfigured) {
          fetch('/api/binance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'ORDER',
              credentials: { apiKey: state.apiKey, apiSecret: state.apiSecret, isTestnet: state.isTestnet },
              payload: {
                symbol,
                side: isLong ? 'BUY' : 'SELL',
                type: 'MARKET',
                quantity: formattedQty,
              },
            }),
          }).catch(() => {});
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
              credentials: { apiKey: state.apiKey, apiSecret: state.apiSecret, isTestnet: state.isTestnet },
              payload: { symbol, positionAmt: pos.positionAmt, quantityToClose: qty },
            }),
          }).catch(() => {});
        }
      },

      panicCloseAll: async () => {
        const state = get();
        const currentPositions = [...state.positions];
        state.addTelemetryLog('PANIC', 'ORDER', `🚨 PANIC CLOSE ALL: Liquidating ${currentPositions.length} positions!`);

        for (const pos of currentPositions) {
          await state.closePosition(pos.symbol);
        }
        set({ positions: [], isAutoTrading: false });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
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
        walletBalance: state.walletBalance,
      }),
    }
  )
);
