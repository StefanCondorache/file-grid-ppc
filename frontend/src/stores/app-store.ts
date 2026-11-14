import { create } from 'zustand';

export type AppLiveStatus = 'connecting' | 'open' | { reconnectingInS: number } | 'offline' | 'polling';

type AppState = {
  live: AppLiveStatus;
  lastEventAt: number | null;
  /** "Actualizări live" pause (A11Y-14): no updates and no motion while true. */
  livePaused: boolean;
  setLive: (s: AppLiveStatus) => void;
  markEvent: (at: number) => void;
  setLivePaused: (paused: boolean) => void;
};

/** Small client store written by non-React code (stream, API client). Server data lives in TanStack Query. */
export const useAppStore = create<AppState>((set) => ({
  live: 'connecting',
  lastEventAt: null,
  livePaused: false,
  setLive: (live) => set({ live }),
  markEvent: (lastEventAt) => set({ lastEventAt }),
  setLivePaused: (livePaused) => set({ livePaused }),
}));
