/** Only same-site relative paths survive a login redirect (blocks open redirects, incl. "/\t/evil" which URL parsing collapses). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/';
  if (/[\u0000- \\\u007F]/.test(next)) return '/';
  return next;
}
