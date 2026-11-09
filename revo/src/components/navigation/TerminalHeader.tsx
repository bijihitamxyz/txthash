'use client';

import React from 'react';
import { useRoomStore } from '@/store/useRoomStore';
import { useTradingStore } from '@/store/useTradingStore';
import { useBinanceStore } from '@/store/useBinanceStore';
import { useLicense } from '@/components/LicenseGate';
import { ThemeToggle } from '@/components/InstitutionalChrome';
import {
  CandlestickChart,
  Coins,
  KeyRound,
  LogOut,
} from 'lucide-react';

export const TerminalHeader: React.FC = () => {
  const { license, remainingDays, logout } = useLicense();

  const activeRoom = useRoomStore((s) => s.activeRoom);
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom);
  const activeMarket: 'FOREX' | 'CRYPTO' =
    activeRoom === 'CRYPTO' || activeRoom === 'ROOM_2_BINANCE' ? 'CRYPTO' : 'FOREX';

  const kronosHealth = useTradingStore((s) => s.kronosHealth);
  const checkKronosHealth = useTradingStore((s) => s.checkKronosHealth);
  const openExnessVaultModal = useTradingStore((s) => s.openVaultModal);

  const openBinanceVaultModal = useBinanceStore((s) => s.openVaultModal);
  const activeCryptoExchange = useBinanceStore((s) => s.activeExchange);

  // Precision status indicators driven by GET /api/kronos
  const kronosReadyState =
    kronosHealth === null ? 'CHECKING' : kronosHealth.kronosReady ? 'READY' : 'OFFLINE';
  const vpsReadyState =
    kronosHealth === null ? 'CHECKING' : kronosHealth.vpsReady ? 'READY' : 'OFFLINE';
  const aiReadyState =
    kronosHealth === null ? 'CHECKING' : kronosHealth.aiReady ? 'READY' : 'STANDBY';
  const activeAiCount = kronosHealth?.activeAiCount ?? 0;

  return (
    <header className="bg-white/95 dark:bg-slate-950/95 backdrop-blur-md border-b border-slate-200/90 dark:border-zinc-800 sticky top-0 z-40">
      <div className="max-w-[1920px] mx-auto px-3 sm:px-6 py-2.5 flex flex-wrap items-center justify-between gap-2.5">
        {/* Left: Brand + Market Switcher */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-[#0F172A] dark:bg-zinc-900 dark:border dark:border-zinc-700 text-white dark:text-emerald-400 flex items-center justify-center font-sans font-bold text-xs shrink-0">
              NX
            </div>
            <div className="flex items-center gap-1.5">
              <span className="font-sans font-bold text-[#0F172A] dark:text-slate-100 text-sm tracking-tight">
                NMSSx
              </span>
              <span className="hidden sm:inline-block font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-200/80 dark:border-emerald-500/30 font-semibold">
                CLIENT TERMINAL
              </span>
            </div>
          </div>

          {/* Market Switcher: FOREX (Exness) <-> CRYPTO (Binance/Bitget) */}
          <div className="inline-flex items-center p-1 rounded-xl bg-slate-100 dark:bg-zinc-900 border border-slate-200/90 dark:border-zinc-800 font-mono text-xs">
            <button
              type="button"
              onClick={() => setActiveRoom('FOREX')}
              className={`px-3 py-1.5 rounded-lg font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                activeMarket === 'FOREX'
                  ? 'bg-[#0F172A] dark:bg-emerald-600 text-white shadow-2xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-100'
              }`}
            >
              <CandlestickChart
                className={`w-3.5 h-3.5 ${
                  activeMarket === 'FOREX' ? 'text-emerald-400 dark:text-white' : 'text-slate-400'
                }`}
              />
              <span>Forex · Exness</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveRoom('CRYPTO')}
              className={`px-3 py-1.5 rounded-lg font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                activeMarket === 'CRYPTO'
                  ? 'bg-[#0F172A] dark:bg-emerald-600 text-white shadow-2xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-100'
              }`}
            >
              <Coins
                className={`w-3.5 h-3.5 ${
                  activeMarket === 'CRYPTO' ? 'text-emerald-400 dark:text-white' : 'text-slate-400'
                }`}
              />
              <span>Crypto · {activeCryptoExchange === 'BITGET' ? 'Bitget' : 'Binance'}</span>
            </button>
          </div>
        </div>

        {/* Right: Status Indicators + Theme Toggle + Vault Modal Button + Logout */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Status Indicators driven by GET /api/kronos */}
          <div
            onClick={() => checkKronosHealth()}
            title="Real-time live state polled from GET /api/kronos (Click to refresh)"
            className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-slate-50 dark:bg-zinc-900 border border-slate-200/90 dark:border-zinc-800 font-mono text-[11px] cursor-pointer hover:bg-slate-100 dark:hover:bg-zinc-800/80 transition-colors"
          >
            {/* 1. Kronos Ready */}
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-semibold border ${
                kronosReadyState === 'READY'
                  ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200/80 dark:border-emerald-500/30'
                  : kronosReadyState === 'CHECKING'
                  ? 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-zinc-700'
                  : 'bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-200/80 dark:border-rose-500/30'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  kronosReadyState === 'READY'
                    ? 'bg-[#10B981] animate-pulse'
                    : kronosReadyState === 'CHECKING'
                    ? 'bg-slate-400 animate-pulse'
                    : 'bg-rose-500'
                }`}
              />
              <span>
                {kronosReadyState === 'READY'
                  ? 'Kronos Ready'
                  : kronosReadyState === 'CHECKING'
                  ? 'Kronos Sync...'
                  : 'Kronos Offline'}
              </span>
            </span>

            {/* 2. VPS Ready */}
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-semibold border ${
                vpsReadyState === 'READY'
                  ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200/80 dark:border-emerald-500/30'
                  : vpsReadyState === 'CHECKING'
                  ? 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-zinc-700'
                  : 'bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-500/30'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  vpsReadyState === 'READY'
                    ? 'bg-[#10B981] animate-pulse'
                    : vpsReadyState === 'CHECKING'
                    ? 'bg-slate-400 animate-pulse'
                    : 'bg-rose-500'
                }`}
              />
              <span>
                {vpsReadyState === 'READY'
                  ? `VPS Ready (${kronosHealth?.latencyMs ?? 12}ms)`
                  : vpsReadyState === 'CHECKING'
                  ? 'VPS Sync...'
                  : 'VPS Offline'}
              </span>
            </span>

            {/* 3. AI Ready */}
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-semibold border ${
                aiReadyState === 'READY'
                  ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200/80 dark:border-emerald-500/30'
                  : aiReadyState === 'CHECKING'
                  ? 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-zinc-700'
                  : 'bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-200/80 dark:border-amber-500/30'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  aiReadyState === 'READY'
                    ? 'bg-[#10B981] animate-pulse'
                    : aiReadyState === 'CHECKING'
                    ? 'bg-slate-400 animate-pulse'
                    : 'bg-amber-500'
                }`}
              />
              <span>
                {aiReadyState === 'READY'
                  ? `AI Ready${activeAiCount > 1 ? ` (${activeAiCount})` : ''}`
                  : aiReadyState === 'CHECKING'
                  ? 'AI Sync...'
                  : 'AI Standby'}
              </span>
            </span>
          </div>

          <ThemeToggle />

          {/* Client Exchange Credentials Button */}
          <button
            type="button"
            onClick={() =>
              activeMarket === 'FOREX' ? openExnessVaultModal() : openBinanceVaultModal()
            }
            className="bg-[#0F172A] dark:bg-zinc-900 dark:border dark:border-zinc-700 hover:bg-[#1E293B] dark:hover:bg-zinc-800 text-white rounded-xl px-3.5 py-1.5 text-xs font-mono font-semibold transition-all flex items-center gap-1.5 shrink-0 cursor-pointer shadow-2xs"
          >
            <KeyRound className="w-3.5 h-3.5 text-emerald-400" />
            <span>{activeMarket === 'FOREX' ? 'EXNESS VAULT' : 'API KEY'}</span>
          </button>

          {/* Active License Session Pill */}
          {license && (
            <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-xs font-mono">
              <span className="text-[#0F172A] dark:text-slate-200 font-semibold truncate max-w-[110px]">
                {license.telegram || license.username}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-200/80 dark:border-emerald-500/30 text-[10px] font-bold">
                {remainingDays}d
              </span>
            </div>
          )}

          <button
            type="button"
            onClick={logout}
            title="Lock Terminal / Logout Key"
            className="p-2 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-slate-300 hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-200 dark:hover:border-rose-500/40 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Mobile Status Strip */}
      <div className="md:hidden px-3 pb-2 flex items-center justify-between gap-1.5 font-mono text-[10px]">
        <span
          className={`flex-1 text-center py-1 rounded-lg border font-semibold ${
            kronosReadyState === 'READY'
              ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30'
              : 'bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-500/30'
          }`}
        >
          {kronosReadyState === 'READY' ? '● Kronos Ready' : '○ Kronos Offline'}
        </span>
        <span
          className={`flex-1 text-center py-1 rounded-lg border font-semibold ${
            vpsReadyState === 'READY'
              ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30'
              : 'bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-500/30'
          }`}
        >
          {vpsReadyState === 'READY' ? '● VPS Ready' : '○ VPS Offline'}
        </span>
        <span
          className={`flex-1 text-center py-1 rounded-lg border font-semibold ${
            aiReadyState === 'READY'
              ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30'
              : 'bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-500/30'
          }`}
        >
          {aiReadyState === 'READY' ? '● AI Ready' : '○ AI Standby'}
        </span>
      </div>
    </header>
  );
};

export default TerminalHeader;
