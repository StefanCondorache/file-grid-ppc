import type { NextConfig } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { checkBuildGuard } from './src/lib/config/mock-guard';

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  images: { unoptimized: true },
  turbopack: {
    rules: {
      '*.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' },
    },
  },
};

export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD) {
    const error = checkBuildGuard();
    if (error) throw new Error(error);
  }
  return nextConfig;
}
