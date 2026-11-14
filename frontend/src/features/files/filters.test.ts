import { describe, expect, it } from 'vitest';
import { activeFilterCount, DEFAULT_FILTERS, parseFilters, toApiQuery, toSearchParams, type FileFilters } from './filters';

const sp = (query: string) => new URLSearchParams(query);

const FULL: FileFilters = {
  category: 'fault_records',
  q: 'Medgidia',
  zone: 'dobrogea',
  from: '2026-11-12',
  to: '2026-11-14',
  uploader: 'dispecerat',
  integrity: 'corrupt',
  storage: 'ftp',
  origin: 'storm',
  excludeGenerated: true,
  sort: 'size',
  page: 3,
};

describe('file filters in the URL', () => {
  it('round-trips every filter through the URL', () => {
    const params = toSearchParams(FULL);
    expect(parseFilters(sp(params.toString()))).toEqual(FULL);
    // Shareable links use the short category alias of the plan's routes (`/files?category=fault`).
    expect(params.get('category')).toBe('fault');
  });

  it('accepts the short aliases and the real category ids', () => {
    expect(parseFilters(sp('category=meter')).category).toBe('meter_readings');
    expect(parseFilters(sp('category=connection_documents')).category).toBe('connection_documents');
    expect(toSearchParams(parseFilters(sp('category=drone_videos'))).toString()).toBe('category=drone');
  });

  it('drops invalid values and keeps the valid ones', () => {
    const query = [
      'category=nuclear', 'zone=moldova', 'from=2026-13-45', 'to=ieri', `q=${'x'.repeat(101)}`, 'uploader=root',
      'integrity=maybe', 'storage=db', 'origin=alien', 'excludeGenerated=yes', 'sort=name', 'page=-2',
    ].join('&');
    expect(parseFilters(sp(query))).toEqual({ ...DEFAULT_FILTERS, storage: 'db' });
    expect(parseFilters(sp('page=0')).page).toBe(1);
    expect(parseFilters(sp('page=2.5')).page).toBe(1);
    expect(parseFilters(sp('q=%20%20')).q).toBeUndefined();
  });

  it('writes the defaults as an empty query string', () => {
    expect(toSearchParams(DEFAULT_FILTERS).toString()).toBe('');
    expect(toSearchParams(parseFilters(sp('sort=-createdAt&page=1&excludeGenerated=0'))).toString()).toBe('');
  });

  it('counts the applied filters, not sort or page', () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...DEFAULT_FILTERS, sort: 'size', page: 4 })).toBe(0);
    expect(activeFilterCount(FULL)).toBe(10);
  });
});

describe('toApiQuery', () => {
  it('maps the filters to the real GET /files query, days in Bucharest time', () => {
    expect(toApiQuery(FULL, { page: 3, pageSize: 25 })).toEqual({
      category: 'fault_records',
      q: 'Medgidia',
      zone: 'dobrogea',
      from: '2026-11-12T00:00:00+02:00',
      to: '2026-11-14T23:59:59.999+02:00',
      integrity: 'corrupt',
      origin: 'storm',
      excludeGenerated: 'true',
      sort: 'size',
      page: '3',
      pageSize: '25',
    });
  });

  it('uses the summer offset in summer and sends only the defaults when nothing is filtered', () => {
    expect(toApiQuery({ ...DEFAULT_FILTERS, from: '2026-07-01' }, { page: 1, pageSize: 25 }).from).toBe('2026-07-01T00:00:00+03:00');
    expect(toApiQuery(DEFAULT_FILTERS, { page: 1, pageSize: 25 })).toEqual({ sort: '-createdAt', page: '1', pageSize: '25' });
  });
});
