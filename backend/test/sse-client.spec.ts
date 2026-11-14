import { SseClient, type SseTarget, nextEventId } from '../src/events/sse-client';

class FakeResponse implements SseTarget {
  written: string[] = [];
  writableLength = 0;
  ended = false;
  destroyed = false;
  /** Simulates a client that stops reading: nothing written is ever flushed. */
  stalled = false;

  write(chunk: string): boolean {
    this.written.push(chunk);
    if (this.stalled) this.writableLength += Buffer.byteLength(chunk);
    return !this.stalled;
  }

  end(): void {
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

describe('SseClient', () => {
  it('drops a client that does not read once its buffer passes the limit', () => {
    const target = new FakeResponse();
    const onClose = jest.fn();
    const client = new SseClient(target, { maxBufferedBytes: 1000, nextId: nextEventId, onClose });
    client.start();
    target.stalled = true;

    for (let i = 0; i < 50 && client.isOpen; i += 1) {
      client.send({ type: 'file.created', data: { fileId: `f-${i}`, padding: 'x'.repeat(100) } });
    }

    expect(client.isOpen).toBe(false);
    expect(target.destroyed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(target.writableLength).toBeLessThan(1500);
  });

  it('frames events with a monotonic id, the event name and one JSON data line', () => {
    const target = new FakeResponse();
    const client = new SseClient(target, {
      maxBufferedBytes: 10_000,
      nextId: nextEventId,
      onClose: () => undefined,
    });

    client.start();
    client.send({ type: 'policy.updated', data: { category: 'fault_records', version: 3 } });
    client.send({ type: 'policy.updated', data: { category: 'drone_videos', version: 2 } });

    expect(target.written[0]).toBe('retry: 3000\n\n');
    const ids = target.written.slice(1).map((frame) => Number(/^id: (\d+)\n/.exec(frame)?.[1]));
    expect(ids[1]).toBeGreaterThan(ids[0]);
    expect(target.written[1]).toMatch(
      /^id: \d+\nevent: policy\.updated\ndata: \{"category":"fault_records","version":3\}\n\n$/,
    );
    client.close();
    expect(target.ended).toBe(true);
  });
});
