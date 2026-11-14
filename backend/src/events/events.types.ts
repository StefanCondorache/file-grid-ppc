import type { Capability, Role } from '../common/domain';
import { can } from '../common/domain';

/**
 * Live-stream events (GET /stream, ADR-0008). The names and payloads are the frontend proposal's
 * `x-sse-events`; every payload is a snapshot or a hint, clients refetch over REST on (re)connect.
 */
export const STREAM_EVENTS = [
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
export type StreamEventName = (typeof STREAM_EVENTS)[number];

/** Who may receive an event; no audience = every logged-in user. */
export interface Audience {
  /** The active role must have this capability. */
  readonly capability?: Capability;
  /** Only this account (the real user, e.g. the uploader). */
  readonly username?: string;
}

export interface StreamEvent {
  readonly type: StreamEventName;
  readonly data: Readonly<Record<string, unknown>>;
  readonly audience?: Audience;
}

/** Snapshot events sent at most every `COALESCE_MS` per client; the newest one wins. */
export const COALESCED_EVENTS: ReadonlySet<StreamEventName> = new Set([
  'meters.counters',
  'storage.health',
  'simulator.status',
  'guarantees.status',
]);
export const COALESCE_MS = 500;

export function visibleTo(
  event: StreamEvent,
  viewer: { readonly username: string; readonly activeRole: Role },
): boolean {
  const audience = event.audience;
  if (!audience) return true;
  if (audience.username !== undefined && audience.username !== viewer.username) return false;
  return audience.capability === undefined || can(viewer.activeRole, audience.capability);
}
