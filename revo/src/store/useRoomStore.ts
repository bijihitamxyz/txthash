import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type WorkspaceRoom = 'FOREX' | 'CRYPTO' | 'ROOM_1_EXNESS' | 'ROOM_2_BINANCE';

interface RoomStoreState {
  activeRoom: WorkspaceRoom;
  setActiveRoom: (room: WorkspaceRoom) => void;
}

export const useRoomStore = create<RoomStoreState>()(
  persist(
    (set) => ({
      activeRoom: 'FOREX',
      setActiveRoom: (activeRoom) => set({ activeRoom }),
    }),
    {
      name: 'quant_workspace_active_room_v2',
      storage: createJSONStorage(() => localStorage),
    }
  )
);
