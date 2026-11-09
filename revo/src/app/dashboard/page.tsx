'use client';

import React from 'react';
import { LicenseGate } from '@/components/LicenseGate';
import { useRoomStore } from '@/store/useRoomStore';
import { TerminalHeader } from '@/components/navigation/TerminalHeader';
import { ForexTerminalRoom } from '@/components/forex/ForexTerminalRoom';
import { CryptoTerminalRoom } from '@/components/crypto/CryptoTerminalRoom';
import { ExnessVaultModal } from '@/components/ExnessVaultModal';
import { InstitutionalFooter } from '@/components/InstitutionalChrome';

/**
 * Lightweight Client Terminal Layout Shell (< 120 lines)
 * Keeps both ForexTerminalRoom and CryptoTerminalRoom mounted using CSS visibility toggling
 * so switching tabs never unmounts or resets active scans, ticks, or positions.
 */
function ClientTerminalWorkspace() {
  const activeRoom = useRoomStore((s) => s.activeRoom);
  const activeMarket: 'FOREX' | 'CRYPTO' =
    activeRoom === 'CRYPTO' || activeRoom === 'ROOM_2_BINANCE' ? 'CRYPTO' : 'FOREX';

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] dark:bg-slate-950 text-[#0F172A] dark:text-slate-100 transition-colors">
      <TerminalHeader />

      {/* Room 1: Forex · Exness (persisted across tab switches) */}
      <div className={activeMarket === 'FOREX' ? 'flex flex-1 w-full min-h-0' : 'hidden'}>
        <ForexTerminalRoom />
      </div>

      {/* Room 2: Crypto · Binance / Bitget (persisted across tab switches) */}
      <div className={activeMarket === 'CRYPTO' ? 'flex flex-1 w-full min-h-0' : 'hidden'}>
        <CryptoTerminalRoom />
      </div>

      {/* Isolated Exness Vault Modal */}
      <ExnessVaultModal />

      {/* Institutional System Footer */}
      <InstitutionalFooter />
    </div>
  );
}

export default function LiveTradingDashboardPage() {
  return (
    <LicenseGate>
      <ClientTerminalWorkspace />
    </LicenseGate>
  );
}
