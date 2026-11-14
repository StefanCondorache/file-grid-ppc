/** Handle to the single live stream; LiveBridge (6a.10) registers the real one. */
export type LiveHandle = { close(): void; reconnect(): void };

let handle: LiveHandle = { close: () => {}, reconnect: () => {} };

export const liveHandle = {
  get: (): LiveHandle => handle,
  set: (h: LiveHandle) => {
    handle = h;
  },
};
