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
  const forexVaultConnected = isVaultConfigured(credentials);
  const isForexAccountLive = forexVaultConnected && Boolean(accountInfo?.connected);
  const forexBalance = isForexAccountLive ? (balance > 0 ? balance : (accountInfo?.balance ?? 0)) : 0;

  const activePositions = Array.isArray(openPositions) && openPositions.length > 0
    ? openPositions
    : (Array.isArray(positions) ? positions : []);

  const totalUnrealizedPnl = activePositions.reduce((sum, pos) => {
    const quote = quotes[pos.symbol];
    if (quote) {
      return sum + evaluatePositionPnL(pos, quote).pnlUsd;
    }
    return sum + (pos.unrealizedPnl || 0);
  }, 0);
  const forexDynamicEquity = isForexAccountLive
    ? (activePositions.length === 0 ? forexBalance : (equity > 0 ? equity : Number((forexBalance + totalUnrealizedPnl).toFixed(2))))
    : 0;

  const todayDateStr = getLocalDateString();
  const todayRecord = dailyPnlHistory?.[todayDateStr];
  const hasTradedToday = isForexAccountLive && Boolean(todayRecord && todayRecord.trades > 0);
  const forexDailyRealizedPnL = hasTradedToday ? (todayRecord?.pnl ?? 0) : 0;
  const forexDailyPnlPercent = Number(((forexDailyRealizedPnL / 100.00) * 100).toFixed(2));

  // Current Workspace Unified Values
  const isForex = currentWorkspace === 'FOREX';
  const engineActive = isForex
    ? (isAutoTrading || isTickRunning)
    : (cryptoIsAutoTrading || cryptoIsScanning);

  const isDemo = isForex ? accountMode === 'DEMO' : isTestnet;

  const displayBalance = isForex ? forexBalance : cryptoWalletBalance;
  const displayEquity = isForex ? forexDynamicEquity : Number((cryptoWalletBalance + cryptoUnrealizedProfit).toFixed(2));
  const isEquityUp = displayEquity >= displayBalance;

  const displayDailyPnl = isForex ? forexDailyRealizedPnL : cryptoDailyPnl;
  const displayDailyPercent = isForex ? forexDailyPnlPercent : cryptoDailyPnlPercent;
  const isDailyPnlUp = displayDailyPnl >= 0;

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
      <header className="bg-slate-900 border-b border-slate-800 px-3 py-2 sm:px-4 sm:py-2.5 sticky top-0 z-40 select-none shadow-md">
        <div className="max-w-[1920px] mx-auto flex flex-col gap-2 animate-pulse">
          <div className="h-9 bg-slate-950 rounded-xl border border-slate-800" />
          <div className="grid grid-cols-3 gap-2">
            <div className="h-12 bg-slate-950 rounded-xl border border-slate-800" />
            <div className="h-12 bg-slate-950 rounded-xl border border-slate-800" />
            <div className="h-12 bg-slate-950 rounded-xl border border-slate-800" />
          </div>
          <div className="h-7 bg-slate-950 rounded-lg border border-slate-800" />
        </div>
      </header>
    );
  }

  return (
    <>
      <header className="bg-slate-900 border-b border-slate-800 px-3 py-2 sm:px-4 sm:py-2.5 sticky top-0 z-40 select-none shadow-md backdrop-blur-md">
      <div className="max-w-[1920px] mx-auto flex flex-col gap-2 sm:gap-2.5">
        {/* ROW 1: Sleek Brand Logo + Segmented FOREX/CRYPTO Switcher + Compact DEMO/REAL Mode Toggle */}
        <div className="flex items-center justify-between gap-2 sm:gap-4">
          {/* Brand Logo & Engine Activity Indicator */}
          <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
            <div className="relative">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-600 via-indigo-500 to-amber-500 flex items-center justify-center text-white shadow-lg shadow-indigo-900/30">
                <Sparkles className="w-4 h-4 text-white" />
              </div>
              {engineActive && (
                <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                </span>
              )}
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="font-extrabold text-xs sm:text-sm text-white tracking-wider flex items-center gap-1">
                  <span>QUANT AI</span>
                  <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-indigo-950 text-indigo-300 border border-indigo-800 font-normal">
                    v3.8
                  </span>
                </h1>
              </div>
              <div className="text-[10px] text-slate-400 flex items-center gap-1 font-mono">
                <span className={`w-1.5 h-1.5 rounded-full ${engineActive ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
                <span className={engineActive ? 'text-emerald-400 font-semibold' : 'text-slate-400'}>
                  {engineActive ? 'Engine Active' : 'Engine Idle'}
                </span>
              </div>
            </div>
          </div>

          {/* Segmented Pill Switcher (FOREX vs CRYPTO Only) */}
          <div className="flex items-center bg-slate-950 p-0.5 sm:p-1 rounded-xl border border-slate-800 shadow-inner">
            <button
              type="button"
              onClick={() => handleWorkspaceSelect('FOREX')}
              className={`px-3 py-1 sm:px-4 sm:py-1.5 rounded-lg text-xs font-bold font-mono transition-all cursor-pointer flex items-center gap-1.5 ${
                isForex
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-900/40 border border-indigo-400/50'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${isForex ? 'bg-emerald-400' : 'bg-slate-600'}`} />
              <span>FOREX</span>
            </button>
            <button
              type="button"
              onClick={() => handleWorkspaceSelect('CRYPTO')}
              className={`px-3 py-1 sm:px-4 sm:py-1.5 rounded-lg text-xs font-bold font-mono transition-all cursor-pointer flex items-center gap-1.5 ${
                !isForex
                  ? 'bg-[#F3BA2F] text-slate-950 shadow-md shadow-[#F3BA2F]/20 border border-[#F3BA2F]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${!isForex ? 'bg-amber-900' : 'bg-slate-600'}`} />
              <span>CRYPTO</span>
            </button>
          </div>

          {/* Compact DEMO / REAL Mode Toggle */}
          <div className="flex items-center bg-slate-950 p-0.5 rounded-xl border border-slate-800 shadow-inner shrink-0 font-mono">
            <button
              type="button"
              onClick={() => handleModeSelect('DEMO')}
              className={`px-2 py-1 sm:px-2.5 sm:py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer flex items-center gap-1 ${
                isDemo
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${isDemo ? 'bg-amber-400' : 'bg-slate-600'}`} />
              <span>DEMO</span>
            </button>
            <button
              type="button"
              onClick={() => handleModeSelect('REAL')}
              className={`px-2 py-1 sm:px-2.5 sm:py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer flex items-center gap-1 ${
                !isDemo
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${!isDemo ? 'bg-emerald-400' : 'bg-slate-600'}`} />
              <span>REAL</span>
            </button>
          </div>
        </div>

        {/* ROW 2: 3-Column Financial KPI Strip (BALANCE, EQUITY, DAILY PNL) */}
        <div className="grid grid-cols-3 gap-2 font-mono">
          {/* 1. BALANCE */}
          <div className="bg-slate-900/80 border border-slate-800/80 rounded-xl p-2.5 flex items-center gap-2 shadow-sm min-w-0">
            <DollarSign className="w-4 h-4 text-slate-400 shrink-0 hidden sm:block" />
            <div className="min-w-0 flex-1">
              <div className="text-[9px] sm:text-[10px] text-slate-400 uppercase tracking-wider truncate font-semibold">
                Balance
              </div>
              <div className="font-mono font-bold text-slate-100 text-xs sm:text-sm truncate">
                ${displayBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
          </div>

          {/* 2. EQUITY */}
          <div className="bg-slate-900/80 border border-slate-800/80 rounded-xl p-2.5 flex items-center gap-2 shadow-sm min-w-0">
            <PieChart className="w-4 h-4 text-indigo-400 shrink-0 hidden sm:block" />
            <div className="min-w-0 flex-1">
              <div className="text-[9px] sm:text-[10px] text-slate-400 uppercase tracking-wider truncate font-semibold">
                Equity
              </div>
              <div className={`font-mono font-bold text-xs sm:text-sm truncate ${isEquityUp ? 'text-emerald-400' : 'text-rose-400'}`}>
                ${displayEquity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
          </div>

          {/* 3. DAILY PNL (Clickable -> Opens Calendar Modal) */}
          <div
            onClick={handleOpenDailyCalendar}
            className="bg-slate-900/80 border border-slate-800/80 hover:border-indigo-500/50 rounded-xl p-2.5 flex items-center gap-2 shadow-sm min-w-0 cursor-pointer group transition-all"
            title="Click to view Daily PnL Calendar modal"
          >
            <div className="relative shrink-0 hidden sm:block">
              <Activity className="w-4 h-4 text-amber-400 group-hover:text-indigo-400 transition-colors" />
              <Calendar className="w-2.5 h-2.5 text-indigo-400 absolute -bottom-1 -right-1 opacity-70 group-hover:opacity-100 transition-opacity" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[9px] sm:text-[10px] text-slate-400 uppercase tracking-wider flex items-center justify-between gap-1">
                <span className="truncate flex items-center gap-1 group-hover:text-indigo-300 font-semibold transition-colors">
                  <span>Daily PnL</span>
                  <Calendar className="w-2.5 h-2.5 text-slate-500 group-hover:text-indigo-400 sm:hidden" />
                </span>
                <span className={`font-mono font-bold text-[9px] sm:text-[10px] shrink-0 ${isDailyPnlUp ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {isDailyPnlUp ? '+' : ''}{displayDailyPercent.toFixed(1)}%
                </span>
              </div>
              <div className={`font-mono font-bold text-xs sm:text-sm truncate ${isDailyPnlUp ? 'text-emerald-400' : 'text-rose-400'}`}>
                {isDailyPnlUp ? '+' : ''}${displayDailyPnl.toFixed(2)}
              </div>
            </div>
          </div>
        </div>

        {/* ROW 3: Compact Action & Session Bar */}
        <div className="flex items-center justify-between gap-2 overflow-x-auto py-0.5 font-mono text-xs">
          {/* Connection status indicator */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-950/80 border border-slate-800/80 shrink-0">
            <span className={`w-2 h-2 rounded-full shrink-0 ${isLiveConnected ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
            <span className={`text-[11px] font-bold ${isLiveConnected ? 'text-emerald-400' : 'text-slate-500'}`}>
              {isLiveConnected ? 'CONNECTED' : 'DISCONNECTED'}
            </span>
            {isLiveConnected && (
              <span className="hidden sm:inline text-[10px] text-slate-500 font-normal">
                ({isForex ? (activeCreds.server || 'Exness') : (isTestnet ? 'Binance Testnet' : 'Binance Live')})
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
                  ? isForex
                    ? 'bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-200 border-indigo-500/40'
                    : 'bg-[#F3BA2F]/20 hover:bg-[#F3BA2F]/30 text-[#F3BA2F] border-[#F3BA2F]/40'
                  : 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border-amber-500/50 animate-pulse'
              }`}
            >
              <Key className="w-3.5 h-3.5" />
              <span>{isForex ? 'Exness Vault' : 'Binance Vault'}</span>
            </button>

            {/* Active License pill */}
            {license && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-emerald-500/30 bg-emerald-950/40 text-emerald-300 text-xs shrink-0 font-sans shadow-sm">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="font-semibold text-emerald-200 text-xs">
                  {(() => {
                    const handle = license.telegram || license.username || 'user';
                    return handle.startsWith('@') ? handle : `@${handle}`;
                  })()}
                </span>
                <span className="text-emerald-500/50">•</span>
                <span className="text-[11px] font-mono text-emerald-300 font-medium">
                  {remainingDays}d
                </span>
                <button
                  type="button"
                  onClick={logout}
                  title="Logout Lisensi"
                  className="ml-0.5 text-slate-400 hover:text-rose-400 transition-colors p-0.5 rounded hover:bg-slate-800 cursor-pointer"
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
