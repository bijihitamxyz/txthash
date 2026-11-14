import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type WorkspaceRoom = 'FOREX' | 'CRYPTO' | 'ROOM_1_EXNESS' | 'ROOM_2_BINANCE';

export interface RoomMaintenanceState {
  forex: boolean;
  crypto: boolean;
}

interface RoomStoreState {
  activeRoom: WorkspaceRoom;
  maintenance: RoomMaintenanceState;
  setActiveRoom: (room: WorkspaceRoom) => void;
  setMaintenance: (maintenance: RoomMaintenanceState) => void;
}

function isCryptoRoom(room: WorkspaceRoom): boolean {
  return room === 'CRYPTO' || room === 'ROOM_2_BINANCE';
}

export const useRoomStore = create<RoomStoreState>()(
  persist(
    (set) => ({
      activeRoom: 'FOREX',
      maintenance: { forex: false, crypto: false },
      setActiveRoom: (activeRoom) =>
        set((state) => {
          const targetIsCrypto = isCryptoRoom(activeRoom);
          if (targetIsCrypto && state.maintenance.crypto) return state;
          if (!targetIsCrypto && state.maintenance.forex) return state;
          return { activeRoom };
        }),
      setMaintenance: (maintenance) => set({ maintenance }),
    }),
    {
      name: 'quant_workspace_active_room_v2',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ activeRoom: state.activeRoom }),
    }
  )
);
