'use client';

import React from 'react';
import { LicenseLoginModal } from '../components/LicenseLoginModal';
import { useLicenseAuth } from '../hooks/useLicenseAuth';

/**
 * Example demonstrating how to gate a Quantitative Trading Dashboard behind
 * the LicenseLoginModal component.
 */
export default function TradingDashboardPage() {
  const { isAuthenticated, isLoading, license, user, login, logout, remainingDays } =
    useLicenseAuth();

  // 1. Loading state while checking localStorage
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 font-mono text-xs text-slate-400">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 animate-ping rounded-full bg-indigo-500" />
          <span>INITIALIZING QUANT TRADING ENGINE...</span>
        </div>
      </div>
    );
  }

  // 2. Unauthenticated: Show License Login Screen / Modal
  if (!isAuthenticated) {
    return (
      <LicenseLoginModal
        isModal={false} // Full-page mode
        terminalName="EXNESS QUANT TERMINAL"
        onLoginSuccess={(data) => {
          login(data);
        }}
      />
    );
  }

  // 3. Authenticated: Render Main Dashboard
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Top Navigation Bar */}
      <header className="border-b border-slate-800 bg-slate-900/50 px-6 py-3.5 backdrop-blur-md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/50" />
            <h1 className="font-mono text-sm font-semibold tracking-wider text-slate-200 uppercase">
              Exness Quant Terminal
            </h1>
            <span className="rounded bg-indigo-500/10 px-2 py-0.5 font-mono text-xs text-indigo-400 border border-indigo-500/20">
              LIVE FEED
            </span>
          </div>

          <div className="flex items-center gap-4 text-xs">
            <div className="flex items-center gap-2 rounded-lg bg-slate-900 border border-slate-800 px-3 py-1.5">
              <span className="text-slate-400">User:</span>
              <span className="font-semibold text-slate-200">@{user?.username}</span>
              <span className="text-slate-600">|</span>
              <span className="text-slate-400">Key:</span>
              <span className="font-mono text-indigo-400">{license?.licenseKey}</span>
              <span className="text-slate-600">|</span>
              <span className="text-emerald-400 font-mono">{remainingDays}d remaining</span>
            </div>

            <button
              onClick={logout}
              className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 font-medium text-slate-300 transition-colors hover:border-rose-900 hover:bg-rose-950/30 hover:text-rose-400"
            >
              Disconnect
            </button>
          </div>
        </div>
      </header>

      {/* Main Terminal View Mock */}
      <main className="p-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5">
            <h3 className="text-xs font-mono uppercase text-slate-400">Active Trading Pairs</h3>
            <p className="mt-2 text-2xl font-bold font-mono text-slate-100">EUR/USD, BTC/USD</p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5">
            <h3 className="text-xs font-mono uppercase text-slate-400">Total Simulated PnL</h3>
            <p className="mt-2 text-2xl font-bold font-mono text-emerald-400">+14.82%</p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5">
            <h3 className="text-xs font-mono uppercase text-slate-400">Execution Latency</h3>
            <p className="mt-2 text-2xl font-bold font-mono text-indigo-400">0.82 ms</p>
          </div>
        </div>
      </main>
    </div>
  );
}
