'use client';

import React, { useState, useEffect } from 'react';
import { useTradingStore } from '@/store/useTradingStore';
import { getPairProfile, formatPrice, evaluatePositionPnL } from '@/core/pairConfig';
import { X, CheckCircle, ShieldCheck, ArrowUpRight, ArrowDownRight, Scissors, Layers } from 'lucide-react';

export const ActivePositions: React.FC = () => {
  const [isMounted, setIsMounted] = useState(false);
  const [closingIds, setClosingIds] = useState<Record<string, boolean>>({});
  const openPositions = useTradingStore((s) => s.openPositions);
  const positions = useTradingStore((s) => s.positions);
  const isAutoTrading = useTradingStore((s) => s.isAutoTrading);
  const quotes = useTradingStore((s) => s.quotes);
  const closePosition = useTradingStore((s) => s.closePosition);
  const modifyPosition = useTradingStore((s) => s.modifyPosition);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const handleClose = async (posId: string, vol?: number) => {
    setClosingIds((prev) => ({ ...prev, [posId]: true }));
    try {
      await closePosition(posId, vol);
    } catch (err) {
      console.error('Failed to close position:', err);
    } finally {
      setClosingIds((prev) => {
        const next = { ...prev };
        delete next[posId];
        return next;
      });
    }
  };

  // Client-side guard prevents SSR hydration mismatch
  if (!isMounted) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-6 text-center text-slate-500 text-xs shadow-sm animate-pulse">
        <div className="flex items-center justify-center gap-2">
          <span className="w-2 h-2 rounded-full bg-slate-400 animate-ping" />
          <span>Loading positions ledger...</span>
        </div>
      </div>
    );
  }

  // Retain active open positions across reloads for passive quote updates and floating PnL/SL monitoring
  const rawPositions = Array.isArray(openPositions) && openPositions.length > 0
    ? openPositions
    : (Array.isArray(positions) ? positions : []);
  const activePositions = rawPositions.filter((p) => p && p.id !== 'F-637' && p.id !== '#F-637');

  if (activePositions.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-6 text-center text-slate-500 text-xs shadow-sm">
        {isAutoTrading
          ? 'No active open positions. Engine is scanning market for high-probability setups.'
          : 'No active open positions. Trading engine is idle. Click START AUTO-TRADING to begin autonomous execution.'}
      </div>
    );
  }

  const getTrailingStageBadge = (status: string) => {
    switch (status) {
      case 'ATR_TRAILING':
        return 'bg-emerald-50 text-emerald-700 border-emerald-200 animate-pulse';
      case 'BREAKEVEN_LOCKED':
        return 'bg-sky-50 text-sky-700 border-sky-200';
      case 'PARTIAL_CLOSED_BE':
        return 'bg-amber-50 text-amber-800 border-amber-300';
      case 'INITIAL':
      default:
        return 'bg-slate-100 text-slate-600 border-slate-200';
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm w-full max-w-full text-slate-900">
      {/* Header */}
      <div className="bg-slate-50/80 px-3 py-2 sm:px-4 sm:py-2.5 border-b border-slate-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-indigo-600" />
          <span className="font-bold text-slate-900 text-xs uppercase tracking-wider">
            Active Open Positions
          </span>
          <span className="px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-mono font-semibold">
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
              className="bg-slate-50 border border-slate-200 rounded-xl p-3 flex flex-col gap-2 shadow-sm"
            >
              {/* Row 1: Symbol + Side Badge & Live PnL */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-slate-900 text-sm">{pos.symbol}</span>
                  <span
                    className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-bold ${
                      pos.side === 'BUY'
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        : 'bg-rose-50 text-rose-700 border border-rose-200'
                    }`}
                  >
                    {pos.side === 'BUY' ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                    {pos.side}
                  </span>
                  <span className="text-[10px] text-slate-500">#{pos.id.slice(-5)}</span>
                </div>

                <div className="text-right">
                  <div className={`font-bold text-sm ${isProfit ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {isProfit ? '+' : ''}${pnlUsd.toFixed(2)}
                  </div>
                  <div className={`text-[10px] ${isProfit ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {isProfit ? '+' : ''}{pnlPips} pips
                  </div>
                </div>
              </div>

              {/* Row 2: Size/Lots & Entry -> Current Price */}
              <div className="flex items-center justify-between text-xs text-slate-600 border-t border-b border-slate-200 py-1.5">
                <div>
                  <span className="text-slate-500 text-[10px] block">Size</span>
                  <span className="text-slate-900 font-semibold">{pos.volume.toFixed(2)} Lots</span>
                </div>
                <div className="text-right">
                  <span className="text-slate-500 text-[10px] block">Entry → Current</span>
                  <span className="text-slate-800">
                    {formatPrice(pos.entryPrice, profile.digits)} →{' '}
                    <span className="text-slate-900 font-bold">{formatPrice(curPrice, profile.digits)}</span>
                  </span>
                </div>
              </div>

              {/* Row 3: TP1/Trailing Status Pill & Action Buttons */}
              <div className="flex items-center justify-between gap-2 pt-0.5">
                <div>
                  {pos.partialClosed ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-300 text-[10px]">
                      <CheckCircle className="w-3 h-3 text-amber-600" />
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
                  <button
                    type="button"
                    onClick={() => {
                      const newSl = pos.side === 'BUY'
                        ? Number((pos.entryPrice - 20 * profile.pipValue).toFixed(profile.digits))
                        : Number((pos.entryPrice + 20 * profile.pipValue).toFixed(profile.digits));
                      const newTp = pos.side === 'BUY'
                        ? Number((pos.entryPrice + 50 * profile.pipValue).toFixed(profile.digits))
                        : Number((pos.entryPrice - 50 * profile.pipValue).toFixed(profile.digits));
                      modifyPosition(pos.id, newSl, newTp);
                    }}
                    className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 text-[10px] cursor-pointer"
                  >
                    SL/TP
                  </button>
                  {pos.volume >= 0.02 && !pos.partialClosed && (
                    <button
                      type="button"
                      onClick={() => handleClose(pos.id, Number((pos.volume * 0.5).toFixed(2)))}
                      disabled={closingIds[pos.id]}
                      className="px-2 py-1 rounded bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 text-[10px] cursor-pointer disabled:opacity-50"
                    >
                      <Scissors className="w-3 h-3 inline mr-0.5" /> 50%
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleClose(pos.id)}
                    disabled={closingIds[pos.id]}
                    className="px-2.5 py-1 rounded bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-300 text-[11px] font-bold cursor-pointer transition-colors disabled:opacity-50"
                  >
                    {closingIds[pos.id] ? 'Closing...' : 'Close'}
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
          <thead className="bg-slate-50 text-[10px] text-slate-500 uppercase tracking-wider border-b border-slate-200">
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
          <tbody className="divide-y divide-slate-100">
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
                <tr key={pos.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-3 py-2.5 text-slate-500 font-sans text-[11px]">
                    #{pos.id.slice(-6)}
                  </td>
                  <td className="px-3 py-2.5 font-bold text-slate-900">
                    {pos.symbol}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-bold ${
                        pos.side === 'BUY'
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : 'bg-rose-50 text-rose-700 border border-rose-200'
                      }`}
                    >
                      {pos.side === 'BUY' ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                      {pos.side}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-slate-900 font-semibold">
                    {pos.volume.toFixed(2)}
                  </td>
                  <td className="px-3 py-2.5 text-slate-700">
                    {formatPrice(pos.entryPrice, profile.digits)}
                  </td>
                  <td className="px-3 py-2.5 text-slate-900 font-semibold">
                    {formatPrice(curPrice, profile.digits)}
                  </td>
                  <td className="px-3 py-2.5 text-[11px]">
                    <div className="text-rose-700">SL: {pos.currentSl > 0 ? formatPrice(pos.currentSl, profile.digits) : 'None'}</div>
                    <div className="text-emerald-700">TP: {pos.currentTp > 0 ? formatPrice(pos.currentTp, profile.digits) : 'None'}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className={`font-bold text-sm ${isProfit ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {isProfit ? '+' : ''}${pnlUsd.toFixed(2)}
                    </div>
                    <div className={`text-[10px] ${isProfit ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {isProfit ? '+' : ''}{pnlPips} pips
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    {pos.partialClosed ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-300 text-[10px]">
                        <CheckCircle className="w-3 h-3 text-amber-600" />
                        50% Banked
                      </span>
                    ) : (
                      <span className="text-slate-400 text-[11px]">Pending</span>
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
                    <button
                      type="button"
                      onClick={() => {
                        const newSl = pos.side === 'BUY'
                          ? Number((pos.entryPrice - 20 * profile.pipValue).toFixed(profile.digits))
                          : Number((pos.entryPrice + 20 * profile.pipValue).toFixed(profile.digits));
                        const newTp = pos.side === 'BUY'
                          ? Number((pos.entryPrice + 50 * profile.pipValue).toFixed(profile.digits))
                          : Number((pos.entryPrice - 50 * profile.pipValue).toFixed(profile.digits));
                        modifyPosition(pos.id, newSl, newTp);
                      }}
                      className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 text-[10px] transition-colors cursor-pointer"
                      title="Set Test SL/TP"
                    >
                      SL/TP
                    </button>
                    {pos.volume >= 0.02 && !pos.partialClosed && (
                      <button
                        type="button"
                        onClick={() => handleClose(pos.id, Number((pos.volume * 0.5).toFixed(2)))}
                        disabled={closingIds[pos.id]}
                        className="px-2 py-1 rounded bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 text-[10px] transition-colors cursor-pointer disabled:opacity-50"
                        title="Close 50% lot now"
                      >
                        <Scissors className="w-3 h-3 inline mr-0.5" /> 50%
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleClose(pos.id)}
                      disabled={closingIds[pos.id]}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-300 text-[11px] font-bold transition-colors cursor-pointer disabled:opacity-50"
                      title="Close entire position"
                    >
                      <X className="w-3.5 h-3.5" />
                      <span>{closingIds[pos.id] ? 'Closing...' : 'Close'}</span>
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
