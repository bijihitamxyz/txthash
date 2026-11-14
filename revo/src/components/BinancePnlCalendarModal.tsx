'use client';

import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useBinanceStore, getTodayDateString } from '@/store/useBinanceStore';
import { Calendar, ChevronLeft, ChevronRight, X, RotateCcw } from 'lucide-react';

export const BinancePnlCalendarModal: React.FC = () => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const isPnlCalendarOpen = useBinanceStore((s) => s.isPnlCalendarOpen);
  const closePnlCalendar = useBinanceStore((s) => s.closePnlCalendar);
  const dailyPnlHistory = useBinanceStore((s) => s.dailyPnlHistory);
  const tradeHistory = useBinanceStore((s) => s.tradeHistory);
  const resetCalendarHistory = useBinanceStore((s) => s.resetCalendarHistory);

  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState<string>(() => getTodayDateString());

  if (!isPnlCalendarOpen) return null;

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const handlePrevMonth = () => setCurrentDate(new Date(year, month - 1, 1));
  const handleNextMonth = () => setCurrentDate(new Date(year, month + 1, 1));

  const firstDayOfMonth = new Date(year, month, 1).getDay();
  const startingCol = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let monthTotalPnl = 0;
  let monthTrades = 0;
  let monthWins = 0;
  let monthLosses = 0;
  let bestDayPnl = -Infinity;

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
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm overflow-y-auto animate-in fade-in duration-200 select-none"
      onClick={closePnlCalendar}
    >
      <div
        className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl max-w-2xl w-full p-5 sm:p-6 shadow-2xl relative text-slate-900 dark:text-slate-100 flex flex-col max-h-[92vh] my-auto transition-colors"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-3.5 border-b border-slate-200 dark:border-zinc-800 mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800/60 flex items-center justify-center text-emerald-700 dark:text-emerald-400">
              <Calendar className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm sm:text-base text-[#0F172A] dark:text-slate-100 flex items-center gap-2">
                <span>Binance USDⓈ-M Daily PnL Calendar</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-zinc-700">
                  USDT Ledger
                </span>
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Audited daily realized crypto performance and asymmetric lock history
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={closePnlCalendar}
            className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors cursor-pointer p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Month Navigation */}
        <div className="flex items-center justify-between mb-4 bg-slate-50 dark:bg-zinc-950 p-3 rounded-xl border border-slate-200 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePrevMonth}
              className="p-1.5 rounded-lg bg-white dark:bg-zinc-900 hover:bg-slate-100 dark:hover:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-slate-300 transition-colors cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="font-mono font-bold text-sm sm:text-base text-[#0F172A] dark:text-slate-100 px-2">
              {monthNames[month]} {year}
            </span>
            <button
              type="button"
              onClick={handleNextMonth}
              className="p-1.5 rounded-lg bg-white dark:bg-zinc-900 hover:bg-slate-100 dark:hover:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-slate-300 transition-colors cursor-pointer"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="text-right font-mono text-xs">
            <span className="text-[10px] text-slate-500 dark:text-slate-400 block uppercase">Net Realized PnL</span>
            <span className={`font-bold sm:text-sm ${isNetProfit ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
              {isNetProfit ? '+' : ''}${monthTotalPnl.toFixed(2)} USDT
            </span>
          </div>
        </div>

        {/* 4 Statistics Pills */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4 font-mono text-xs">
          <div className="bg-slate-50 dark:bg-zinc-950 p-2.5 rounded-xl border border-slate-200 dark:border-zinc-800 flex flex-col justify-between">
            <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase">Winrate</span>
            <span className="text-sm font-bold text-[#0F172A] dark:text-slate-100 mt-1">{winrate}%</span>
          </div>
          <div className="bg-slate-50 dark:bg-zinc-950 p-2.5 rounded-xl border border-slate-200 dark:border-zinc-800 flex flex-col justify-between">
            <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase">Total Trades</span>
            <span className="text-sm font-bold text-[#0F172A] dark:text-slate-100 mt-1">{monthTrades} trades</span>
          </div>
          <div className="bg-slate-50 dark:bg-zinc-950 p-2.5 rounded-xl border border-slate-200 dark:border-zinc-800 flex flex-col justify-between">
            <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase">Wins / Losses</span>
            <span className="text-sm font-bold text-emerald-700 dark:text-emerald-400 mt-1">
              {monthWins} <span className="text-slate-400 dark:text-zinc-500 font-normal">/</span> <span className="text-rose-600 dark:text-rose-400">{monthLosses}</span>
            </span>
          </div>
          <div className="bg-slate-50 dark:bg-zinc-950 p-2.5 rounded-xl border border-slate-200 dark:border-zinc-800 flex flex-col justify-between">
            <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase">Best Day</span>
            <span className="text-sm font-bold text-emerald-700 dark:text-emerald-400 mt-1">
              {bestDayPnl !== -Infinity ? `+$${bestDayPnl.toFixed(2)}` : '$0.00'}
            </span>
          </div>
        </div>

        {/* Calendar Grid */}
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-7 gap-1.5 mb-1.5 text-center font-mono text-[10px] text-slate-500 dark:text-slate-400 font-bold uppercase tracking-wider">
            <span>Mon</span>
            <span>Tue</span>
            <span>Wed</span>
            <span>Thu</span>
            <span>Fri</span>
            <span>Sat</span>
            <span>Sun</span>
          </div>

          <div className="grid grid-cols-7 gap-1.5 font-mono text-xs">
            {Array.from({ length: startingCol }).map((_, idx) => (
              <div key={`offset_${idx}`} className="h-14 sm:h-16 rounded-xl bg-slate-50/50 dark:bg-zinc-950/50 border border-slate-100 dark:border-zinc-800" />
            ))}

            {calendarDays.map((d) => {
              const isProfit = d.pnl >= 0;
              const isSelected = selectedDate === d.dateStr;
              return (
                <button
                  type="button"
                  key={d.dateStr}
                  onClick={() => setSelectedDate(d.dateStr)}
                  className={`h-14 sm:h-16 rounded-xl p-1.5 flex flex-col justify-between border text-left transition-all cursor-pointer ${
                    isSelected ? 'ring-2 ring-[#0F172A] dark:ring-emerald-400 ' : ''
                  }${
                    d.hasTrade
                      ? isProfit
                        ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-800/80 text-emerald-900 dark:text-emerald-200'
                        : 'bg-rose-50 dark:bg-rose-950/60 border-rose-200 dark:border-rose-800/80 text-rose-900 dark:text-rose-200'
                      : 'bg-white dark:bg-zinc-900 border-slate-200/80 dark:border-zinc-800 text-slate-400 dark:text-zinc-500 hover:bg-slate-50 dark:hover:bg-zinc-800/60'
                  }`}
                >
                  <div className="flex items-center justify-between w-full text-[10px]">
                    <span className="font-semibold text-slate-700 dark:text-slate-300">{d.dayNumber}</span>
                    {d.hasTrade && <span className="text-[9px] opacity-75 font-sans">{d.trades}t</span>}
                  </div>

                  {d.hasTrade ? (
                    <div className="truncate w-full">
                      <div className={`font-bold text-[10px] sm:text-[11px] truncate ${isProfit ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                        {isProfit ? '+' : ''}${d.pnl.toFixed(2)}
                      </div>
                    </div>
                  ) : (
                    <div className="text-[9px] text-slate-300 dark:text-zinc-600 truncate">-</div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Selected Day Entry & Trade History Breakdown */}
          {(() => {
            const dayLogs = tradeHistory.filter((item) => item.date === selectedDate);
            const daySummary = dailyPnlHistory[selectedDate];
            const dayPnl = daySummary?.pnl ?? 0;
            return (
              <div className="mt-4 pt-3 border-t border-slate-200 dark:border-zinc-800 space-y-2 font-mono">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-[#0F172A] dark:text-slate-100">
                    Entry &amp; Trade Log ({selectedDate})
                  </span>
                  <span
                    className={`font-bold ${
                      dayPnl >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                    }`}
                  >
                    Daily PnL: {dayPnl >= 0 ? '+' : ''}${dayPnl.toFixed(2)} USDT
                  </span>
                </div>
                {dayLogs.length === 0 ? (
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-zinc-950 border border-slate-200/80 dark:border-zinc-800 text-[11px] text-slate-400 dark:text-zinc-500 text-center">
                    No recorded entry or exit logs for {selectedDate}.
                  </div>
                ) : (
                  <div className="max-h-40 overflow-y-auto space-y-1.5 pr-1">
                    {dayLogs.map((item) => {
                      const hasPnl = typeof item.realizedPnl === 'number';
                      const isWin = (item.realizedPnl ?? 0) >= 0;
                      const pxDigits = item.entryPrice < 0.01 ? 7 : item.entryPrice < 1 ? 5 : item.entryPrice < 10 ? 4 : 2;
                      return (
                        <div
                          key={item.id}
                          className="p-2 rounded-xl bg-slate-50 dark:bg-zinc-950 border border-slate-200/80 dark:border-zinc-800 flex items-center justify-between gap-2 text-[11px]"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-slate-400 dark:text-zinc-500 shrink-0">
                              {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                            <span
                              className={`px-1.5 py-0.5 rounded text-[9px] font-bold border shrink-0 ${
                                item.side === 'LONG'
                                  ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/60'
                                  : 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800/60'
                              }`}
                            >
                              {item.side} {item.leverage}x
                            </span>
                            <span className="font-bold text-[#0F172A] dark:text-slate-100 shrink-0">{item.symbol}</span>
                            <span className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
                              {item.action.replace('_', ' ')} @ ${item.entryPrice.toFixed(pxDigits)}
                              {item.exitPrice ? ` -> $${item.exitPrice.toFixed(pxDigits)}` : ''}
                            </span>
                          </div>
                          <span
                            className={`font-bold shrink-0 ${
                              !hasPnl
                                ? 'text-sky-600 dark:text-sky-400'
                                : isWin
                                ? 'text-emerald-700 dark:text-emerald-400'
                                : 'text-rose-600 dark:text-rose-400'
                            }`}
                          >
                            {hasPnl ? `${isWin ? '+' : ''}$${item.realizedPnl!.toFixed(2)}` : 'ENTRY'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}
        </div>

        {/* Footer */}
        <div className="pt-3 border-t border-slate-200 dark:border-zinc-800 mt-4 flex items-center justify-between text-[11px] font-mono text-slate-500 dark:text-slate-400 gap-2">
          <button
            type="button"
            onClick={resetCalendarHistory}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono text-rose-700 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-950/60 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/60 rounded-xl transition-colors cursor-pointer shrink-0"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Reset History</span>
          </button>
          <button
            type="button"
            onClick={closePnlCalendar}
            className="px-4 py-1.5 rounded-xl bg-[#0F172A] hover:bg-[#1E293B] dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white font-semibold cursor-pointer transition-colors"
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
