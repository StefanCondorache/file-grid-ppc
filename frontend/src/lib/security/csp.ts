/**
 * Content-Security-Policy (threat-model §6, ADR-0012).
 * P0 ships a static policy (no nonce → 'unsafe-inline' for Next's inline scripts, recorded as a residual risk);
 * P1 passes a per-request nonce from proxy.ts, which removes 'unsafe-inline' from script-src.
 */
export function buildCsp({ nonce, dev }: { nonce?: string; dev: boolean }): string {
  const script = ["'self'", nonce ? `'nonce-${nonce}' 'strict-dynamic'` : "'unsafe-inline'", "'wasm-unsafe-eval'", dev ? "'unsafe-eval'" : '']
    .filter(Boolean)
    .join(' ');
  const directives = [
    "default-src 'self'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    dev ? "connect-src 'self' ws: wss:" : "connect-src 'self'",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    dev ? '' : 'upgrade-insecure-requests',
  ];
  return directives.filter(Boolean).join('; ');
}
