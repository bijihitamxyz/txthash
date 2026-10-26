'use client';

import React, { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { HeaderBar } from '@/components/HeaderBar';
import { ControlPanel } from '@/components/ControlPanel';
import { ActivePositionsTable } from '@/components/ActivePositionsTable';
import { TelemetryLog } from '@/components/TelemetryLog';
import { ApiKeyModal } from '@/components/ApiKeyModal';
import { useTradingStore } from '@/store/useTradingStore';
import { LicenseGate } from '@/components/LicenseGate';

const TradingChart = dynamic(
  () => import('@/components/TradingChart').then((mod) => mod.TradingChart),
  {
    ssr: false,
    loading: () => (
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col h-full shadow-lg items-center justify-center min-h-[460px]">
        <div className="flex items-center gap-2 text-slate-500 font-mono text-xs">
          <span className="w-2 h-2 rounded-full bg-indigo-500 animate-ping" />
          Initializing Chart Engine...
        </div>
      </div>
    ),
  }
);

function TradingTerminalInner() {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const isAutoTrading = useTradingStore((s) => s.isAutoTrading);
  const tickIntervalMs = useTradingStore((s) => s.tickIntervalMs);

  // Initial load on mount - load vault & account in sequence
  useEffect(() => {
    if (!isMounted) return;
    const initApp = async () => {
      // Strictly enforce engine idle on page load / refresh
      useTradingStore.setState({ isAutoTrading: false });
      await useTradingStore.getState().loadVaultOnStartup();
      await useTradingStore.getState().fetchAccountInfo();
    };
    initApp();
  }, [isMounted]);

  // Background state & quote polling
  useEffect(() => {
    if (!isMounted) return;
    let isFetchingQuote = false;
    const quoteInterval = setInterval(async () => {
      if (isFetchingQuote) return;
      isFetchingQuote = true;
      try {
        const cur = useTradingStore.getState().focusSymbol || useTradingStore.getState().selectedSymbol || 'XAUUSDm';
        await useTradingStore.getState().fetchQuote(cur);
      } catch {
      } finally {
        isFetchingQuote = false;
      }
    }, 1000);

    const syncInterval = setInterval(() => {
      useTradingStore.getState().syncWithServerState();
    }, 5000);

    return () => {
      clearInterval(quoteInterval);
      clearInterval(syncInterval);
    };
  }, [isMounted]);

  // Automated Engine Heartbeat Loop from UI (triggers server API tick)
  useEffect(() => {
    if (!isMounted || !isAutoTrading) return;

    // Trigger immediate tick upon activation
    useTradingStore.getState().executeEngineTick();

    const intervalId = setInterval(() => {
      useTradingStore.getState().executeEngineTick();
    }, tickIntervalMs || 3000);

    return () => clearInterval(intervalId);
  }, [isMounted, isAutoTrading, tickIntervalMs]);

  // Client-side guard prevents SSR hydration mismatch & UI flickering
  if (!isMounted) {
    return (
      <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans select-none">
        {/* Skeleton HeaderBar */}
        <div className="bg-slate-900 border-b border-slate-800 px-3 py-2 sm:px-4 sm:py-2.5 sticky top-0 z-40 select-none shadow-md">
          <div className="max-w-[1920px] mx-auto flex flex-col xl:flex-row xl:items-center justify-between gap-2 sm:gap-2.5 xl:gap-4 animate-pulse">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-slate-800" />
                <div>
                  <div className="h-4 w-28 sm:w-32 bg-slate-800 rounded mb-1" />
                  <div className="h-3 w-20 bg-slate-800/60 rounded" />
                </div>
              </div>
              <div className="h-8 w-36 sm:w-44 bg-slate-950 rounded-xl border border-slate-800" />
            </div>
            <div className="grid grid-cols-3 gap-2 w-full xl:w-auto xl:min-w-[480px]">
              <div className="h-11 bg-slate-950 rounded-lg border border-slate-800" />
              <div className="h-11 bg-slate-950 rounded-lg border border-slate-800" />
              <div className="h-11 bg-slate-950 rounded-lg border border-slate-800" />
            </div>
            <div className="flex items-center justify-between sm:justify-end gap-2 w-full xl:w-auto">
              <div className="h-8 w-20 sm:w-24 bg-slate-950 rounded-lg border border-slate-800" />
              <div className="flex items-center gap-2">
                <div className="h-8 w-24 sm:w-28 bg-slate-950 rounded-lg border border-slate-800" />
                <div className="h-8 w-24 sm:w-28 bg-slate-950 rounded-lg border border-slate-800" />
              </div>
            </div>
          </div>
        </div>

        {/* Skeleton Dashboard Layout */}
        <div className="flex-1 max-w-[1920px] w-full mx-auto p-2 sm:p-3 md:p-4 flex flex-col lg:flex-row gap-3 sm:gap-4 overflow-hidden">
          <section className="flex-1 flex flex-col gap-3 sm:gap-4 min-w-0 w-full overflow-hidden">
            <div className="h-[440px] sm:h-[480px] md:h-[500px] bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex items-center justify-center animate-pulse">
              <div className="flex items-center gap-2 text-slate-500 font-mono text-xs">
                <span className="w-2 h-2 rounded-full bg-indigo-500 animate-ping" />
                Initializing Quant Terminal...
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-center text-slate-500 text-xs shadow-md animate-pulse">
              Loading positions ledger...
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl h-72 animate-pulse" />
          </section>
          <section className="w-full lg:w-96 shrink-0">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 h-[500px] animate-pulse" />
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans select-none">
      {/* Top Navigation & Financial Header */}
      <HeaderBar />

      {/* Main Workspace Layout */}
      <div className="flex-1 max-w-[1920px] w-full mx-auto p-2 sm:p-3 md:p-4 flex flex-col lg:flex-row gap-3 sm:gap-4 overflow-hidden">
        {/* Left / Center Section: Interactive Chart, Positions, Telemetry */}
        <section className="flex-1 flex flex-col gap-3 sm:gap-4 min-w-0 w-full overflow-hidden">
          {/* Real-time HTML5 Candlestick & Indicator Chart */}
          <div className="h-[440px] sm:h-[480px] md:h-[500px] w-full min-w-0">
            <TradingChart />
          </div>

          {/* Active Positions Table */}
          <ActivePositionsTable />

          {/* Live Streaming Execution Telemetry Terminal */}
          <TelemetryLog />
        </section>

        {/* Right Section: Strategy Controls & Preset Manager */}
        <section className="w-full lg:w-96 shrink-0">
          <ControlPanel />
        </section>
      </div>

      {/* BYOK Encrypted Credential Vault Modal */}
      <ApiKeyModal />
    </main>
  );
}

export default function TradingDashboard() {
  return (
    <LicenseGate>
      <TradingTerminalInner />
    </LicenseGate>
  );
}
