/** Live stream event names and envelope (BA-60, frontend-architecture §4). */
export const STREAM_EVENT_TYPES = [
  'ping',
  'meters.counters',
  'guarantees.status',
  'alert.raised',
  'alert.updated',
  'storage.health',
  'file.created',
  'file.integrity',
  'upload.verified',
  'policy.updated',
  'simulator.status',
  'demo.storm',
] as const;

export type StreamEventType = (typeof STREAM_EVENT_TYPES)[number];

export type StreamEvent = { type: StreamEventType; id: number; data: unknown };
