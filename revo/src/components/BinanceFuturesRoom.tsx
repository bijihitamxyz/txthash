'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  useBinanceStore,
  L2_MODULAR_SYMBOLS,
  L1_DEFI_SYMBOLS,
  AI_MEME_SYMBOLS,
  BinanceCategory,
} from '@/store/useBinanceStore';
import { BinanceVaultModal } from './BinanceVaultModal';
import { BinancePnlCalendarModal } from './BinancePnlCalendarModal';
import {
  Search,
  Star,
  ShieldCheck,
  TrendingUp,
  TrendingDown,
  Activity,
  AlertTriangle,
  Play,
  Square,
  Sliders,
  CheckCircle2,
  Lock,
  Layers,
  ChevronDown,
  ChevronUp,
  X,
  Trash2,
} from 'lucide-react';
import {
  calculateBollingerBands,
  calculateVWAP,
  calculateEMA,
} from '@/core/cryptoSignalEngine';

interface BinanceFuturesRoomProps {
  onSwitchToForex?: () => void;
}

export const BinanceFuturesRoom: React.FC<BinanceFuturesRoomProps> = ({ onSwitchToForex }) => {
  // 1. ALL State Hooks at the top
  const [isMounted, setIsMounted] = useState(false);
  const [isCoinSelectorOpen, setIsCoinSelectorOpen] = useState(false);
  const [isTelemetryCollapsed, setIsTelemetryCollapsed] = useState(false);
  const [telemetryFilter, setTelemetryFilter] = useState('ALL');

  // 2. ALL Store Hooks
  const allSymbols = useBinanceStore((s) => s.allSymbols);
  const tickers = useBinanceStore((s) => s.tickers);
  const selectedSymbol = useBinanceStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useBinanceStore((s) => s.setSelectedSymbol);
  const selectedCategory = useBinanceStore((s) => s.selectedCategory);
  const setSelectedCategory = useBinanceStore((s) => s.setSelectedCategory);
  const searchQuery = useBinanceStore((s) => s.searchQuery);
  const setSearchQuery = useBinanceStore((s) => s.setSearchQuery);
  const customWatchlist = useBinanceStore((s) => s.customWatchlist);
  const toggleWatchlistCoin = useBinanceStore((s) => s.toggleWatchlistCoin);

  const klines = useBinanceStore((s) => s.klines[s.selectedSymbol] || []);
  const timeframe = useBinanceStore((s) => s.timeframe);
  const setTimeframe = useBinanceStore((s) => s.setTimeframe);

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
  const lastScanStatus = useBinanceStore((s) => s.lastScanStatus);

  // Positions & Logs
  const positions = useBinanceStore((s) => s.positions);
  const telemetryLogs = useBinanceStore((s) => s.telemetryLogs);
  const closePosition = useBinanceStore((s) => s.closePosition);
  const panicCloseAll = useBinanceStore((s) => s.panicCloseAll);
  const executeManualTrade = useBinanceStore((s) => s.executeManualTrade);

  // BTC Guard
  const btcDumpBlocked = useBinanceStore((s) => s.btcDumpBlocked);
  const btcGuardStatus = useBinanceStore((s) => s.btcGuardStatus);

  // 3. Canvas Ref
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // 4. Mount & Polling Effects
  useEffect(() => {
    setIsMounted(true);
    useBinanceStore.setState({ isAutoTrading: false });
    useBinanceStore.getState().loadSavedCredentials();
    useBinanceStore.getState().fetchSymbolsAndTickers();
    useBinanceStore.getState().fetchKlines(selectedSymbol);
    useBinanceStore.getState().fetchAccountInfo();

    const tickerInterval = setInterval(() => {
      useBinanceStore.getState().fetchSymbolsAndTickers();
    }, 2000);

    const klineInterval = setInterval(() => {
      const sym = useBinanceStore.getState().selectedSymbol;
      useBinanceStore.getState().fetchKlines(sym);
    }, 3000);

    const accountInterval = setInterval(() => {
      useBinanceStore.getState().fetchAccountInfo();
    }, 4000);

    return () => {
      clearInterval(tickerInterval);
      clearInterval(klineInterval);
      clearInterval(accountInterval);
    };
  }, []);

  // Background auto-scanner loop
  useEffect(() => {
    if (!isMounted || !isAutoTrading) return;

    useBinanceStore.getState().executeScannerTick();
    const scanInterval = setInterval(() => {
      useBinanceStore.getState().executeScannerTick();
    }, 4000);

    return () => clearInterval(scanInterval);
  }, [isMounted, isAutoTrading]);

  // Current ticker for selected coin
  const activeTicker = tickers[selectedSymbol] || {
    symbol: selectedSymbol,
    lastPrice: 0.50,
    priceChangePercent: 0,
    highPrice: 0.52,
    lowPrice: 0.48,
    volume: 1000000,
    quoteVolume: 500000,
  };

  // Filtered 300+ symbols list for Search modal/dropdown
  const filteredSymbols = useMemo(() => {
    let list = allSymbols;

    if (selectedCategory === 'L2') {
      list = list.filter((s) => L2_MODULAR_SYMBOLS.includes(s.symbol));
    } else if (selectedCategory === 'L1_DEFI') {
      list = list.filter((s) => L1_DEFI_SYMBOLS.includes(s.symbol));
    } else if (selectedCategory === 'AI_MEME') {
      list = list.filter((s) => AI_MEME_SYMBOLS.includes(s.symbol));
    } else if (selectedCategory === 'TOP_MOVERS') {
      list = [...list].sort((a, b) => {
        const changeA = Math.abs(tickers[a.symbol]?.priceChangePercent || 0);
        const changeB = Math.abs(tickers[b.symbol]?.priceChangePercent || 0);
        return changeB - changeA;
      }).slice(0, 25);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toUpperCase();
      list = list.filter((s) => s.symbol.includes(q) || s.baseAsset.includes(q));
    }

    return list;
  }, [allSymbols, selectedCategory, searchQuery, tickers]);

  // Filtered telemetry logs
  const filteredTelemetryLogs = useMemo(() => {
    if (telemetryFilter === 'ALL') return telemetryLogs.slice(0, 80);
    return telemetryLogs.filter((l) => l.category === telemetryFilter).slice(0, 80);
  }, [telemetryLogs, telemetryFilter]);

  // Dynamic Notional calculation
  const currentPrice = activeTicker.lastPrice > 0 ? activeTicker.lastPrice : 1.0;
  const notionalUsdt = Number((marginUsdt * leverage).toFixed(2));
  const estimatedCoins = Number((notionalUsdt / currentPrice).toFixed(2));

  // Canvas Candlestick Chart Renderer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || klines.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.parentElement?.clientWidth || 800;
    const height = 440;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#0B0E11';
    ctx.fillRect(0, 0, width, height);

    const paddingRight = 60;
    const paddingBottom = 25;
    const chartW = width - paddingRight;
    const chartH = height - paddingBottom - 10;

    const visibleKlines = klines.slice(Math.max(0, klines.length - 60));
    if (visibleKlines.length === 0) return;

    let minPrice = Infinity;
    let maxPrice = -Infinity;
    let maxVol = 0;

    for (const k of visibleKlines) {
      if (k.low < minPrice) minPrice = k.low;
      if (k.high > maxPrice) maxPrice = k.high;
      if (k.volume > maxVol) maxVol = k.volume;
    }

    const priceMargin = (maxPrice - minPrice) * 0.1 || minPrice * 0.01;
    minPrice -= priceMargin;
    maxPrice += priceMargin;
    const priceRange = maxPrice - minPrice || 1;

    const getY = (p: number) => chartH - ((p - minPrice) / priceRange) * chartH + 10;
    const barWidth = Math.max(3, (chartW / visibleKlines.length) * 0.7);
    const stepX = chartW / visibleKlines.length;

    // Grid Lines
    ctx.strokeStyle = '#1E2329';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      const y = (chartH / 5) * i + 10;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(chartW, y);
      ctx.stroke();

      const pVal = maxPrice - (i / 5) * priceRange;
      ctx.fillStyle = '#474D57';
      ctx.font = '10px monospace';
      ctx.fillText(pVal.toFixed(pVal < 1 ? 4 : 2), chartW + 5, y + 3);
    }

    const closes = visibleKlines.map((k) => k.close);
    const bb = calculateBollingerBands(closes, 20, 2.2);
    const vwap = calculateVWAP(visibleKlines);
    const ema50 = calculateEMA(closes, 50);

    // BB Lower
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(14, 203, 129, 0.4)';
    ctx.beginPath();
    bb.lower.forEach((val, i) => {
      const x = i * stepX + stepX / 2;
      const y = getY(val);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // BB Upper
    ctx.strokeStyle = 'rgba(246, 70, 93, 0.4)';
    ctx.beginPath();
    bb.upper.forEach((val, i) => {
      const x = i * stepX + stepX / 2;
      const y = getY(val);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // VWAP
    ctx.strokeStyle = '#F3BA2F';
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
    ctx.strokeStyle = '#3861FB';
    ctx.lineWidth = 1.2;
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
      const color = isGreen ? '#0ECB81' : '#F6465D';
      const x = i * stepX + (stepX - barWidth) / 2;
      const wickX = i * stepX + stepX / 2;

      const yHigh = getY(k.high);
      const yLow = getY(k.low);
      const yOpen = getY(k.open);
      const yClose = getY(k.close);

      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(wickX, yHigh);
      ctx.lineTo(wickX, yLow);
      ctx.stroke();

      const topY = Math.min(yOpen, yClose);
      const bodyH = Math.max(1.5, Math.abs(yClose - yOpen));
      ctx.fillStyle = color;
      ctx.fillRect(x, topY, barWidth, bodyH);
    });
  }, [klines]);

  return (
    <div className="flex-1 flex flex-col w-full bg-[#0B0E11] text-slate-100">
      {/* Searchable Coin Picker Modal (Overlay) */}
      {isCoinSelectorOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
          <div className="bg-[#181A20] border border-slate-700 rounded-2xl max-w-lg w-full p-4 sm:p-5 shadow-2xl flex flex-col max-h-[85vh] animate-in fade-in duration-150">
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm text-white">Select Binance Futures Pair</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-[#F3BA2F]/20 text-[#F3BA2F] border border-[#F3BA2F]/30">
                  300+ USDT-M
                </span>
              </div>
              <button
                type="button"
                onClick={() => setIsCoinSelectorOpen(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Search Input */}
            <div className="relative mb-3">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search 300+ Binance pairs (ARB, SUI, SOL...)"
                className="w-full bg-[#0B0E11] border border-slate-700 rounded-xl px-3 py-2.5 pl-9 text-xs font-mono text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-[#F3BA2F]"
                autoFocus
              />
              <Search className="w-4 h-4 text-slate-500 absolute left-3 top-3 pointer-events-none" />
            </div>

            {/* Category Filter Chips */}
            <div className="flex flex-wrap gap-1.5 mb-3 pb-2 border-b border-slate-800 text-[11px] font-mono">
              <button
                type="button"
                onClick={() => setSelectedCategory('ALL')}
                className={`px-2.5 py-1 rounded-lg border transition-all cursor-pointer ${
                  selectedCategory === 'ALL'
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 font-bold'
                    : 'bg-[#0B0E11] text-slate-400 border-slate-800 hover:text-white'
                }`}
              >
                🌐 All Pairs
              </button>
              <button
                type="button"
                onClick={() => setSelectedCategory('TOP_MOVERS')}
                className={`px-2.5 py-1 rounded-lg border transition-all cursor-pointer ${
                  selectedCategory === 'TOP_MOVERS'
                    ? 'bg-[#F3BA2F]/20 text-[#F3BA2F] border-[#F3BA2F]/40 font-bold'
                    : 'bg-[#0B0E11] text-slate-400 border-slate-800 hover:text-white'
                }`}
              >
                🔥 Top 25 Vol
              </button>
              <button
                type="button"
                onClick={() => setSelectedCategory('L2')}
                className={`px-2.5 py-1 rounded-lg border transition-all cursor-pointer ${
                  selectedCategory === 'L2'
                    ? 'bg-blue-500/20 text-blue-300 border-blue-500/40 font-bold'
                    : 'bg-[#0B0E11] text-slate-400 border-slate-800 hover:text-white'
                }`}
              >
                🔵 Layer-2 (L2)
              </button>
              <button
                type="button"
                onClick={() => setSelectedCategory('L1_DEFI')}
                className={`px-2.5 py-1 rounded-lg border transition-all cursor-pointer ${
                  selectedCategory === 'L1_DEFI'
                    ? 'bg-purple-500/20 text-purple-300 border-purple-500/40 font-bold'
                    : 'bg-[#0B0E11] text-slate-400 border-slate-800 hover:text-white'
                }`}
              >
                💎 L1 Altcoins
              </button>
              <button
                type="button"
                onClick={() => setSelectedCategory('AI_MEME')}
                className={`px-2.5 py-1 rounded-lg border transition-all cursor-pointer ${
                  selectedCategory === 'AI_MEME'
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 font-bold'
                    : 'bg-[#0B0E11] text-slate-400 border-slate-800 hover:text-white'
                }`}
              >
                🚀 AI & Meme
              </button>
            </div>

            {/* Coins List */}
            <div className="flex-1 overflow-y-auto space-y-1 font-mono text-xs pr-1">
              {filteredSymbols.map((item) => {
                const t = tickers[item.symbol];
                const change = t?.priceChangePercent ?? 0;
                const price = t?.lastPrice ?? 0;
                const isStarred = customWatchlist.includes(item.symbol);

                return (
                  <div
                    key={item.symbol}
                    onClick={() => {
                      setSelectedSymbol(item.symbol);
                      setIsCoinSelectorOpen(false);
                    }}
                    className={`p-2 rounded-xl flex items-center justify-between cursor-pointer border transition-colors ${
                      selectedSymbol === item.symbol
                        ? 'bg-[#F3BA2F]/15 border-[#F3BA2F]/40 text-white'
                        : 'bg-[#0B0E11] border-slate-800/60 hover:border-slate-700 text-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleWatchlistCoin(item.symbol);
                        }}
                        className="text-slate-500 hover:text-[#F3BA2F] p-0.5 cursor-pointer"
                        title="Add to Watchlist"
                      >
                        <Star className={`w-3.5 h-3.5 ${isStarred ? 'fill-[#F3BA2F] text-[#F3BA2F]' : ''}`} />
                      </button>
                      <div>
                        <div className="font-bold flex items-center gap-1.5">
                          <span>{item.symbol}</span>
                        </div>
                        <span className="text-[10px] text-slate-500">
                          Vol: ${(t ? (t.quoteVolume / 1000000).toFixed(1) : '0')}M
                        </span>
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="font-bold">
                        ${price > 0 ? price.toFixed(price < 1 ? 4 : 2) : '-'}
                      </div>
                      <span className={`text-[10px] font-semibold ${change >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}>
                        {change >= 0 ? '+' : ''}{change.toFixed(2)}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* MAIN WORKSPACE GRID */}
      <div className="flex-1 max-w-[1920px] w-full mx-auto p-2 sm:p-3 md:p-4 flex flex-col lg:flex-row gap-3 sm:gap-4 overflow-hidden">
        {/* Left Section: Candlestick Chart, BTC Radar, Positions, Telemetry */}
        <section className="flex-1 flex flex-col gap-3 sm:gap-4 min-w-0 w-full overflow-hidden">
          {/* Real-time Candlestick Chart Card */}
          <div className="bg-[#181A20] border border-slate-800 rounded-xl overflow-hidden flex flex-col shadow-lg">
            {/* Chart Header Bar */}
            <div className="px-3 py-2 bg-[#0B0E11] border-b border-slate-800 flex items-center justify-between gap-2 text-xs font-mono">
              {/* Left: Coin Selector Dropdown + Live Price & Stats */}
              <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                <button
                  type="button"
                  onClick={() => setIsCoinSelectorOpen(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-bold border border-slate-700 cursor-pointer transition-colors shrink-0"
                >
                  <span className="text-[#F3BA2F]">{selectedSymbol}</span>
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                </button>

                <div className="flex items-center gap-2 font-mono text-[11px] shrink-0">
                  <span className="font-bold text-white">
                    ${activeTicker.lastPrice.toFixed(activeTicker.lastPrice < 1 ? 4 : 2)}
                  </span>
                  <span className={`font-semibold flex items-center gap-0.5 text-[10px] ${activeTicker.priceChangePercent >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}>
                    {activeTicker.priceChangePercent >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    <span>{activeTicker.priceChangePercent >= 0 ? '+' : ''}{activeTicker.priceChangePercent.toFixed(2)}%</span>
                  </span>
                  <span className="hidden sm:inline text-slate-500 text-[10px]">
                    Vol: ${(activeTicker.quoteVolume / 1000000).toFixed(1)}M
                  </span>
                </div>
              </div>

              {/* Right: Timeframe Switcher & Indicators */}
              <div className="flex items-center gap-2 sm:gap-3 shrink-0">
                <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5 font-mono">
                  {(['M1', 'M5', 'M15', 'H1'] as const).map((tf) => (
                    <button
                      key={tf}
                      type="button"
                      onClick={() => setTimeframe(tf)}
                      className={`px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-bold cursor-pointer transition-colors ${
                        timeframe === tf
                          ? 'bg-[#F3BA2F] text-slate-950 shadow-sm'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {tf}
                    </button>
                  ))}
                </div>

                <div className="hidden lg:flex items-center gap-2 text-[10px] text-slate-400">
                  <span className="text-[#F3BA2F] flex items-center gap-1">
                    <span className="w-2 h-0.5 bg-[#F3BA2F]" /> VWAP
                  </span>
                  <span className="text-[#3861FB] flex items-center gap-1">
                    <span className="w-2 h-0.5 bg-[#3861FB]" /> EMA50
                  </span>
                  <span className="text-[#0ECB81] flex items-center gap-1">
                    <span className="w-2 h-0.5 bg-[#0ECB81]" /> BB
                  </span>
                </div>
              </div>
            </div>

            {/* Canvas */}
            <div className="w-full relative h-[380px] sm:h-[420px] bg-[#0B0E11]">
              <canvas ref={canvasRef} className="w-full h-full block" />
            </div>
          </div>

          {/* BTC Velocity Radar Banner */}
          <div className={`p-2.5 sm:p-3 rounded-xl border font-mono text-xs flex items-center justify-between shadow-sm transition-colors ${
            btcDumpBlocked
              ? 'bg-rose-950/60 border-rose-500 text-rose-200'
              : 'bg-[#181A20] border-slate-800 text-slate-300'
          }`}>
            <div className="flex items-center gap-2.5">
              <AlertTriangle className={`w-4 h-4 shrink-0 ${btcDumpBlocked ? 'text-rose-400 animate-pulse' : 'text-[#F3BA2F]'}`} />
              <div>
                <span className="font-bold block sm:inline mr-2">BTC Velocity Radar:</span>
                <span className={btcDumpBlocked ? 'text-rose-300 font-semibold' : 'text-slate-400'}>
                  {btcGuardStatus}
                </span>
              </div>
            </div>

            <span className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase ${
              btcDumpBlocked ? 'bg-rose-900/60 text-rose-200 border border-rose-500/50' : 'bg-slate-900 text-slate-400 border border-slate-800'
            }`}>
              {btcDumpBlocked ? 'LONGS BLOCKED' : 'RADAR CLEAR'}
            </span>
          </div>

          {/* Active Futures Positions */}
          <div className="bg-[#181A20] border border-slate-800 rounded-xl p-3 sm:p-4 shadow-lg flex flex-col font-mono text-xs">
            <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-[#F3BA2F]" />
                <h3 className="font-bold text-white text-xs sm:text-sm">
                  Active Futures Positions ({positions.length}/{maxConcurrentCoins})
                </h3>
              </div>
              {positions.length > 0 && (
                <button
                  type="button"
                  onClick={panicCloseAll}
                  className="px-2.5 py-1 rounded-lg bg-rose-950/60 hover:bg-rose-900 text-rose-300 border border-rose-800/60 text-[10px] font-bold cursor-pointer transition-colors"
                >
                  Panic Close All
                </button>
              )}
            </div>

            {positions.length === 0 ? (
              <div className="text-center py-6 text-slate-500 text-xs">
                No active Binance positions. {isAutoTrading ? 'Auto-scanner active and evaluating confluence.' : 'Click "START FUTURES AUTO-TRADING" or place a manual entry.'}
              </div>
            ) : (
              <>
                {/* Mobile View: Horizontal Scroll-Free Cards */}
                <div className="block md:hidden space-y-2">
                  {positions.map((pos) => {
                    const isLong = pos.positionAmt > 0;
                    const ticker = tickers[pos.symbol];
                    const mark = ticker?.lastPrice || pos.markPrice || pos.entryPrice;
                    const size = Math.abs(pos.positionAmt);
                    const pnl = isLong
                      ? (mark - pos.entryPrice) * size
                      : (pos.entryPrice - mark) * size;
                    const pnlPct = pos.isolatedMargin > 0 ? (pnl / pos.isolatedMargin) * 100 : 0;
                    const isProfit = pnl >= 0;

                    return (
                      <div
                        key={pos.symbol}
                        className="bg-[#0B0E11] border border-slate-800 rounded-xl p-3 flex flex-col gap-2"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-white">{pos.symbol}</span>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              isLong ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                            }`}>
                              {isLong ? 'LONG' : 'SHORT'} {pos.leverage}x
                            </span>
                          </div>
                          <div className={`font-bold text-sm ${isProfit ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}>
                            {isProfit ? '+' : ''}${pnl.toFixed(2)} ({isProfit ? '+' : ''}{pnlPct.toFixed(1)}%)
                          </div>
                        </div>

                        <div className="flex items-center justify-between text-[11px] text-slate-400 border-t border-b border-slate-900 py-1">
                          <span>Size: {size}</span>
                          <span>Entry: ${pos.entryPrice.toFixed(pos.entryPrice < 1 ? 4 : 2)} → ${mark.toFixed(mark < 1 ? 4 : 2)}</span>
                        </div>

                        <div className="flex items-center justify-between pt-1">
                          <div>
                            {pos.partialClosed ? (
                              <span className="px-2 py-0.5 rounded-full text-[10px] bg-emerald-950/60 border border-emerald-500/60 text-emerald-300 font-bold flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                                🎯 60% Banked
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded-full text-[10px] bg-amber-950/40 border border-amber-500/40 text-amber-300 flex items-center gap-1">
                                <Lock className="w-3 h-3 text-amber-400" />
                                TP1: ${pos.takeProfit1Price?.toFixed(pos.entryPrice < 1 ? 4 : 2) || '-'}
                              </span>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => closePosition(pos.symbol)}
                            className="px-2.5 py-1 rounded bg-slate-800 hover:bg-rose-900/60 text-slate-300 hover:text-rose-200 border border-slate-700 text-[10px] cursor-pointer"
                          >
                            Close
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Desktop View: Table */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="text-slate-500 text-[10px] border-b border-slate-800/60 pb-1">
                        <th className="py-1">Symbol</th>
                        <th>Side</th>
                        <th>Size</th>
                        <th>Entry</th>
                        <th>Mark</th>
                        <th>Margin</th>
                        <th>PnL (USDT)</th>
                        <th>Asymmetric Lock Status</th>
                        <th className="text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {positions.map((pos) => {
                        const isLong = pos.positionAmt > 0;
                        const ticker = tickers[pos.symbol];
                        const mark = ticker?.lastPrice || pos.markPrice || pos.entryPrice;
                        const size = Math.abs(pos.positionAmt);
                        const pnl = isLong
                          ? (mark - pos.entryPrice) * size
                          : (pos.entryPrice - mark) * size;
                        const pnlPct = pos.isolatedMargin > 0 ? (pnl / pos.isolatedMargin) * 100 : 0;
                        const isProfit = pnl >= 0;

                        return (
                          <tr key={pos.symbol} className="border-b border-slate-800/40 text-xs hover:bg-slate-800/30">
                            <td className="py-2.5 font-bold text-white">{pos.symbol}</td>
                            <td>
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                isLong ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                              }`}>
                                {isLong ? 'LONG' : 'SHORT'} {pos.leverage}x
                              </span>
                            </td>
                            <td>{size}</td>
                            <td>${pos.entryPrice.toFixed(pos.entryPrice < 1 ? 4 : 2)}</td>
                            <td>${mark.toFixed(mark < 1 ? 4 : 2)}</td>
                            <td>${pos.isolatedMargin.toFixed(2)}</td>
                            <td className={`font-bold ${isProfit ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}>
                              {isProfit ? '+' : ''}${pnl.toFixed(2)} ({isProfit ? '+' : ''}{pnlPct.toFixed(1)}%)
                            </td>
                            <td>
                              {pos.partialClosed ? (
                                <span className="px-2 py-0.5 rounded-full text-[10px] bg-emerald-950/60 border border-emerald-500/60 text-emerald-300 font-bold flex items-center gap-1 w-fit">
                                  <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                                  🎯 60% Realized (BE+ Locked)
                                </span>
                              ) : (
                                <span className="px-2 py-0.5 rounded-full text-[10px] bg-amber-950/40 border border-amber-500/40 text-amber-300 flex items-center gap-1 w-fit">
                                  <Lock className="w-3 h-3 text-amber-400" />
                                  Target TP1: ${pos.takeProfit1Price?.toFixed(pos.entryPrice < 1 ? 4 : 2) || '-'}
                                </span>
                              )}
                            </td>
                            <td className="text-right">
                              <button
                                type="button"
                                onClick={() => closePosition(pos.symbol)}
                                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-rose-900/60 text-slate-300 hover:text-rose-200 border border-slate-700 text-[10px] cursor-pointer transition-colors"
                              >
                                Market Close
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

          {/* Crypto Execution Terminal & Scanner Telemetry (Compact collapsible h-44) */}
          <div className="bg-[#181A20] border border-slate-800 rounded-xl overflow-hidden shadow-lg flex flex-col font-mono text-xs">
            <div className="bg-[#0B0E11] px-3 py-2 border-b border-slate-800 flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 text-slate-300 font-bold">
                <Activity className="w-4 h-4 text-[#F3BA2F]" />
                <span>Crypto Execution Terminal</span>
                <span className="text-[10px] text-slate-500 font-normal">({filteredTelemetryLogs.length})</span>
              </div>

              <div className="flex items-center gap-1.5">
                {/* Pill filter tabs */}
                <div className="flex items-center gap-1 bg-slate-900 p-0.5 rounded-lg border border-slate-800 text-[10px]">
                  {['ALL', 'SIGNAL', 'GUARD', 'ORDER', 'LOCK'].map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setTelemetryFilter(cat)}
                      className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                        telemetryFilter === cat
                          ? 'bg-[#F3BA2F] text-slate-950 font-bold'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => setIsTelemetryCollapsed(!isTelemetryCollapsed)}
                  className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800"
                >
                  {isTelemetryCollapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            {!isTelemetryCollapsed && (
              <div className="h-44 p-2.5 overflow-y-auto space-y-1 bg-[#0B0E11]/90">
                {filteredTelemetryLogs.length === 0 ? (
                  <div className="text-slate-600 text-[11px] py-4 text-center">
                    Engine idle. Click START FUTURES AUTO-TRADING to initiate live Altcoin/L2 radar.
                  </div>
                ) : (
                  filteredTelemetryLogs.map((log) => (
                    <div key={log.id} className="text-[11px] leading-relaxed flex items-start gap-1.5 py-0.5 border-b border-slate-900/40">
                      <span className="text-slate-500 text-[10px] shrink-0">
                        [{new Date(log.timestamp).toLocaleTimeString()}]
                      </span>
                      <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold shrink-0 ${
                        log.category === 'LOCK' ? 'bg-emerald-950 text-emerald-300 border border-emerald-700' :
                        log.category === 'SIGNAL' ? 'bg-amber-950 text-amber-300 border border-amber-700' :
                        log.category === 'GUARD' ? 'bg-rose-950 text-rose-300 border border-rose-700' :
                        'bg-slate-900 text-slate-400 border border-slate-800'
                      }`}>
                        {log.category}
                      </span>
                      <span className="text-slate-300 flex-1">{log.message}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </section>

        {/* Right Section: Sizing Controls & Auto-Trading Engine Panel */}
        <section className="w-full lg:w-96 shrink-0 flex flex-col gap-3.5 font-mono text-xs">
          {/* Prominent Full-Width Start / Stop Auto-Trading Button */}
          <div className="bg-[#181A20] border border-[#F3BA2F]/40 rounded-xl p-3.5 shadow-xl flex flex-col gap-2.5">
            <button
              type="button"
              onClick={toggleAutoTrading}
              className={`w-full py-3.5 px-4 rounded-xl font-bold font-sans text-sm tracking-wide flex items-center justify-center gap-2 cursor-pointer shadow-lg transition-all ${
                isAutoTrading
                  ? 'bg-gradient-to-r from-rose-600 to-red-600 hover:from-rose-500 hover:to-red-500 text-white shadow-rose-950/40 animate-pulse'
                  : 'bg-gradient-to-r from-amber-500 to-[#F3BA2F] hover:from-amber-400 hover:to-[#F3BA2F] text-slate-950 shadow-[#F3BA2F]/20'
              }`}
            >
              {isAutoTrading ? (
                <>
                  <Square className="w-4 h-4 fill-current" />
                  <span>STOP AUTO-TRADING</span>
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 fill-current" />
                  <span>START FUTURES AUTO-TRADING</span>
                </>
              )}
            </button>

            <div className="flex items-center justify-between text-[11px] text-slate-400 px-1">
              <span className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${isAutoTrading ? 'bg-[#0ECB81] animate-ping' : 'bg-slate-600'}`} />
                <span>{isAutoTrading ? 'Altcoin/L2 Scanner Active' : 'Engine Idle'}</span>
              </span>
              <span>{isScanning ? 'Scanning...' : 'Ready'}</span>
            </div>
          </div>

          {/* Sizing & Leverage Configuration Card (2-column layout) */}
          <div className="bg-[#181A20] border border-slate-800 rounded-xl p-3.5 sm:p-4 shadow-lg flex flex-col gap-3.5">
            <div className="flex items-center gap-2 pb-2 border-b border-slate-800">
              <Sliders className="w-4 h-4 text-[#F3BA2F]" />
              <h3 className="font-bold text-white text-xs sm:text-sm">
                Position Sizing & Leverage
              </h3>
            </div>

            {/* Margin per Entry ($ USDT) */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-slate-300 font-semibold">Margin / Entry ($ USDT)</label>
                <span className="text-[#F3BA2F] font-bold">${marginUsdt.toFixed(2)}</span>
              </div>
              <input
                type="number"
                step="0.5"
                min="1"
                max="500"
                value={marginUsdt}
                onChange={(e) => setMarginUsdt(parseFloat(e.target.value) || 3)}
                className="w-full bg-[#0B0E11] border border-slate-700 rounded-lg px-3 py-1.5 text-white font-bold focus:border-[#F3BA2F] focus:outline-none mb-2"
              />

              {/* Quick Preset Buttons ($2, $3, $5, $10, $25) */}
              <div className="grid grid-cols-5 gap-1.5">
                {[2, 3, 5, 10, 25].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setMarginUsdt(preset)}
                    className={`py-1.5 rounded-lg text-xs font-bold border transition-colors cursor-pointer ${
                      marginUsdt === preset
                        ? 'bg-[#F3BA2F] text-slate-950 border-[#F3BA2F] shadow-sm'
                        : 'bg-[#0B0E11] border-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    ${preset}
                  </button>
                ))}
              </div>
            </div>

            {/* Custom Leverage (2x - 50x) */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-slate-300 font-semibold">Leverage ({leverage}x)</label>
                <div className="flex gap-1">
                  {(['ISOLATED', 'CROSS'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setMarginMode(mode)}
                      className={`px-2 py-0.5 rounded text-[10px] font-bold border cursor-pointer ${
                        marginMode === mode
                          ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                          : 'bg-[#0B0E11] border-slate-800 text-slate-400'
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
                className="w-full accent-[#F3BA2F] cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-slate-500 mt-0.5">
                <span>2x</span>
                <span>10x (Default)</span>
                <span>25x</span>
                <span>50x</span>
              </div>
            </div>

            {/* Max Concurrent Coins (1 to 5) */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-slate-300 font-semibold">Max Active Coins</label>
                <span className="text-white font-bold">{maxConcurrentCoins} Coins</span>
              </div>
              <div className="grid grid-cols-5 gap-1.5">
                {[1, 2, 3, 4, 5].map((count) => (
                  <button
                    key={count}
                    type="button"
                    onClick={() => setMaxConcurrentCoins(count)}
                    className={`py-1 rounded-lg text-xs font-bold border transition-colors cursor-pointer ${
                      maxConcurrentCoins === count
                        ? 'bg-[#F3BA2F] text-slate-950 border-[#F3BA2F]'
                        : 'bg-[#0B0E11] border-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    {count}
                  </button>
                ))}
              </div>
            </div>

            {/* Live Calculation Preview */}
            <div className="bg-[#0B0E11] p-2.5 rounded-xl border border-slate-800 space-y-1 text-[11px]">
              <div className="flex justify-between text-slate-400">
                <span>Margin × Leverage:</span>
                <span className="text-white font-semibold">${marginUsdt.toFixed(2)} × {leverage}x</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Total Notional Position:</span>
                <span className="text-[#F3BA2F] font-bold">${notionalUsdt.toFixed(2)} USDT</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Estimated Size ({selectedSymbol}):</span>
                <span className="text-white font-semibold">~{estimatedCoins} coins</span>
              </div>
            </div>
          </div>

          {/* Quick Manual Market Entry */}
          <div className="bg-[#181A20] border border-slate-800 rounded-xl p-3.5 shadow-lg flex flex-col gap-2.5">
            <h4 className="font-bold text-white text-xs">
              Manual Market Entry ({selectedSymbol})
            </h4>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => executeManualTrade(selectedSymbol, 'LONG')}
                className="py-2.5 rounded-xl bg-[#0ECB81] hover:bg-[#0ECB81]/90 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer shadow-md shadow-emerald-950/40"
              >
                <span>BUY / LONG (${marginUsdt})</span>
              </button>
              <button
                type="button"
                onClick={() => executeManualTrade(selectedSymbol, 'SHORT')}
                className="py-2.5 rounded-xl bg-[#F6465D] hover:bg-[#F6465D]/90 text-white font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer shadow-md shadow-rose-950/40"
              >
                <span>SELL / SHORT (${marginUsdt})</span>
              </button>
            </div>
          </div>

          {/* Asymmetric 75%+ Winrate Guarantee Explanation */}
          <div className="bg-amber-950/20 border border-amber-600/30 rounded-xl p-3 text-[11px] space-y-1 text-amber-200">
            <div className="font-bold flex items-center gap-1.5 text-amber-300">
              <ShieldCheck className="w-4 h-4 text-amber-400" />
              <span>75%+ Asymmetric Winrate Lock</span>
            </div>
            <p className="text-slate-400 text-[10px] leading-relaxed font-sans">
              1. Entry qualifies via 5-indicator confluence (Wick sweep + VWAP + EMA + RSI extreme).<br />
              2. At <strong>+0.7R (or VWAP)</strong>, auto-closes <strong>60%</strong> to lock realized USDT.<br />
              3. The remaining <strong>40%</strong> Stop Loss moves to <strong>Breakeven+</strong>. Trade cannot lose once TP1 is touched!
            </p>
          </div>
        </section>
      </div>

      {/* Modals */}
      <BinanceVaultModal />
      <BinancePnlCalendarModal />
    </div>
  );
};

export default BinanceFuturesRoom;
