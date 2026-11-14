import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error';
import { APP_CONFIG, type AppConfig } from '../config/config';

export interface SimulatorStatus {
  readonly mode: 'normal' | 'peak' | 'custom' | 'stopped';
  readonly ratePerS: number;
  readonly normalRatePerS: number;
  readonly peakRatePerS: number;
  readonly queueDepth?: number;
  readonly stormEndsAt?: string | null;
  readonly sentUnique?: number;
  readonly ackedUnique?: number;
}

export interface SimulatorUpdate {
  readonly mode: SimulatorStatus['mode'];
  readonly ratePerS?: number | null;
  readonly durationS?: number;
}

const TIMEOUT_MS = 3000;

/** HTTP client for the meter simulator's control endpoint (simulator/, GET|PUT /control). */
@Injectable()
export class SimulatorClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  status(): Promise<SimulatorStatus> {
    return this.call('GET');
  }

  update(update: SimulatorUpdate): Promise<SimulatorStatus> {
    return this.call('PUT', update);
  }

  private async call(method: 'GET' | 'PUT', body?: SimulatorUpdate): Promise<SimulatorStatus> {
    let response: globalThis.Response;
    try {
      response = await fetch(new URL('/control', this.config.simulatorUrl), {
        method,
        ...(body
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new AppError(503, 'SIMULATOR_UNAVAILABLE', 'Simulatorul de contoare nu răspunde.');
    }
    if (response.status === 400) {
      throw new AppError(422, 'VALIDATION_ERROR', 'Simulatorul a refuzat setarea.', {
        details: await response.text(),
      });
    }
    if (!response.ok)
      throw new AppError(503, 'SIMULATOR_UNAVAILABLE', 'Simulatorul de contoare nu răspunde.');
    return (await response.json()) as SimulatorStatus;
  }
}
