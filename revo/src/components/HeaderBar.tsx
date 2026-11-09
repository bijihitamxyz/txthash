'use client';

import React, { useState, useEffect } from 'react';
import { useTradingStore, getLocalDateString } from '@/store/useTradingStore';
import { getActiveExnessCredentials, isVaultConfigured } from '@/lib/cryptoVault';
import { evaluatePositionPnL } from '@/core/pairConfig';
import { PnlCalendarModal } from './PnlCalendarModal';
import { useLicense } from './LicenseGate';
import { useRoomStore } from '@/store/useRoomStore';
import { useBinanceStore } from '@/store/useBinanceStore';
import {
  Key,
  Activity,
  DollarSign,
  PieChart,
  LogOut,
  Calendar,
  Sparkles,
  ShieldCheck,
  BrainCircuit,
} from 'lucide-react';

export interface HeaderBarProps {
  activeWorkspace?: 'FOREX' | 'CRYPTO';
  onWorkspaceChange?: (workspace: 'FOREX' | 'CRYPTO') => void;
  onSwitchToCrypto?: () => void;
}

export const HeaderBar: React.FC<HeaderBarProps> = ({
  activeWorkspace: propActiveWorkspace,
  onWorkspaceChange,
  onSwitchToCrypto,
}) => {
  const [isMounted, setIsMounted] = useState(false);
  const [isForexCalendarOpen, setIsForexCalendarOpen] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Room store & active workspace resolution
  const activeRoom = useRoomStore((s) => s.activeRoom);
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom);

  const currentWorkspace: 'FOREX' | 'CRYPTO' = propActiveWorkspace || (
    activeRoom === 'CRYPTO' || (activeRoom as string) === 'ROOM_2_BINANCE' ? 'CRYPTO' : 'FOREX'
  );

  // FOREX Store Hooks
  const balance = useTradingStore((s) => s.balance);
  const equity = useTradingStore((s) => s.equity);
  const accountInfo = useTradingStore((s) => s.accountInfo);
  const credentials = useTradingStore((s) => s.credentials);
  const accountMode = useTradingStore((s) => s.accountMode);
  const setAccountMode = useTradingStore((s) => s.setAccountMode);
  const isAutoTrading = useTradingStore((s) => s.isAutoTrading);
  const isTickRunning = useTradingStore((s) => s.isTickRunning);
  const openApiKeyModal = useTradingStore((s) => s.openApiKeyModal);
  const openAiModal = useTradingStore((s) => s.openAiModal);
  const openPositions = useTradingStore((s) => s.openPositions);
  const positions = useTradingStore((s) => s.positions);
  const quotes = useTradingStore((s) => s.quotes);
  const dailyPnlHistory = useTradingStore((s) => s.dailyPnlHistory);

  // CRYPTO Store Hooks
  const cryptoWalletBalance = useBinanceStore((s) => s.walletBalance);
  const cryptoUnrealizedProfit = useBinanceStore((s) => s.unrealizedProfit);
  const cryptoDailyPnl = useBinanceStore((s) => s.dailyPnl);
  const cryptoDailyPnlPercent = useBinanceStore((s) => s.dailyPnlPercent);
  const isTestnet = useBinanceStore((s) => s.isTestnet);
  const activeCryptoExchange = useBinanceStore((s) => s.activeExchange);
  const isCryptoVaultConfigured = useBinanceStore((s) => s.isVaultConfigured);
  const openCryptoVaultModal = useBinanceStore((s) => s.openVaultModal);
  const openCryptoPnlCalendar = useBinanceStore((s) => s.openPnlCalendar);
  const cryptoIsAutoTrading = useBinanceStore((s) => s.isAutoTrading);
  const cryptoIsScanning = useBinanceStore((s) => s.isScanning);

  // License Hook
  const { license, remainingDays, logout } = useLicense();

  const handleWorkspaceSelect = (ws: 'FOREX' | 'CRYPTO') => {
    onWorkspaceChange?.(ws);
    setActiveRoom(ws);
    if (ws === 'CRYPTO' && onSwitchToCrypto) {
      onSwitchToCrypto();
    }
  };

  const handleModeSelect = (mode: 'DEMO' | 'REAL') => {
    if (currentWorkspace === 'FOREX') {
      setAccountMode(mode);
    } else {
      const wantTestnet = mode === 'DEMO';
      useBinanceStore.setState({ isTestnet: wantTestnet });
    }
  };

  // FOREX Calculations
  const activeCreds = getActiveExnessCredentials(credentials);
  const isForexAccountLive = Boolean(accountInfo?.connected);
  const forexBalance: number | null = isForexAccountLive ? (accountInfo?.balance ?? balance ?? null) : null;

  const rawPositions = Array.isArray(openPositions) && openPositions.length > 0
    ? openPositions
    : (Array.isArray(positions) ? positions : []);
  const activePositions = rawPositions.filter((p) => p && p.id !== 'F-637' && p.id !== '#F-637');

  const totalUnrealizedPnl = activePositions.reduce((sum, pos) => {
    const quote = quotes[pos.symbol];
    if (quote) {
      return sum + evaluatePositionPnL(pos, quote).pnlUsd;
    }
    return sum + (pos.unrealizedPnl || 0);
  }, 0);
  const forexDynamicEquity: number | null = isForexAccountLive
    ? (accountInfo?.equity !== null && accountInfo?.equity !== undefined && accountInfo.equity > 0
        ? accountInfo.equity
        : (forexBalance !== null ? Number((forexBalance + totalUnrealizedPnl).toFixed(2)) : null))
    : null;

  const todayDateStr = getLocalDateString();
  const todayRecord = dailyPnlHistory?.[todayDateStr];
  const hasTradedToday = isForexAccountLive && Boolean(todayRecord && todayRecord.trades > 0);
  const forexDailyRealizedPnL: number | null = isForexAccountLive
    ? (hasTradedToday ? (todayRecord?.pnl ?? 0) : (accountInfo?.dailyRealizedPnL ?? 0))
    : null;
  const baseForPercent = (forexBalance !== null && forexBalance > 0) ? forexBalance : 1.0;
  const forexDailyPnlPercent: number | null = (isForexAccountLive && forexDailyRealizedPnL !== null)
    ? Number(((forexDailyRealizedPnL / baseForPercent) * 100).toFixed(2))
    : null;

  // Current Workspace Unified Values
  const isForex = currentWorkspace === 'FOREX';
  const engineActive = isForex
    ? (isAutoTrading || isTickRunning)
    : (cryptoIsAutoTrading || cryptoIsScanning);

  const isDemo = isForex ? accountMode === 'DEMO' : isTestnet;

  const displayBalance: number | null = isForex ? forexBalance : cryptoWalletBalance;
  const displayEquity: number | null = isForex
    ? forexDynamicEquity
    : Number((cryptoWalletBalance + cryptoUnrealizedProfit).toFixed(2));
  const isEquityUp = (displayEquity !== null && displayBalance !== null) ? displayEquity >= displayBalance : true;

  const displayDailyPnl: number | null = isForex ? forexDailyRealizedPnL : cryptoDailyPnl;
  const displayDailyPercent: number | null = isForex ? forexDailyPnlPercent : cryptoDailyPnlPercent;
  const isDailyPnlUp = (displayDailyPnl !== null) ? displayDailyPnl >= 0 : true;

  const isLiveConnected = isForex ? isForexAccountLive : isCryptoVaultConfigured;

  const handleOpenDailyCalendar = () => {
    if (isForex) {
      setIsForexCalendarOpen(true);
    } else {
      openCryptoPnlCalendar();
    }
  };

  const handleOpenVault = () => {
    if (isForex) {
      openApiKeyModal();
    } else {
      openCryptoVaultModal();
    }
  };

  if (!isMounted) {
    return (
      <header className="bg-white border-b border-slate-200 px-3 py-2 sm:px-4 sm:py-2.5 sticky top-0 z-40 select-none shadow-sm">
        <div className="max-w-[1920px] mx-auto flex flex-col gap-2 animate-pulse">
          <div className="h-9 bg-slate-100 rounded-xl border border-slate-200" />
          <div className="grid grid-cols-3 gap-2">
            <div className="h-12 bg-slate-100 rounded-xl border border-slate-200" />
            <div className="h-12 bg-slate-100 rounded-xl border border-slate-200" />
            <div className="h-12 bg-slate-100 rounded-xl border border-slate-200" />
          </div>
          <div className="h-7 bg-slate-100 rounded-lg border border-slate-200" />
        </div>
      </header>
    );
  }

  return (
    <>
      <header className="bg-white/95 border-b border-slate-200 px-3 py-2 sm:px-4 sm:py-2.5 sticky top-0 z-40 select-none shadow-sm backdrop-blur-md text-slate-900">
      <div className="max-w-[1920px] mx-auto flex flex-col gap-2 sm:gap-2.5">
        {/* ROW 1: Sleek Brand Logo + Segmented FOREX/CRYPTO Switcher + Compact DEMO/REAL Mode Toggle */}
        <div className="flex items-center justify-between gap-2 sm:gap-4">
          {/* Brand Logo & Engine Activity Indicator */}
          <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
            <div className="relative">
              <div className="w-8 h-8 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-sm">
                <Sparkles className="w-4 h-4 text-white" />
              </div>
              {engineActive && (
                <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-600"></span>
                </span>
              )}
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="font-extrabold text-xs sm:text-sm text-slate-900 tracking-wider flex items-center gap-1">
                  <span>NEMESIS X</span>
                  <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 font-semibold">
                    v3.8
                  </span>
                </h1>
              </div>
              <div className="text-[10px] text-slate-500 flex items-center gap-1 font-mono">
                <span className={`w-1.5 h-1.5 rounded-full ${engineActive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
                <span className={engineActive ? 'text-emerald-700 font-semibold' : 'text-slate-500'}>
                  {engineActive ? 'Engine Active' : 'Engine Idle'}
                </span>
              </div>
            </div>
          </div>

          {/* Segmented Pill Switcher (FOREX vs CRYPTO Only) */}
          <div className="flex items-center bg-slate-100 p-0.5 sm:p-1 rounded-xl border border-slate-200 shadow-inner">
            <button
              type="button"
              onClick={() => handleWorkspaceSelect('FOREX')}
              className={`px-3 py-1 sm:px-4 sm:py-1.5 rounded-lg text-xs font-bold font-mono transition-all cursor-pointer flex items-center gap-1.5 ${
                isForex
                  ? 'bg-indigo-600 text-white shadow-sm border border-indigo-600'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${isForex ? 'bg-emerald-400' : 'bg-slate-400'}`} />
              <span>FOREX</span>
            </button>
            <button
              type="button"
              onClick={() => handleWorkspaceSelect('CRYPTO')}
              className={`px-3 py-1 sm:px-4 sm:py-1.5 rounded-lg text-xs font-bold font-mono transition-all cursor-pointer flex items-center gap-1.5 ${
                !isForex
                  ? 'bg-[#F3BA2F] text-slate-950 shadow-sm border border-amber-400'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${!isForex ? 'bg-amber-900' : 'bg-slate-400'}`} />
              <span>CRYPTO</span>
            </button>
          </div>

          {/* Compact DEMO / REAL Mode Toggle */}
          <div className="flex items-center bg-slate-100 p-0.5 rounded-xl border border-slate-200 shadow-inner shrink-0 font-mono">
            <button
              type="button"
              onClick={() => handleModeSelect('DEMO')}
              className={`px-2 py-1 sm:px-2.5 sm:py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer flex items-center gap-1 ${
                isDemo
                  ? 'bg-white text-amber-700 border border-amber-300 shadow-sm'
                  : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${isDemo ? 'bg-amber-500' : 'bg-slate-400'}`} />
              <span>DEMO</span>
            </button>
            <button
              type="button"
              onClick={() => handleModeSelect('REAL')}
              className={`px-2 py-1 sm:px-2.5 sm:py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer flex items-center gap-1 ${
                !isDemo
                  ? 'bg-white text-emerald-700 border border-emerald-300 shadow-sm'
                  : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${!isDemo ? 'bg-emerald-500' : 'bg-slate-400'}`} />
              <span>REAL</span>
            </button>
          </div>
        </div>

        {/* ROW 2: 3-Column Financial KPI Strip (BALANCE, EQUITY, DAILY PNL) */}
        <div className="grid grid-cols-3 gap-2 font-mono">
          {/* 1. BALANCE */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-2.5 flex items-center gap-2 shadow-sm min-w-0">
            <DollarSign className="w-4 h-4 text-slate-500 shrink-0 hidden sm:block" />
            <div className="min-w-0 flex-1">
              <div className="text-[9px] sm:text-[10px] text-slate-500 uppercase tracking-wider truncate font-semibold">
                Balance
              </div>
              <div className="font-mono font-bold text-slate-900 text-xs sm:text-sm truncate">
                {displayBalance !== null && displayBalance !== undefined
                  ? `$${displayBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : '---'}
              </div>
            </div>
          </div>

          {/* 2. EQUITY */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-2.5 flex items-center gap-2 shadow-sm min-w-0">
            <PieChart className="w-4 h-4 text-indigo-500 shrink-0 hidden sm:block" />
            <div className="min-w-0 flex-1">
              <div className="text-[9px] sm:text-[10px] text-slate-500 uppercase tracking-wider truncate font-semibold">
                Equity
              </div>
              <div className={`font-mono font-bold text-xs sm:text-sm truncate ${displayEquity === null || displayEquity === undefined ? 'text-slate-400' : isEquityUp ? 'text-emerald-700' : 'text-rose-700'}`}>
                {displayEquity !== null && displayEquity !== undefined
                  ? `$${displayEquity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : '---'}
              </div>
            </div>
          </div>

          {/* 3. DAILY PNL (Clickable -> Opens Calendar Modal) */}
          <div
            onClick={handleOpenDailyCalendar}
            className="bg-slate-50 border border-slate-200 hover:border-indigo-300 rounded-xl p-2.5 flex items-center gap-2 shadow-sm min-w-0 cursor-pointer group transition-all"
            title="Click to view Daily PnL Calendar modal"
          >
            <div className="relative shrink-0 hidden sm:block">
              <Activity className="w-4 h-4 text-amber-500 group-hover:text-indigo-600 transition-colors" />
              <Calendar className="w-2.5 h-2.5 text-indigo-500 absolute -bottom-1 -right-1 opacity-70 group-hover:opacity-100 transition-opacity" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[9px] sm:text-[10px] text-slate-500 uppercase tracking-wider flex items-center justify-between gap-1">
                <span className="truncate flex items-center gap-1 group-hover:text-indigo-600 font-semibold transition-colors">
                  <span>Daily PnL</span>
                  <Calendar className="w-2.5 h-2.5 text-slate-400 group-hover:text-indigo-600 sm:hidden" />
                </span>
                <span className={`font-mono font-bold text-[9px] sm:text-[10px] shrink-0 ${displayDailyPercent === null || displayDailyPercent === undefined ? 'text-slate-400' : isDailyPnlUp ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {displayDailyPercent !== null && displayDailyPercent !== undefined
                    ? `${isDailyPnlUp ? '+' : ''}${displayDailyPercent.toFixed(1)}%`
                    : '---'}
                </span>
              </div>
              <div className={`font-mono font-bold text-xs sm:text-sm truncate ${displayDailyPnl === null || displayDailyPnl === undefined ? 'text-slate-400' : isDailyPnlUp ? 'text-emerald-700' : 'text-rose-700'}`}>
                {displayDailyPnl !== null && displayDailyPnl !== undefined
                  ? `${isDailyPnlUp ? '+' : ''}$${displayDailyPnl.toFixed(2)}`
                  : '---'}
              </div>
            </div>
          </div>
        </div>

        {/* ROW 3: Compact Action & Session Bar */}
        <div className="flex items-center justify-between gap-2 overflow-x-auto py-0.5 font-mono text-xs">
          {/* Connection status indicator */}
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border shrink-0 ${isLiveConnected ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
            <span className={`w-2 h-2 rounded-full shrink-0 ${isLiveConnected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
            <span className="text-[11px] font-bold">
              {isLiveConnected ? 'CONNECTED' : 'DISCONNECTED'}
            </span>
            {isLiveConnected && (
              <span className="hidden sm:inline text-[10px] text-emerald-600 font-normal">
                ({isForex ? (activeCreds.server || 'Exness') : (activeCryptoExchange === 'BITGET' ? (isTestnet ? 'Bitget Demo' : 'Bitget Live') : (isTestnet ? 'Binance Testnet' : 'Binance Live'))})
              </span>
            )}
          </div>

          {/* Vault Button + Active License Pill */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Vault button */}
            <button
              type="button"
              onClick={handleOpenVault}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold cursor-pointer transition-all border shrink-0 ${
                isLiveConnected
                  ? 'bg-slate-100 hover:bg-slate-200 text-slate-800 border-slate-200 shadow-sm'
                  : 'bg-[#0F172A] hover:bg-[#1E293B] text-white border-[#0F172A] shadow-sm'
              }`}
            >
              <Key className="w-3.5 h-3.5" />
              <span>{isForex ? 'Exness Vault' : (activeCryptoExchange === 'BITGET' ? 'Bitget API' : 'Binance API')}</span>
            </button>

            {/* Active License pill */}
            {license && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 text-xs shrink-0 font-sans shadow-sm">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span className="font-semibold text-emerald-900 text-xs">
                  {(() => {
                    const handle = license.telegram || license.username || 'user';
                    return handle.startsWith('@') ? handle : `@${handle}`;
                  })()}
                </span>
                <span className="text-emerald-400">•</span>
                <span className="text-[11px] font-mono text-emerald-700 font-medium">
                  {remainingDays}d
                </span>
                <button
                  type="button"
                  onClick={logout}
                  title="Logout Lisensi"
                  className="ml-0.5 text-slate-400 hover:text-rose-600 transition-colors p-0.5 rounded hover:bg-rose-50 cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>

    {/* FOREX PnL Calendar Modal */}
    <PnlCalendarModal
      isOpen={isForexCalendarOpen}
      onClose={() => setIsForexCalendarOpen(false)}
    />
  </>
);
};

export default HeaderBar;
