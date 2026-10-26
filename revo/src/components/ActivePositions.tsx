'use client';

import React, { useState, useEffect } from 'react';
import { useTradingStore } from '@/store/useTradingStore';
import { getPairProfile, formatPrice, evaluatePositionPnL } from '@/core/pairConfig';
import { X, CheckCircle, ShieldCheck, ArrowUpRight, ArrowDownRight, Scissors, Layers } from 'lucide-react';

export const ActivePositions: React.FC = () => {
  const [isMounted, setIsMounted] = useState(false);
  const openPositions = useTradingStore((s) => s.openPositions);
  const positions = useTradingStore((s) => s.positions);
  const isAutoTrading = useTradingStore((s) => s.isAutoTrading);
  const quotes = useTradingStore((s) => s.quotes);
  const closePosition = useTradingStore((s) => s.closePosition);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Client-side guard prevents SSR hydration mismatch
  if (!isMounted) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-center text-slate-500 text-xs shadow-md animate-pulse">
        <div className="flex items-center justify-center gap-2">
          <span className="w-2 h-2 rounded-full bg-slate-600 animate-ping" />
          <span>Loading positions ledger...</span>
        </div>
      </div>
    );
  }

  // Retain active open positions across reloads for passive quote updates and floating PnL/SL monitoring
  const activePositions = Array.isArray(openPositions) && openPositions.length > 0
    ? openPositions
    : (Array.isArray(positions) ? positions : []);

  if (activePositions.length === 0) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-center text-slate-500 text-xs shadow-md">
        {isAutoTrading
          ? 'No active open positions. Engine is scanning market for high-probability setups.'
          : 'No active open positions. Trading engine is idle. Click START AUTO-TRADING to begin autonomous execution.'}
      </div>
    );
  }

  const getTrailingStageBadge = (status: string) => {
    switch (status) {
      case 'ATR_TRAILING':
        return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 animate-pulse';
      case 'BREAKEVEN_LOCKED':
        return 'bg-sky-500/20 text-sky-300 border-sky-500/40';
      case 'PARTIAL_CLOSED_BE':
        return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
      case 'INITIAL':
      default:
        return 'bg-slate-800 text-slate-400 border-slate-700';
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg w-full max-w-full">
      {/* Header */}
      <div className="bg-slate-950/80 px-3 py-2 sm:px-4 sm:py-2.5 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-indigo-400" />
          <span className="font-bold text-white text-xs uppercase tracking-wider">
            Active Open Positions
          </span>
          <span className="px-2 py-0.5 rounded-full bg-indigo-950 text-indigo-300 border border-indigo-800 text-[10px] font-mono font-semibold">
            {activePositions.length} Active
          </span>
        </div>
      </div>

      {/* 1. MOBILE RESPONSIVE CARD VIEW (Horizontal Scroll-Free) */}
      <div className="block md:hidden p-2.5 space-y-2 font-mono">
        {activePositions.map((pos) => {
          const profile = getPairProfile(pos.symbol);
          const quote = quotes[pos.symbol];
          const pnlData = quote
            ? evaluatePositionPnL(pos, quote)
            : (pos.unrealizedPnl !== undefined
              ? {
                  curPrice: pos.entryPrice,
                  priceDiff: 0,
                  pnlPips: 0,
                  pnlUsd: pos.unrealizedPnl,
                  pnlPercent: 0,
                }
              : { curPrice: pos.entryPrice, priceDiff: 0, pnlPips: 0, pnlUsd: 0, pnlPercent: 0 });

          const { curPrice, pnlPips, pnlUsd } = pnlData;
          const isProfit = pnlUsd >= 0;

          return (
            <div
              key={pos.id}
              className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 flex flex-col gap-2 shadow-sm"
            >
              {/* Row 1: Symbol + Side Badge & Live PnL */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-slate-100 text-sm">{pos.symbol}</span>
                  <span
                    className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-bold ${
                      pos.side === 'BUY'
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                        : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                    }`}
                  >
                    {pos.side === 'BUY' ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                    {pos.side}
                  </span>
                  <span className="text-[10px] text-slate-500">#{pos.id.slice(-5)}</span>
                </div>

                <div className="text-right">
                  <div className={`font-bold text-sm ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {isProfit ? '+' : ''}${pnlUsd.toFixed(2)}
                  </div>
                  <div className={`text-[10px] ${isProfit ? 'text-emerald-500' : 'text-rose-500'}`}>
                    {isProfit ? '+' : ''}{pnlPips} pips
                  </div>
                </div>
              </div>

              {/* Row 2: Size/Lots & Entry -> Current Price */}
              <div className="flex items-center justify-between text-xs text-slate-400 border-t border-b border-slate-900 py-1.5">
                <div>
                  <span className="text-slate-500 text-[10px] block">Size</span>
                  <span className="text-slate-200 font-semibold">{pos.volume.toFixed(2)} Lots</span>
                </div>
                <div className="text-right">
                  <span className="text-slate-500 text-[10px] block">Entry → Current</span>
                  <span className="text-slate-200">
                    {formatPrice(pos.entryPrice, profile.digits)} →{' '}
                    <span className="text-slate-100 font-bold">{formatPrice(curPrice, profile.digits)}</span>
                  </span>
                </div>
              </div>

              {/* Row 3: TP1/Trailing Status Pill & Action Buttons */}
              <div className="flex items-center justify-between gap-2 pt-0.5">
                <div>
                  {pos.partialClosed ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-950/60 text-amber-300 border border-amber-800 text-[10px]">
                      <CheckCircle className="w-3 h-3 text-amber-400" />
                      50% Banked (BE Locked)
                    </span>
                  ) : (
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${getTrailingStageBadge(
                        pos.trailingStatus
                      )}`}
                    >
                      <ShieldCheck className="w-3 h-3" />
                      {pos.trailingStatus}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  {pos.volume >= 0.02 && !pos.partialClosed && (
                    <button
                      type="button"
                      onClick={() => closePosition(pos.id, Number((pos.volume * 0.5).toFixed(2)))}
                      className="px-2 py-1 rounded bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/40 text-[10px] cursor-pointer"
                    >
                      <Scissors className="w-3 h-3 inline mr-0.5" /> 50%
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => closePosition(pos.id)}
                    className="px-2.5 py-1 rounded bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/40 text-[11px] font-bold cursor-pointer transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 2. DESKTOP TABLE VIEW */}
      <div className="hidden md:block overflow-x-auto w-full">
        <table className="w-full text-left text-xs font-mono">
          <thead className="bg-slate-950/60 text-[10px] text-slate-400 uppercase tracking-wider border-b border-slate-800">
            <tr>
              <th className="px-3 py-2">Ticket</th>
              <th className="px-3 py-2">Symbol</th>
              <th className="px-3 py-2">Side</th>
              <th className="px-3 py-2">Lots</th>
              <th className="px-3 py-2">Entry</th>
              <th className="px-3 py-2">Current</th>
              <th className="px-3 py-2">SL / TP</th>
              <th className="px-3 py-2">Unrealized PnL</th>
              <th className="px-3 py-2">Partial Close</th>
              <th className="px-3 py-2">Trailing Stage</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-850">
            {activePositions.map((pos) => {
              const profile = getPairProfile(pos.symbol);
              const quote = quotes[pos.symbol];
              const pnlData = quote
                ? evaluatePositionPnL(pos, quote)
                : (pos.unrealizedPnl !== undefined
                  ? {
                      curPrice: pos.entryPrice,
                      priceDiff: 0,
                      pnlPips: 0,
                      pnlUsd: pos.unrealizedPnl,
                      pnlPercent: 0,
                    }
                  : { curPrice: pos.entryPrice, priceDiff: 0, pnlPips: 0, pnlUsd: 0, pnlPercent: 0 });

              const { curPrice, pnlPips, pnlUsd } = pnlData;
              const isProfit = pnlUsd >= 0;

              return (
                <tr key={pos.id} className="hover:bg-slate-850/50 transition-colors">
                  <td className="px-3 py-2.5 text-slate-400 font-sans text-[11px]">
                    #{pos.id.slice(-6)}
                  </td>
                  <td className="px-3 py-2.5 font-bold text-slate-200">
                    {pos.symbol}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-bold ${
                        pos.side === 'BUY'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                          : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                      }`}
                    >
                      {pos.side === 'BUY' ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                      {pos.side}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-slate-100 font-semibold">
                    {pos.volume.toFixed(2)}
                  </td>
                  <td className="px-3 py-2.5 text-slate-300">
                    {formatPrice(pos.entryPrice, profile.digits)}
                  </td>
                  <td className="px-3 py-2.5 text-slate-100 font-semibold">
                    {formatPrice(curPrice, profile.digits)}
                  </td>
                  <td className="px-3 py-2.5 text-[11px]">
                    <div className="text-rose-400">SL: {pos.currentSl > 0 ? formatPrice(pos.currentSl, profile.digits) : 'None'}</div>
                    <div className="text-emerald-400">TP: {pos.currentTp > 0 ? formatPrice(pos.currentTp, profile.digits) : 'None'}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className={`font-bold text-sm ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {isProfit ? '+' : ''}${pnlUsd.toFixed(2)}
                    </div>
                    <div className={`text-[10px] ${isProfit ? 'text-emerald-500' : 'text-rose-500'}`}>
                      {isProfit ? '+' : ''}{pnlPips} pips
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    {pos.partialClosed ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800 text-[10px]">
                        <CheckCircle className="w-3 h-3 text-amber-400" />
                        50% Banked
                      </span>
                    ) : (
                      <span className="text-slate-500 text-[11px]">Pending</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold border ${getTrailingStageBadge(
                        pos.trailingStatus
                      )}`}
                    >
                      <ShieldCheck className="w-3 h-3" />
                      {pos.trailingStatus}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right space-x-1">
                    {pos.volume >= 0.02 && !pos.partialClosed && (
                      <button
                        type="button"
                        onClick={() => closePosition(pos.id, Number((pos.volume * 0.5).toFixed(2)))}
                        className="px-2 py-1 rounded bg-amber-600/30 hover:bg-amber-600/50 text-amber-300 border border-amber-500/40 text-[10px] transition-colors cursor-pointer"
                        title="Close 50% lot now"
                      >
                        <Scissors className="w-3 h-3 inline mr-0.5" /> 50%
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => closePosition(pos.id)}
                      className="p-1 rounded bg-rose-600/20 hover:bg-rose-600/40 text-rose-300 border border-rose-500/40 transition-colors cursor-pointer"
                      title="Close entire position"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export const ActivePositionsTable = ActivePositions;
export default ActivePositions;
