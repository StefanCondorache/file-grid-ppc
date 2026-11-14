import { setupServer } from 'msw/node';
import type { RequestHandler } from 'msw';

/** MSW server for Vitest; tests pass the handlers they need (usually `await buildHandlers('all')`). */
export function createMockServer(...handlers: RequestHandler[]) {
  return setupServer(...handlers);
}
