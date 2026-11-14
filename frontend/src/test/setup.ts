import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// RTL auto-cleanup needs Vitest globals; we keep globals off and clean up explicitly.
afterEach(() => cleanup());
