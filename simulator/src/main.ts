// Entry point: node src/main.ts (Node 26 strips the types, no build step).

import type { AddressInfo } from 'node:net';
import { ConfigError, loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { createLogger } from './log.ts';
import { createControlServer } from './server.ts';
import { Simulator } from './simulator.ts';

const SHUTDOWN_DRAIN_MS = 5000;

function loadConfigOrExit(): Config {
  try {
    return loadConfig(process.env);
  } catch (err) {
    const problems = err instanceof ConfigError ? err.problems : [String(err)];
    process.stderr.write(
      `${JSON.stringify({ level: 'error', time: new Date().toISOString(), message: 'invalid configuration', problems })}\n`,
    );
    process.exit(1);
  }
}

function main(): void {
  const config = loadConfigOrExit();
  const log = createLogger({ level: config.logLevel, secrets: [config.apiKey] });
  const simulator = new Simulator({ config, log });
  const server = createControlServer(simulator, log);

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection, exiting', { error: reason });
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown signal received', { signal });
    simulator
      .shutdown(SHUTDOWN_DRAIN_MS)
      .catch((err: unknown) => log.error('shutdown failed', { error: err }))
      .finally(() => {
        server.close();
        server.closeAllConnections();
        process.exit(0);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.on('error', (err) => {
    log.error('control server failed', { error: err, port: config.port });
    process.exit(1);
  });
  server.listen(config.port, () => {
    log.info('control server listening', {
      port: (server.address() as AddressInfo).port,
      backendUrl: config.backendUrl,
      meterCount: config.meterCount,
      normalRatePerS: config.meterRate,
      stormFactor: config.stormFactor,
      maxRatePerS: config.maxRate,
      batchMax: config.batchMax,
      duplicateRatio: config.duplicateRatio,
      maxQueue: config.maxQueue,
    });
    simulator.start();
  });
}

main();
