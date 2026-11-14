'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  useBinanceStore,
  getTodayDateString,
  getCoinCategory,
  CoinCategory,
  TargetCategory,
} from '@/store/useBinanceStore';
import { BinanceVaultModal } from './BinanceVaultModal';
import { BinancePnlCalendarModal } from './BinancePnlCalendarModal';
import {
  Search,
  Star,
  ShieldCheck,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Play,
  Square,
  Sliders,
  CheckCircle2,
  Lock,
  Layers,
  ChevronDown,
  X,
  Trash2,
  Terminal,
  BrainCircuit,
  RefreshCw,
  CalendarDays,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react';
import {
  calculateBollingerBands,
  calculateVWAP,
  calculateEMA,
  evaluateCryptoSignal,
  CryptoSignalVerdict,
} from '@/core/cryptoSignalEngine';
import { computeRealTimeKronosForecast } from '@/core/kronosService';
import { Timeframe } from '@/core/indicatorEngine';
import { useTheme } from '@/components/InstitutionalChrome';
import { useRoomStore } from '@/store/useRoomStore';

interface BinanceFuturesRoomProps {
  onSwitchToForex?: () => void;
  isActiveRoom?: boolean;
}

const QUICK_MAJORS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'] as const;

const CATEGORY_BADGE_STYLE: Record<CoinCategory, string> = {
  MEME: 'bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800/60',
  L1: 'bg-sky-50 dark:bg-sky-950/60 text-sky-700 dark:text-sky-400 border-sky-200 dark:border-sky-800/60',
  L2: 'bg-violet-50 dark:bg-violet-950/60 text-violet-700 dark:text-violet-400 border-violet-200 dark:border-violet-800/60',
  ALT: 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-zinc-700',
};

export const BinanceFuturesRoom: React.FC<BinanceFuturesRoomProps> = ({ onSwitchToForex, isActiveRoom = true }) => {
  const { isDark } = useTheme();
  const isForexMaintenance = useRoomStore((s) => s.maintenance.forex);
  const [isMounted, setIsMounted] = useState(false);
  const [isCoinSelectorOpen, setIsCoinSelectorOpen] = useState(false);
  const [isWsLive, setIsWsLive] = useState(false);
  const [kronosCrypto, setKronosCrypto] = useState<{
    symbol: string;
    timeframe: string;
    bullishPct: number;
    bearishPct: number;
    verdict: string;
    multiAiSummary: string;
    pocPrice: number;
    vahPrice: number;
    valPrice: number;
    rsi: number;
    zScore: number;
    regime: string;
    horizonPrice: number;
    signal: 'BUY' | 'SELL' | 'NEUTRAL';
  } | null>(null);
  const lastKronosFetchRef = useRef<{ key: string; ts: number }>({ key: '', ts: 0 });

  // Store selectors
  const allSymbols = useBinanceStore((s) => s.allSymbols);
  const tickers = useBinanceStore((s) => s.tickers);
  const selectedSymbol = useBinanceStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useBinanceStore((s) => s.setSelectedSymbol);
  const selectedCategory = useBinanceStore((s) => s.selectedCategory);
  const setSelectedCategory = useBinanceStore((s) => s.setSelectedCategory);
  const targetCategory = useBinanceStore((s) => s.targetCategory);
  const setTargetCategory = useBinanceStore((s) => s.setTargetCategory);
  const searchQuery = useBinanceStore((s) => s.searchQuery);
  const setSearchQuery = useBinanceStore((s) => s.setSearchQuery);
  const customWatchlist = useBinanceStore((s) => s.customWatchlist);
  const toggleWatchlistCoin = useBinanceStore((s) => s.toggleWatchlistCoin);

  const klines = useBinanceStore((s) => s.klines[s.selectedSymbol] || []);
  const timeframe = useBinanceStore((s) => s.timeframe);
  const setTimeframe = useBinanceStore((s) => s.setTimeframe);

  // Account & Vault
  const activeExchange = useBinanceStore((s) => s.activeExchange || 'BINANCE');
  const walletBalance = useBinanceStore((s) => s.walletBalance);
  const isTestnet = useBinanceStore((s) => s.isTestnet);
  const isVaultConfigured = useBinanceStore((s) => s.isVaultConfigured);
  const openPnlCalendar = useBinanceStore((s) => s.openPnlCalendar);
  const fetchAccountInfo = useBinanceStore((s) => s.fetchAccountInfo);

  // Sizing & Risk
  const marginUsdt = useBinanceStore((s) => s.marginUsdt);
  const setMarginUsdt = useBinanceStore((s) => s.setMarginUsdt);
  const leverage = useBinanceStore((s) => s.leverage);
  const setLeverage = useBinanceStore((s) => s.setLeverage);
  const marginMode = useBinanceStore((s) => s.marginMode);
  const setMarginMode = useBinanceStore((s) => s.setMarginMode);
  const maxConcurrentCoins = useBinanceStore((s) => s.maxConcurrentCoins);
  const setMaxConcurrentCoins = useBinanceStore((s) => s.setMaxConcurrentCoins);

  // Engine
  const isAutoTrading = useBinanceStore((s) => s.isAutoTrading);
  const toggleAutoTrading = useBinanceStore((s) => s.toggleAutoTrading);
  const isScanning = useBinanceStore((s) => s.isScanning);

  // Positions & Telemetry & Trade History
  const positions = useBinanceStore((s) => s.positions);
  const lastVerdict = useBinanceStore((s) => s.lastVerdict);
  const telemetryLogs = useBinanceStore((s) => s.telemetryLogs);
  const clearTelemetry = useBinanceStore((s) => s.clearTelemetry);
  const tradeHistory = useBinanceStore((s) => s.tradeHistory);
  const clearTradeHistory = useBinanceStore((s) => s.clearTradeHistory);
  const dailyPnl = useBinanceStore((s) => s.dailyPnl);
  const dailyPnlHistory = useBinanceStore((s) => s.dailyPnlHistory);
  const closePosition = useBinanceStore((s) => s.closePosition);
  const panicCloseAll = useBinanceStore((s) => s.panicCloseAll);
  const executeManualTrade = useBinanceStore((s) => s.executeManualTrade);

  const [bottomTab, setBottomTab] = useState<'HISTORY' | 'TELEMETRY'>('HISTORY');
  const [historyScope, setHistoryScope] = useState<'TODAY' | 'ALL'>('TODAY');

  const [localVerdict, setLocalVerdict] = useState<CryptoSignalVerdict | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [canvasWidthTick, setCanvasWidthTick] = useState(0);

  // Mount & Polling Effects
  useEffect(() => {
    setIsMounted(true);
    useBinanceStore.getState().loadSavedCredentials();
    if (isActiveRoom || isAutoTrading || (positions && positions.length > 0)) {
      useBinanceStore.getState().fetchSymbolsAndTickers(true);
      useBinanceStore.getState().fetchKlines(useBinanceStore.getState().selectedSymbol);
      useBinanceStore.getState().fetchAccountInfo();
    }

    let tickerInterval: NodeJS.Timeout | null = null;
    let klineInterval: NodeJS.Timeout | null = null;
    let accountInterval: NodeJS.Timeout | null = null;

    const shouldPollCrypto = () => {
      if (isActiveRoom) return true;
      const st = useBinanceStore.getState();
      return Boolean(st.isAutoTrading || (st.positions && st.positions.length > 0));
    };

    const startIntervals = () => {
      if (tickerInterval) clearInterval(tickerInterval);
      if (klineInterval) clearInterval(klineInterval);
      if (accountInterval) clearInterval(accountInterval);

      const curTf = (useBinanceStore.getState().timeframe || 'M5').toUpperCase();
      const klinePollMs = curTf === 'M1' ? 1500 : curTf === 'M5' ? 2000 : 3500;

      tickerInterval = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        if (!shouldPollCrypto()) return;
        useBinanceStore.getState().fetchSymbolsAndTickers();
      }, 2000);

      klineInterval = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        if (!shouldPollCrypto()) return;
        const sym = useBinanceStore.getState().selectedSymbol;
        useBinanceStore.getState().fetchKlines(sym);
      }, klinePollMs);

      accountInterval = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        if (!shouldPollCrypto()) return;
        useBinanceStore.getState().fetchAccountInfo();
      }, 4500);
    };

    const stopIntervals = () => {
      if (tickerInterval) clearInterval(tickerInterval);
      if (klineInterval) clearInterval(klineInterval);
      if (accountInterval) clearInterval(accountInterval);
      tickerInterval = null;
      klineInterval = null;
      accountInterval = null;
    };

    startIntervals();

    const handleVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden) {
        stopIntervals();
      } else {
        if (shouldPollCrypto()) {
          const sym = useBinanceStore.getState().selectedSymbol;
          useBinanceStore.getState().fetchSymbolsAndTickers();
          useBinanceStore.getState().fetchKlines(sym);
          useBinanceStore.getState().fetchAccountInfo();
        }
        setCanvasWidthTick((v) => v + 1);
        startIntervals();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    const handleResize = () => setCanvasWidthTick((v) => v + 1);
    window.addEventListener('resize', handleResize);

    return () => {
      stopIntervals();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('resize', handleResize);
    };
  }, [isActiveRoom]);

  // When room becomes active from background, fetch fresh crypto data immediately
  useEffect(() => {
    if (isActiveRoom) {
      useBinanceStore.getState().fetchSymbolsAndTickers();
      useBinanceStore.getState().fetchKlines(useBinanceStore.getState().selectedSymbol);
      useBinanceStore.getState().fetchAccountInfo();
      setCanvasWidthTick((v) => v + 1);
    }
  }, [isActiveRoom]);

  // Real-time WebSocket K-Line Stream for active Crypto pair & timeframe (M1/M5/M15/H1)
  useEffect(() => {
    if (!isActiveRoom || typeof window === 'undefined' || typeof WebSocket === 'undefined') {
      setIsWsLive(false);
      return;
    }

    let ws: WebSocket | null = null;
    let closedByCleanup = false;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let pingTimer: NodeJS.Timeout | null = null;

    const ex = (activeExchange || 'BINANCE').toUpperCase();
    const tfUpper = (timeframe || 'M5').toUpperCase();
    const binanceTf =
      tfUpper === 'M1' ? '1m' : tfUpper === 'M5' ? '5m' : tfUpper === 'M15' ? '15m' : '1h';
    const bitgetChannel =
      tfUpper === 'M1' ? 'candle1m' : tfUpper === 'M5' ? 'candle5m' : tfUpper === 'M15' ? 'candle15m' : 'candle1H';

    const connectWs = () => {
      if (closedByCleanup) return;
      try {
        if (ex === 'BITGET') {
          ws = new WebSocket('wss://ws.bitget.com/v2/ws/public');
          ws.onopen = () => {
            setIsWsLive(true);
            const cleanInstId = selectedSymbol.replace(/[-_]/g, '').toUpperCase();
            ws?.send(
              JSON.stringify({
                op: 'subscribe',
                args: [{ instType: 'USDT-FUTURES', channel: bitgetChannel, instId: cleanInstId }],
              })
            );
            pingTimer = setInterval(() => {
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send('ping');
              }
            }, 25000);
          };
          ws.onmessage = (evt) => {
            if (evt.data === 'pong') return;
            try {
              const msg = JSON.parse(evt.data);
              if (Array.isArray(msg?.data) && msg.data.length > 0) {
                const row = msg.data[msg.data.length - 1];
                if (Array.isArray(row) && row.length >= 6) {
                  const close = parseFloat(row[4]);
                  if (Number.isFinite(close) && close > 0) {
                    useBinanceStore.getState().upsertLiveKline(
                      selectedSymbol,
                      {
                        timestamp: parseInt(row[0], 10),
                        open: parseFloat(row[1]),
                        high: parseFloat(row[2]),
                        low: parseFloat(row[3]),
                        close,
                        volume: parseFloat(row[5] || '0'),
                      },
                      close
                    );
                  }
                }
              }
            } catch {}
          };
        } else {
          const streamSym = selectedSymbol.toLowerCase();
          const wsHost = isTestnet ? 'wss://stream.binancefuture.com' : 'wss://fstream.binance.com';
          ws = new WebSocket(`${wsHost}/ws/${streamSym}@kline_${binanceTf}`);
          ws.onopen = () => setIsWsLive(true);
          ws.onmessage = (evt) => {
            try {
              const msg = JSON.parse(evt.data);
              const k = msg?.k;
              if (k && typeof k.t === 'number') {
                const close = parseFloat(k.c);
                if (Number.isFinite(close) && close > 0) {
                  useBinanceStore.getState().upsertLiveKline(
                    selectedSymbol,
                    {
                      timestamp: k.t,
                      open: parseFloat(k.o),
                      high: parseFloat(k.h),
                      low: parseFloat(k.l),
                      close,
                      volume: parseFloat(k.v || '0'),
                    },
                    close
                  );
                }
              }
            } catch {}
          };
        }

        ws.onerror = () => {
          setIsWsLive(false);
        };
        ws.onclose = () => {
          setIsWsLive(false);
          if (pingTimer) clearInterval(pingTimer);
          if (!closedByCleanup) {
            reconnectTimer = setTimeout(connectWs, 3000);
          }
        };
      } catch {
        setIsWsLive(false);
      }
    };

    connectWs();

    return () => {
      closedByCleanup = true;
      setIsWsLive(false);
      if (pingTimer) clearInterval(pingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {}
    };
  }, [isActiveRoom, selectedSymbol, timeframe, activeExchange, isTestnet]);

  // Synchronous + Throttled Server Multi-AI + Kronos forecast for active Crypto pair
  const lastKlineClose = klines.length > 0 ? klines[klines.length - 1]?.close : 0;
  useEffect(() => {
    if (!isActiveRoom && !isAutoTrading && (!positions || positions.length === 0)) return;
    if (klines.length < 5) return;
    let cancelled = false;

    const mappedCandles = klines.slice(-100).map((k) => ({
      time: k.timestamp > 1e11 ? Math.floor(k.timestamp / 1000) : k.timestamp,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume,
    }));

    // 1. Immediate synchronous local quantitative forecast (zero lag when switching TF/pair or on WS ticks)
    const localForecast = computeRealTimeKronosForecast({
      symbol: selectedSymbol,
      timeframe: (timeframe || 'M5') as Timeframe,
      candles: klines.slice(-100),
    });
    setKronosCrypto((prev) => {
      const sameContext = prev && prev.symbol === selectedSymbol && prev.timeframe === timeframe;
      return {
        symbol: selectedSymbol,
        timeframe,
        bullishPct: localForecast.bullishPct,
        bearishPct: localForecast.bearishPct,
        verdict: localForecast.verdict,
        multiAiSummary: sameContext && prev.multiAiSummary ? prev.multiAiSummary : localForecast.multiAiSummary,
        pocPrice: localForecast.pocPrice,
        vahPrice: localForecast.vahPrice,
        valPrice: localForecast.valPrice,
        rsi: localForecast.rsi,
        zScore: localForecast.zScore,
        regime: localForecast.regime,
        horizonPrice: localForecast.horizonPrice,
        signal: localForecast.signal,
      };
    });

    // 2. Throttled server /api/kronos sync (max once every 4s per symbol:timeframe, immediate on symbol/TF switch)
    const contextKey = `${selectedSymbol}:${timeframe}`;
    const now = Date.now();
    const shouldFetchServer =
      lastKronosFetchRef.current.key !== contextKey ||
      now - lastKronosFetchRef.current.ts >= 4000;

    if (!shouldFetchServer) {
      return () => {
        cancelled = true;
      };
    }
    lastKronosFetchRef.current = { key: contextKey, ts: now };

    const syncCryptoKronos = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (!isActiveRoom && !useBinanceStore.getState().isAutoTrading && (!useBinanceStore.getState().positions || useBinanceStore.getState().positions.length === 0)) return;
      try {
        const res = await fetch('/api/kronos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: selectedSymbol,
            timeframe,
            candles: mappedCandles,
          }),
        });
        if (!cancelled && res.ok) {
          const data = await res.json();
          if (data.ok || data.success) {
            setKronosCrypto({
              symbol: selectedSymbol,
              timeframe,
              bullishPct: typeof data.bullishPct === 'number' ? data.bullishPct : localForecast.bullishPct,
              bearishPct: typeof data.bearishPct === 'number' ? data.bearishPct : localForecast.bearishPct,
              verdict: data.verdict || localForecast.verdict,
              multiAiSummary:
                data.multiAiSummary ||
                localForecast.multiAiSummary,
              pocPrice: typeof data.pocPrice === 'number' ? data.pocPrice : localForecast.pocPrice,
              vahPrice: typeof data.vahPrice === 'number' ? data.vahPrice : localForecast.vahPrice,
              valPrice: typeof data.valPrice === 'number' ? data.valPrice : localForecast.valPrice,
              rsi: typeof data.rsi === 'number' ? data.rsi : localForecast.rsi,
              zScore: typeof data.zScore === 'number' ? data.zScore : localForecast.zScore,
              regime: data.regime || localForecast.regime,
              horizonPrice: typeof data.horizonPrice === 'number' ? data.horizonPrice : localForecast.horizonPrice,
              signal: data.signal || localForecast.signal,
            });
          }
        }
      } catch {}
    };

    syncCryptoKronos();
    return () => {
      cancelled = true;
    };
  }, [isActiveRoom, isAutoTrading, positions, selectedSymbol, timeframe, lastKlineClose, klines.length]);

  // Compute live local Crypto Quant Verdict preview (no external AI cost) for selected symbol & timeframe
  useEffect(() => {
    if (!isActiveRoom || klines.length < 50) return;
    let cancelled = false;
    evaluateCryptoSignal({
      symbol: selectedSymbol,
      klines,
      timeframe,
      enableAiJudge: false,
    })
      .then((v) => {
        if (!cancelled) setLocalVerdict(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isActiveRoom, selectedSymbol, timeframe, klines]);

  // Background auto-scanner loop
  useEffect(() => {
    if (!isMounted || !isAutoTrading) return;

    let scanInterval: NodeJS.Timeout | null = null;
    const runScanTick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (useBinanceStore.getState().isAutoTrading) {
        useBinanceStore.getState().executeScannerTick();
      }
    };

    runScanTick();
    scanInterval = setInterval(runScanTick, 4000);

    const handleVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden && useBinanceStore.getState().isAutoTrading) {
        runScanTick();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      if (scanInterval) clearInterval(scanInterval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isMounted, isAutoTrading]);

  // Current ticker for selected coin
  const activeTicker = tickers[selectedSymbol] || {
    symbol: selectedSymbol,
    lastPrice: lastKlineClose || 0,
    priceChangePercent: 0,
    highPrice: 0,
    lowPrice: 0,
    volume: 0,
    quoteVolume: 0,
  };

  // Live Floating PnL across open Binance positions
  const totalFloatingPnl = useMemo(() => {
    return positions.reduce((sum, pos) => {
      const isLong = pos.positionAmt > 0;
      const mark = tickers[pos.symbol]?.lastPrice || pos.markPrice || pos.entryPrice;
      const size = Math.abs(pos.positionAmt);
      const pnl = isLong ? (mark - pos.entryPrice) * size : (pos.entryPrice - mark) * size;
      return sum + pnl;
    }, 0);
  }, [positions, tickers]);

  const liveEquity = Number((walletBalance + totalFloatingPnl).toFixed(2));

  // Filtered 300+ symbols list for Search modal
  const filteredSymbols = useMemo(() => {
    let list = allSymbols;

    if (
      selectedCategory === 'MEME' ||
      selectedCategory === 'L1' ||
      selectedCategory === 'L2' ||
      selectedCategory === 'ALT'
    ) {
      list = list.filter((s) => getCoinCategory(s.symbol) === selectedCategory);
    } else if (selectedCategory === 'TOP_MOVERS') {
      list = [...list]
        .sort((a, b) => {
          const changeA = Math.abs(tickers[a.symbol]?.priceChangePercent || 0);
          const changeB = Math.abs(tickers[b.symbol]?.priceChangePercent || 0);
          return changeB - changeA;
        })
        .slice(0, 25);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toUpperCase();
      list = list.filter((s) => s.symbol.includes(q) || s.baseAsset.includes(q));
    }

    return list;
  }, [allSymbols, selectedCategory, searchQuery, tickers]);

  // Quick-pick coins for the active targetCategory above the chart
  const quickPairPills = useMemo(() => {
    if (targetCategory === 'ALL') return [...QUICK_MAJORS];
    const catCoins = allSymbols
      .filter((s) => getCoinCategory(s.symbol) === targetCategory)
      .sort((a, b) => (tickers[b.symbol]?.quoteVolume || 0) - (tickers[a.symbol]?.quoteVolume || 0))
      .slice(0, 5)
      .map((s) => s.symbol);
    return catCoins.length > 0 ? catCoins : [...QUICK_MAJORS];
  }, [allSymbols, targetCategory, tickers]);

  // Unified ALL Telemetry stream
  const unifiedTelemetry = useMemo(() => {
    return telemetryLogs.slice(0, 100);
  }, [telemetryLogs]);

  // Dynamic Notional calculation
  const currentPrice = activeTicker.lastPrice > 0 ? activeTicker.lastPrice : 1.0;
  const notionalUsdt = Number((marginUsdt * leverage).toFixed(2));
  const estimatedCoins = Number(
    (notionalUsdt / currentPrice).toFixed(currentPrice >= 1000 ? 4 : currentPrice >= 10 ? 3 : 2)
  );

  const activeVerdict = lastVerdict[selectedSymbol] || (localVerdict?.symbol === selectedSymbol ? localVerdict : undefined);
  const isKronosMatch =
    kronosCrypto?.symbol === selectedSymbol && kronosCrypto?.timeframe === timeframe;
  const aiBullish = isKronosMatch ? kronosCrypto.bullishPct : 50;
  const aiBearish = 100 - aiBullish;
  const aiVerdict = isKronosMatch ? kronosCrypto.verdict : 'NEUTRAL CONSOLIDATION';
  const aiSummary = isKronosMatch
    ? kronosCrypto.multiAiSummary
    : `Multi-AI Consensus / Risk Governance active on ${selectedSymbol} (${timeframe}).`;
  const aiSignal = isKronosMatch
    ? kronosCrypto.signal
    : activeVerdict?.approved
    ? activeVerdict.side === 'LONG'
      ? 'BUY'
      : 'SELL'
    : 'NEUTRAL';
  const priceDigits = currentPrice < 0.01 ? 7 : currentPrice < 1 ? 5 : currentPrice < 10 ? 4 : currentPrice < 100 ? 3 : 2;

  // Institutional Dark / Light Adaptive HTML5 Canvas Candlestick Renderer
  useEffect(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    const canvas = canvasRef.current;
    if (!canvas || klines.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.parentElement?.clientWidth || 0;
    const height = canvas.parentElement?.clientHeight || 0;
    if (width <= 0 || height <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Institutional Obsidian (Dark) or Crisp White (Light) Surface
    ctx.fillStyle = isDark ? '#09090b' : '#FFFFFF';
    ctx.fillRect(0, 0, width, height);

    const paddingRight = 68;
    const paddingBottom = 24;
    const chartW = Math.max(100, width - paddingRight);
    const chartH = Math.max(120, height - paddingBottom - 12);

    const visibleKlines = klines.slice(Math.max(0, klines.length - 64));
    if (visibleKlines.length === 0) return;

    let minPrice = Infinity;
    let maxPrice = -Infinity;

    for (const k of visibleKlines) {
      if (k.low < minPrice) minPrice = k.low;
      if (k.high > maxPrice) maxPrice = k.high;
    }

    const priceMargin = (maxPrice - minPrice) * 0.1 || minPrice * 0.01;
    minPrice -= priceMargin;
    maxPrice += priceMargin;
    const priceRange = maxPrice - minPrice || 1;

    const getY = (p: number) => chartH - ((p - minPrice) / priceRange) * chartH + 10;
    const barWidth = Math.max(3, (chartW / visibleKlines.length) * 0.68);
    const stepX = chartW / visibleKlines.length;

    // Subtle Institutional Grid Lines
    ctx.strokeStyle = isDark ? 'rgba(148, 163, 184, 0.10)' : '#F1F5F9';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 5; i++) {
      const y = (chartH / 6) * i + 10;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(chartW, y);
      ctx.stroke();

      const pVal = maxPrice - (i / 6) * priceRange;
      ctx.fillStyle = isDark ? '#94a3b8' : '#64748B';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(pVal.toFixed(priceDigits), chartW + 6, y + 3);
    }

    // Right price axis separator
    ctx.strokeStyle = isDark ? '#27272a' : '#E2E8F0';
    ctx.beginPath();
    ctx.moveTo(chartW, 0);
    ctx.lineTo(chartW, height);
    ctx.stroke();

    const closes = visibleKlines.map((k) => k.close);
    const bb = calculateBollingerBands(closes, 20, 2.2);
    const vwap = calculateVWAP(visibleKlines);
    const ema50 = calculateEMA(closes, 50);

    // BB Lower
    ctx.lineWidth = 1;
    ctx.strokeStyle = isDark ? 'rgba(16, 185, 129, 0.45)' : 'rgba(16, 185, 129, 0.35)';
    ctx.beginPath();
    bb.lower.forEach((val, i) => {
      const x = i * stepX + stepX / 2;
      const y = getY(val);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // BB Upper
    ctx.strokeStyle = isDark ? 'rgba(244, 63, 94, 0.45)' : 'rgba(225, 29, 72, 0.35)';
    ctx.beginPath();
    bb.upper.forEach((val, i) => {
      const x = i * stepX + stepX / 2;
      const y = getY(val);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // VWAP
    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    vwap.forEach((val, i) => {
      const x = i * stepX + stepX / 2;
      const y = getY(val);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // EMA 50
    ctx.strokeStyle = isDark ? '#38bdf8' : '#0F172A';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ema50.forEach((val, i) => {
      const x = i * stepX + stepX / 2;
      const y = getY(val);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Candlesticks
    visibleKlines.forEach((k, i) => {
      const isGreen = k.close >= k.open;
      const color = isGreen ? '#10B981' : '#EF4444';
      const x = i * stepX + (stepX - barWidth) / 2;
      const wickX = i * stepX + stepX / 2;

      const yHigh = getY(k.high);
      const yLow = getY(k.low);
      const yOpen = getY(k.open);
      const yClose = getY(k.close);

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(wickX, yHigh);
      ctx.lineTo(wickX, yLow);
      ctx.stroke();

      const topY = Math.min(yOpen, yClose);
      const bodyH = Math.max(1.5, Math.abs(yClose - yOpen));
      ctx.fillStyle = color;
      ctx.fillRect(x, topY, barWidth, bodyH);
    });

    // Kronos POC overlay line when available
    if (kronosCrypto && kronosCrypto.symbol === selectedSymbol && kronosCrypto.pocPrice > 0) {
      const yPoc = getY(kronosCrypto.pocPrice);
      if (yPoc > 14 && yPoc < chartH - 8) {
        ctx.save();
        ctx.setLineDash([2, 4]);
        ctx.strokeStyle = isDark ? 'rgba(148, 163, 184, 0.45)' : 'rgba(15, 23, 42, 0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(chartW * 0.45, yPoc);
        ctx.lineTo(chartW, yPoc);
        ctx.stroke();
        ctx.fillStyle = isDark ? '#cbd5e1' : '#475569';
        ctx.font = '9px ui-monospace, monospace';
        ctx.fillText(
          `POC ${kronosCrypto.pocPrice.toFixed(priceDigits)}`,
          chartW * 0.45 + 4,
          yPoc - 3
        );
        ctx.restore();
      }
    }

    // Live Last Price Line
    const lastClose = visibleKlines[visibleKlines.length - 1].close;
    const lastY = getY(lastClose);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = isDark ? '#38bdf8' : '#0F172A';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, lastY);
    ctx.lineTo(chartW, lastY);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = isDark ? '#0284c7' : '#0F172A';
    ctx.fillRect(chartW + 2, lastY - 8, paddingRight - 4, 16);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 10px ui-monospace, monospace';
    ctx.fillText(lastClose.toFixed(priceDigits), chartW + 5, lastY + 3);
  }, [klines, canvasWidthTick, isDark, kronosCrypto, selectedSymbol, timeframe, priceDigits]);

  const watchlistSymbols =
    customWatchlist.length > 0
      ? customWatchlist.slice(0, 7)
      : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'ARBUSDT', 'SUIUSDT'];

  return (
    <div className="flex-1 flex max-w-[1920px] w-full mx-auto text-[#0F172A] dark:text-slate-100">
      {/* Searchable 300+ Coin Picker Modal */}
      {isCoinSelectorOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 dark:bg-black/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl max-w-lg w-full p-4 sm:p-5 shadow-2xl flex flex-col max-h-[85vh]">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-zinc-800 mb-3">
              <div className="flex items-center gap-2">
                <span className="font-sans font-bold text-sm text-[#0F172A] dark:text-slate-100">
                  Select {activeExchange === 'BITGET' ? 'Bitget' : 'Binance'} USDⓈ-M Perpetual Pair
                </span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/60 font-semibold">
                  300+ PAIRS
                </span>
              </div>
              <button
                type="button"
                onClick={() => setIsCoinSelectorOpen(false)}
                className="text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-100 p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="relative mb-3">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search symbol (BTC, ETH, SOL, ARB, SUI...)"
                className="w-full bg-[#F8FAFC] dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl px-3 py-2.5 pl-9 text-xs font-mono text-[#0F172A] dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none focus:bg-white dark:focus:bg-zinc-900 focus:border-[#0F172A] dark:focus:border-indigo-500"
                autoFocus
              />
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5 pointer-events-none" />
            </div>

            <div className="flex flex-wrap gap-1.5 mb-3 pb-2 border-b border-slate-100 dark:border-zinc-800 text-[11px] font-mono">
              {(
                [
                  { id: 'ALL', label: 'All Pairs' },
                  { id: 'TOP_MOVERS', label: 'Top 25 Vol' },
                  { id: 'MEME', label: 'MEME' },
                  { id: 'L1', label: 'L1' },
                  { id: 'L2', label: 'L2' },
                  { id: 'ALT', label: 'ALT' },
                ] as const
              ).map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setSelectedCategory(cat.id)}
                  className={`px-2.5 py-1 rounded-lg border transition-all cursor-pointer ${
                    selectedCategory === cat.id
                      ? 'bg-[#0F172A] dark:bg-indigo-600 text-white border-[#0F172A] dark:border-indigo-500 font-semibold'
                      : 'bg-slate-50 dark:bg-zinc-950 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-zinc-800 hover:bg-slate-100 dark:hover:bg-zinc-800'
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto space-y-1 font-mono text-xs pr-1">
              {filteredSymbols.map((item) => {
                const t = tickers[item.symbol];
                const change = t?.priceChangePercent ?? 0;
                const price = t?.lastPrice ?? 0;
                const isStarred = customWatchlist.includes(item.symbol);
                const coinCat = getCoinCategory(item.symbol);

                return (
                  <div
                    key={item.symbol}
                    onClick={() => {
                      setSelectedSymbol(item.symbol);
                      setIsCoinSelectorOpen(false);
                    }}
                    className={`p-2.5 rounded-xl flex items-center justify-between cursor-pointer border transition-colors ${
                      selectedSymbol === item.symbol
                        ? 'bg-slate-100 dark:bg-zinc-800 border-slate-300 dark:border-zinc-700 text-[#0F172A] dark:text-slate-100'
                        : 'bg-white dark:bg-zinc-900 border-slate-200/70 dark:border-zinc-800/70 hover:bg-slate-50 dark:hover:bg-zinc-800/60 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleWatchlistCoin(item.symbol);
                        }}
                        className="text-slate-400 hover:text-amber-500 p-0.5 cursor-pointer"
                        title="Toggle Watchlist"
                      >
                        <Star
                          className={`w-3.5 h-3.5 ${
                            isStarred ? 'fill-amber-400 text-amber-500' : ''
                          }`}
                        />
                      </button>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-[#0F172A] dark:text-slate-100">{item.symbol}</span>
                          <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold border ${CATEGORY_BADGE_STYLE[coinCat]}`}>
                            {coinCat}
                          </span>
                        </div>
                        <span className="text-[10px] text-slate-400">
                          Vol: ${(t ? (t.quoteVolume / 1000000).toFixed(1) : '0')}M
                        </span>
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="font-bold text-[#0F172A] dark:text-slate-100">
                        ${price > 0 ? price.toFixed(price < 1 ? 4 : 2) : '---'}
                      </div>
                      <span
                        className={`text-[10px] font-semibold ${
                          change >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                        }`}
                      >
                        {change >= 0 ? '+' : ''}
                        {change.toFixed(2)}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Left Minimalist Watchlist Sidebar on Desktop (Matches Exness Forex Sidebar) */}
      <aside className="hidden xl:flex w-60 border-r border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/90 flex-col justify-between p-4 shrink-0 select-none transition-colors">
        <div className="space-y-6">
          <div className="space-y-1">
            <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400 dark:text-zinc-500 px-2">
              TERMINAL WORKSPACE
            </div>
            <div className="pt-1 space-y-1.5">
              <div className="w-full px-3 py-2.5 rounded-xl bg-[#0F172A] dark:bg-indigo-600 text-white text-xs font-medium flex items-center justify-between shadow-2xs">
                <span className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-emerald-400 dark:text-emerald-300" />
                  <span>Crypto Perpetuals</span>
                </span>
                <span className="w-2 h-2 rounded-full bg-[#10B981] animate-pulse" />
              </div>
              {onSwitchToForex && (
                <button
                  type="button"
                  disabled={isForexMaintenance}
                  aria-disabled={isForexMaintenance}
                  title={isForexMaintenance ? 'Forex Room sedang dalam mode Maintenance (Terkunci)' : undefined}
                  onClick={() => {
                    if (!isForexMaintenance) onSwitchToForex();
                  }}
                  className={`w-full px-3 py-2 rounded-xl border text-xs font-mono font-medium flex items-center justify-between transition-colors ${
                    isForexMaintenance
                      ? 'bg-slate-50 dark:bg-zinc-950/50 border-slate-200/60 dark:border-zinc-800/60 text-slate-400 dark:text-zinc-500 opacity-50 cursor-not-allowed select-none'
                      : 'bg-slate-50 dark:bg-zinc-950 hover:bg-slate-100 dark:hover:bg-zinc-800 border-slate-200/80 dark:border-zinc-800 text-slate-600 dark:text-slate-300 hover:text-[#0F172A] dark:hover:text-slate-100 cursor-pointer'
                  }`}
                >
                  <span>{isForexMaintenance ? 'Forex Maintenance' : 'Switch to Exness Forex'}</span>
                  {isForexMaintenance ? (
                    <Lock className="w-3.5 h-3.5 text-amber-500" />
                  ) : (
                    <ArrowUpRight className="w-3.5 h-3.5 text-slate-400" />
                  )}
                </button>
              )}
            </div>
          </div>

          <div className="space-y-2 pt-4 border-t border-slate-100 dark:border-zinc-800">
            <div className="flex items-center justify-between px-2">
              <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400 dark:text-zinc-500">
                LIVE {activeExchange} FEED
              </span>
              <button
                type="button"
                onClick={() => setIsCoinSelectorOpen(true)}
                className="font-mono text-[10px] text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer font-semibold"
              >
                +300 Pairs
              </button>
            </div>
            <div className="space-y-1.5">
              {watchlistSymbols.map((sym) => {
                const t = tickers[sym];
                const isSel = selectedSymbol === sym;
                const chg = t?.priceChangePercent ?? 0;
                return (
                  <button
                    key={sym}
                    type="button"
                    onClick={() => setSelectedSymbol(sym)}
                    className={`w-full p-2.5 rounded-xl border text-left transition-all cursor-pointer flex items-center justify-between ${
                      isSel
                        ? 'bg-slate-50 dark:bg-zinc-800 border-slate-300 dark:border-zinc-700 shadow-2xs'
                        : 'bg-white dark:bg-zinc-900 border-slate-200/70 dark:border-zinc-800/70 hover:bg-slate-50 dark:hover:bg-zinc-800/60'
                    }`}
                  >
                    <div>
                      <div className="font-mono text-xs font-bold text-[#0F172A] dark:text-slate-100">{sym}</div>
                      <div className="text-[10px] text-slate-400 dark:text-zinc-500 font-mono">
                        Vol: ${t ? (t.quoteVolume / 1000000).toFixed(1) : '0.0'}M
                      </div>
                    </div>
                    <div className="text-right font-mono">
                      <div className="text-xs font-semibold text-[#0F172A] dark:text-slate-100">
                        ${t && t.lastPrice > 0 ? t.lastPrice.toFixed(t.lastPrice < 1 ? 4 : 2) : '---'}
                      </div>
                      <div
                        className={`text-[10px] font-semibold ${
                          chg >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                        }`}
                      >
                        {chg >= 0 ? '+' : ''}
                        {chg.toFixed(2)}%
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="p-3.5 rounded-2xl bg-[#F8FAFC] dark:bg-zinc-950 border border-slate-200/90 dark:border-zinc-800 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
              {activeExchange === 'BITGET' ? 'BITGET V2 SIGNING' : 'BINANCE SIGNING'}
            </span>
            <span
              className={`w-2 h-2 rounded-full ${
                isVaultConfigured ? 'bg-[#10B981] animate-pulse' : 'bg-amber-400'
              }`}
            />
          </div>
          <div className="font-mono text-xs font-bold text-[#0F172A] dark:text-slate-100 truncate">
            {isVaultConfigured
              ? activeExchange === 'BITGET'
                ? isTestnet ? 'Bitget Demo Bound' : 'Bitget Live Bound'
                : isTestnet ? 'Binance Testnet Bound' : 'Binance Live Bound'
              : 'Public Feed (Unbound)'}
          </div>
          <div className="font-mono text-[10px] text-slate-500 dark:text-slate-400 truncate">
            {activeExchange === 'BITGET'
              ? isTestnet ? 'api.bitget.com (Demo V2)' : 'api.bitget.com (Live V2)'
              : isTestnet ? 'testnet.binancefuture.com' : 'fapi.binance.com'}
          </div>
        </div>
      </aside>

      {/* Main Crypto Terminal Content */}
      <main className="flex-1 p-3 sm:p-5 space-y-4 min-w-0">
        {/* TOP STATUS & KPI STRIP */}
        <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* 1. CONSOLIDATED USDT BALANCE & EQUITY */}
          <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-slate-200/90 dark:border-zinc-800 shadow-[0_2px_12px_rgba(15,23,42,0.03)] p-4 flex flex-col justify-between transition-colors">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
                  USDT BALANCE &amp; EQUITY
                </span>
                <span className="bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-200/80 dark:border-emerald-800/60 px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold">
                  {activeExchange === 'BITGET'
                    ? isTestnet ? 'DEMO V2' : 'MAINNET'
                    : isTestnet ? 'TESTNET' : 'MAINNET'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                  Active: <strong className="text-[#0F172A] dark:text-slate-100">{positions.length}/{maxConcurrentCoins}</strong>
                </span>
                <button
                  type="button"
                  onClick={() => fetchAccountInfo()}
                  className="text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-100 cursor-pointer p-0.5"
                  title={`Sync ${activeExchange === 'BITGET' ? 'Bitget' : 'Binance'} Wallet`}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="my-2 flex items-baseline justify-between gap-3">
              <div>
                <div className="text-[10px] font-mono uppercase text-slate-400 dark:text-zinc-500">Wallet Balance</div>
                <div className="font-bold text-[#0F172A] dark:text-slate-100 tracking-tight text-xl sm:text-2xl font-mono">
                  ${Number(walletBalance).toFixed(2)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] font-mono uppercase text-slate-400 dark:text-zinc-500">Live Equity</div>
                <div className="font-bold text-[#0F172A] dark:text-slate-100 tracking-tight text-lg sm:text-xl font-mono">
                  ${liveEquity.toFixed(2)}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 dark:text-slate-400 pt-1.5 border-t border-slate-100 dark:border-zinc-800/80">
              <div className="flex items-center gap-1.5">
                <span>Floating PnL:</span>
                <strong
                  className={
                    totalFloatingPnl >= 0
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-rose-600 dark:text-rose-400'
                  }
                >
                  {totalFloatingPnl >= 0 ? '+' : ''}${totalFloatingPnl.toFixed(2)}
                </strong>
              </div>
              <span className="text-emerald-700 dark:text-emerald-400 font-semibold">24/7 Perpetual</span>
            </div>
          </div>

          {/* 2. BINANCE / BITGET USDⓈ-M GATEWAY */}
          <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-slate-200/90 dark:border-zinc-800 shadow-[0_2px_12px_rgba(15,23,42,0.03)] p-4 flex flex-col justify-between transition-colors">
            <div className="flex items-center justify-between gap-1">
              <span className="font-mono text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
                {activeExchange} GATEWAY
              </span>
              <span
                className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono font-semibold flex items-center gap-1 border ${
                  isVaultConfigured
                    ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border-emerald-200/80 dark:border-emerald-800/60'
                    : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-zinc-700'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    isVaultConfigured ? 'bg-[#10B981] animate-pulse' : 'bg-slate-400'
                  }`}
                />
                {isVaultConfigured ? 'CONNECTED' : 'STANDBY'}
              </span>
            </div>
            <div className="my-1.5">
              <div className="font-mono text-xs font-bold text-[#0F172A] dark:text-slate-100 truncate">
                {activeExchange === 'BITGET'
                  ? isTestnet ? 'api.bitget.com (Demo V2 · paptrading:1)' : 'api.bitget.com (USDT-M V2)'
                  : isTestnet ? 'testnet.binancefuture.com' : 'fapi.binance.com'}
              </div>
              <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                Signing: <strong className="text-emerald-700 dark:text-emerald-400">
                  {activeExchange === 'BITGET' ? 'HMAC-SHA256 + Passphrase' : 'HMAC-SHA256'}
                </strong>
              </div>
            </div>
            <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 dark:text-slate-400 pt-1.5 border-t border-slate-100 dark:border-zinc-800/80">
              <span>Vault: AES-256</span>
              <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
                {isTestnet ? 'Testnet / Demo' : 'Mainnet'}
              </span>
            </div>
          </div>
        </section>

        {/* MAIN CONTENT GRID */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          {/* LEFT / CENTER AREA (8 cols on lg) */}
          <div className="lg:col-span-8 space-y-4 min-w-0">
            {/* LIVE CRYPTO CHART CARD */}
            <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-slate-200/90 dark:border-zinc-800 shadow-[0_2px_12px_rgba(15,23,42,0.03)] p-3 sm:p-4 space-y-3 transition-colors">
              {/* Category Target Filter + Quick Pair Selector Pills + Timeframe Pills */}
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-100 dark:border-zinc-800">
                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="flex items-center gap-1 bg-slate-100 dark:bg-zinc-950 p-1 rounded-xl border border-slate-200/80 dark:border-zinc-800 font-mono text-[10px] mr-1">
                    {(['ALL', 'MEME', 'L1', 'L2', 'ALT'] as const).map((cat) => (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => {
                          setTargetCategory(cat);
                          if (cat !== 'ALL') {
                            const topCatCoin = allSymbols
                              .filter((s) => getCoinCategory(s.symbol) === cat)
                              .sort((a, b) => (tickers[b.symbol]?.quoteVolume || 0) - (tickers[a.symbol]?.quoteVolume || 0))[0];
                            if (topCatCoin) setSelectedSymbol(topCatCoin.symbol);
                          }
                        }}
                        className={`px-2 py-1 rounded-lg font-bold transition-all cursor-pointer ${
                          targetCategory === cat
                            ? 'bg-[#0F172A] dark:bg-indigo-600 text-white shadow-2xs'
                            : 'text-slate-500 dark:text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-100'
                        }`}
                        title={`Filter & Target ${cat === 'ALL' ? 'All Categories' : `${cat} Coins`}`}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>

                  {quickPairPills.map((sym) => {
                    const isActive = selectedSymbol === sym;
                    return (
                      <button
                        key={sym}
                        type="button"
                        onClick={() => setSelectedSymbol(sym)}
                        className={`px-3 py-1.5 rounded-xl font-mono text-xs font-semibold transition-all cursor-pointer ${
                          isActive
                            ? 'bg-[#0F172A] dark:bg-emerald-500/15 text-white dark:text-emerald-300 dark:border dark:border-emerald-500/30 shadow-2xs'
                            : 'bg-slate-50 dark:bg-zinc-950 text-slate-600 dark:text-slate-300 border border-slate-200/80 dark:border-zinc-800 hover:bg-slate-100 dark:hover:bg-zinc-800'
                        }`}
                      >
                        {sym}
                      </button>
                    );
                  })}

                  <button
                    type="button"
                    onClick={() => {
                      if (targetCategory !== 'ALL') setSelectedCategory(targetCategory);
                      setIsCoinSelectorOpen(true);
                    }}
                    className="px-3 py-1.5 rounded-xl font-mono text-xs font-semibold bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 border border-emerald-200/80 dark:border-emerald-800/60 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-all flex items-center gap-1 cursor-pointer"
                  >
                    <span>
                      {quickPairPills.includes(selectedSymbol)
                        ? '300+ Pairs'
                        : selectedSymbol}
                    </span>
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex items-center gap-1 bg-slate-50 dark:bg-zinc-950 p-1 rounded-xl border border-slate-200/80 dark:border-zinc-800 font-mono">
                  {(['M1', 'M5', 'M15', 'H1'] as const).map((tf) => (
                    <button
                      key={tf}
                      type="button"
                      onClick={() => setTimeframe(tf)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                        timeframe === tf
                          ? 'bg-[#0F172A] dark:bg-emerald-500/20 text-white dark:text-emerald-300 shadow-2xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-100'
                      }`}
                    >
                      {tf}
                    </button>
                  ))}
                </div>
              </div>

              {/* Live Price / 24h Change / Indicators / Kronos Strip */}
              <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-[#0F172A] dark:text-slate-100 font-bold inline-flex items-center gap-1.5">
                    <span>
                      {selectedSymbol}: $
                      {activeTicker.lastPrice > 0
                        ? activeTicker.lastPrice.toFixed(activeTicker.lastPrice < 1 ? 4 : 2)
                        : '---'}
                    </span>
                    <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold border ${CATEGORY_BADGE_STYLE[getCoinCategory(selectedSymbol)]}`}>
                      {getCoinCategory(selectedSymbol)}
                    </span>
                  </span>
                  <span
                    className={`px-2.5 py-1 rounded-lg font-semibold border inline-flex items-center gap-1 ${
                      activeTicker.priceChangePercent >= 0
                        ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200/80 dark:border-emerald-800/60 text-emerald-700 dark:text-emerald-400'
                        : 'bg-rose-50 dark:bg-rose-950/60 border-rose-200 dark:border-rose-800/60 text-rose-600 dark:text-rose-400'
                    }`}
                  >
                    {activeTicker.priceChangePercent >= 0 ? (
                      <TrendingUp className="w-3.5 h-3.5" />
                    ) : (
                      <TrendingDown className="w-3.5 h-3.5" />
                    )}
                    <span>
                      {activeTicker.priceChangePercent >= 0 ? '+' : ''}
                      {activeTicker.priceChangePercent.toFixed(2)}%
                    </span>
                  </span>
                  <span className="px-2.5 py-1 rounded-lg bg-slate-50 dark:bg-zinc-800/80 border border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-slate-300">
                    24h Vol: <strong>${(activeTicker.quoteVolume / 1000000).toFixed(1)}M</strong>
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                  <span className="px-2 py-0.5 rounded-md bg-amber-50 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border border-amber-200/80 dark:border-amber-800/60 font-semibold inline-flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                    VWAP
                  </span>
                  <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-zinc-800 text-[#0F172A] dark:text-slate-200 font-semibold inline-flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
                    EMA50
                  </span>
                  <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-300 font-semibold inline-flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    BB 2.2
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded-md font-semibold border inline-flex items-center gap-1 ${
                      isWsLive
                        ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/60'
                        : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-zinc-700'
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        isWsLive ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'
                      }`}
                    />
                    {isWsLive ? 'LIVE WS' : 'REST'}
                  </span>
                  {isKronosMatch && kronosCrypto && kronosCrypto.horizonPrice > 0 && (
                    <span className="px-2 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 border border-indigo-200/80 dark:border-indigo-800/60 font-semibold">
                      Target: ${kronosCrypto.horizonPrice.toFixed(priceDigits)}
                    </span>
                  )}
                  <span
                    className={`px-2 py-0.5 rounded-md font-semibold border ${
                      aiSignal === 'BUY'
                        ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/60'
                        : aiSignal === 'SELL'
                        ? 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800/60'
                        : 'bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-zinc-700'
                    }`}
                  >
                    Kronos: {aiSignal}
                  </span>
                </div>
              </div>

              {/* Clean White-Surface Candlestick Canvas */}
              <div className="w-full relative h-[410px] sm:h-[450px] rounded-xl border border-slate-200/80 dark:border-zinc-800 overflow-hidden bg-white dark:bg-zinc-950">
                <canvas ref={canvasRef} className="w-full h-full block" />
              </div>
            </div>

            {/* ACTIVE FUTURES POSITIONS TABLE */}
            <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-slate-200/90 dark:border-zinc-800 shadow-[0_2px_12px_rgba(15,23,42,0.03)] overflow-hidden transition-colors">
              <div className="px-4 py-3.5 border-b border-slate-200/80 dark:border-zinc-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Layers className="w-4 h-4 text-[#0F172A] dark:text-emerald-400" />
                  <h2 className="font-sans font-bold text-[#0F172A] dark:text-slate-100 tracking-tight text-sm uppercase">
                    Active Futures Positions
                  </h2>
                  <span className="bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-200/80 dark:border-emerald-800/60 px-2.5 py-0.5 rounded-full text-xs font-mono font-semibold">
                    {positions.length}/{maxConcurrentCoins} Open
                  </span>
                </div>

                {positions.length > 0 && (
                  <button
                    type="button"
                    onClick={panicCloseAll}
                    className="bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800/80 text-rose-600 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-900/60 rounded-xl px-3 py-1.5 text-xs font-semibold transition-all cursor-pointer"
                  >
                    Panic Close All
                  </button>
                )}
              </div>

              {positions.length === 0 ? (
                <div className="p-8 text-center space-y-1">
                  <div className="font-mono text-xs text-slate-500 dark:text-slate-400">
                    No open {activeExchange === 'BITGET' ? 'Bitget' : 'Binance'} Futures positions.
                  </div>
                  <p className="text-slate-400 dark:text-zinc-500 text-xs">
                    Toggle START FUTURES AUTO-TRADING or use Manual Market Entry on the right panel.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left font-mono text-xs">
                    <thead className="bg-slate-50/90 dark:bg-zinc-950/80 text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400 border-b border-slate-200/80 dark:border-zinc-800">
                      <tr>
                        <th className="px-3 sm:px-4 py-2.5 whitespace-nowrap">SYMBOL</th>
                        <th className="px-2.5 sm:px-4 py-2.5 whitespace-nowrap">SIDE &amp; LEV</th>
                        <th className="px-2.5 sm:px-4 py-2.5 whitespace-nowrap">SIZE</th>
                        <th className="px-2.5 sm:px-4 py-2.5 whitespace-nowrap">ENTRY -&gt; MARK</th>
                        <th className="px-2.5 sm:px-4 py-2.5 whitespace-nowrap">MARGIN</th>
                        <th className="px-2.5 sm:px-4 py-2.5 whitespace-nowrap">PNL (USDT)</th>
                        <th className="px-2.5 sm:px-4 py-2.5 whitespace-nowrap">ASYMMETRIC LOCK</th>
                        <th className="px-3 sm:px-4 py-2.5 text-right whitespace-nowrap">ACTION</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-zinc-800">
                      {positions.map((pos) => {
                        const isLong = pos.positionAmt > 0;
                        const ticker = tickers[pos.symbol];
                        const mark = ticker?.lastPrice || pos.markPrice || pos.entryPrice;
                        const size = Math.abs(pos.positionAmt);
                        const pnl = isLong
                          ? (mark - pos.entryPrice) * size
                          : (pos.entryPrice - mark) * size;
                        const margin =
                          pos.isolatedMargin > 0
                            ? pos.isolatedMargin
                            : pos.entryPrice > 0 && pos.leverage > 0
                              ? (size * pos.entryPrice) / pos.leverage
                              : 0;
                        const pnlPct = margin > 0 ? (pnl / margin) * 100 : 0;
                        const isProfit = pnl >= 0;

                        return (
                          <tr key={pos.symbol} className="hover:bg-slate-50/80 dark:hover:bg-zinc-800/50 transition-colors">
                            <td className="px-3 sm:px-4 py-3 font-bold text-[#0F172A] dark:text-slate-100 whitespace-nowrap min-w-[96px]">
                              {pos.symbol}
                            </td>
                            <td className="px-2.5 sm:px-4 py-3 whitespace-nowrap">
                              <span
                                className={`inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded text-[10px] font-bold border ${
                                  isLong
                                    ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/60'
                                    : 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800/60'
                                }`}
                              >
                                {isLong ? 'LONG' : 'SHORT'} {pos.leverage}x
                              </span>
                            </td>
                            <td className="px-2.5 sm:px-4 py-3 font-semibold text-[#0F172A] dark:text-slate-100 whitespace-nowrap">{size}</td>
                            <td className="px-2.5 sm:px-4 py-3 text-slate-700 dark:text-slate-300 whitespace-nowrap">
                              ${pos.entryPrice.toFixed(pos.entryPrice < 10 ? 4 : 2)} -&gt;{' '}
                              <strong className="text-[#0F172A] dark:text-slate-100">
                                ${mark.toFixed(mark < 10 ? 4 : 2)}
                              </strong>
                            </td>
                            <td className="px-2.5 sm:px-4 py-3 text-slate-600 dark:text-slate-400 whitespace-nowrap">
                              ${margin.toFixed(2)}
                            </td>
                            <td className="px-2.5 sm:px-4 py-3 whitespace-nowrap">
                              <div
                                className={`font-bold ${
                                  isProfit ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                                }`}
                              >
                                {isProfit ? '+' : ''}${pnl.toFixed(2)} ({isProfit ? '+' : ''}
                                {pnlPct.toFixed(1)}%)
                              </div>
                            </td>
                            <td className="px-2.5 sm:px-4 py-3 whitespace-nowrap">
                              {pos.partialClosed ? (
                                <span className="px-2.5 py-0.5 rounded-full text-[10px] bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800/60 text-emerald-700 dark:text-emerald-400 font-semibold inline-flex items-center gap-1 whitespace-nowrap">
                                  <CheckCircle2 className="w-3 h-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                                  <span>50% Banked (BE+ Locked)</span>
                                </span>
                              ) : (
                                <span className="px-2.5 py-0.5 rounded-full text-[10px] bg-amber-50 dark:bg-amber-950/60 border border-amber-200 dark:border-amber-800/60 text-amber-800 dark:text-amber-300 font-semibold inline-flex items-center gap-1 whitespace-nowrap">
                                  <Lock className="w-3 h-3 shrink-0 text-amber-600 dark:text-amber-400" />
                                  <span>
                                    TP1: $
                                    {pos.takeProfit1Price?.toFixed(pos.entryPrice < 10 ? 4 : 2) ||
                                      '---'}
                                  </span>
                                </span>
                              )}
                            </td>
                            <td className="px-3 sm:px-4 py-3 text-right whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() => closePosition(pos.symbol)}
                                className="bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800/80 text-rose-600 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-900/60 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-all cursor-pointer"
                              >
                                Close
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* RIGHT CONTROL PANEL (4 cols on lg) */}
          <div className="lg:col-span-4 space-y-4">
            <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-slate-200/90 dark:border-zinc-800 shadow-[0_2px_12px_rgba(15,23,42,0.03)] p-5 space-y-5 transition-colors">
              <div className="flex items-center justify-between border-b border-slate-100 dark:border-zinc-800 pb-3.5">
                <div className="flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-[#0F172A] dark:text-emerald-400" />
                  <h2 className="font-sans font-bold text-[#0F172A] dark:text-slate-100 tracking-tight text-sm uppercase">
                    FUTURES EXECUTION CONTROL
                  </h2>
                </div>
                <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-slate-300 font-semibold">
                  {selectedSymbol}
                </span>
              </div>

              {/* Master Auto-Trading Toggle */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={toggleAutoTrading}
                  className={`w-full py-3.5 px-4 rounded-xl font-sans font-bold text-xs sm:text-sm transition-all flex items-center justify-center gap-2 shadow-xs cursor-pointer ${
                    isAutoTrading
                      ? 'bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800/80 text-rose-600 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-900/60'
                      : 'bg-[#0F172A] dark:bg-emerald-600 hover:bg-[#1E293B] dark:hover:bg-emerald-500 text-white'
                  }`}
                >
                  {isAutoTrading ? (
                    <>
                      <Square className="w-4 h-4 fill-current" />
                      <span>STOP AUTO-TRADING</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 fill-current text-emerald-400" />
                      <span>START FUTURES AUTO-TRADING</span>
                    </>
                  )}
                </button>
                <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 dark:text-slate-400 px-1">
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        isAutoTrading ? 'bg-[#10B981] animate-pulse' : 'bg-slate-300 dark:bg-zinc-600'
                      }`}
                    />
                    <span>{isAutoTrading ? 'Multi-Coin Radar Active' : 'Autonomous Scanner Idle'}</span>
                  </span>
                  <span>{isScanning ? 'Scanning...' : 'Cycle: 4.0s'}</span>
                </div>
              </div>

              {/* Target Coin Category Selector (MEME, L1, L2, ALT) */}
              <div className="p-3.5 rounded-xl bg-[#F8FAFC] dark:bg-zinc-950 border border-slate-200/90 dark:border-zinc-800 space-y-2 font-mono text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-sans font-semibold text-slate-600 dark:text-slate-300">
                    Target Coin Category
                  </span>
                  <span className="text-[10px] text-emerald-700 dark:text-emerald-400 font-semibold">
                    {targetCategory === 'ALL' ? 'Watchlist / Majors' : `${targetCategory} Focus`}
                  </span>
                </div>
                <div className="grid grid-cols-5 gap-1">
                  {(['ALL', 'MEME', 'L1', 'L2', 'ALT'] as TargetCategory[]).map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setTargetCategory(cat)}
                      className={`py-1.5 rounded-lg text-[10px] font-bold border transition-all cursor-pointer ${
                        targetCategory === cat
                          ? 'bg-[#0F172A] dark:bg-indigo-600 text-white border-[#0F172A] dark:border-indigo-500'
                          : 'bg-white dark:bg-zinc-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800'
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>

              {/* Position Sizing & Leverage */}
              <div className="p-4 rounded-xl bg-[#F8FAFC] dark:bg-zinc-950 border border-slate-200/90 dark:border-zinc-800 space-y-4 font-mono text-xs">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-slate-500 dark:text-slate-400 font-sans font-medium">
                      Margin / Entry ($ USDT)
                    </label>
                    <span className="font-bold text-[#0F172A] dark:text-slate-100">${marginUsdt.toFixed(2)}</span>
                  </div>
                  <input
                    type="number"
                    step="0.5"
                    min="1"
                    max="500"
                    value={marginUsdt}
                    onChange={(e) => setMarginUsdt(parseFloat(e.target.value) || 3)}
                    className="w-full rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 px-3 py-1.5 font-bold text-[#0F172A] dark:text-slate-100 focus:outline-none focus:border-[#0F172A] dark:focus:border-emerald-500"
                  />
                  <div className="grid grid-cols-5 gap-1.5 pt-1">
                    {[2, 3, 5, 10, 25].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setMarginUsdt(preset)}
                        className={`py-1.5 rounded-lg text-[11px] font-semibold border transition-all cursor-pointer ${
                          marginUsdt === preset
                            ? 'bg-[#0F172A] dark:bg-emerald-600 text-white border-[#0F172A] dark:border-emerald-600'
                            : 'bg-white dark:bg-zinc-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800'
                        }`}
                      >
                        ${preset}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Leverage & Margin Mode */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-slate-500 dark:text-slate-400 font-sans font-medium">
                      Leverage ({leverage}x)
                    </label>
                    <div className="flex gap-1">
                      {(['ISOLATED', 'CROSS'] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setMarginMode(mode)}
                          className={`px-2 py-0.5 rounded text-[10px] font-semibold border cursor-pointer ${
                            marginMode === mode
                              ? 'bg-[#0F172A] dark:bg-emerald-600 text-white border-[#0F172A] dark:border-emerald-600'
                              : 'bg-white dark:bg-zinc-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-zinc-700'
                          }`}
                        >
                          {mode}
                        </button>
                      ))}
                    </div>
                  </div>
                  <input
                    type="range"
                    min="2"
                    max="50"
                    step="1"
                    value={leverage}
                    onChange={(e) => setLeverage(parseInt(e.target.value, 10))}
                    className="w-full accent-[#0F172A] dark:accent-emerald-500 cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-slate-400 dark:text-zinc-500">
                    <span>2x</span>
                    <span>10x</span>
                    <span>25x</span>
                    <span>50x</span>
                  </div>
                </div>

                {/* Max Concurrent Coins */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-slate-500 dark:text-slate-400 font-sans font-medium">
                      Max Concurrent Coins
                    </label>
                    <span className="font-bold text-[#0F172A] dark:text-slate-100">{maxConcurrentCoins} Pairs</span>
                  </div>
                  <div className="grid grid-cols-5 gap-1.5">
                    {[1, 2, 3, 4, 5].map((count) => (
                      <button
                        key={count}
                        type="button"
                        onClick={() => setMaxConcurrentCoins(count)}
                        className={`py-1 rounded-lg text-[11px] font-semibold border transition-all cursor-pointer ${
                          maxConcurrentCoins === count
                            ? 'bg-[#0F172A] dark:bg-emerald-600 text-white border-[#0F172A] dark:border-emerald-600'
                            : 'bg-white dark:bg-zinc-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800'
                        }`}
                      >
                        {count}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Live Notional Preview */}
                <div className="p-3 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-800 space-y-1 text-[11px]">
                  <div className="flex justify-between text-slate-500 dark:text-slate-400">
                    <span>Notional Size:</span>
                    <span className="font-bold text-[#0F172A] dark:text-slate-100">${notionalUsdt.toFixed(2)} USDT</span>
                  </div>
                  <div className="flex justify-between text-slate-500 dark:text-slate-400">
                    <span>Est. {selectedSymbol} Qty:</span>
                    <span className="font-semibold text-emerald-700 dark:text-emerald-400">~{estimatedCoins}</span>
                  </div>
                </div>

                {/* Manual Market Execution */}
                <div className="grid grid-cols-2 gap-2.5 pt-1 font-sans">
                  <button
                    type="button"
                    onClick={() => executeManualTrade(selectedSymbol, 'LONG')}
                    className="bg-[#0F172A] hover:bg-[#1E293B] dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white font-medium rounded-xl px-3 py-2.5 text-xs shadow-xs transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <ArrowUpRight className="w-4 h-4 text-emerald-400 dark:text-white" />
                    <span>LONG (${marginUsdt})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => executeManualTrade(selectedSymbol, 'SHORT')}
                    className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-zinc-800 hover:border-slate-300 dark:hover:border-zinc-600 rounded-xl px-3 py-2.5 text-xs font-medium transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <ArrowDownRight className="w-4 h-4 text-rose-500" />
                    <span>SHORT (${marginUsdt})</span>
                  </button>
                </div>
              </div>
            </div>

            {/* KRONOS & QUANT PREDICTION CARD */}
            <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-slate-200/90 dark:border-zinc-800 shadow-[0_2px_12px_rgba(15,23,42,0.03)] p-4 sm:p-5 space-y-3.5 transition-colors">
              <div className="flex items-center justify-between border-b border-slate-100 dark:border-zinc-800 pb-3">
                <span className="font-mono text-xs uppercase tracking-wider font-bold text-[#0F172A] dark:text-slate-100 flex items-center gap-1.5">
                  <BrainCircuit className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                  KRONOS &amp; QUANT PREDICTION
                </span>
                <span className="bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-200/80 dark:border-emerald-800/60 px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold">
                  {kronosCrypto?.regime || 'MEAN_REVERTING'}
                </span>
              </div>

              {/* Bull / Bear Probability Bar */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between font-mono text-[11px]">
                  <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
                    Bullish: {aiBullish}%
                  </span>
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 font-semibold">
                    {aiVerdict}
                  </span>
                  <span className="text-rose-600 dark:text-rose-400 font-semibold">
                    Bearish: {aiBearish}%
                  </span>
                </div>
                <div className="w-full h-2.5 rounded-full bg-rose-100 dark:bg-rose-950/60 overflow-hidden flex">
                  <div
                    className="h-full bg-[#10B981] transition-all duration-300"
                    style={{ width: `${aiBullish}%` }}
                  />
                </div>
              </div>

              {/* Key Quantitative Metrics Grid */}
              <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
                <div className="p-2 rounded-xl bg-[#F8FAFC] dark:bg-zinc-950 border border-slate-200/80 dark:border-zinc-800">
                  <div className="text-[10px] text-slate-400 dark:text-zinc-500">POC</div>
                  <div className="font-bold text-[#0F172A] dark:text-slate-100 truncate">
                    ${kronosCrypto?.symbol === selectedSymbol ? kronosCrypto.pocPrice.toFixed(priceDigits) : '---'}
                  </div>
                </div>
                <div className="p-2 rounded-xl bg-[#F8FAFC] dark:bg-zinc-950 border border-slate-200/80 dark:border-zinc-800">
                  <div className="text-[10px] text-slate-400 dark:text-zinc-500">RSI / Z-Score</div>
                  <div className="font-bold text-[#0F172A] dark:text-slate-100 truncate">
                    {kronosCrypto?.symbol === selectedSymbol
                      ? `${kronosCrypto.rsi.toFixed(1)} / ${kronosCrypto.zScore >= 0 ? '+' : ''}${kronosCrypto.zScore.toFixed(2)}`
                      : '---'}
                  </div>
                </div>
                <div className="p-2 rounded-xl bg-[#F8FAFC] dark:bg-zinc-950 border border-slate-200/80 dark:border-zinc-800">
                  <div className="text-[10px] text-slate-400 dark:text-zinc-500">QUANT GATE</div>
                  <div
                    className={`font-bold truncate ${
                      activeVerdict?.approved
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {activeVerdict
                      ? `${activeVerdict.score}/${activeVerdict.dynamicThreshold || 65}%`
                      : '---'}
                  </div>
                </div>
              </div>

              {/* Active Setup & Risk Levels */}
              {activeVerdict && (
                <div className="p-2.5 rounded-xl bg-[#F8FAFC] dark:bg-zinc-950 border border-slate-200/80 dark:border-zinc-800 font-mono text-[11px] space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 dark:text-slate-400">Setup Status:</span>
                    <span
                      className={`font-bold ${
                        activeVerdict.approved
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-amber-700 dark:text-amber-400'
                      }`}
                    >
                      {activeVerdict.approved
                        ? `${activeVerdict.side} (${activeVerdict.setupName?.replace('SETUP_', '')})`
                        : 'WAIT / NO SETUP'}
                    </span>
                  </div>
                  {activeVerdict.stopLossPrice > 0 && (
                    <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400">
                      <span>SL: ${activeVerdict.stopLossPrice.toFixed(priceDigits)}</span>
                      <span>TP1 (1R): ${activeVerdict.takeProfit1Price.toFixed(priceDigits)}</span>
                      <span>TP2: ${activeVerdict.takeProfit2Price.toFixed(priceDigits)}</span>
                    </div>
                  )}
                </div>
              )}

              <div className="p-3 rounded-xl bg-[#F8FAFC] dark:bg-zinc-950 border border-slate-200/80 dark:border-zinc-800 space-y-1">
                <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400 dark:text-zinc-500 font-semibold flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                  <span>MULTI-AI RISK GOVERNANCE</span>
                </div>
                <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed font-mono line-clamp-3">
                  {aiSummary}
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* BOTTOM CARD: UNIFIED PNL & ENTRY HISTORY + LIVE EXECUTION TELEMETRY */}
        {(() => {
          const todayStr = getTodayDateString();
          const todayRecord = dailyPnlHistory[todayStr];
          const todayRealizedPnl = todayRecord?.pnl ?? dailyPnl ?? 0;
          const todayTradesCount = todayRecord?.trades ?? 0;
          const allDays = Object.values(dailyPnlHistory || {});
          const totalRealizedPnl = allDays.reduce((sum, d) => sum + (d?.pnl ?? 0), 0);
          const totalWins = allDays.reduce((sum, d) => sum + (d?.wins ?? 0), 0);
          const totalLosses = allDays.reduce((sum, d) => sum + (d?.losses ?? 0), 0);
          const totalClosed = totalWins + totalLosses;
          const winRate = totalClosed > 0 ? ((totalWins / totalClosed) * 100).toFixed(1) : '0.0';
          const filteredHistory =
            historyScope === 'TODAY'
              ? tradeHistory.filter((h) => h.date === todayStr)
              : tradeHistory;

          return (
            <section className="bg-white dark:bg-zinc-900 rounded-2xl border border-slate-200/90 dark:border-zinc-800 shadow-[0_2px_12px_rgba(15,23,42,0.03)] overflow-hidden transition-colors">
              <div className="px-4 py-3 border-b border-slate-200/80 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-1 bg-slate-100 dark:bg-zinc-950 p-1 rounded-xl border border-slate-200/80 dark:border-zinc-800 font-mono text-[11px]">
                    <button
                      type="button"
                      onClick={() => setBottomTab('HISTORY')}
                      className={`px-2.5 py-1 rounded-lg font-semibold transition-all cursor-pointer ${
                        bottomTab === 'HISTORY'
                          ? 'bg-[#0F172A] dark:bg-emerald-600 text-white shadow-2xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-100'
                      }`}
                    >
                      PNL &amp; ENTRY HISTORY ({filteredHistory.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setBottomTab('TELEMETRY')}
                      className={`px-2.5 py-1 rounded-lg font-semibold transition-all cursor-pointer ${
                        bottomTab === 'TELEMETRY'
                          ? 'bg-[#0F172A] dark:bg-emerald-600 text-white shadow-2xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-100'
                      }`}
                    >
                      TELEMETRY ({unifiedTelemetry.length})
                    </button>
                  </div>

                  {/* PnL Calendar Modal Trigger */}
                  <button
                    type="button"
                    onClick={openPnlCalendar}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-mono font-semibold border inline-flex items-center gap-1.5 cursor-pointer transition-colors ${
                      todayRealizedPnl >= 0
                        ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/60 hover:bg-emerald-100 dark:hover:bg-emerald-900/50'
                        : 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800/60 hover:bg-rose-100 dark:hover:bg-rose-900/50'
                    }`}
                    title="Open Monthly PnL Calendar"
                  >
                    <CalendarDays className="w-3 h-3" />
                    <span>PnL Calendar</span>
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  {bottomTab === 'HISTORY' ? (
                    <>
                      <div className="flex items-center gap-1 bg-slate-50 dark:bg-zinc-950 p-0.5 rounded-lg border border-slate-200 dark:border-zinc-800 font-mono text-[10px]">
                        <button
                          type="button"
                          onClick={() => setHistoryScope('TODAY')}
                          className={`px-2 py-0.5 rounded-md font-semibold cursor-pointer ${
                            historyScope === 'TODAY'
                              ? 'bg-[#0F172A] dark:bg-emerald-600 text-white'
                              : 'text-slate-500 dark:text-slate-400'
                          }`}
                        >
                          TODAY
                        </button>
                        <button
                          type="button"
                          onClick={() => setHistoryScope('ALL')}
                          className={`px-2 py-0.5 rounded-md font-semibold cursor-pointer ${
                            historyScope === 'ALL'
                              ? 'bg-[#0F172A] dark:bg-emerald-600 text-white'
                              : 'text-slate-500 dark:text-slate-400'
                          }`}
                        >
                          ALL
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={clearTradeHistory}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                        title="Clear Entry History"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={clearTelemetry}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                      title="Clear Telemetry Logs"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {bottomTab === 'HISTORY' && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 px-4 py-2.5 bg-slate-50/70 dark:bg-zinc-950/60 border-b border-slate-200/80 dark:border-zinc-800 font-mono text-xs">
                  <div className="flex flex-col">
                    <span className="text-[10px] uppercase text-slate-400 dark:text-zinc-500">Today Realized PnL</span>
                    <span className={`font-bold ${todayRealizedPnl >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                      {todayRealizedPnl >= 0 ? '+' : ''}${todayRealizedPnl.toFixed(2)}{' '}
                      <span className="text-[10px] font-normal text-slate-400">({todayTradesCount}t)</span>
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[10px] uppercase text-slate-400 dark:text-zinc-500">Total Realized PnL</span>
                    <span className={`font-bold ${totalRealizedPnl >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                      {totalRealizedPnl >= 0 ? '+' : ''}${totalRealizedPnl.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[10px] uppercase text-slate-400 dark:text-zinc-500">Win Rate</span>
                    <span className="font-bold text-[#0F172A] dark:text-slate-100">
                      {winRate}% <span className="text-[10px] font-normal text-slate-400">({totalWins}W/{totalLosses}L)</span>
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[10px] uppercase text-slate-400 dark:text-zinc-500">Floating PnL</span>
                    <span className={`font-bold ${totalFloatingPnl >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                      {totalFloatingPnl >= 0 ? '+' : ''}${totalFloatingPnl.toFixed(2)}
                    </span>
                  </div>
                </div>
              )}

              {bottomTab === 'HISTORY' ? (
                <div className="max-h-72 overflow-y-auto font-mono text-xs">
                  {filteredHistory.length === 0 ? (
                    <div className="p-6 text-center text-slate-400 dark:text-zinc-500">
                      No recorded {historyScope === 'TODAY' ? "today's " : ''}crypto entry or exit logs yet. Entries and realized PnL will appear here and sync automatically with Daily PnL.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left">
                        <thead className="bg-slate-50/90 dark:bg-zinc-950/80 text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 border-b border-slate-200/80 dark:border-zinc-800">
                          <tr>
                            <th className="px-4 py-2">TIME</th>
                            <th className="px-4 py-2">PAIR</th>
                            <th className="px-4 py-2">SIDE / LEV</th>
                            <th className="px-4 py-2">ACTION</th>
                            <th className="px-4 py-2">PRICE (ENTRY -&gt; EXIT)</th>
                            <th className="px-4 py-2">QTY / MARGIN</th>
                            <th className="px-4 py-2 text-right">REALIZED PNL</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-zinc-800">
                          {filteredHistory.map((item) => {
                            const timeStr = isMounted
                              ? new Date(item.timestamp).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                  second: '2-digit',
                                })
                              : '';
                            const pxDigits =
                              item.entryPrice < 0.01 ? 7 : item.entryPrice < 1 ? 5 : item.entryPrice < 10 ? 4 : 2;
                            const hasPnl = typeof item.realizedPnl === 'number';
                            const isWin = (item.realizedPnl ?? 0) >= 0;
                            const isOpen = item.action === 'OPEN_AUTO' || item.action === 'OPEN_MANUAL';

                            return (
                              <tr
                                key={item.id}
                                className="hover:bg-slate-50/80 dark:hover:bg-zinc-800/50 transition-colors"
                              >
                                <td className="px-4 py-2.5 text-slate-400 dark:text-zinc-500 whitespace-nowrap">
                                  <div>{timeStr}</div>
                                  <div className="text-[10px]">{item.date}</div>
                                </td>
                                <td className="px-4 py-2.5 font-bold text-[#0F172A] dark:text-slate-100 whitespace-nowrap">
                                  <div>{item.symbol}</div>
                                  <div className="text-[10px] font-normal text-slate-400">{item.exchange}</div>
                                </td>
                                <td className="px-4 py-2.5 whitespace-nowrap">
                                  <span
                                    className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                                      item.side === 'LONG'
                                        ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/60'
                                        : 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800/60'
                                    }`}
                                  >
                                    {item.side} {item.leverage}x
                                  </span>
                                </td>
                                <td className="px-4 py-2.5 whitespace-nowrap">
                                  <span
                                    className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
                                      isOpen
                                        ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-700 dark:text-sky-400 border-sky-200 dark:border-sky-800/60'
                                        : hasPnl && isWin
                                        ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/60'
                                        : 'bg-amber-50 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800/60'
                                    }`}
                                  >
                                    {item.action.replace('_', ' ')}
                                  </span>
                                  {item.note && (
                                    <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-0.5 max-w-[180px] truncate" title={item.note}>
                                      {item.note}
                                    </div>
                                  )}
                                </td>
                                <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300 whitespace-nowrap">
                                  ${item.entryPrice.toFixed(pxDigits)}
                                  {item.exitPrice ? (
                                    <>
                                      {' -> '}
                                      <strong className="text-[#0F172A] dark:text-slate-100">
                                        ${item.exitPrice.toFixed(pxDigits)}
                                      </strong>
                                    </>
                                  ) : (
                                    <span className="text-slate-400"> (OPEN)</span>
                                  )}
                                </td>
                                <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300 whitespace-nowrap">
                                  {item.quantity} · ${item.marginUsdt.toFixed(2)}
                                </td>
                                <td className="px-4 py-2.5 text-right font-bold whitespace-nowrap">
                                  {hasPnl ? (
                                    <span
                                      className={
                                        isWin
                                          ? 'text-emerald-700 dark:text-emerald-400'
                                          : 'text-rose-600 dark:text-rose-400'
                                      }
                                    >
                                      {isWin ? '+' : ''}${item.realizedPnl!.toFixed(2)}
                                    </span>
                                  ) : (
                                    <span className="text-slate-400 dark:text-zinc-500 font-normal">ACTIVE</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ) : (
                <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 dark:divide-zinc-800 font-mono text-xs">
                  {unifiedTelemetry.length === 0 ? (
                    <div className="p-6 text-center text-slate-400 dark:text-zinc-500">
                      [SYSTEM] {activeExchange === 'BITGET' ? 'Bitget' : 'Binance'} Futures Execution Telemetry active for {selectedSymbol}. Waiting for scanner or manual execution event...
                    </div>
                  ) : (
                    unifiedTelemetry.map((log) => {
                      const timeStr = isMounted ? new Date(log.timestamp).toLocaleTimeString() : '';
                      const badgeStyle =
                        log.category === 'LOCK' || log.category === 'ORDER'
                          ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/60'
                          : log.category === 'SIGNAL'
                          ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-700 dark:text-sky-400 border-sky-200 dark:border-sky-800/60'
                          : log.category === 'AI'
                          ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800/60'
                          : log.category === 'GUARD'
                          ? 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800/60'
                          : 'bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-zinc-700';

                      return (
                        <div
                          key={log.id}
                          className="px-4 py-2 hover:bg-slate-50/80 dark:hover:bg-zinc-800/50 flex items-start gap-2.5 leading-relaxed transition-colors"
                        >
                          <span className="text-slate-400 dark:text-zinc-500 shrink-0">[{timeStr}]</span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border shrink-0 ${badgeStyle}`}
                          >
                            [{log.category}]
                          </span>
                          <span className="font-semibold text-[#0F172A] dark:text-slate-100 shrink-0">[{log.symbol}]</span>
                          <span className="text-slate-600 dark:text-slate-300 break-all">{log.message}</span>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </section>
          );
        })()}
      </main>

      {/* Crypto Exchange Credentials & PnL Modals (Strictly NO AI/VPS Client Config) */}
      <BinanceVaultModal />
      <BinancePnlCalendarModal />
    </div>
  );
};

export default BinanceFuturesRoom;
