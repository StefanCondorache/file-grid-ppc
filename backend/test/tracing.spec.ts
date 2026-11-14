import { createRootLogger } from '../src/observability/logger';
import { currentTraceId, runWithTrace, span } from '../src/observability/trace-context';
import { memoryLogDestination } from './log-capture';

describe('trace context', () => {
  it('records spans with attributes, status and error type', async () => {
    const trace = await runWithTrace('trace-abc', async (current) => {
      await span('storage.put', { storage: 's3', category: 'fault_record' }, async (attrs) => {
        attrs.bytes = 4096;
      });
      await expect(
        span('audit', {}, async () => {
          throw new RangeError('audit store down');
        }),
      ).rejects.toThrow('audit store down');
      return current;
    });

    expect(trace.spans.map((s) => s.name)).toEqual(['storage.put', 'audit']);
    expect(trace.spans[0].attrs).toEqual({ storage: 's3', category: 'fault_record', bytes: 4096 });
    expect(trace.spans[0].status).toBe('ok');
    expect(trace.spans[1]).toMatchObject({ status: 'error', error: 'RangeError' });
    expect(trace.spans.every((s) => s.durationMs >= 0)).toBe(true);
  });

  it('keeps the trace across awaits and restores the outer one', async () => {
    await runWithTrace('outer', async () => {
      await runWithTrace('inner', async () => {
        await Promise.resolve();
        expect(currentTraceId()).toBe('inner');
      });
      expect(currentTraceId()).toBe('outer');
    });

    expect(currentTraceId()).toBeUndefined();
  });

  it('lets a span outside any trace run normally', async () => {
    await expect(span('orphan', {}, async () => 42)).resolves.toBe(42);
  });

  it('writes JSON log lines that carry the current trace id and extra fields', () => {
    const destination = memoryLogDestination();
    const logger = createRootLogger('info', destination);

    runWithTrace('trace-log', () => logger.info({ category: 'drone_video' }, 'chunk stored'));

    expect(destination.lines()[0]).toMatchObject({
      trace_id: 'trace-log',
      message: 'chunk stored',
      level: 'info',
      category: 'drone_video',
    });
  });
});
