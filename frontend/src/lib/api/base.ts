/** API prefix (contract proposal: /api/v1; the NestJS skeleton uses /api). Never hard-code it elsewhere. */
export const API_BASE: string = process.env.NEXT_PUBLIC_API_BASE ?? '/api/v1';

export function apiUrl(path: string): string {
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

/** openapi-fetch needs an absolute base: Node's Request rejects relative URLs (Vitest). */
export function absoluteBase(): string {
  const origin = typeof location !== 'undefined' && location.origin && location.origin !== 'null' ? location.origin : 'http://localhost';
  return new URL(API_BASE, origin).href;
}
