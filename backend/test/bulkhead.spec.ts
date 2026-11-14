import { BulkheadService } from '../src/bulkhead/bulkhead.service';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('BulkheadService', () => {
  it('limits concurrency per category without slowing the others', async () => {
    const bulkhead = new BulkheadService();
    const gate = deferred();
    let meterRunning = 0;
    let meterPeak = 0;
    const meterJob = () =>
      bulkhead.run('meter_readings', 2, async () => {
        meterRunning += 1;
        meterPeak = Math.max(meterPeak, meterRunning);
        await gate.promise;
        meterRunning -= 1;
      });

    const storm = [meterJob(), meterJob(), meterJob(), meterJob()];
    const fault = await bulkhead.run('fault_records', 1, async () => 'fault done');

    expect(fault).toBe('fault done');
    expect(bulkhead.snapshot().meter_readings).toEqual({ active: 2, queued: 2 });
    gate.release();
    await Promise.all(storm);
    expect(meterPeak).toBe(2);
    expect(bulkhead.snapshot().meter_readings).toEqual({ active: 0, queued: 0 });
  });

  it('rejects at once with 503 CATEGORY_BUSY when the queue is full', async () => {
    const bulkhead = new BulkheadService();
    const gate = deferred();
    const held = Array.from({ length: 5 }, () =>
      bulkhead.run('drone_videos', 1, () => gate.promise),
    );

    await expect(bulkhead.run('drone_videos', 1, async () => undefined)).rejects.toMatchObject({
      status: 503,
      code: 'CATEGORY_BUSY',
    });
    gate.release();
    await Promise.all(held);
  });

  it('releases the slot when the job throws', async () => {
    const bulkhead = new BulkheadService();

    await expect(
      bulkhead.run('fault_records', 1, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(bulkhead.run('fault_records', 1, async () => 'ok')).resolves.toBe('ok');
  });
});
