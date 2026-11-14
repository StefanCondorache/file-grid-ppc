import { type IncomingMessage, get } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';

export interface SseFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data?: unknown;
  readonly retry?: number;
}

export interface OpenStream {
  readonly status: number;
  readonly headers: IncomingMessage['headers'];
  readonly frames: SseFrame[];
  /** The raw text received so far. */
  text(): string;
  readonly ended: Promise<void>;
  waitFor(predicate: (frame: SseFrame) => boolean, timeoutMs?: number): Promise<SseFrame>;
  close(): void;
}

/** Starts the app on a random local port (once) and returns its base URL. */
export async function listen(app: NestExpressApplication): Promise<string> {
  const server = app.getHttpServer();
  if (!server.listening) await app.listen(0, '127.0.0.1');
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function parse(block: string): SseFrame {
  const frame: Record<string, unknown> = {};
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).trimStart();
    if (field === 'data') frame.data = JSON.parse(value);
    else if (field === 'retry') frame.retry = Number(value);
    else frame[field] = value;
  }
  return frame as SseFrame;
}

/** Opens GET /api/v1/stream with these headers and parses the frames as they arrive. */
export function openStream(baseUrl: string, headers: Record<string, string>): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const request = get(`${baseUrl}/api/v1/stream`, { headers }, (response) => {
      let text = '';
      let buffer = '';
      const frames: SseFrame[] = [];
      const waiters: Array<() => void> = [];
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
        buffer += chunk;
        let end = buffer.indexOf('\n\n');
        while (end >= 0) {
          frames.push(parse(buffer.slice(0, end)));
          buffer = buffer.slice(end + 2);
          end = buffer.indexOf('\n\n');
        }
        for (const wake of waiters.splice(0)) wake();
      });
      const ended = new Promise<void>((done) => {
        response.once('end', () => done());
        response.once('close', () => done());
        response.once('error', () => done());
      });
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        frames,
        text: () => text,
        ended,
        waitFor(predicate, timeoutMs = 5000) {
          return new Promise((found, fail) => {
            const timer = setTimeout(
              () => fail(new Error('no matching SSE frame in time')),
              timeoutMs,
            );
            const check = (): void => {
              const frame = frames.find(predicate);
              if (frame) {
                clearTimeout(timer);
                found(frame);
              } else waiters.push(check);
            };
            check();
          });
        },
        close: () => request.destroy(),
      });
    });
    request.once('error', reject);
  });
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
