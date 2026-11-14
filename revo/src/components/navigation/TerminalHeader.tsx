'use client';

import React from 'react';
import { useRoomStore } from '@/store/useRoomStore';
import { useTradingStore } from '@/store/useTradingStore';
import { useBinanceStore } from '@/store/useBinanceStore';
import { useLicense } from '@/components/LicenseGate';
import { ThemeToggle } from '@/components/InstitutionalChrome';
import {
  Bot,
  CandlestickChart,
  Coins,
  Cpu,
  KeyRound,
  Lock,
  LogOut,
  Server,
} from 'lucide-react';

export const TerminalHeader: React.FC = () => {
  const { license, remainingDays, logout } = useLicense();

  const activeRoom = useRoomStore((s) => s.activeRoom);
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom);
  const maintenance = useRoomStore((s) => s.maintenance);
  const activeMarket: 'FOREX' | 'CRYPTO' =
    activeRoom === 'CRYPTO' || activeRoom === 'ROOM_2_BINANCE' ? 'CRYPTO' : 'FOREX';

  const kronosHealth = useTradingStore((s) => s.kronosHealth);
  const checkKronosHealth = useTradingStore((s) => s.checkKronosHealth);
  const openExnessVaultModal = useTradingStore((s) => s.openVaultModal);

  React.useEffect(() => {
    if (kronosHealth === null) {
      checkKronosHealth().catch(() => {});
    }
  }, [kronosHealth, checkKronosHealth]);

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

  const kronosTooltip =
    kronosReadyState === 'READY'
      ? 'Kronos Ready'
      : kronosReadyState === 'CHECKING'
      ? 'Kronos Syncing...'
      : 'Kronos Offline';
  const vpsTooltip =
    vpsReadyState === 'READY'
      ? `VPS Ready (${kronosHealth?.latencyMs ?? 12}ms)`
      : vpsReadyState === 'CHECKING'
      ? 'VPS Syncing...'
      : 'VPS Offline';
  const aiTooltip =
    aiReadyState === 'READY'
      ? `AI Ready${activeAiCount > 0 ? ` (${activeAiCount} Active)` : ''}`
      : aiReadyState === 'CHECKING'
      ? 'AI Syncing...'
      : 'AI Standby';
  const vaultTooltip =
    activeMarket === 'FOREX'
      ? 'Exness Vault Credentials'
      : `${activeCryptoExchange === 'BITGET' ? 'Bitget' : 'Binance'} API Key`;

  const statusItems = [
    {
      id: 'kronos',
      state: kronosReadyState,
      tooltip: kronosTooltip,
      Icon: Cpu,
      offlineDot: 'bg-rose-500',
      readyColor: 'text-emerald-600 dark:text-emerald-400',
      offlineColor: 'text-rose-500 dark:text-rose-400',
    },
    {
      id: 'vps',
      state: vpsReadyState,
      tooltip: vpsTooltip,
      Icon: Server,
      offlineDot: 'bg-rose-500',
      readyColor: 'text-emerald-600 dark:text-emerald-400',
      offlineColor: 'text-rose-500 dark:text-rose-400',
    },
    {
      id: 'ai',
      state: aiReadyState,
      tooltip: aiTooltip,
      Icon: Bot,
      offlineDot: 'bg-amber-500',
      readyColor: 'text-emerald-600 dark:text-emerald-400',
      offlineColor: 'text-amber-500 dark:text-amber-400',
    },
  ] as const;

  return (
    <header className="bg-white/95 dark:bg-slate-950/95 backdrop-blur-md border-b border-slate-200/90 dark:border-zinc-800 sticky top-0 z-40">
      <div className="max-w-[1920px] mx-auto px-3 sm:px-6 py-2 flex items-center justify-between gap-2">
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
              disabled={maintenance.forex}
              aria-disabled={maintenance.forex}
              title={maintenance.forex ? 'Forex Room sedang dalam mode Maintenance (Terkunci)' : undefined}
              onClick={() => {
                if (!maintenance.forex) setActiveRoom('FOREX');
              }}
              className={`px-3 py-1.5 rounded-lg font-semibold transition-all flex items-center gap-1.5 ${
                maintenance.forex
                  ? 'opacity-50 cursor-not-allowed text-slate-400 dark:text-zinc-500 select-none'
                  : activeMarket === 'FOREX'
                  ? 'bg-[#0F172A] dark:bg-emerald-600 text-white shadow-2xs cursor-pointer'
                  : 'text-slate-600 dark:text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-100 cursor-pointer'
              }`}
            >
              {maintenance.forex ? (
                <Lock className="w-3.5 h-3.5 text-amber-500" />
              ) : (
                <CandlestickChart
                  className={`w-3.5 h-3.5 ${
                    activeMarket === 'FOREX' ? 'text-emerald-400 dark:text-white' : 'text-slate-400'
                  }`}
                />
              )}
              <span>Forex · Exness</span>
            </button>

            <button
              type="button"
              disabled={maintenance.crypto}
              aria-disabled={maintenance.crypto}
              title={maintenance.crypto ? 'Crypto Room sedang dalam mode Maintenance (Terkunci)' : undefined}
              onClick={() => {
                if (!maintenance.crypto) setActiveRoom('CRYPTO');
              }}
              className={`px-3 py-1.5 rounded-lg font-semibold transition-all flex items-center gap-1.5 ${
                maintenance.crypto
                  ? 'opacity-50 cursor-not-allowed text-slate-400 dark:text-zinc-500 select-none'
                  : activeMarket === 'CRYPTO'
                  ? 'bg-[#0F172A] dark:bg-emerald-600 text-white shadow-2xs cursor-pointer'
                  : 'text-slate-600 dark:text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-100 cursor-pointer'
              }`}
            >
              {maintenance.crypto ? (
                <Lock className="w-3.5 h-3.5 text-amber-500" />
              ) : (
                <Coins
                  className={`w-3.5 h-3.5 ${
                    activeMarket === 'CRYPTO' ? 'text-emerald-400 dark:text-white' : 'text-slate-400'
                  }`}
                />
              )}
              <span>Crypto · {activeCryptoExchange === 'BITGET' ? 'Bitget' : 'Binance'}</span>
            </button>
          </div>
        </div>

        {/* Right: Compact Status Icons + Theme Toggle + Single API Key Icon + Session + Logout */}
        <div className="flex items-center gap-1.5">
          {/* Grouped Minimalist Status Icons (Kronos, VPS, AI) */}
          <div
            onClick={() => checkKronosHealth()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                checkKronosHealth();
              }
            }}
            aria-label="Refresh Kronos, VPS, and AI status"
            className="flex items-center gap-0.5 px-1.5 py-1 rounded-xl bg-slate-100/80 dark:bg-zinc-900/90 border border-slate-200/90 dark:border-zinc-800 cursor-pointer hover:border-slate-300 dark:hover:border-zinc-700 transition-colors"
          >
            {statusItems.map(({ id, state, tooltip, Icon, offlineDot, readyColor, offlineColor }) => {
              const isReady = state === 'READY';
              const isChecking = state === 'CHECKING';
              return (
                <div
                  key={id}
                  title={`${tooltip} (Click to refresh)`}
                  className="group relative flex items-center justify-center w-7 h-7 rounded-lg hover:bg-white dark:hover:bg-zinc-800 transition-colors"
                >
                  <Icon
                    className={`w-3.5 h-3.5 transition-colors ${
                      isReady
                        ? readyColor
                        : isChecking
                        ? 'text-slate-400 dark:text-zinc-500'
                        : offlineColor
                    }`}
                  />
                  {/* Corner Status Dot */}
                  <span
                    className={`absolute top-1 right-1 w-1.5 h-1.5 rounded-full ring-2 ring-slate-100 dark:ring-zinc-900 ${
                      isReady
                        ? 'bg-emerald-500 animate-pulse'
                        : isChecking
                        ? 'bg-slate-400 animate-pulse'
                        : offlineDot
                    }`}
                  />
                  {/* Hover Tooltip */}
                  <span className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 rounded-md bg-slate-900 dark:bg-zinc-800 text-white dark:text-slate-100 border border-slate-700/60 dark:border-zinc-700 font-mono text-[10px] font-medium whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity shadow-lg z-50">
                    {tooltip}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Theme Toggle & Single Compact API Key Action */}
          <ThemeToggle />

          <button
            type="button"
            onClick={() =>
              activeMarket === 'FOREX' ? openExnessVaultModal() : openBinanceVaultModal()
            }
            title={vaultTooltip}
            aria-label={vaultTooltip}
            className="group relative p-2 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-slate-600 dark:text-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-300 hover:border-emerald-300 dark:hover:border-emerald-500/40 hover:bg-emerald-50/70 dark:hover:bg-emerald-500/10 transition-all cursor-pointer shrink-0"
          >
            <KeyRound className="w-3.5 h-3.5" />
            <span className="pointer-events-none absolute top-full right-0 mt-2 px-2 py-1 rounded-md bg-slate-900 dark:bg-zinc-800 text-white dark:text-slate-100 border border-slate-700/60 dark:border-zinc-700 font-mono text-[10px] font-medium whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity shadow-lg z-50">
              {vaultTooltip}
            </span>
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
            aria-label="Lock Terminal / Logout Key"
            className="p-2 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-slate-600 dark:text-slate-300 hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-200 dark:hover:border-rose-500/40 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors cursor-pointer shrink-0"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
};

export default TerminalHeader;
