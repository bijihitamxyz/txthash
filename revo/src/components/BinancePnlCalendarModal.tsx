'use client';

import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useBinanceStore } from '@/store/useBinanceStore';
import { Calendar, ChevronLeft, ChevronRight, X, RotateCcw } from 'lucide-react';

export const BinancePnlCalendarModal: React.FC = () => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const isPnlCalendarOpen = useBinanceStore((s) => s.isPnlCalendarOpen);
  const closePnlCalendar = useBinanceStore((s) => s.closePnlCalendar);
  const dailyPnlHistory = useBinanceStore((s) => s.dailyPnlHistory);
  const resetCalendarHistory = useBinanceStore((s) => s.resetCalendarHistory);

  const [currentDate, setCurrentDate] = useState(() => new Date());

  if (!isPnlCalendarOpen) return null;

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth(); // 0-indexed

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  const handlePrevMonth = () => {
    setCurrentDate(new Date(year, month - 1, 1));
  };

  const handleNextMonth = () => {
    setCurrentDate(new Date(year, month + 1, 1));
  };

  // Calendar math
  const firstDayOfMonth = new Date(year, month, 1).getDay(); // 0 is Sunday
  // Convert Sunday (0) to 6, Mon (1) to 0, etc.
  const startingCol = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Aggregate monthly stats
  let monthTotalPnl = 0;
  let monthTrades = 0;
  let monthWins = 0;
  let monthLosses = 0;
  let bestDayPnl = -Infinity;
  let worstDayPnl = Infinity;

  const calendarDays: Array<{
    dayNumber: number;
    dateStr: string;
    hasTrade: boolean;
    pnl: number;
    trades: number;
    wins: number;
    losses: number;
  }> = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const record = dailyPnlHistory[dateStr];
    const hasTrade = Boolean(record && record.trades > 0);
    const pnl = hasTrade ? record.pnl : 0;
    const trades = hasTrade ? record.trades : 0;
    const wins = hasTrade ? record.wins : 0;
    const losses = hasTrade ? record.losses : 0;

    if (hasTrade) {
      monthTotalPnl += pnl;
      monthTrades += trades;
      monthWins += wins;
      monthLosses += losses;
      if (pnl > bestDayPnl) bestDayPnl = pnl;
      if (pnl < worstDayPnl) worstDayPnl = pnl;
    }

    calendarDays.push({
      dayNumber: day,
      dateStr,
      hasTrade,
      pnl,
      trades,
      wins,
      losses,
    });
  }

  const winrate = monthTrades > 0 ? Number(((monthWins / monthTrades) * 100).toFixed(1)) : 0;
  const isNetProfit = monthTotalPnl >= 0;

  const modalContent = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-4 bg-slate-950/85 backdrop-blur-md overflow-y-auto animate-in fade-in duration-200 select-none"
      onClick={closePnlCalendar}
    >
      <div
        className="bg-[#181A20] border border-[#F3BA2F]/40 rounded-2xl max-w-2xl w-full p-4 sm:p-6 shadow-2xl relative text-slate-100 flex flex-col max-h-[92vh] my-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#F3BA2F]/20 border border-[#F3BA2F]/40 flex items-center justify-center text-[#F3BA2F]">
              <Calendar className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm sm:text-base text-white flex items-center gap-2">
                <span>Binance Futures Daily PnL Calendar</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#F3BA2F]/20 text-[#F3BA2F] border border-[#F3BA2F]/30">
                  USDT Ledger
                </span>
              </h3>
              <p className="text-[11px] text-slate-400">
                Audited daily realized performance and asymmetric lock history
              </p>
            </div>
          </div>
          <button
            onClick={closePnlCalendar}
            className="text-slate-400 hover:text-white transition-colors cursor-pointer p-1 rounded-lg hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Month Navigation & Highlights */}
        <div className="flex items-center justify-between mb-4 bg-[#0B0E11] p-3 rounded-xl border border-slate-800">
          <div className="flex items-center gap-2">
            <button
              onClick={handlePrevMonth}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="font-mono font-bold text-sm sm:text-base text-white px-2">
              {monthNames[month]} {year}
            </span>
            <button
              onClick={handleNextMonth}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-3 font-mono text-xs">
            <div className="text-right">
              <span className="text-[10px] text-slate-400 block uppercase">Net Realized PnL</span>
              <span className={`font-bold sm:text-sm ${isNetProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
                {isNetProfit ? '+' : ''}${monthTotalPnl.toFixed(2)} USDT
              </span>
            </div>
          </div>
        </div>

        {/* 4 Statistics Pills */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4 font-mono text-xs">
          <div className="bg-[#0B0E11] p-2.5 rounded-xl border border-slate-800 flex flex-col justify-between">
            <span className="text-[10px] text-slate-400 uppercase">Winrate</span>
            <span className="text-sm font-bold text-[#F3BA2F] mt-1">{winrate}%</span>
          </div>
          <div className="bg-[#0B0E11] p-2.5 rounded-xl border border-slate-800 flex flex-col justify-between">
            <span className="text-[10px] text-slate-400 uppercase">Total Trades</span>
            <span className="text-sm font-bold text-slate-100 mt-1">{monthTrades} trades</span>
          </div>
          <div className="bg-[#0B0E11] p-2.5 rounded-xl border border-slate-800 flex flex-col justify-between">
            <span className="text-[10px] text-slate-400 uppercase">Wins / Losses</span>
            <span className="text-sm font-bold text-emerald-400 mt-1">
              {monthWins} <span className="text-slate-500 font-normal">/</span> <span className="text-rose-400">{monthLosses}</span>
            </span>
          </div>
          <div className="bg-[#0B0E11] p-2.5 rounded-xl border border-slate-800 flex flex-col justify-between">
            <span className="text-[10px] text-slate-400 uppercase">Best Day</span>
            <span className="text-sm font-bold text-emerald-400 mt-1">
              {bestDayPnl !== -Infinity ? `+$${bestDayPnl.toFixed(2)}` : '$0.00'}
            </span>
          </div>
        </div>

        {/* Calendar Grid */}
        <div className="flex-1 overflow-y-auto">
          {/* Day of week headers */}
          <div className="grid grid-cols-7 gap-1.5 mb-1.5 text-center font-mono text-[10px] text-slate-400 font-bold uppercase tracking-wider">
            <span>Mon</span>
            <span>Tue</span>
            <span>Wed</span>
            <span>Thu</span>
            <span>Fri</span>
            <span>Sat</span>
            <span>Sun</span>
          </div>

          <div className="grid grid-cols-7 gap-1.5 font-mono text-xs">
            {/* Empty offset padding */}
            {Array.from({ length: startingCol }).map((_, idx) => (
              <div key={`offset_${idx}`} className="h-14 sm:h-16 rounded-xl bg-slate-900/30 border border-slate-800/40 opacity-30" />
            ))}

            {/* Days */}
            {calendarDays.map((d) => {
              const isProfit = d.pnl >= 0;
              return (
                <div
                  key={d.dateStr}
                  className={`h-14 sm:h-16 rounded-xl p-1.5 flex flex-col justify-between border transition-all ${
                    d.hasTrade
                      ? isProfit
                        ? 'bg-emerald-950/40 border-emerald-500/50 text-emerald-200'
                        : 'bg-rose-950/40 border-rose-500/50 text-rose-200'
                      : 'bg-[#0B0E11] border-slate-800/80 text-slate-500'
                  }`}
                >
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="font-semibold text-slate-300">{d.dayNumber}</span>
                    {d.hasTrade && (
                      <span className="text-[9px] opacity-75 font-sans">
                        {d.trades}t
                      </span>
                    )}
                  </div>

                  {d.hasTrade ? (
                    <div className="truncate">
                      <div className={`font-bold text-[10px] sm:text-[11px] truncate ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {isProfit ? '+' : ''}${d.pnl.toFixed(2)}
                      </div>
                    </div>
                  ) : (
                    <div className="text-[9px] text-slate-600 truncate">-</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="pt-3 border-t border-slate-800 mt-4 flex items-center justify-between text-[11px] font-mono text-slate-400 gap-2">
          <button
            type="button"
            onClick={resetCalendarHistory}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono text-rose-300 hover:text-white bg-rose-950/40 hover:bg-rose-900/60 border border-rose-800/60 rounded-lg transition-colors cursor-pointer shrink-0"
            title="Reset calendar history"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Reset Calendar History</span>
          </button>
          <button
            onClick={closePnlCalendar}
            className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-medium cursor-pointer"
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
