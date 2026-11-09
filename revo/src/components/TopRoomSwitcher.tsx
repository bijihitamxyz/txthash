'use client';

import React from 'react';
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
  const activeExchange = useBinanceStore((s) => s.activeExchange || 'BINANCE');

  const isForex = propActiveMarket
    ? propActiveMarket === 'FOREX'
    : storeActiveRoom === 'FOREX' || (storeActiveRoom as string) === 'ROOM_1_EXNESS';

  const handleSelect = (market: 'FOREX' | 'CRYPTO') => {
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
              onClick={() => handleSelect('FOREX')}
              className={`px-3 py-1 rounded-lg text-xs font-bold font-mono transition-all cursor-pointer flex items-center gap-1.5 ${
                isForex
                  ? 'bg-[#0F172A] text-white shadow-xs'
                  : 'text-slate-600 hover:text-[#0F172A]'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${isForex ? 'bg-emerald-400' : 'bg-slate-400'}`} />
              <span>FOREX · Exness</span>
            </button>

            <button
              type="button"
              onClick={() => handleSelect('CRYPTO')}
              className={`px-3 py-1 rounded-lg text-xs font-bold font-mono transition-all cursor-pointer flex items-center gap-1.5 ${
                !isForex
                  ? 'bg-[#0F172A] text-white shadow-xs'
                  : 'text-slate-600 hover:text-[#0F172A]'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${!isForex ? 'bg-emerald-400' : 'bg-slate-400'}`} />
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
