'use client';

import React from 'react';
import { useTradingStore } from '@/store/useTradingStore';
import { EXNESS_PAIR_PROFILES, getPairProfile } from '@/core/pairConfig';
import { TargetMarket } from '@/lib/stateSync';
import {
  Play,
  Square,
  AlertOctagon,
  Sliders,
  Layers,
  Shield,
  Coins,
  TrendingUp,
} from 'lucide-react';

export const ControlPanel: React.FC = () => {
  const targetMarket = useTradingStore((s) => s.targetMarket);
  const setTargetMarket = useTradingStore((s) => s.setTargetMarket);
  const focusSymbol = useTradingStore((s) => s.focusSymbol);
  const selectedSymbol = useTradingStore((s) => s.selectedSymbol);
  const setFocusSymbol = useTradingStore((s) => s.setFocusSymbol);
  const isAutoTrading = useTradingStore((s) => s.isAutoTrading);
  const toggleAutoTrading = useTradingStore((s) => s.toggleAutoTrading);
  const panicCloseAll = useTradingStore((s) => s.panicCloseAll);
  const openPositions = useTradingStore((s) => s.openPositions);
  const positions = useTradingStore((s) => s.positions);
  const positionCount = openPositions?.length ?? positions?.length ?? 0;
  const lotSize = useTradingStore((s) => s.lotSize);
  const setLotSize = useTradingStore((s) => s.setLotSize);
  const enablePartialClose = useTradingStore((s) => s.enablePartialClose);
  const setEnablePartialClose = useTradingStore((s) => s.setEnablePartialClose);

  const activeFocus = focusSymbol || selectedSymbol || 'XAUUSDm';

  // Optimistic UI state to decouple UI interactions from API latency
  const [optimisticMarket, setOptimisticMarket] = React.useState<TargetMarket>(targetMarket);
  const [optimisticSymbol, setOptimisticSymbol] = React.useState<string>(activeFocus);

  React.useEffect(() => {
    setOptimisticMarket(targetMarket);
  }, [targetMarket]);

  React.useEffect(() => {
    setOptimisticSymbol(activeFocus);
  }, [activeFocus]);

  const handleSelectMarket = (marketId: TargetMarket) => {
    setOptimisticMarket(marketId);
    const nextSym = marketId === 'FOREX' ? 'EURUSDm' : 'XAUUSDm';
    setOptimisticSymbol(nextSym);
    setTargetMarket(marketId);
  };

  const handleSelectSymbol = (sym: string) => {
    setOptimisticSymbol(sym);
    setFocusSymbol(sym);
  };

  const marketOptions: { id: TargetMarket; label: string; sub: string; icon: React.ReactNode }[] = [
    {
      id: 'GOLD',
      label: 'Gold (XAUUSDm)',
      sub: 'Ultra-High Volatility & Deep Liquidity',
      icon: <Coins className="w-4 h-4 text-amber-400" />,
    },
    {
      id: 'FOREX',
      label: 'Forex Majors',
      sub: 'EURUSDm, GBPUSDm, USDJPYm',
      icon: <TrendingUp className="w-4 h-4 text-sky-400" />,
    },
    {
      id: 'BOTH',
      label: 'Multi-Pair Scanner',
      sub: 'Autonomous Multi-Pair Confluence Scanner',
      icon: <Layers className="w-4 h-4 text-purple-400" />,
    },
  ];

  const quickSymbols = ['XAUUSDm', 'EURUSDm', 'GBPUSDm', 'USDJPYm'];

  return (
    <aside className="w-full lg:w-96 bg-slate-900 border border-slate-800 rounded-xl p-3 sm:p-4 flex flex-col gap-3.5 text-xs shadow-xl select-none">
      {/* Title Header */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
        <div className="flex items-center gap-2 text-sm font-bold text-white">
          <Sliders className="w-4 h-4 text-indigo-400" />
          <span>Forex Trading Controls</span>
        </div>
      </div>

      {/* Prominent Full-Width Gradient Start/Stop Auto-Trading Button */}
      <div>
        <button
          type="button"
          onClick={() => toggleAutoTrading()}
          className={`w-full py-3.5 px-4 rounded-xl font-bold flex items-center justify-center gap-2 shadow-lg transition-all text-sm cursor-pointer ${
            isAutoTrading
              ? 'bg-gradient-to-r from-rose-600 via-rose-500 to-red-600 hover:from-rose-500 hover:to-red-500 text-white shadow-rose-950/50 animate-pulse'
              : 'bg-gradient-to-r from-emerald-600 via-emerald-500 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white shadow-emerald-950/50'
          }`}
        >
          {isAutoTrading ? (
            <>
              <Square className="w-4 h-4 fill-white" />
              <span>STOP AUTO-TRADING</span>
            </>
          ) : (
            <>
              <Play className="w-4 h-4 fill-white" />
              <span>START AUTO-TRADING</span>
            </>
          )}
        </button>

        <div className="flex items-center justify-between text-[11px] text-slate-400 mt-2 px-1 font-mono">
          <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${isAutoTrading ? 'bg-emerald-400 animate-ping' : 'bg-slate-600'}`} />
            <span>{isAutoTrading ? 'Scanner Radar Active' : 'Engine Idle'}</span>
          </span>
          <span className="text-slate-500">Autonomous Confluence</span>
        </div>
      </div>

      {/* 1. TARGET MARKET SELECTOR (Clean Radio Cards) */}
      <div className="space-y-2">
        <label className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider block">
          Target Market
        </label>
        <div className="flex flex-col gap-2">
          {marketOptions.map((opt) => {
            const isSelected = optimisticMarket === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => handleSelectMarket(opt.id)}
                className={`p-2.5 sm:p-3 rounded-xl text-left transition-all border cursor-pointer flex items-center justify-between ${
                  isSelected
                    ? 'bg-indigo-600/20 border-indigo-500 text-indigo-100 font-bold shadow-md shadow-indigo-950'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className={`p-2 rounded-lg shrink-0 ${isSelected ? 'bg-indigo-600/40 text-white' : 'bg-slate-900 text-slate-400'}`}>
                    {opt.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-slate-200 truncate">{opt.label}</div>
                    <div className="text-[10px] text-slate-400 font-normal truncate">{opt.sub}</div>
                  </div>
                </div>
                <div className={`w-3.5 h-3.5 rounded-full border shrink-0 flex items-center justify-center ml-2 ${isSelected ? 'border-indigo-400 bg-indigo-500' : 'border-slate-700'}`}>
                  {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-white"></span>}
                </div>
              </button>
            );
          })}
        </div>

        {/* Quick Symbol Focus Pills */}
        <div className="pt-1.5">
          <div className="text-[10px] text-slate-400 font-medium mb-1.5 flex items-center justify-between">
            <span>Quick Symbol Focus:</span>
            <span className="font-mono text-indigo-300 font-bold">{optimisticSymbol}</span>
          </div>
          <div className="grid grid-cols-4 gap-1.5 font-mono text-[11px]">
            {quickSymbols.map((sym) => (
              <button
                key={sym}
                type="button"
                onClick={() => handleSelectSymbol(sym)}
                className={`py-1.5 px-1 rounded-lg border text-center transition-all cursor-pointer font-semibold ${
                  optimisticSymbol === sym
                    ? 'bg-indigo-600 text-white border-indigo-400 shadow-sm'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
                }`}
              >
                {sym.replace('USDm', '').replace('XAU', 'GOLD')}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 2. LOT SIZE PER ENTRY + PRESET PILLS */}
      <div className="bg-slate-950 p-3 sm:p-3.5 rounded-xl border border-slate-800 space-y-3">
        <div>
          <label className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider block mb-1.5 flex items-center justify-between">
            <span>Lot Size per Entry</span>
            <span className="text-[10px] text-slate-500 font-mono">Step: 0.01</span>
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              step="0.01"
              min="0.01"
              max="10.0"
              value={lotSize}
              onChange={(e) => setLotSize(parseFloat(e.target.value) || 0.01)}
              className="flex-1 min-w-[70px] bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-slate-100 font-mono text-sm font-bold focus:border-indigo-500 focus:outline-none"
            />
            {/* Preset pills: 0.01, 0.02, 0.05, 0.10 */}
            <div className="flex gap-1 shrink-0 font-mono">
              {[0.01, 0.02, 0.05, 0.1].map((val) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setLotSize(val)}
                  className={`px-2 py-1.5 rounded-lg text-[11px] border transition-colors cursor-pointer ${
                    lotSize === val
                      ? 'bg-indigo-600 text-white border-indigo-500 font-bold shadow-sm'
                      : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
                  }`}
                >
                  {val.toFixed(2)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Auto 50% Partial Close Toggle */}
        <label className="flex items-center justify-between text-xs text-slate-200 cursor-pointer pt-2 border-t border-slate-800/80">
          <span className="flex items-center gap-1.5 font-medium">
            <Shield className="w-3.5 h-3.5 text-amber-400" />
            Auto 50% Partial Close at Mid BB
          </span>
          <input
            type="checkbox"
            checked={enablePartialClose}
            onChange={(e) => setEnablePartialClose(e.target.checked)}
            className="w-4 h-4 rounded text-indigo-600 bg-slate-900 border-slate-700 cursor-pointer"
          />
        </label>
        <p className="text-[10px] text-slate-400 leading-relaxed font-sans">
          Automatically banks 50% profits when price reaches 70% toward Middle BB and locks stop loss at Breakeven.
        </p>
      </div>

      {/* Emergency Panic Close Button */}
      <div className="pt-0.5">
        <button
          type="button"
          onClick={panicCloseAll}
          disabled={positionCount === 0}
          className={`w-full py-2.5 px-3 rounded-xl border font-bold flex items-center justify-center gap-2 transition-all text-xs font-mono ${
            positionCount > 0
              ? 'bg-rose-950/80 border-rose-700 text-rose-300 hover:bg-rose-900 cursor-pointer shadow-md shadow-rose-950'
              : 'bg-slate-950 border-slate-800 text-slate-600 cursor-not-allowed'
          }`}
        >
          <AlertOctagon className="w-4 h-4 text-rose-400" />
          <span>PANIC CLOSE ALL ({positionCount} POSITIONS)</span>
        </button>
      </div>
    </aside>
  );
};

export default ControlPanel;
