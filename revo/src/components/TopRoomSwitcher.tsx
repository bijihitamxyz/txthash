'use client';

import React from 'react';
import { Lock } from 'lucide-react';
import { useRoomStore } from '@/store/useRoomStore';
import { useBinanceStore } from '@/store/useBinanceStore';

interface TopRoomSwitcherProps {
  activeMarket?: 'FOREX' | 'CRYPTO';
  onMarketChange?: (market: 'FOREX' | 'CRYPTO') => void;
}

export const TopRoomSwitcher: React.FC<TopRoomSwitcherProps> = ({
  activeMarket: propActiveMarket,
  onMarketChange,
}) => {
  const storeActiveRoom = useRoomStore((s) => s.activeRoom);
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom);
  const maintenance = useRoomStore((s) => s.maintenance);
  const activeExchange = useBinanceStore((s) => s.activeExchange || 'BINANCE');

  const isForex = propActiveMarket
    ? propActiveMarket === 'FOREX'
    : storeActiveRoom === 'FOREX' || (storeActiveRoom as string) === 'ROOM_1_EXNESS';

  const handleSelect = (market: 'FOREX' | 'CRYPTO') => {
    if (market === 'FOREX' && maintenance.forex) return;
    if (market === 'CRYPTO' && maintenance.crypto) return;
    onMarketChange?.(market);
    setActiveRoom(market);
  };

  return (
    <div className="bg-white border-b border-slate-200 px-3 py-1.5 sm:px-4 select-none shrink-0">
      <div className="max-w-[1920px] mx-auto flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 sm:gap-2">
          <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider hidden sm:inline">
            MARKET:
          </span>
          <div className="flex items-center bg-slate-100 p-0.5 rounded-xl border border-slate-200">
            <button
              type="button"
              disabled={maintenance.forex}
              aria-disabled={maintenance.forex}
              title={maintenance.forex ? 'Forex Room sedang dalam mode Maintenance (Terkunci)' : undefined}
              onClick={() => handleSelect('FOREX')}
              className={`px-3 py-1 rounded-lg text-xs font-bold font-mono transition-all flex items-center gap-1.5 ${
                maintenance.forex
                  ? 'opacity-50 cursor-not-allowed text-slate-400 select-none'
                  : isForex
                  ? 'bg-[#0F172A] text-white shadow-xs cursor-pointer'
                  : 'text-slate-600 hover:text-[#0F172A] cursor-pointer'
              }`}
            >
              {maintenance.forex ? (
                <Lock className="w-3 h-3 text-amber-500" />
              ) : (
                <span className={`w-1.5 h-1.5 rounded-full ${isForex ? 'bg-emerald-400' : 'bg-slate-400'}`} />
              )}
              <span>FOREX · Exness</span>
            </button>

            <button
              type="button"
              disabled={maintenance.crypto}
              aria-disabled={maintenance.crypto}
              title={maintenance.crypto ? 'Crypto Room sedang dalam mode Maintenance (Terkunci)' : undefined}
              onClick={() => handleSelect('CRYPTO')}
              className={`px-3 py-1 rounded-lg text-xs font-bold font-mono transition-all flex items-center gap-1.5 ${
                maintenance.crypto
                  ? 'opacity-50 cursor-not-allowed text-slate-400 select-none'
                  : !isForex
                  ? 'bg-[#0F172A] text-white shadow-xs cursor-pointer'
                  : 'text-slate-600 hover:text-[#0F172A] cursor-pointer'
              }`}
            >
              {maintenance.crypto ? (
                <Lock className="w-3 h-3 text-amber-500" />
              ) : (
                <span className={`w-1.5 h-1.5 rounded-full ${!isForex ? 'bg-emerald-400' : 'bg-slate-400'}`} />
              )}
              <span>CRYPTO · {activeExchange === 'BITGET' ? 'Bitget' : 'Binance'}</span>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 text-[10px] font-mono text-slate-500">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span className="hidden sm:inline">Multi-AI Risk Governance + Kronos Pipeline</span>
        </div>
      </div>
    </div>
  );
};

export default TopRoomSwitcher;
