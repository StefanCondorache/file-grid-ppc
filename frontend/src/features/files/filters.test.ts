import { describe, expect, it } from 'vitest';
import { activeFilterCount, DEFAULT_FILTERS, parseFilters, toApiQuery, toMeterApiQuery, toSearchParams, type FileFilters } from './filters';

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

describe('the meter readings view', () => {
  it('keeps only the filters GET /meter-readings applies, in the parsed state and in the written URL', () => {
    const query = 'category=meter&q=RO-BAN-000007&zone=banat&origin=storm&integrity=corrupt&storage=ftp&uploader=teren&from=2026-11-12&to=2026-11-14&excludeGenerated=1&sort=size&page=2';
    expect(parseFilters(sp(query))).toEqual({ category: 'meter_readings', q: 'RO-BAN-000007', zone: 'banat', origin: 'storm', sort: '-createdAt', page: 2 });
    expect(toSearchParams({ ...FULL, category: 'meter_readings' }).toString()).toBe('category=meter&q=Medgidia&zone=dobrogea&origin=storm&page=3');
    // No reading is uploaded by hand.
    expect(parseFilters(sp('category=meter&origin=manual')).origin).toBeUndefined();
    expect(activeFilterCount(parseFilters(sp(query)))).toBe(4);
  });

  it('maps the search to the exact meter id of the real GET /meter-readings query', () => {
    const f = parseFilters(sp('category=meter&q=RO-BAN-000007&zone=banat&origin=seed'));
    expect(toMeterApiQuery(f, { page: 2, pageSize: 25 })).toEqual({ meterId: 'RO-BAN-000007', zone: 'banat', origin: 'seed', page: '2', pageSize: '25' });
    expect(toMeterApiQuery(parseFilters(sp('category=meter')), { page: 1, pageSize: 25 })).toEqual({ page: '1', pageSize: '25' });
    // An id no meter can have (the ingest format is [A-Za-z0-9._-]{1,64}) is never sent.
    expect(toMeterApiQuery(parseFilters(sp('category=meter&q=RO%20MUN%207')), { page: 1, pageSize: 25 })).toBeNull();
    expect(toMeterApiQuery(parseFilters(sp(`category=meter&q=${'7'.repeat(65)}`)), { page: 1, pageSize: 25 })).toBeNull();
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
