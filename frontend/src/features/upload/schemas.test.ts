import { describe, expect, it } from 'vitest';
import { cnpIsValid, connectionMetadataSchema, droneMetadataSchema, faultMetadataSchema } from './schemas';

/** Weights of the official CNP control digit (S AA LL ZZ JJ NNN C). */
const VALID_CNP = '1960101410019'; // 1·2 + 9·7 + 6·9 + 0·1 + 1·4 + 0·6 + 1·3 + 4·5 + 1·8 + 0·2 + 0·7 + 1·9 = 163; 163 mod 11 = 9
const WRONG_CONTROL = '1960101410018';

describe('cnpIsValid', () => {
  it('follows the official checksum', () => {
    expect(cnpIsValid(VALID_CNP)).toBe(true);
    expect(cnpIsValid('2850228123457')).toBe(true); // sum 249, 249 mod 11 = 7
    expect(cnpIsValid(WRONG_CONTROL)).toBe(false);
    expect(cnpIsValid('2850228123453')).toBe(false);
  });

  it('a remainder of 10 gives control digit 1', () => {
    // 196010141006: sum 208, 208 mod 11 = 10
    expect(cnpIsValid('1960101410061')).toBe(true);
    expect(cnpIsValid('1960101410060')).toBe(false);
  });

  it('needs 13 digits, the first one not 0', () => {
    expect(cnpIsValid('196010141001')).toBe(false);
    expect(cnpIsValid('19601014100190')).toBe(false);
    expect(cnpIsValid('196010141001a')).toBe(false);
    expect(cnpIsValid('0960101410019')).toBe(false);
    expect(cnpIsValid('')).toBe(false);
  });
});

describe('metadata schemas', () => {
  it('give the contract shape of each category', () => {
    expect(
      faultMetadataSchema.parse({ kind: 'fault', zone: 'dobrogea', substation: ' PT Medgidia 0412 ', eventTime: '2026-11-14T15:41', severity: 'high' }),
    ).toEqual({ kind: 'fault', zone: 'dobrogea', substation: 'PT Medgidia 0412', eventTime: new Date('2026-11-14T15:41').toISOString(), severity: 'high' });

    expect(droneMetadataSchema.parse({ kind: 'drone', lineSection: 'LEA 110 kV Călărași – Oltenița', zone: 'muntenia', inspectionDate: '2026-11-14' })).toEqual({
      kind: 'drone',
      lineSection: 'LEA 110 kV Călărași – Oltenița',
      zone: 'muntenia',
      inspectionDate: '2026-11-14',
    });

    expect(
      connectionMetadataSchema.parse({ kind: 'connection', requestNumber: 'RC-2026-0412', documentType: 'act_identitate', applicantName: 'Ion Popescu', cnp: ' 1960101 410019 ', zone: '' }),
    ).toEqual({ kind: 'connection', requestNumber: 'RC-2026-0412', documentType: 'act_identitate', applicantName: 'Ion Popescu', cnp: VALID_CNP, zone: undefined });
  });

  it('explain in Romanian what to fix', () => {
    const issues = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
      Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join('.'), i.message]));

    expect(issues(connectionMetadataSchema.safeParse({ kind: 'connection', requestNumber: 'RC-1', documentType: 'cerere', applicantName: 'Ion Popescu', cnp: WRONG_CONTROL, zone: '' }))).toEqual({
      cnp: 'CNP-ul nu este valid: ultima cifră (cifra de control) nu se potrivește cu celelalte. Verifică cifrele.',
    });
    expect(issues(connectionMetadataSchema.safeParse({ kind: 'connection', requestNumber: '', documentType: '', applicantName: '', cnp: '123', zone: '' }))).toEqual({
      requestNumber: 'Introdu numărul cererii.',
      documentType: 'Alege tipul documentului.',
      applicantName: 'Introdu numele solicitantului.',
      cnp: 'Introdu un CNP din 13 cifre.',
    });
    expect(issues(faultMetadataSchema.safeParse({ kind: 'fault', zone: '', substation: '', eventTime: '', severity: '' }))).toEqual({
      zone: 'Alege zona.',
      substation: 'Introdu stația sau postul de transformare.',
      eventTime: 'Introdu data și ora avariei.',
      severity: 'Alege severitatea.',
    });
    expect(issues(droneMetadataSchema.safeParse({ kind: 'drone', lineSection: '', zone: '', inspectionDate: '' }))).toEqual({
      lineSection: 'Introdu linia sau tronsonul.',
      zone: 'Alege zona.',
      inspectionDate: 'Introdu data inspecției.',
    });
  });
});
