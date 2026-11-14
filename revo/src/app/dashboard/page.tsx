'use client';

import React from 'react';
import { LicenseGate } from '@/components/LicenseGate';
import { useRoomStore } from '@/store/useRoomStore';
import { useTradingStore } from '@/store/useTradingStore';
import { useBinanceStore } from '@/store/useBinanceStore';
import { TerminalHeader } from '@/components/navigation/TerminalHeader';
import { ForexTerminalRoom } from '@/components/forex/ForexTerminalRoom';
import { CryptoTerminalRoom } from '@/components/crypto/CryptoTerminalRoom';
import { ExnessVaultModal } from '@/components/ExnessVaultModal';
import { InstitutionalFooter } from '@/components/InstitutionalChrome';
import { Wrench } from 'lucide-react';

/**
 * Lightweight Client Terminal Layout Shell (< 120 lines)
 * Keeps both ForexTerminalRoom and CryptoTerminalRoom mounted using CSS visibility toggling
 * so switching tabs never unmounts or resets active scans, ticks, or positions.
 */
function ClientTerminalWorkspace() {
  const activeRoom = useRoomStore((s) => s.activeRoom);
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom);
  const maintenance = useRoomStore((s) => s.maintenance);
  const setMaintenance = useRoomStore((s) => s.setMaintenance);
  const activeMarket: 'FOREX' | 'CRYPTO' =
    activeRoom === 'CRYPTO' || activeRoom === 'ROOM_2_BINANCE' ? 'CRYPTO' : 'FOREX';

  // Poll Admin maintenance switches from /api/health
  React.useEffect(() => {
    let mounted = true;
    const syncMaintenance = async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const sw = data?.engineSwitches || {};
        const forex = Boolean(sw.forexMaintenance);
        const crypto = Boolean(sw.cryptoMaintenance);
        if (mounted) {
          setMaintenance({ forex, crypto });
        }
        if (forex && useTradingStore.getState().isAutoTrading) {
          useTradingStore.getState().toggleAutoTrading(false).catch(() => {});
        }
        if (crypto && useBinanceStore.getState().isAutoTrading) {
          useBinanceStore.getState().setIsAutoTrading(false);
        }
      } catch {}
    };

    syncMaintenance();
    const timer = setInterval(syncMaintenance, 15000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  // Synchronize active room with server engine scheduler
  React.useEffect(() => {
    fetch('/api/binance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'SYNC_ACTIVE_ROOM', activeRoom: activeMarket }),
    }).catch(() => {});
  }, [activeMarket]);

  const isCurrentRoomInMaintenance =
    (activeMarket === 'FOREX' && maintenance.forex) ||
    (activeMarket === 'CRYPTO' && maintenance.crypto);

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] dark:bg-slate-950 text-[#0F172A] dark:text-slate-100 transition-colors">
      <TerminalHeader />

      {/* Room 1: Forex · Exness (persisted across tab switches) */}
      <div className={activeMarket === 'FOREX' && !maintenance.forex ? 'flex flex-1 w-full min-h-0' : 'hidden'}>
        <ForexTerminalRoom isActiveRoom={activeMarket === 'FOREX' && !maintenance.forex} />
      </div>

      {/* Room 2: Crypto · Binance / Bitget (persisted across tab switches) */}
      <div className={activeMarket === 'CRYPTO' && !maintenance.crypto ? 'flex flex-1 w-full min-h-0' : 'hidden'}>
        <CryptoTerminalRoom isActiveRoom={activeMarket === 'CRYPTO' && !maintenance.crypto} />
      </div>

      {isCurrentRoomInMaintenance && (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white dark:bg-zinc-900 border border-amber-300 dark:border-amber-500/40 rounded-3xl p-6 sm:p-8 shadow-xl text-center space-y-4">
            <div className="w-12 h-12 mx-auto rounded-2xl bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 flex items-center justify-center border border-amber-300/70 dark:border-amber-500/30">
              <Wrench className="w-6 h-6" />
            </div>
            <div className="space-y-1.5">
              <div className="inline-block font-mono text-[10px] font-bold uppercase tracking-widest px-2.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300">
                MAINTENANCE &amp; UPGRADE MODE
              </div>
              <h2 className="text-lg font-extrabold text-[#0F172A] dark:text-slate-100">
                {activeMarket === 'FOREX' ? 'Forex Room (Exness)' : 'Crypto Room (Binance / Bitget)'} Sedang Pemeliharaan
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                Admin sedang melakukan pemeliharaan atau upgrade sistem pada modul {activeMarket === 'FOREX' ? 'Forex' : 'Crypto'}. Auto-trading dihentikan sementara demi keamanan akun.
              </p>
            </div>
            {((activeMarket === 'FOREX' && !maintenance.crypto) || (activeMarket === 'CRYPTO' && !maintenance.forex)) && (
              <button
                type="button"
                onClick={() => setActiveRoom(activeMarket === 'FOREX' ? 'CRYPTO' : 'FOREX')}
                className="w-full py-2.5 px-4 rounded-xl bg-[#0F172A] dark:bg-emerald-600 text-white font-mono text-xs font-bold hover:opacity-90 transition cursor-pointer"
              >
                Beralih ke {activeMarket === 'FOREX' ? 'Crypto Room' : 'Forex Room'}
              </button>
            )}
          </div>
        </div>
      )}

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
