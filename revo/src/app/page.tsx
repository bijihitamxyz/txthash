'use client';

import React, { useState, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { HeaderBar } from '@/components/HeaderBar';
import { ControlPanel } from '@/components/ControlPanel';
import { ActivePositionsTable } from '@/components/ActivePositionsTable';
import { TelemetryLog } from '@/components/TelemetryLog';
import { VaultModal } from '@/components/VaultModal';
import { useTradingStore } from '@/store/useTradingStore';
import { LicenseGate } from '@/components/LicenseGate';
import { useRoomStore } from '@/store/useRoomStore';

const BinanceFuturesRoom = dynamic(
  () => import('@/components/BinanceFuturesRoom').then((mod) => mod.BinanceFuturesRoom),
  {
    ssr: false,
    loading: () => (
      <div className="flex-1 bg-[#0B0E11] flex items-center justify-center font-mono text-[#F3BA2F] p-8 min-h-[500px]">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-[#F3BA2F] animate-ping" />
          <span>Loading Binance Futures Quant Workspace...</span>
        </div>
      </div>
    ),
  }
);

const TradingChart = dynamic(
  () => import('@/components/TradingChart').then((mod) => mod.TradingChart),
  {
    ssr: false,
    loading: () => (
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col h-full shadow-lg items-center justify-center min-h-[460px]">
        <div className="flex items-center gap-2 text-slate-500 font-mono text-xs">
          <span className="w-2 h-2 rounded-full bg-indigo-500 animate-ping" />
          <span>Initializing Chart Engine...</span>
        </div>
      </div>
    ),
  }
);

let isSingletonLoopRunning = false;

function TradingTerminalInner() {
  // 1. ALL Zustand Store Hooks at absolute top - zero conditional hooks
  const isAutoTrading = useTradingStore((s) => s.isAutoTrading);
  const tickIntervalMs = useTradingStore((s) => s.tickIntervalMs);
  const loopLockRef = useRef(false);

  // 2. Initial load on mount - load vault & account in sequence
  useEffect(() => {
    const initApp = async () => {
      // Strictly halt scanning on initial page load / refresh without purging active open positions
      useTradingStore.setState({ isAutoTrading: false });
      await useTradingStore.getState().loadVaultOnStartup();
      await useTradingStore.getState().fetchAccountInfo();
      const state = useTradingStore.getState();
      if ((state.openPositions || []).length === 0 && state.balance > 0) {
        useTradingStore.setState({ equity: state.balance });
      }
    };
    initApp();
  }, []);

  // 3. SINGLETON COORDINATED TICK & EXECUTION LOOP
  // Runs a 1000ms heartbeat guarded by module-level lock and ref lock
  useEffect(() => {
    if (isSingletonLoopRunning || loopLockRef.current) {
      return;
    }
    isSingletonLoopRunning = true;
    loopLockRef.current = true;

    let tickCounter = 0;
    let isExecuting = false;

    // Immediately trigger initial live tick
    useTradingStore.getState().executeLiveTickStream().catch(() => {});

    const intervalId = setInterval(async () => {
      if (isExecuting) return;
      isExecuting = true;
      try {
        tickCounter++;

        // 1. Live Tick Stream (every 1000ms):
        // Continuously updates currentBid / currentAsk for active chart symbol AND all symbols in openPositions,
        // updating chart's current candle, recalculating live unrealized PnL, and advancing Tight ATR Trailing Stop smoothly
        await useTradingStore.getState().executeLiveTickStream();

        // 2. Automated Strategy Engine Tick (every 3000ms when auto-trading is active)
        if (useTradingStore.getState().isAutoTrading && tickCounter % 3 === 0) {
          await useTradingStore.getState().executeEngineTick();
        }

        // 3. Poll account metrics periodically (every 5000ms)
        if (tickCounter % 5 === 0) {
          await useTradingStore.getState().fetchAccountInfo();
        }

        // 4. Server state synchronization (every 10000ms)
        if (tickCounter % 10 === 0) {
          await useTradingStore.getState().syncWithServerState();
        }
      } catch (err) {
        console.error('[SingletonExecutionLoop] Error:', err);
      } finally {
        isExecuting = false;
      }
    }, 1000);

    return () => {
      clearInterval(intervalId);
      isSingletonLoopRunning = false;
      loopLockRef.current = false;
    };
  }, []);

  // ZERO early returns before hooks, ZERO inline useRef calls, ZERO conditional hooks.
  return (
    <>
      {/* Main Workspace Layout */}
      <div className="flex-1 max-w-[1920px] w-full mx-auto p-2 sm:p-3 md:p-4 flex flex-col lg:flex-row gap-3 sm:gap-4 overflow-hidden">
        {/* Left / Center Section: Interactive Chart, Positions, Telemetry */}
        <section className="flex-1 flex flex-col gap-3 sm:gap-4 min-w-0 w-full overflow-hidden">
          {/* Real-time Candlestick & Indicator Chart */}
          <div className="h-[440px] sm:h-[480px] md:h-[500px] w-full min-w-0">
            <TradingChart />
          </div>

          {/* Active Positions Table & Mobile Cards */}
          <ActivePositionsTable />

          {/* Live Streaming Execution Telemetry Terminal */}
          <TelemetryLog />
        </section>

        {/* Right Section: Strategy Controls & Preset Manager */}
        <section className="w-full lg:w-96 shrink-0">
          <ControlPanel />
        </section>
      </div>

      {/* Encrypted Credential Vault Modal */}
      <VaultModal />
    </>
  );
}

export default function TradingDashboard() {
  // 1. ALL State and Store Hooks managed strictly at top parent level
  const [activeWorkspace, setActiveWorkspace] = useState<'FOREX' | 'CRYPTO'>('FOREX');
  const [isMounted, setIsMounted] = useState(false);
  const activeRoom = useRoomStore((s) => s.activeRoom);
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom);

  // 2. Client-side mount effect prevents SSR hydration mismatch & UI flickering
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // 3. Keep activeWorkspace synchronized with useRoomStore when updated externally
  useEffect(() => {
    if (activeRoom === 'CRYPTO' || (activeRoom as string) === 'ROOM_2_BINANCE') {
      setActiveWorkspace('CRYPTO');
    } else if (activeRoom === 'FOREX' || (activeRoom as string) === 'ROOM_1_EXNESS') {
      setActiveWorkspace('FOREX');
    }
  }, [activeRoom]);

  const handleWorkspaceChange = (workspace: 'FOREX' | 'CRYPTO') => {
    setActiveWorkspace(workspace);
    setActiveRoom(workspace);
  };

  // 4. Client-side guard prevents SSR hydration mismatch
  if (!isMounted) {
    return (
      <LicenseGate>
        <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans select-none">
          <div className="bg-slate-900 border-b border-slate-800 px-3 py-2 sm:px-4 sm:py-2.5 sticky top-0 z-40 select-none shadow-md">
            <div className="max-w-[1920px] mx-auto flex flex-col gap-2 animate-pulse">
              <div className="h-9 bg-slate-950 rounded-xl border border-slate-800" />
              <div className="grid grid-cols-3 gap-2">
                <div className="h-12 bg-slate-950 rounded-xl border border-slate-800" />
                <div className="h-12 bg-slate-950 rounded-xl border border-slate-800" />
                <div className="h-12 bg-slate-950 rounded-xl border border-slate-800" />
              </div>
              <div className="h-7 bg-slate-950 rounded-lg border border-slate-800" />
            </div>
          </div>
          <div className="flex-1 max-w-[1920px] w-full mx-auto p-2 sm:p-3 md:p-4 flex flex-col lg:flex-row gap-3 sm:gap-4 overflow-hidden">
            <section className="flex-1 flex flex-col gap-3 sm:gap-4 min-w-0 w-full overflow-hidden">
              <div className="h-[440px] sm:h-[480px] md:h-[500px] bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex items-center justify-center animate-pulse">
                <div className="flex items-center gap-2 text-slate-500 font-mono text-xs">
                  <span className="w-2 h-2 rounded-full bg-indigo-500 animate-ping" />
                  <span>Initializing Quant Terminal...</span>
                </div>
              </div>
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-center text-slate-500 text-xs shadow-md animate-pulse">
                Loading positions ledger...
              </div>
              <div className="bg-slate-900 border border-slate-800 rounded-xl h-44 animate-pulse" />
            </section>
            <section className="w-full lg:w-96 shrink-0">
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 h-[500px] animate-pulse" />
            </section>
          </div>
        </main>
      </LicenseGate>
    );
  }

  // Unified Top Navigation Bar + Clean Workspace Separation
  return (
    <LicenseGate>
      <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans select-none">
        <HeaderBar
          activeWorkspace={activeWorkspace}
          onWorkspaceChange={handleWorkspaceChange}
        />

        {activeWorkspace === 'FOREX' ? (
          <TradingTerminalInner />
        ) : (
          <BinanceFuturesRoom onSwitchToForex={() => handleWorkspaceChange('FOREX')} />
        )}
      </main>
    </LicenseGate>
  );
}
