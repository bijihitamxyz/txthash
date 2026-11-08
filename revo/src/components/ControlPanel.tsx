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
  ArrowUpRight,
  ArrowDownRight,
  Zap,
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
  const openTestOrder = useTradingStore((s) => s.openTestOrder);

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
    <aside className="w-full lg:w-96 bg-white border border-slate-200 rounded-xl p-3 sm:p-4 flex flex-col gap-3.5 text-xs shadow-sm select-none text-slate-900">
      {/* Title Header */}
      <div className="flex items-center justify-between border-b border-slate-200 pb-2.5">
        <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <Sliders className="w-4 h-4 text-indigo-600" />
          <span>Forex Trading Controls</span>
        </div>
      </div>

      {/* Prominent Full-Width Start/Stop Auto-Trading Button */}
      <div>
        <button
          type="button"
          onClick={() => toggleAutoTrading()}
          className={`w-full py-3.5 px-4 rounded-xl font-bold flex items-center justify-center gap-2 shadow-sm transition-all text-sm cursor-pointer ${
            isAutoTrading
              ? 'bg-rose-600 hover:bg-rose-700 text-white animate-pulse'
              : 'bg-indigo-600 hover:bg-indigo-700 text-white'
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

        <div className="flex items-center justify-between text-[11px] text-slate-500 mt-2 px-1 font-mono">
          <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${isAutoTrading ? 'bg-emerald-500 animate-ping' : 'bg-slate-400'}`} />
            <span className={isAutoTrading ? 'text-emerald-700 font-semibold' : 'text-slate-500'}>
              {isAutoTrading ? 'Scanner Radar Active' : 'Engine Idle'}
            </span>
          </span>
          <span className="text-slate-400">Autonomous Confluence</span>
        </div>
      </div>

      {/* 1. TARGET MARKET SELECTOR (Clean Radio Cards) */}
      <div className="space-y-2">
        <label className="text-[11px] font-semibold text-slate-700 uppercase tracking-wider block">
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
                    ? 'bg-indigo-50 border-indigo-300 text-indigo-950 font-bold shadow-sm'
                    : 'bg-slate-50 border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className={`p-2 rounded-lg shrink-0 ${isSelected ? 'bg-indigo-600 text-white' : 'bg-slate-200/70 text-slate-600'}`}>
                    {opt.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-slate-900 truncate">{opt.label}</div>
                    <div className="text-[10px] text-slate-500 font-normal truncate">{opt.sub}</div>
                  </div>
                </div>
                <div className={`w-3.5 h-3.5 rounded-full border shrink-0 flex items-center justify-center ml-2 ${isSelected ? 'border-indigo-600 bg-indigo-600' : 'border-slate-300'}`}>
                  {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-white"></span>}
                </div>
              </button>
            );
          })}
        </div>

        {/* Quick Symbol Focus Pills */}
        <div className="pt-1.5">
          <div className="text-[10px] text-slate-500 font-medium mb-1.5 flex items-center justify-between">
            <span>Quick Symbol Focus:</span>
            <span className="font-mono text-indigo-600 font-bold">{optimisticSymbol}</span>
          </div>
          <div className="grid grid-cols-4 gap-1.5 font-mono text-[11px]">
            {quickSymbols.map((sym) => (
              <button
                key={sym}
                type="button"
                onClick={() => handleSelectSymbol(sym)}
                className={`py-1.5 px-1 rounded-lg border text-center transition-all cursor-pointer font-semibold ${
                  optimisticSymbol === sym
                    ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                    : 'bg-slate-50 border-slate-200 text-slate-700 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                {sym.replace('USDm', '').replace('XAU', 'GOLD')}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 2. LOT SIZE PER ENTRY + PRESET PILLS */}
      <div className="bg-slate-50 p-3 sm:p-3.5 rounded-xl border border-slate-200 space-y-3">
        <div>
          <label className="text-[11px] font-semibold text-slate-700 uppercase tracking-wider block mb-1.5 flex items-center justify-between">
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
              className="flex-1 min-w-[70px] bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-slate-900 font-mono text-sm font-bold focus:border-indigo-600 focus:outline-none shadow-sm"
            />
            {/* Preset pills: 0.01, 0.02, 0.05, 0.10, 0.50 */}
            <div className="flex gap-1 shrink-0 font-mono">
              {[0.01, 0.02, 0.05, 0.1, 0.5].map((val) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setLotSize(val)}
                  className={`px-2 py-1.5 rounded-lg text-[11px] border transition-colors cursor-pointer ${
                    lotSize === val
                      ? 'bg-indigo-600 text-white border-indigo-600 font-bold shadow-sm'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {val.toFixed(2)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Quick Test Execution Buttons: TEST BUY / TEST SELL */}
        <div className="pt-2 border-t border-slate-200">
          <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-amber-500" />
              <span>Manual Test Execution</span>
            </span>
            <span className="text-indigo-600 font-mono font-bold">{activeFocus}</span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => openTestOrder('BUY')}
              className="py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold flex items-center justify-center gap-1.5 shadow-sm transition-all cursor-pointer font-mono text-xs"
            >
              <ArrowUpRight className="w-4 h-4" /> TEST BUY ({lotSize})
            </button>
            <button
              type="button"
              onClick={() => openTestOrder('SELL')}
              className="py-2.5 px-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold flex items-center justify-center gap-1.5 shadow-sm transition-all cursor-pointer font-mono text-xs"
            >
              <ArrowDownRight className="w-4 h-4" /> TEST SELL ({lotSize})
            </button>
          </div>
        </div>

        {/* Auto 50% Partial Close Toggle */}
        <label className="flex items-center justify-between text-xs text-slate-700 cursor-pointer pt-2 border-t border-slate-200">
          <span className="flex items-center gap-1.5 font-medium">
            <Shield className="w-3.5 h-3.5 text-amber-500" />
            Auto 50% Partial Close at Mid BB
          </span>
          <input
            type="checkbox"
            checked={enablePartialClose}
            onChange={(e) => setEnablePartialClose(e.target.checked)}
            className="w-4 h-4 rounded text-indigo-600 bg-white border-slate-300 cursor-pointer"
          />
        </label>
        <p className="text-[10px] text-slate-500 leading-relaxed font-sans">
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
              ? 'bg-rose-50 border-rose-300 text-rose-700 hover:bg-rose-100 cursor-pointer shadow-sm'
              : 'bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed'
          }`}
        >
          <AlertOctagon className="w-4 h-4 text-rose-600" />
          <span>PANIC CLOSE ALL ({positionCount} POSITIONS)</span>
        </button>
      </div>
    </aside>
  );
};

export default ControlPanel;
