import type { NextConfig } from 'next';
import { buildCsp } from './src/lib/security/csp';

const dev = process.env.NODE_ENV === 'development';

const securityHeaders = [
  { key: 'Content-Security-Policy', value: buildCsp({ dev }) },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  images: { unoptimized: true },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  // Development only: proxy /api to a local backend. Production routing is Traefik (ADR-0002); never proxy bodies here.
  async rewrites() {
    if (!dev) return [];
    const target = process.env.API_DEV_PROXY_TARGET ?? 'http://localhost:8000';
    return [{ source: '/api/:path*', destination: `${target}/api/:path*` }];
  },
  turbopack: {
    rules: {
      '*.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' },
    },
  },
};

export default nextConfig;
