'use client';

import React, { useRef, useEffect, useState, useMemo } from 'react';
import { useTradingStore } from '@/store/useTradingStore';
import { EXNESS_PAIR_PROFILES, getPairProfile, formatPrice } from '@/core/pairConfig';
import { computeIndicatorSnapshot } from '@/core/indicatorEngine';
import { useTheme } from '@/components/InstitutionalChrome';

export const TradingChart: React.FC = () => {
  const { isDark } = useTheme();
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const focusSymbol = useTradingStore((s) => s.focusSymbol);
  const selectedSymbol = useTradingStore((s) => s.selectedSymbol);
  const candles = useTradingStore((s) => s.candles);
  const timeframe = useTradingStore((s) => s.timeframe);
  const setTimeframe = useTradingStore((s) => s.setTimeframe);
  const activeSymbol = focusSymbol || selectedSymbol || 'XAUUSDm';
  const currentQuote = useTradingStore((s) => s.quotes[activeSymbol]);
  const positions = useTradingStore((s) => s.positions);
  const kronosPrediction = useTradingStore((s) => s.kronosPrediction);

  // Derive the chart title, decimal digits, and pip calculation strictly from EXNESS_PAIR_PROFILES[focusSymbol] (NOT from stale candle state)
  const profile = EXNESS_PAIR_PROFILES[focusSymbol] || EXNESS_PAIR_PROFILES[activeSymbol] || getPairProfile(focusSymbol || activeSymbol);

  // Zoom & Pan state (default 50 visible candles, min 15 for deep zoom-in, max 150 for wide zoom-out)
  const [visibleCandleCount, setVisibleCandleCount] = useState<number>(50);
  const [panOffset, setPanOffset] = useState<number>(0);

  const maxPan = Math.max(0, candles.length - visibleCandleCount);
  const safePan = panOffset <= 5 ? 0 : Math.max(0, Math.min(panOffset, maxPan));

  // Reset pan offset when switching symbol or timeframe
  useEffect(() => {
    setPanOffset(0);
  }, [activeSymbol, timeframe]);

  // Memoize heavy indicator snapshot calculations (BB(20,2), EMA 200, RSI(14), ATR(14))
  // Recomputes ONLY when candles or timeframe/preset change, eliminating CPU/GPU throttling on mobile
  const indicators = useMemo(() => {
    if (!candles || candles.length < 2) return null;
    try {
      return computeIndicatorSnapshot(
        candles,
        profile.preset.rsiPeriod,
        profile.preset.bbPeriod,
        profile.preset.bbStdDev
      );
    } catch {
      return null;
    }
  }, [candles, profile.preset.rsiPeriod, profile.preset.bbPeriod, profile.preset.bbStdDev]);

  // Immediately reload candles & quote whenever focused symbol changes
  useEffect(() => {
    useTradingStore.getState().fetchCandles(activeSymbol);
    useTradingStore.getState().fetchQuote(activeSymbol);
  }, [activeSymbol]);

  // Series adapter for Lightweight Charts compatibility & tick-by-tick updates
  const candleSeries = useMemo(() => ({
    update: (latestCandle: any) => {
      if (!latestCandle) return;
      const state = useTradingStore.getState();
      const currentCandles = state.candles;
      if (currentCandles.length === 0) {
        useTradingStore.setState({ candles: [latestCandle] });
        return;
      }
      const last = currentCandles[currentCandles.length - 1];
      if (last.timestamp === latestCandle.timestamp) {
        const updated = [...currentCandles.slice(0, -1), latestCandle];
        useTradingStore.setState({ candles: updated });
      } else {
        const updated = [...currentCandles.slice(currentCandles.length >= 250 ? 1 : 0), latestCandle];
        useTradingStore.setState({ candles: updated });
      }
    },
    setData: (data: any[]) => {
      if (Array.isArray(data)) {
        useTradingStore.setState({ candles: data });
      }
    },
  }), []);

  // Lightweight Charts timeScale adapter (allows scrollToRealTime locking)
  const chart = useMemo(() => ({
    timeScale: () => ({
      scrollToRealTime: () => {
        setPanOffset(0);
      },
      scrollToPosition: (position: number) => {
        setPanOffset(Math.max(0, position));
      },
      resetTimeScale: () => {
        setPanOffset(0);
        setVisibleCandleCount(50);
      },
    }),
  }), []);

  // Automatically scroll to real time when switching symbol, timeframe, or when new candles load
  const prevSymbolRef = useRef(activeSymbol);
  const prevTfRef = useRef(timeframe);
  const prevCandlesLenRef = useRef(0);

  useEffect(() => {
    const symbolChanged = prevSymbolRef.current !== activeSymbol;
    const tfChanged = prevTfRef.current !== timeframe;
    const isNewBatch = prevCandlesLenRef.current === 0 && candles.length > 0;
    const countJump = Math.abs(candles.length - prevCandlesLenRef.current) > 5;

    if (symbolChanged || tfChanged || isNewBatch || countJump) {
      chart.timeScale().scrollToRealTime();
    }

    prevSymbolRef.current = activeSymbol;
    prevTfRef.current = timeframe;
    prevCandlesLenRef.current = candles.length;
  }, [candles.length, activeSymbol, timeframe, chart]);

  // Sync candleSeries.setData whenever timeframe changes or historical candles re-anchor
  const prevTimeframeRef = useRef(timeframe);
  useEffect(() => {
    if (prevTimeframeRef.current !== timeframe) {
      prevTimeframeRef.current = timeframe;
      candleSeries.setData(candles);
      chart.timeScale().scrollToRealTime();
    }
  }, [timeframe, candles, candleSeries, chart]);

  // Touch and mouse drag/pinch state tracking
  const isDraggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartYRef = useRef(0);
  const dragStartPanRef = useRef(0);
  const touchGestureDirectionRef = useRef<'horizontal' | 'vertical' | null>(null);

  const isPinchingRef = useRef(false);
  const pinchStartDistRef = useRef(0);
  const pinchStartCountRef = useRef(50);

  // High-DPI and dimension tracking without forced layout thrashing
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });

  useEffect(() => {
    if (!isMounted) return;
    const container = containerRef.current;
    if (!container) return;

    const syncDimensions = () => {
      const canvas = canvasRef.current;
      if (!canvas || !container) return;
      const dpr = window.devicePixelRatio || 1;
      const width = container.clientWidth;
      const height = Math.max(340, container.clientHeight || 420);

      if (sizeRef.current.width !== width || sizeRef.current.height !== height || sizeRef.current.dpr !== dpr) {
        sizeRef.current = { width, height, dpr };
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = '100%';
        canvas.style.height = '100%';
      }
    };

    syncDimensions();
    const observer = new ResizeObserver(syncDimensions);
    observer.observe(container);

    return () => observer.disconnect();
  }, [isMounted]);

  // Wheel Zoom Listener (Scroll Up = Zoom In, Scroll Down = Zoom Out)
  useEffect(() => {
    if (!isMounted) return;
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY;
      if (delta < 0) {
        // Zoom in (fewer visible candles)
        setVisibleCandleCount((prev) => Math.max(15, prev - 5));
      } else if (delta > 0) {
        // Zoom out (more visible candles)
        setVisibleCandleCount((prev) => Math.min(150, prev + 5));
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [isMounted]);

  // Touch Pinch-to-Zoom & Touch Drag Panning Listener
  useEffect(() => {
    if (!isMounted) return;
    const container = containerRef.current;
    if (!container) return;

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        isDraggingRef.current = true;
        isPinchingRef.current = false;
        touchGestureDirectionRef.current = null;
        dragStartXRef.current = e.touches[0].clientX;
        dragStartYRef.current = e.touches[0].clientY;
        dragStartPanRef.current = panOffset;
      } else if (e.touches.length === 2) {
        isDraggingRef.current = false;
        isPinchingRef.current = true;
        touchGestureDirectionRef.current = null;
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        pinchStartDistRef.current = dist;
        pinchStartCountRef.current = visibleCandleCount;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (isPinchingRef.current && e.touches.length === 2) {
        e.preventDefault();
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        if (pinchStartDistRef.current > 0 && dist > 10) {
          const ratio = pinchStartDistRef.current / dist;
          const nextCount = Math.round(pinchStartCountRef.current * ratio);
          setVisibleCandleCount(Math.max(15, Math.min(150, nextCount)));
        }
      } else if (isDraggingRef.current && e.touches.length === 1) {
        const deltaX = e.touches[0].clientX - dragStartXRef.current;
        const deltaY = e.touches[0].clientY - dragStartYRef.current;
        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);

        // Disambiguate vertical page scrolling from intentional horizontal chart panning
        if (!touchGestureDirectionRef.current) {
          if (absY > 8 && absY >= absX) {
            touchGestureDirectionRef.current = 'vertical';
          } else if (absX > 20 && absX > absY * 2.2) {
            touchGestureDirectionRef.current = 'horizontal';
          }
        }

        // If user is scrolling vertically or hasn't decisively dragged horizontally, strictly DO NOT pan chart!
        if (touchGestureDirectionRef.current !== 'horizontal') {
          return;
        }

        e.preventDefault();
        const width = sizeRef.current.width || container.clientWidth || 360;
        const rightAxisWidth = width < 540 ? 56 : 70;
        const mainChartWidth = Math.max(100, width - rightAxisWidth);
        const candleSlotWidth = Math.max(2, mainChartWidth / visibleCandleCount);
        const candleDelta = Math.round(deltaX / candleSlotWidth);
        const maxP = Math.max(0, candles.length - visibleCandleCount);
        let nextPan = Math.max(0, Math.min(maxP, dragStartPanRef.current + candleDelta));

        // Auto-lock to live edge if within <= 5 bars of live edge
        if (nextPan <= 5) {
          nextPan = 0;
        }
        setPanOffset(nextPan);
      }
    };

    const handleTouchEnd = () => {
      isDraggingRef.current = false;
      isPinchingRef.current = false;
      touchGestureDirectionRef.current = null;
      // Auto-snap back to 0 (LIVE) if released within <= 5 bars of live edge
      setPanOffset((prev) => (prev <= 5 ? 0 : prev));
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd);
    container.addEventListener('touchcancel', handleTouchEnd);

    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
      container.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [isMounted, candles.length, visibleCandleCount, panOffset]);

  // Mouse Drag Panning Handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    isDraggingRef.current = true;
    dragStartXRef.current = e.clientX;
    dragStartPanRef.current = panOffset;
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;
    const dx = e.clientX - dragStartXRef.current;
    const container = containerRef.current;
    const width = sizeRef.current.width || container?.clientWidth || 360;
    const rightAxisWidth = width < 540 ? 56 : 70;
    const mainChartWidth = Math.max(100, width - rightAxisWidth);
    const candleSlotWidth = Math.max(2, mainChartWidth / visibleCandleCount);
    const candleDelta = Math.round(dx / candleSlotWidth);
    const maxP = Math.max(0, candles.length - visibleCandleCount);
    const nextPan = Math.max(0, Math.min(maxP, dragStartPanRef.current + candleDelta));
    setPanOffset(nextPan <= 5 ? 0 : nextPan);
  };

  const handleMouseUp = () => {
    isDraggingRef.current = false;
    setPanOffset((prev) => (prev <= 5 ? 0 : prev));
  };

  useEffect(() => {
    if (!isMounted) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rafId = requestAnimationFrame(() => {
      let { width, height, dpr } = sizeRef.current;
      if (width === 0 || height === 0) {
        dpr = window.devicePixelRatio || 1;
        width = container.clientWidth || 360;
        height = Math.max(340, container.clientHeight || 420);
        sizeRef.current = { width, height, dpr };
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = '100%';
        canvas.style.height = '100%';
      }

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // Layout configuration
      const isMobile = width < 540;
      const rsiPaneHeight = isMobile ? 85 : 110;
      const paddingBottom = 20;
      const rightAxisWidth = isMobile ? 56 : 70;
      const mainChartHeight = height - rsiPaneHeight - paddingBottom - 10;
      const mainChartWidth = Math.max(100, width - rightAxisWidth);

    // Clear background cleanly according to active Dark / Light institutional theme
    ctx.fillStyle = isDark ? '#09090b' : '#FFFFFF';
    ctx.fillRect(0, 0, width, height);

    // Validate if candles match the current activeSymbol to prevent cross-symbol price desync
    const isGold = profile.symbol === 'XAUUSDm';
    const isStaleData = candles.length > 0 && (
      (isGold && (candles[0].close < 1000 || candles[0].close > 10000 || Math.abs(candles[0].close - 3875.70) < 1.0)) ||
      (!isGold && profile.symbol !== 'USDJPYm' && candles[0].close > 50) ||
      (profile.symbol === 'USDJPYm' && (candles[0].close < 50 || candles[0].close > 500))
    );

    // Instant Lightweight Skeleton Renderer: Clear canvas instantly & render new symbol's scale without locking main thread
    if (candles.length < 2 || isStaleData) {
      const baselines: Record<string, number> = {
        XAUUSDm: 4108.90,
        EURUSDm: 1.11592,
        GBPUSDm: 1.33877,
        USDJPYm: 157.569,
      };
      const baseline = (currentQuote && currentQuote.symbol === activeSymbol && currentQuote.bid > 0)
        ? currentQuote.bid
        : (baselines[activeSymbol] || (profile.digits === 5 ? 1.11592 : profile.digits === 3 ? 157.569 : 4108.90));

      const skeletonRange = profile.pipValue * (isGold ? 50 : 30);
      const sMinPrice = baseline - skeletonRange / 2;
      const sMaxPrice = baseline + skeletonRange / 2;
      const sPriceRange = sMaxPrice - sMinPrice;

      const sPriceToY = (p: number) => {
        const ratio = (p - sMinPrice) / sPriceRange;
        return mainChartHeight - (ratio * mainChartHeight) + 10;
      };

      // 1. Grid Lines & Right Price Axis with new symbol's format & digits
      ctx.strokeStyle = isDark ? 'rgba(148, 163, 184, 0.10)' : '#F1F5F9';
      ctx.lineWidth = 1;
      const gridSteps = 5;
      for (let i = 0; i <= gridSteps; i++) {
        const p = sMinPrice + (sPriceRange * (i / gridSteps));
        const y = sPriceToY(p);

        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(mainChartWidth, y);
        ctx.stroke();

        ctx.fillStyle = isDark ? '#94a3b8' : '#64748B';
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillText(formatPrice(p, profile.digits), mainChartWidth + 6, y + 3);
      }

      // Vertical grid lines
      const vCols = 8;
      for (let c = 1; c < vCols; c++) {
        const x = (mainChartWidth / vCols) * c;
        ctx.beginPath();
        ctx.moveTo(x, 10);
        ctx.lineTo(x, mainChartHeight + 10);
        ctx.stroke();
      }

      // 2. Lightweight Skeleton Ghost Candles
      const barCount = 28;
      const barSlotWidth = mainChartWidth / barCount;
      const barBodyWidth = Math.max(3, barSlotWidth * 0.55);
      const pseudoPatterns = [0.2, 0.4, 0.3, 0.6, 0.5, 0.7, 0.4, 0.6, 0.8, 0.5, 0.3, 0.5, 0.7, 0.6, 0.4, 0.8, 0.6, 0.5, 0.7, 0.4, 0.6, 0.5, 0.7, 0.3, 0.5, 0.6, 0.4, 0.5];

      for (let b = 0; b < barCount; b++) {
        const xCenter = b * barSlotWidth + (barSlotWidth / 2);
        const factor = pseudoPatterns[b % pseudoPatterns.length];
        const barP = sMinPrice + sPriceRange * (0.25 + factor * 0.5);
        const yCenter = sPriceToY(barP);
        const bHeight = 12 + factor * 16;
        const yTop = yCenter - bHeight / 2;

        ctx.strokeStyle = isDark ? 'rgba(56, 189, 248, 0.22)' : 'rgba(2, 132, 199, 0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xCenter, yTop - 6);
        ctx.lineTo(xCenter, yTop + bHeight + 6);
        ctx.stroke();

        ctx.fillStyle = b % 2 === 0
          ? (isDark ? 'rgba(56, 189, 248, 0.12)' : 'rgba(2, 132, 199, 0.08)')
          : 'rgba(148, 163, 184, 0.08)';
        ctx.fillRect(xCenter - barBodyWidth / 2, yTop, barBodyWidth, bHeight);
      }

      // 3. RSI Sub-Pane Skeleton
      const rsiTop = mainChartHeight + 15;
      const rsiBottom = rsiTop + rsiPaneHeight - 15;
      const rsiRange = rsiBottom - rsiTop;
      ctx.fillStyle = isDark ? '#020617' : '#F8FAFC';
      ctx.fillRect(0, rsiTop - 10, width, rsiPaneHeight);
      ctx.strokeStyle = isDark ? '#27272a' : '#E2E8F0';
      ctx.beginPath();
      ctx.moveTo(0, rsiTop - 10);
      ctx.lineTo(width, rsiTop - 10);
      ctx.stroke();

      const rsiY70 = rsiBottom - 0.7 * rsiRange;
      const rsiY30 = rsiBottom - 0.3 * rsiRange;
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.3)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, rsiY70);
      ctx.lineTo(mainChartWidth, rsiY70);
      ctx.stroke();
      ctx.fillStyle = '#ef4444';
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText('70', mainChartWidth + 6, rsiY70 + 3);

      ctx.strokeStyle = 'rgba(16, 185, 129, 0.3)';
      ctx.beginPath();
      ctx.moveTo(0, rsiY30);
      ctx.lineTo(mainChartWidth, rsiY30);
      ctx.stroke();
      ctx.fillStyle = '#10b981';
      ctx.fillText('30', mainChartWidth + 6, rsiY30 + 3);
      ctx.setLineDash([]);

      // 4. Centered Sleek Loading Skeleton Badge
      const badgeW = Math.min(280, mainChartWidth - 16);
      const badgeH = 50;
      const badgeX = (mainChartWidth - badgeW) / 2;
      const badgeY = (mainChartHeight - badgeH) / 2;

      ctx.fillStyle = isDark ? '#18181b' : '#FFFFFF';
      ctx.strokeStyle = isDark ? '#3f3f46' : '#CBD5E1';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 10);
      } else {
        ctx.rect(badgeX, badgeY, badgeW, badgeH);
      }
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = isDark ? '#f8fafc' : '#0F172A';
      ctx.font = 'bold 12px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`⚡ Loading ${profile.name} (${profile.symbol})`, badgeX + badgeW / 2, badgeY + 22);

      ctx.fillStyle = isDark ? '#38bdf8' : '#0284C7';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(`Price Format: ${profile.digits} Decimals · Synchronizing ${timeframe}`, badgeX + badgeW / 2, badgeY + 40);
      ctx.textAlign = 'left';

      ctx.restore();
      return;
    }

    // Determine slice of candles to display based on zoom level and pan offset
    const totalCandles = candles.length;
    const displayCount = Math.min(visibleCandleCount, totalCandles);
    const candleEndIndex = Math.max(displayCount, totalCandles - safePan);
    const candleStartIndex = Math.max(0, candleEndIndex - displayCount);
    const visibleCandles = candles.slice(candleStartIndex, candleEndIndex).map((c) => ({ ...c }));

    // Single source of truth: synchronize latest candle close/tick strictly with currentQuote
    if (visibleCandles.length > 0 && currentQuote && currentQuote.symbol === activeSymbol && currentQuote.bid > 0) {
      if (candleEndIndex === totalCandles) {
        const lastIdx = visibleCandles.length - 1;
        const lastC = visibleCandles[lastIdx];
        const liveTick = currentQuote.bid;
        if (Math.abs(liveTick - lastC.close) / lastC.close < 0.08) {
          lastC.close = liveTick;
          lastC.high = Math.max(lastC.high, liveTick);
          lastC.low = Math.min(lastC.low, liveTick);
        }
      }
    }

    // Historical viewing notice on canvas if panned into the past
    if (safePan > 0) {
      ctx.fillStyle = 'rgba(245, 158, 11, 0.9)';
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.fillText(`◀ HISTORICAL VIEW (-${safePan} bars) · Drag or tap Live to return`, 10, 44);
    }

    // Determine Min & Max price in visible range
    let minPrice = Infinity;
    let maxPrice = -Infinity;

    for (let i = 0; i < visibleCandles.length; i++) {
      const c = visibleCandles[i];
      if (isGold && (c.low < 1000 || c.high > 10000 || Math.abs(c.close - 3875.70) < 1.0)) {
        continue;
      }
      if (c.low < minPrice) minPrice = c.low;
      if (c.high > maxPrice) maxPrice = c.high;

      const fullIdx = candleStartIndex + i;
      if (indicators) {
        if (indicators.bb.upper[fullIdx] && indicators.bb.upper[fullIdx] > maxPrice) {
          maxPrice = indicators.bb.upper[fullIdx];
        }
        if (indicators.bb.lower[fullIdx] && indicators.bb.lower[fullIdx] < minPrice) {
          minPrice = indicators.bb.lower[fullIdx];
        }
        if (indicators.ema200[fullIdx] && indicators.ema200[fullIdx] > 0) {
          if (indicators.ema200[fullIdx] > maxPrice) maxPrice = indicators.ema200[fullIdx];
          if (indicators.ema200[fullIdx] < minPrice) minPrice = indicators.ema200[fullIdx];
        }
      }
    }

    // Include open positions Entry / SL / TP in price range strictly for the active symbol
    const activePositions = (positions || []).filter(
      (p) => p && p.symbol === activeSymbol && p.id !== 'F-637' && p.id !== '#F-637'
    );
    for (const pos of activePositions) {
      if (pos.entryPrice > maxPrice) maxPrice = pos.entryPrice;
      if (pos.entryPrice < minPrice) minPrice = pos.entryPrice;
      if (pos.currentSl > 0) {
        if (pos.currentSl > maxPrice) maxPrice = pos.currentSl;
        if (pos.currentSl < minPrice) minPrice = pos.currentSl;
      }
      if (pos.currentTp > 0) {
        if (pos.currentTp > maxPrice) maxPrice = pos.currentTp;
        if (pos.currentTp < minPrice) minPrice = pos.currentTp;
      }
    }

    // Include live Bid/Ask quote in price bounds so price line and candle close never clip
    if (currentQuote && currentQuote.symbol === activeSymbol && currentQuote.bid > 0) {
      const isQuoteValid = !isGold || (currentQuote.bid >= 1000 && currentQuote.bid <= 10000 && Math.abs(currentQuote.bid - 3875.70) > 1.0);
      if (isQuoteValid) {
        if (currentQuote.bid < minPrice) minPrice = currentQuote.bid;
        if (currentQuote.bid > maxPrice) maxPrice = currentQuote.bid;
        if (currentQuote.ask < minPrice) minPrice = currentQuote.ask;
        if (currentQuote.ask > maxPrice) maxPrice = currentQuote.ask;
      }
    }

    if (!isFinite(minPrice) || !isFinite(maxPrice) || minPrice >= maxPrice) {
      const fallbackPrice = (currentQuote && currentQuote.bid > 0) ? currentQuote.bid : (profile.digits === 5 ? 1.11592 : profile.digits === 3 ? 157.569 : 4108.90);
      const range = profile.pipValue * (isGold ? 50 : 30);
      minPrice = fallbackPrice - range / 2;
      maxPrice = fallbackPrice + range / 2;
    }

    // Padding
    const priceRange = maxPrice - minPrice || 1;
    minPrice -= priceRange * 0.05;
    maxPrice += priceRange * 0.05;
    const effectivePriceRange = maxPrice - minPrice;

    const candleSlotWidth = mainChartWidth / displayCount;
    const candleBodyWidth = Math.max(2, candleSlotWidth * 0.65);

    const priceToY = (price: number) => {
      const ratio = (price - minPrice) / effectivePriceRange;
      return mainChartHeight - (ratio * mainChartHeight) + 10;
    };

    // 1. Grid Lines & Right Axis
    ctx.strokeStyle = isDark ? 'rgba(148, 163, 184, 0.10)' : '#F1F5F9';
    ctx.lineWidth = 1;

    const gridSteps = 5;
    for (let i = 0; i <= gridSteps; i++) {
      const p = minPrice + (effectivePriceRange * (i / gridSteps));
      const y = priceToY(p);

      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(mainChartWidth, y);
      ctx.stroke();

      ctx.fillStyle = isDark ? '#94a3b8' : '#64748B';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(formatPrice(p, profile.digits), mainChartWidth + 6, y + 3);
    }

    // Subtle right axis border separator
    ctx.strokeStyle = isDark ? '#27272a' : '#E2E8F0';
    ctx.beginPath();
    ctx.moveTo(mainChartWidth, 0);
    ctx.lineTo(mainChartWidth, mainChartHeight + 10);
    ctx.stroke();

    // 2. Bollinger Bands Cloud & Lines
    if (indicators && indicators.bb.upper.length > 0) {
      // Area Fill
      ctx.beginPath();
      for (let i = 0; i < visibleCandles.length; i++) {
        const fullIdx = candleStartIndex + i;
        const x = i * candleSlotWidth + (candleSlotWidth / 2);
        const yUpper = priceToY(indicators.bb.upper[fullIdx]);
        if (i === 0) ctx.moveTo(x, yUpper);
        else ctx.lineTo(x, yUpper);
      }
      for (let i = visibleCandles.length - 1; i >= 0; i--) {
        const fullIdx = candleStartIndex + i;
        const x = i * candleSlotWidth + (candleSlotWidth / 2);
        const yLower = priceToY(indicators.bb.lower[fullIdx]);
        ctx.lineTo(x, yLower);
      }
      ctx.closePath();
      ctx.fillStyle = isDark ? 'rgba(56, 189, 248, 0.06)' : 'rgba(2, 132, 199, 0.04)';
      ctx.fill();

      // Upper Band
      ctx.beginPath();
      ctx.strokeStyle = isDark ? 'rgba(56, 189, 248, 0.45)' : 'rgba(2, 132, 199, 0.45)';
      ctx.lineWidth = 1.2;
      for (let i = 0; i < visibleCandles.length; i++) {
        const fullIdx = candleStartIndex + i;
        const x = i * candleSlotWidth + (candleSlotWidth / 2);
        const y = priceToY(indicators.bb.upper[fullIdx]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Middle Band (SMA 20)
      ctx.beginPath();
      ctx.strokeStyle = isDark ? 'rgba(251, 191, 36, 0.65)' : 'rgba(217, 119, 6, 0.7)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      for (let i = 0; i < visibleCandles.length; i++) {
        const fullIdx = candleStartIndex + i;
        const x = i * candleSlotWidth + (candleSlotWidth / 2);
        const y = priceToY(indicators.bb.middle[fullIdx]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Lower Band
      ctx.beginPath();
      ctx.strokeStyle = isDark ? 'rgba(56, 189, 248, 0.45)' : 'rgba(2, 132, 199, 0.45)';
      ctx.lineWidth = 1.2;
      for (let i = 0; i < visibleCandles.length; i++) {
        const fullIdx = candleStartIndex + i;
        const x = i * candleSlotWidth + (candleSlotWidth / 2);
        const y = priceToY(indicators.bb.lower[fullIdx]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // 3. EMA 21 & EMA 50 Trend Overlays
    if (indicators && indicators.ema21 && indicators.ema21.length > 0) {
      ctx.beginPath();
      ctx.strokeStyle = isDark ? '#38bdf8' : '#0284c7';
      ctx.lineWidth = 1.8;
      let started = false;
      for (let i = 0; i < visibleCandles.length; i++) {
        const fullIdx = candleStartIndex + i;
        const val = indicators.ema21[fullIdx];
        if (val > 0) {
          const x = i * candleSlotWidth + (candleSlotWidth / 2);
          const y = priceToY(val);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      ctx.stroke();
    }

    if (indicators && indicators.ema50 && indicators.ema50.length > 0) {
      ctx.beginPath();
      ctx.strokeStyle = isDark ? '#a78bfa' : '#7c3aed';
      ctx.lineWidth = 1.8;
      let started = false;
      for (let i = 0; i < visibleCandles.length; i++) {
        const fullIdx = candleStartIndex + i;
        const val = indicators.ema50[fullIdx];
        if (val > 0) {
          const x = i * candleSlotWidth + (candleSlotWidth / 2);
          const y = priceToY(val);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      ctx.stroke();
    }

    // 4. Candlesticks (Emerald Bullish & Coral Red Bearish)
    for (let i = 0; i < visibleCandles.length; i++) {
      const c = visibleCandles[i];
      const isBullish = c.close >= c.open;
      const xCenter = i * candleSlotWidth + (candleSlotWidth / 2);
      const xLeft = xCenter - (candleBodyWidth / 2);

      const yHigh = priceToY(c.high);
      const yLow = priceToY(c.low);
      const yOpen = priceToY(c.open);
      const yClose = priceToY(c.close);

      const bodyTop = Math.min(yOpen, yClose);
      const bodyHeight = Math.max(1.5, Math.abs(yClose - yOpen));

      // Wick
      ctx.strokeStyle = isBullish ? '#10b981' : '#ef4444';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(xCenter, yHigh);
      ctx.lineTo(xCenter, yLow);
      ctx.stroke();

      // Body
      ctx.fillStyle = isBullish ? '#10b981' : '#ef4444';
      ctx.fillRect(xLeft, bodyTop, candleBodyWidth, bodyHeight);
    }

    // 5. Active Position Lines (Entry, SL, TP)
    for (const pos of activePositions) {
      // Entry Line
      const yEntry = priceToY(pos.entryPrice);
      ctx.strokeStyle = isDark ? '#38bdf8' : '#0284c7';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 2]);
      ctx.beginPath();
      ctx.moveTo(0, yEntry);
      ctx.lineTo(mainChartWidth, yEntry);
      ctx.stroke();
      ctx.fillStyle = isDark ? '#38bdf8' : '#0284c7';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(`Entry #${pos.id.slice(-4)} (${pos.side} @ ${formatPrice(pos.entryPrice, profile.digits)})`, 8, yEntry - 3);

      // Stop Loss Line
      if (pos.currentSl > 0) {
        const ySl = priceToY(pos.currentSl);
        ctx.strokeStyle = '#ef4444';
        ctx.beginPath();
        ctx.moveTo(0, ySl);
        ctx.lineTo(mainChartWidth, ySl);
        ctx.stroke();
        ctx.fillStyle = '#ef4444';
        const slText = `SL: ${formatPrice(pos.currentSl, profile.digits)}`;
        const slW = ctx.measureText(slText).width;
        ctx.fillText(slText, Math.max(10, mainChartWidth - slW - 8), ySl - 3);
      }

      // Take Profit Line
      if (pos.currentTp > 0) {
        const yTp = priceToY(pos.currentTp);
        ctx.strokeStyle = '#10b981';
        ctx.beginPath();
        ctx.moveTo(0, yTp);
        ctx.lineTo(mainChartWidth, yTp);
        ctx.stroke();
        ctx.fillStyle = '#10b981';
        const tpText = `TP: ${formatPrice(pos.currentTp, profile.digits)}`;
        const tpW = ctx.measureText(tpText).width;
        ctx.fillText(tpText, Math.max(10, mainChartWidth - tpW - 8), yTp - 3);
      }
      ctx.setLineDash([]);
    }

    // 5b. Kronos K-Line Forecast Horizon & Volume Profile Levels (POC / VAH / VAL)
    if (visibleCandles.length > 5 && indicators) {
      const lastC = visibleCandles[visibleCandles.length - 1];
      const hasLivePred = kronosPrediction && kronosPrediction.symbol === activeSymbol;
      const pocPrice = hasLivePred && kronosPrediction.pocPrice > 0
        ? kronosPrediction.pocPrice
        : (indicators.c0.middleBB || lastC.close);
      const atr = indicators.c0.atr14 || (lastC.high - lastC.low) || profile.pipValue * 10;
      const rsiNow = indicators.c0.rsi ?? 50;
      const bullPct = hasLivePred ? kronosPrediction.bullishPct : (lastC.close >= pocPrice && rsiNow >= 48 ? 64 : 38);
      const isBullHorizon = bullPct >= 50;
      const kronosTarget = hasLivePred && kronosPrediction.horizonPrice > 0
        ? kronosPrediction.horizonPrice
        : (isBullHorizon ? lastC.close + atr * 1.35 : lastC.close - atr * 1.35);
      const activeSignal = hasLivePred ? kronosPrediction.signal : (isBullHorizon ? 'BUY' : 'SELL');

      // Subtle VAH / VAL markers when live Kronos Volume Profile is available
      if (hasLivePred && kronosPrediction.vahPrice && kronosPrediction.vahPrice > 0) {
        const yVah = priceToY(kronosPrediction.vahPrice);
        if (yVah > 14 && yVah < mainChartHeight - 8) {
          ctx.strokeStyle = isDark ? 'rgba(99, 102, 241, 0.35)' : 'rgba(79, 70, 229, 0.28)';
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 5]);
          ctx.beginPath();
          ctx.moveTo(Math.max(0, mainChartWidth * 0.65), yVah);
          ctx.lineTo(mainChartWidth, yVah);
          ctx.stroke();
          ctx.fillStyle = isDark ? '#818cf8' : '#6366f1';
          ctx.font = '8px ui-monospace, monospace';
          ctx.fillText(`VAH ${formatPrice(kronosPrediction.vahPrice, profile.digits)}`, Math.max(8, mainChartWidth * 0.65 + 4), yVah - 2);
        }
      }

      if (hasLivePred && kronosPrediction.valPrice && kronosPrediction.valPrice > 0) {
        const yVal = priceToY(kronosPrediction.valPrice);
        if (yVal > 14 && yVal < mainChartHeight - 8) {
          ctx.strokeStyle = isDark ? 'rgba(99, 102, 241, 0.35)' : 'rgba(79, 70, 229, 0.28)';
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 5]);
          ctx.beginPath();
          ctx.moveTo(Math.max(0, mainChartWidth * 0.65), yVal);
          ctx.lineTo(mainChartWidth, yVal);
          ctx.stroke();
          ctx.fillStyle = isDark ? '#818cf8' : '#6366f1';
          ctx.font = '8px ui-monospace, monospace';
          ctx.fillText(`VAL ${formatPrice(kronosPrediction.valPrice, profile.digits)}`, Math.max(8, mainChartWidth * 0.65 + 4), yVal - 2);
        }
      }

      const yPoc = priceToY(pocPrice);
      ctx.strokeStyle = isDark ? 'rgba(148, 163, 184, 0.45)' : 'rgba(15, 23, 42, 0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(Math.max(0, mainChartWidth * 0.45), yPoc);
      ctx.lineTo(mainChartWidth, yPoc);
      ctx.stroke();
      ctx.fillStyle = isDark ? '#cbd5e1' : '#475569';
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText(`POC ${formatPrice(pocPrice, profile.digits)}`, Math.max(8, mainChartWidth * 0.45 + 4), yPoc - 3);

      const yKronos = priceToY(kronosTarget);
      if (yKronos > 14 && yKronos < mainChartHeight - 8) {
        ctx.strokeStyle = isBullHorizon ? 'rgba(16, 185, 129, 0.65)' : 'rgba(244, 63, 94, 0.65)';
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.max(0, mainChartWidth * 0.58), yKronos);
        ctx.lineTo(mainChartWidth, yKronos);
        ctx.stroke();
        ctx.fillStyle = isBullHorizon ? (isDark ? '#34d399' : '#059669') : (isDark ? '#fb7185' : '#e11d48');
        ctx.font = 'bold 9px ui-monospace, monospace';
        ctx.fillText(
          `KRONOS ${activeSignal} (${bullPct}% BULL): ${formatPrice(kronosTarget, profile.digits)}`,
          Math.max(8, mainChartWidth * 0.58 + 4),
          yKronos - 3
        );
      }
      ctx.setLineDash([]);
    }

    // 6. Live Quote Line & Axis Bubble
    if (currentQuote && currentQuote.bid > 0) {
      const yBid = priceToY(currentQuote.bid);
      ctx.strokeStyle = '#d97706';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(0, yBid);
      ctx.lineTo(mainChartWidth, yBid);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#d97706';
      ctx.fillRect(mainChartWidth + 1, yBid - 8, rightAxisWidth - 2, 16);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px ui-monospace, monospace';
      ctx.fillText(formatPrice(currentQuote.bid, profile.digits), mainChartWidth + 4, yBid + 4);
    }

    // =========================================================================
    // 7. RSI(14) SUB-PANE WITH 15-CANDLE DIVERGENCE MARKERS
    // =========================================================================
    const rsiTop = mainChartHeight + 15;
    const rsiBottom = rsiTop + rsiPaneHeight - 15;
    const rsiRange = rsiBottom - rsiTop;

    ctx.fillStyle = isDark ? '#020617' : '#F8FAFC';
    ctx.fillRect(0, rsiTop - 10, width, rsiPaneHeight);
    ctx.strokeStyle = isDark ? '#27272a' : '#E2E8F0';
    ctx.beginPath();
    ctx.moveTo(0, rsiTop - 10);
    ctx.lineTo(width, rsiTop - 10);
    ctx.stroke();

    const rsiToY = (val: number) => {
      const clamped = Math.max(0, Math.min(100, val));
      return rsiBottom - (clamped / 100) * rsiRange;
    };

    // RSI Threshold Overbought (from Volatility DNA preset)
    const yOverbought = rsiToY(profile.preset.rsiTrendOverbought);
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, yOverbought);
    ctx.lineTo(mainChartWidth, yOverbought);
    ctx.stroke();
    ctx.fillStyle = '#ef4444';
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillText(`${profile.preset.rsiTrendOverbought}`, mainChartWidth + 6, yOverbought + 3);

    // 50 Center
    const y50 = rsiToY(50);
    ctx.strokeStyle = isDark ? 'rgba(148, 163, 184, 0.22)' : 'rgba(148, 163, 184, 0.35)';
    ctx.beginPath();
    ctx.moveTo(0, y50);
    ctx.lineTo(mainChartWidth, y50);
    ctx.stroke();

    // RSI Threshold Oversold (from Volatility DNA preset)
    const yOversold = rsiToY(profile.preset.rsiTrendOversold);
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.4)';
    ctx.beginPath();
    ctx.moveTo(0, yOversold);
    ctx.lineTo(mainChartWidth, yOversold);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#10b981';
    ctx.fillText(`${profile.preset.rsiTrendOversold}`, mainChartWidth + 6, yOversold + 3);

    // RSI Curve
    if (indicators && indicators.rsi.length > 0) {
      ctx.beginPath();
      ctx.strokeStyle = isDark ? '#38bdf8' : '#0284c7';
      ctx.lineWidth = 1.5;
      for (let i = 0; i < visibleCandles.length; i++) {
        const fullIdx = candleStartIndex + i;
        const x = i * candleSlotWidth + (candleSlotWidth / 2);
        const y = rsiToY(indicators.rsi[fullIdx]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      const currentRsi = indicators.rsi[indicators.rsi.length - 1] ?? (indicators.rsi[candles.length - 1] || 50);
      ctx.fillStyle = currentRsi >= profile.preset.rsiTrendOverbought
        ? '#ef4444'
        : currentRsi <= profile.preset.rsiTrendOversold
        ? '#10b981'
        : (isDark ? '#cbd5e1' : '#334155');
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.fillText(`RSI(14): ${currentRsi.toFixed(1)}${safePan > 0 ? ' (Live)' : ''}`, 10, rsiTop + 8);

      // 15-Candle Divergence Indicator
      if (indicators.divergence && indicators.divergence.detected) {
        ctx.fillStyle = indicators.divergence.bullishDivergence ? '#10b981' : '#ef4444';
        ctx.fillText(`★ 15-Candle Divergence: ${indicators.divergence.type}`, 115, rsiTop + 8);
      }
    }

      ctx.restore();
    });

    return () => cancelAnimationFrame(rafId);
  }, [
    isMounted,
    isDark,
    activeSymbol,
    candles,
    currentQuote,
    positions,
    timeframe,
    visibleCandleCount,
    safePan,
    indicators,
    kronosPrediction,
  ]);

  if (!isMounted) {
    return (
      <div className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-xl overflow-hidden flex flex-col h-full shadow-sm items-center justify-center min-h-[440px]">
        <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 font-mono text-xs">
          <span className="w-2 h-2 rounded-full bg-indigo-600 animate-ping" />
          Initializing Institutional Chart Canvas...
        </div>
      </div>
    );
  }

  return (
    <div key={focusSymbol || activeSymbol} className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-xl overflow-hidden flex flex-col h-full shadow-sm w-full max-w-full transition-colors">
      {/* Chart Control Header - Two Mobile-Friendly Rows */}
      <div className="bg-slate-50/80 dark:bg-zinc-950/80 px-3 py-2 sm:px-4 sm:py-2.5 border-b border-slate-200 dark:border-zinc-800 flex flex-col gap-1.5 text-xs w-full max-w-full select-none transition-colors">
        {/* Row 1: Symbol Title + Timeframe Pills (M1 M5 M15 H1) */}
        <div className="flex items-center justify-between gap-2 w-full">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-bold text-slate-900 dark:text-slate-100 text-xs sm:text-sm tracking-wider flex items-center gap-1.5 truncate">
              {profile.name} ({profile.symbol})
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Timeframe Pills */}
            <div className="flex items-center rounded-lg bg-slate-100 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 p-0.5 font-mono">
              {(['M1', 'M5', 'M15', 'H1'] as const).map((tf) => {
                const isActive = timeframe === tf;
                return (
                  <button
                    key={tf}
                    type="button"
                    onClick={() => setTimeframe(tf)}
                    className={`px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-medium transition-all cursor-pointer ${
                      isActive
                        ? 'bg-indigo-600 text-white shadow-sm font-semibold'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200/60 dark:hover:bg-zinc-800'
                    }`}
                    title={`Switch chart to ${tf} timeframe`}
                  >
                    {tf}
                  </button>
                );
              })}
            </div>

            {/* Indicator Legend (Desktop) */}
            <div className="hidden md:flex items-center gap-2 text-[10px] font-mono text-slate-500 dark:text-slate-400">
              <span className="flex items-center gap-1">
                <span className="w-2 h-0.5 bg-sky-500 inline-block" /> EMA21
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-0.5 bg-purple-500 inline-block" /> EMA50
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-0.5 bg-indigo-500 inline-block" /> RSI(14)
              </span>
            </div>
          </div>
        </div>

        {/* Row 2: Bid, Ask, Spread and Zoom Controls (Never Truncated) */}
        <div className="flex items-center justify-between gap-2 w-full flex-wrap">
          {/* Bid / Ask / Spread Badges */}
          <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap font-mono text-[10px] sm:text-[11px]">
            {currentQuote && currentQuote.symbol === activeSymbol ? (
              <div className="flex items-center gap-1.5 sm:gap-2 px-2 py-0.5 rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-slate-700 dark:text-slate-200 shadow-sm">
                <span className="text-slate-500 dark:text-slate-400">Bid:</span>
                <span className="text-emerald-700 dark:text-emerald-400 font-semibold">{formatPrice(currentQuote.bid, profile.digits)}</span>
                <span className="text-slate-300 dark:text-zinc-700">|</span>
                <span className="text-slate-500 dark:text-slate-400">Ask:</span>
                <span className="text-rose-700 dark:text-rose-400 font-semibold">{formatPrice(currentQuote.ask, profile.digits)}</span>
                <span className="text-slate-300 dark:text-zinc-700">|</span>
                <span className="text-slate-500 dark:text-slate-400">Spread:</span>
                <span className="text-amber-700 dark:text-amber-400 font-medium">{currentQuote.spreadPips} p</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-slate-500 dark:text-slate-400 shadow-sm">
                <span>Connecting live quote...</span>
              </div>
            )}
          </div>

          {/* Zoom and Pan Controls */}
          <div className="flex items-center gap-1 bg-slate-100 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-lg p-0.5 shadow-sm">
            {safePan > 0 && (
              <button
                type="button"
                onClick={() => chart.timeScale().scrollToRealTime()}
                className="px-2 py-0.5 rounded bg-amber-50 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-700/60 font-mono text-[10px] font-bold flex items-center gap-1 hover:bg-amber-100 dark:hover:bg-amber-900/60 transition-colors animate-pulse cursor-pointer shadow-sm"
                title="Jump back to live candle"
              >
                <span>Live ◀</span>
                <span className="text-[9px] opacity-80">(-{safePan})</span>
              </button>
            )}
            {(visibleCandleCount !== 50 || safePan > 0) && safePan === 0 && (
              <button
                type="button"
                onClick={() => chart.timeScale().resetTimeScale()}
                className="px-1.5 py-0.5 rounded bg-white dark:bg-zinc-800 text-slate-700 dark:text-slate-200 hover:text-slate-900 dark:hover:text-white border border-slate-200 dark:border-zinc-700 font-mono text-[10px] transition-colors cursor-pointer shadow-sm"
                title="Reset zoom to default (50 candles)"
              >
                Reset
              </button>
            )}
            <button
              type="button"
              onClick={() => setVisibleCandleCount((prev) => Math.max(15, prev - 8))}
              className="w-5 h-5 sm:w-6 sm:h-6 rounded bg-white dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-zinc-700 font-bold text-xs flex items-center justify-center transition-colors cursor-pointer shadow-sm"
              title="Zoom In (+)"
            >
              +
            </button>
            <button
              type="button"
              onClick={() => setVisibleCandleCount((prev) => Math.min(150, prev + 8))}
              className="w-5 h-5 sm:w-6 sm:h-6 rounded bg-white dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-zinc-700 font-bold text-xs flex items-center justify-center transition-colors cursor-pointer shadow-sm"
              title="Zoom Out (-)"
            >
              -
            </button>
            <span className="px-1 text-[10px] font-mono text-slate-600 dark:text-slate-400 font-semibold">
              {visibleCandleCount}b
            </span>
          </div>
        </div>
      </div>

      {/* Canvas Viewport with Touch/Mouse Drag Panning */}
      <div
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ touchAction: 'pan-y' }}
        className="relative flex-1 min-h-[360px] sm:min-h-[400px] w-full max-w-full overflow-hidden bg-white dark:bg-zinc-950 cursor-grab active:cursor-grabbing select-none transition-colors"
      >
        {(candles.length < 2 || (candles.length > 0 && (
          (activeSymbol === 'XAUUSDm' && (candles[0].close < 1000 || candles[0].close > 10000 || Math.abs(candles[0].close - 3875.70) < 1.0)) ||
          (activeSymbol !== 'XAUUSDm' && activeSymbol !== 'USDJPYm' && candles[0].close > 100) ||
          (activeSymbol === 'USDJPYm' && (candles[0].close < 50 || candles[0].close > 300))
        ))) && (
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-indigo-500 to-transparent animate-pulse z-10" />
        )}
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block" />
      </div>
    </div>
  );
};
