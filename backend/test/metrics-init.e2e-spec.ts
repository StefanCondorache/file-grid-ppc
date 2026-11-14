import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { CATEGORIES, STORAGES } from '../src/common/domain';
import { createTestApp, memoryStorages, resetDatabase } from './helpers';

/**
 * rate() and increase() need two samples of a series: a counter that appears only with its first
 * failure (already at 1) hides that failure from every alert. So the failure outcomes are exported
 * at 0 from the start.
 */
describe('/metrics before any traffic', () => {
  let app: NestExpressApplication;
  let text: string;
  const sample = (series: string): string | undefined => {
    const line = text.split('\n').find((l) => l.startsWith(`${series} `));
    return line?.slice(series.length + 1);
  };

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp({ storage: memoryStorages().registry });
    text = (await request(app.getHttpServer()).get('/metrics')).text;
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(CATEGORIES)('exports every upload and download outcome of %s at 0', (category) => {
    for (const outcome of ['success', 'mismatch', 'error']) {
      expect(sample(`filegrid_uploads_total{category="${category}",outcome="${outcome}"}`)).toBe(
        '0',
      );
    }
    for (const outcome of ['success', 'corrupt', 'aborted', 'error']) {
      expect(sample(`filegrid_downloads_total{category="${category}",outcome="${outcome}"}`)).toBe(
        '0',
      );
    }
    expect(sample(`filegrid_bulkhead_rejected_total{category="${category}"}`)).toBe('0');
    for (const storage of STORAGES) {
      expect(
        sample(`filegrid_integrity_failures_total{category="${category}",storage="${storage}"}`),
      ).toBe('0');
    }
  });

  it('exports every meter batch outcome and the loss gauge at 0', () => {
    for (const outcome of ['success', 'rejected', 'error']) {
      expect(sample(`filegrid_meter_batches_total{outcome="${outcome}"}`)).toBe('0');
    }
    expect(sample('filegrid_meter_readings_duplicate_stored_total')).toBe('0');
    expect(sample('filegrid_meter_readings_lost')).toBe('0');
  });
});
