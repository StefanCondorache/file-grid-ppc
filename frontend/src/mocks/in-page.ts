import { getResponse, type RequestHandler } from 'msw';

/** Hybrid mode: answer mocked groups inside the page; everything else goes to the network untouched. */
export function createMockFetch(handlers: RequestHandler[]): (request: Request) => Promise<Response> {
  return async (request) => (await getResponse(handlers, request.clone())) ?? fetch(request);
}
