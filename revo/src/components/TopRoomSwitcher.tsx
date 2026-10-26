'use client';

import React from 'react';
import { useRoomStore } from '@/store/useRoomStore';

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

  const isForex = propActiveMarket
    ? propActiveMarket === 'FOREX'
    : storeActiveRoom === 'FOREX' || (storeActiveRoom as string) === 'ROOM_1_EXNESS';

  const handleSelect = (market: 'FOREX' | 'CRYPTO') => {
    onMarketChange?.(market);
    setActiveRoom(market);
  };

  return (
    <div className="bg-[#0B0E11] border-b border-slate-800/80 px-3 py-1.5 sm:px-4 select-none shrink-0">
      <div className="max-w-[1920px] mx-auto flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 sm:gap-2">
          <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider hidden sm:inline">
            WORKSPACE:
          </span>
          <div className="flex items-center bg-slate-950 p-0.5 rounded-xl border border-slate-800 shadow-inner">
            {/* FOREX Button */}
            <button
              type="button"
              onClick={() => handleSelect('FOREX')}
              className={`px-3 py-1 rounded-lg text-xs font-bold font-mono transition-all cursor-pointer flex items-center gap-1.5 ${
                isForex
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-900/40 border border-indigo-400/40'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${isForex ? 'bg-emerald-400' : 'bg-slate-600'}`} />
              <span>FOREX</span>
            </button>

            {/* CRYPTO Button */}
            <button
              type="button"
              onClick={() => handleSelect('CRYPTO')}
              className={`px-3 py-1 rounded-lg text-xs font-bold font-mono transition-all cursor-pointer flex items-center gap-1.5 ${
                !isForex
                  ? 'bg-[#F3BA2F] text-slate-950 shadow-md shadow-[#F3BA2F]/20 border border-[#F3BA2F]'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${!isForex ? 'bg-amber-900' : 'bg-slate-600'}`} />
              <span>CRYPTO</span>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="hidden xs:inline">Centralized AI Verification Active</span>
        </div>
      </div>
    </div>
  );
};

export default TopRoomSwitcher;
