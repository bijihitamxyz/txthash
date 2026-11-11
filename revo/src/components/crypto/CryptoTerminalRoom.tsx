'use client';

import React from 'react';
import { BinanceFuturesRoom } from '@/components/BinanceFuturesRoom';
import { useRoomStore } from '@/store/useRoomStore';

export interface CryptoTerminalRoomProps {
  onSwitchToForex?: () => void;
  isActiveRoom?: boolean;
}

export const CryptoTerminalRoom: React.FC<CryptoTerminalRoomProps> = ({ onSwitchToForex, isActiveRoom = true }) => {
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom);
  const handleSwitchToForex = onSwitchToForex || (() => setActiveRoom('FOREX'));

  return (
    <div className="flex flex-1 w-full min-h-0">
      <BinanceFuturesRoom onSwitchToForex={handleSwitchToForex} isActiveRoom={isActiveRoom} />
    </div>
  );
};

export default CryptoTerminalRoom;
