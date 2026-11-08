'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTradingStore, getLocalDateString } from '@/store/useTradingStore';
import {
  ChevronLeft,
  ChevronRight,
  X,
  RotateCcw,
  CalendarDays,
  Check,
  TrendingUp,
  TrendingDown,
} from 'lucide-react';

interface PnlCalendarModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const PnlCalendarModal: React.FC<PnlCalendarModalProps> = ({ isOpen, onClose }) => {
  const [currentDate, setCurrentDate] = useState<Date>(() => new Date());
  const [isResetConfirmed, setIsResetConfirmed] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const dailyPnlHistory = useTradingStore((s) => s.dailyPnlHistory) || {};
  const resetCalendarHistory = useTradingStore((s) => s.resetCalendarHistory);

  // Close on Escape key press
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Keep date updated when modal opens
  useEffect(() => {
    if (isOpen) {
      setCurrentDate(new Date());
      setIsResetConfirmed(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth(); // 0-indexed (0 = Jan, 9 = Oct)
  const monthStr = String(month + 1).padStart(2, '0');
  const yearMonthKey = `${year}-${monthStr}`;
  const todayStr = getLocalDateString();

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const monthName = monthNames[month];

  // Month navigation
  const handlePrevMonth = () => {
    setCurrentDate((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
  };

  const handleNextMonth = () => {
    setCurrentDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
  };

  const handleResetToCurrentMonth = () => {
    setCurrentDate(new Date());
  };

  // Calendar math
  const firstDayOfWeek = new Date(year, month, 1).getDay(); // 0 = Sunday, 1 = Monday...
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Today metrics
  const todayRecord = dailyPnlHistory[todayStr];
  const todayPnl = Number((todayRecord?.pnl ?? 0).toFixed(2));
  const todayTrades = todayRecord?.trades ?? 0;
  const todayWins = todayRecord?.wins ?? 0;
  const todayLosses = todayRecord?.losses ?? 0;
  const todayWinrate =
    todayTrades > 0 ? Number(((todayWins / todayTrades) * 100).toFixed(1)) : 0;

  // Selected month metrics calculation
  const allTimeEntries = Object.entries(dailyPnlHistory);
  const monthEntries = allTimeEntries.filter(([dateKey]) => dateKey.startsWith(yearMonthKey));
  const monthPnl = Number(
    monthEntries.reduce((sum, [, item]) => sum + (item.pnl || 0), 0).toFixed(2)
  );
  const monthTrades = monthEntries.reduce((sum, [, item]) => sum + (item.trades || 0), 0);
  const monthWins = monthEntries.reduce((sum, [, item]) => sum + (item.wins || 0), 0);
  const monthLosses = monthEntries.reduce((sum, [, item]) => sum + (item.losses || 0), 0);
  const monthWinrate =
    monthTrades > 0 ? Number(((monthWins / monthTrades) * 100).toFixed(1)) : 0;

  const handleResetHistory = () => {
    resetCalendarHistory();
    setIsResetConfirmed(true);
    setTimeout(() => {
      setIsResetConfirmed(false);
    }, 2500);
  };

  const modalContent = (
    <div
      className="fixed inset-0 z-[100] bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto select-none animate-in fade-in duration-150"
      onClick={onClose}
    >
      {/* Modal Card */}
      <div
        className="max-w-md w-full bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl p-5 shadow-2xl relative flex flex-col font-sans my-auto transition-colors"
        onClick={(e) => e.stopPropagation()}
      >
        {/* =========================================================================
            TOP HEADER: Title + Month & Year + Prominent [✕] Close Button
            ========================================================================= */}
        <div className="flex items-start justify-between gap-2 border-b border-slate-100 dark:border-zinc-800 pb-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800/60 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0 shadow-xs">
              <CalendarDays className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm sm:text-base font-bold text-slate-900 dark:text-slate-100 tracking-wide truncate flex items-center gap-1.5">
                <span>Daily Realized PNL Calendar</span>
              </h2>
              <p className="text-xs text-indigo-600 dark:text-indigo-400 font-mono font-medium">
                {monthName} {year}
              </p>
            </div>
          </div>

          {/* Prominent [✕] Close button */}
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
            title="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* =========================================================================
            SUMMARY BADGES: Total Daily PNL | Win/Loss Count (1W / 0L) | Winrate %
            ========================================================================= */}
        <div className="grid grid-cols-3 gap-2 my-3 font-mono">
          {/* Badge 1: Total Daily PNL */}
          <div className="bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl p-2.5 flex flex-col justify-between shadow-xs min-w-0">
            <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wider font-semibold truncate">
              Total Daily PNL
            </span>
            <span
              className={`text-xs sm:text-sm font-bold truncate mt-0.5 ${
                todayPnl > 0
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : todayPnl < 0
                  ? 'text-rose-600 dark:text-rose-400'
                  : 'text-slate-700 dark:text-slate-300'
              }`}
            >
              {todayPnl > 0 ? '+' : ''}${todayPnl.toFixed(2)}
            </span>
            <span className="text-[9px] text-slate-400 dark:text-zinc-500 mt-0.5 truncate">
              {todayTrades} {todayTrades === 1 ? 'trade' : 'trades'} today
            </span>
          </div>

          {/* Badge 2: Win/Loss Count (1W / 0L) */}
          <div className="bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl p-2.5 flex flex-col justify-between shadow-xs min-w-0">
            <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wider font-semibold truncate">
              Win / Loss
            </span>
            <span className="text-xs sm:text-sm font-bold text-slate-900 dark:text-slate-100 truncate mt-0.5 flex items-center gap-1">
              <span className="text-emerald-600 dark:text-emerald-400">{todayWins}W</span>
              <span className="text-slate-400 dark:text-zinc-500">/</span>
              <span className="text-rose-600 dark:text-rose-400">{todayLosses}L</span>
            </span>
            <span className="text-[9px] text-slate-400 dark:text-zinc-500 mt-0.5 truncate">
              Mo: {monthWins}W / {monthLosses}L
            </span>
          </div>

          {/* Badge 3: Winrate % */}
          <div className="bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl p-2.5 flex flex-col justify-between shadow-xs min-w-0">
            <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wider font-semibold truncate">
              Winrate %
            </span>
            <span
              className={`text-xs sm:text-sm font-bold truncate mt-0.5 ${
                todayTrades > 0
                  ? todayWinrate >= 50
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-amber-600 dark:text-amber-400'
                  : monthTrades > 0
                  ? monthWinrate >= 50
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-amber-600 dark:text-amber-400'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              {todayTrades > 0
                ? `${todayWinrate.toFixed(1)}%`
                : monthTrades > 0
                ? `${monthWinrate.toFixed(1)}%`
                : '0.0%'}
            </span>
            <span className="text-[9px] text-slate-400 dark:text-zinc-500 mt-0.5 truncate">
              {todayTrades > 0 ? 'Today Rate' : 'Monthly Rate'}
            </span>
          </div>
        </div>

        {/* =========================================================================
            MONTH NAVIGATOR BAR: < Month Year >
            ========================================================================= */}
        <div className="flex items-center justify-between mb-2.5 bg-slate-50 dark:bg-zinc-950 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-zinc-800 font-mono text-xs">
          <button
            type="button"
            onClick={handlePrevMonth}
            className="p-1 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            title="Previous Month"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          <div className="flex items-center gap-2">
            <span className="font-bold text-slate-800 dark:text-slate-200 tracking-wide text-xs">
              {monthName} {year}
            </span>
            {yearMonthKey !== todayStr.slice(0, 7) && (
              <button
                type="button"
                onClick={handleResetToCurrentMonth}
                className="text-[10px] font-mono px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800 hover:bg-indigo-100 dark:hover:bg-indigo-900 transition-colors cursor-pointer font-semibold"
              >
                Today
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={handleNextMonth}
            className="p-1 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            title="Next Month"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* =========================================================================
            7-COLUMN CALENDAR GRID: S M T W T F S
            ========================================================================= */}
        <div className="bg-slate-50/50 dark:bg-zinc-950/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-2.5">
          {/* Day of Week Header: S M T W T F S */}
          <div className="grid grid-cols-7 gap-1 mb-1.5 text-center text-[10px] sm:text-[11px] font-mono font-bold text-slate-500 dark:text-slate-400 py-0.5 border-b border-slate-200 dark:border-zinc-800">
            <span className="text-rose-500">S</span>
            <span>M</span>
            <span>T</span>
            <span>W</span>
            <span>T</span>
            <span>F</span>
            <span className="text-indigo-500 dark:text-indigo-400">S</span>
          </div>

          {/* Calendar Grid Cells */}
          <div className="grid grid-cols-7 gap-1">
            {/* Empty leading padding slots before day 1 */}
            {Array.from({ length: firstDayOfWeek }).map((_, i) => (
              <div key={`empty-${i}`} className="min-h-[46px] rounded-lg" />
            ))}

            {/* Days of the selected month */}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const dayNum = i + 1;
              const dayStr = String(dayNum).padStart(2, '0');
              const dateKey = `${yearMonthKey}-${dayStr}`;
              const data = dailyPnlHistory[dateKey];
              const hasTraded = Boolean(data && data.trades > 0);
              const isToday = dateKey === todayStr;

              if (hasTraded) {
                const pnl = data.pnl;
                const isProfit = pnl > 0;
                const isLoss = pnl < 0;

                if (isProfit) {
                  return (
                    <div
                      key={dateKey}
                      className="bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 hover:border-emerald-400 dark:hover:border-emerald-600 rounded-lg p-1 min-h-[46px] flex flex-col justify-between items-center transition-all shadow-xs group"
                      title={`${dateKey}: +$${pnl.toFixed(2)} (${data.trades} trades, ${data.wins}W / ${data.losses}L)`}
                    >
                      <div className="flex items-center justify-between w-full">
                        <span className="text-slate-800 dark:text-slate-200 font-bold text-[11px] font-mono">
                          {dayNum}
                        </span>
                        {isToday && (
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        )}
                      </div>
                      <div className="text-emerald-600 dark:text-emerald-400 font-mono text-[9px] sm:text-[10px] font-bold tracking-tight text-center truncate w-full">
                        +{pnl.toFixed(2)}
                      </div>
                    </div>
                  );
                }

                if (isLoss) {
                  return (
                    <div
                      key={dateKey}
                      className="bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800 hover:border-rose-400 dark:hover:border-rose-600 rounded-lg p-1 min-h-[46px] flex flex-col justify-between items-center transition-all shadow-xs group"
                      title={`${dateKey}: -$${Math.abs(pnl).toFixed(2)} (${data.trades} trades, ${data.wins}W / ${data.losses}L)`}
                    >
                      <div className="flex items-center justify-between w-full">
                        <span className="text-slate-800 dark:text-slate-200 font-bold text-[11px] font-mono">
                          {dayNum}
                        </span>
                        {isToday && (
                          <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
                        )}
                      </div>
                      <div className="text-rose-600 dark:text-rose-400 font-mono text-[9px] sm:text-[10px] font-bold tracking-tight text-center truncate w-full">
                        -{Math.abs(pnl).toFixed(2)}
                      </div>
                    </div>
                  );
                }

                // Breakeven Day ($0.00)
                return (
                  <div
                    key={dateKey}
                    className="bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-lg p-1 min-h-[46px] flex flex-col justify-between items-center transition-all shadow-xs"
                    title={`${dateKey}: $0.00 (${data.trades} trades)`}
                  >
                    <div className="flex items-center justify-between w-full">
                      <span className="text-slate-800 dark:text-slate-200 font-bold text-[11px] font-mono">
                        {dayNum}
                      </span>
                      {isToday && (
                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                      )}
                    </div>
                    <div className="text-slate-500 dark:text-slate-400 font-mono text-[9px] sm:text-[10px] font-semibold text-center truncate w-full">
                      $0.00
                    </div>
                  </div>
                );
              }

              // No-trade day: clean date number
              return (
                <div
                  key={dateKey}
                  className="min-h-[46px] rounded-lg p-1 flex flex-col items-center justify-start hover:bg-slate-100 dark:hover:bg-zinc-800/60 transition-colors"
                >
                  <div className="flex items-center justify-center w-full">
                    {isToday ? (
                      <span className="w-5 h-5 rounded-full bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 flex items-center justify-center font-mono font-bold text-[10px] shadow-xs">
                        {dayNum}
                      </span>
                    ) : (
                      <span className="text-slate-400 dark:text-zinc-500 font-mono text-xs font-medium">
                        {dayNum}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* =========================================================================
            BOTTOM ACTION BAR: [Reset Calendar History] + Close Button
            ========================================================================= */}
        <div className="pt-3 border-t border-slate-200 dark:border-zinc-800 flex items-center justify-between gap-2 mt-3">
          <button
            type="button"
            onClick={handleResetHistory}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-mono rounded-lg transition-all border cursor-pointer font-medium ${
              isResetConfirmed
                ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-700'
                : 'bg-rose-50 dark:bg-rose-950/50 hover:bg-rose-100 dark:hover:bg-rose-900/60 text-rose-700 dark:text-rose-400 hover:text-rose-800 dark:hover:text-rose-300 border-rose-200 dark:border-rose-800/80'
            }`}
            title="Clear all stale test numbers and reset calendar ledger to $0.00"
          >
            {isResetConfirmed ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                <span>History Cleared!</span>
              </>
            ) : (
              <>
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset Calendar History</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 text-xs font-mono font-medium text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 rounded-lg transition-colors cursor-pointer border border-slate-200 dark:border-zinc-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );

  if (mounted && typeof document !== 'undefined') {
    return createPortal(modalContent, document.body);
  }

  return modalContent;
};

export default PnlCalendarModal;
