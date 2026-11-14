import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import jsxA11y from 'eslint-plugin-jsx-a11y';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // jsx-a11y is already registered by eslint-config-next; add its strict rule set only.
  { files: ['**/*.{ts,tsx}'], rules: { ...jsxA11y.flatConfigs.strict.rules } },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'react/no-danger': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-properties': ['error',
        { property: 'innerHTML', message: 'SR-1: render through React text nodes.' },
        { property: 'outerHTML', message: 'SR-1: render through React text nodes.' },
        { property: 'insertAdjacentHTML', message: 'SR-1: render through React text nodes.' },
        { object: 'document', property: 'write', message: 'SR-1.' }],
      'no-restricted-globals': ['error',
        { name: 'localStorage', message: 'SR-3: no tokens or PII in web storage.' },
        { name: 'sessionStorage', message: 'SR-3: no tokens or PII in web storage.' }],
    },
  },
  // Mocks may persist fake state in localStorage (never real data).
  { files: ['src/mocks/**'], rules: { 'no-restricted-globals': 'off' } },
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'public/mockServiceWorker.js', 'src/lib/api/schema.d.ts']),
]);

export default eslintConfig;
