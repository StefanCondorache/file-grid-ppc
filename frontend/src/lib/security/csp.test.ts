import { describe, expect, it } from 'vitest';
import { buildCsp } from './csp';

const directive = (csp: string, name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';

describe('buildCsp', () => {
  it('static CSP allows wasm and workers, never unsafe-eval', () => {
    const csp = buildCsp({ dev: false });
    expect(directive(csp, 'script-src')).toContain("'wasm-unsafe-eval'");
    expect(directive(csp, 'worker-src')).toBe("worker-src 'self' blob:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain('upgrade-insecure-requests');
  });

  it('development adds eval and HMR websockets, drops the upgrade', () => {
    const csp = buildCsp({ dev: true });
    expect(directive(csp, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(csp, 'connect-src')).toContain('ws:');
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('nonce CSP replaces unsafe-inline (P1)', () => {
    const script = directive(buildCsp({ nonce: 'abc', dev: false }), 'script-src');
    expect(script).toContain("'nonce-abc'");
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toContain("'unsafe-inline'");
  });
});
