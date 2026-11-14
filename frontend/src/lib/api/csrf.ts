/** CSRF defence in depth (ADR-0006): non-GET requests carry a header a cross-site form cannot set. */
export function csrfHeaders(method: string): Record<string, string> {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) ? {} : { 'X-Requested-With': 'filegrid' };
}
