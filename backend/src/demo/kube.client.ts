import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error';
import type { StorageName } from '../common/domain';

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const NAMESPACE = 'filegrid-storage';
/** StatefulSet per storage (deploy/k8s/storage); the backend's Role may scale exactly these. */
const STATEFUL_SETS: Readonly<Record<StorageName, string>> = {
  s3: 's3',
  ftp: 'ftp',
  db: 'postgres',
};

/**
 * Minimal in-cluster Kubernetes client for the demo panel: scales a storage StatefulSet to 0 or 1
 * with the pod's ServiceAccount token (RBAC in deploy/k8s/demo-rbac.yaml). No client library: one
 * PATCH and one GET over node:https with the cluster CA.
 */
@Injectable()
export class KubeClient {
  async scale(storage: StorageName, replicas: 0 | 1): Promise<void> {
    await this.call('PATCH', this.scalePath(storage), JSON.stringify({ spec: { replicas } }));
  }

  async replicas(storage: StorageName): Promise<number | null> {
    try {
      const body = await this.call('GET', this.scalePath(storage));
      return Number((JSON.parse(body) as { spec?: { replicas?: number } }).spec?.replicas ?? 0);
    } catch {
      return null;
    }
  }

  private scalePath(storage: StorageName): string {
    return `/apis/apps/v1/namespaces/${NAMESPACE}/statefulsets/${STATEFUL_SETS[storage]}/scale`;
  }

  private async call(method: 'GET' | 'PATCH', path: string, body?: string): Promise<string> {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
    if (!host) {
      throw new AppError(
        503,
        'CHAOS_UNAVAILABLE',
        'Controlul storage-urilor merge doar în cluster (k3s).',
      );
    }
    const [token, ca] = await Promise.all([
      readFile(`${SA_DIR}/token`, 'utf8'),
      readFile(`${SA_DIR}/ca.crt`),
    ]).catch(() => {
      throw new AppError(503, 'CHAOS_UNAVAILABLE', 'Podul nu are token de ServiceAccount.');
    });
    return new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host,
          port,
          path,
          method,
          ca,
          timeout: 5000,
          headers: {
            Authorization: `Bearer ${token.trim()}`,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/merge-patch+json' } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if ((res.statusCode ?? 500) < 300) resolve(text);
            else
              reject(new AppError(502, 'CHAOS_FAILED', `Kubernetes a răspuns ${res.statusCode}.`));
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () =>
        reject(new AppError(503, 'CHAOS_UNAVAILABLE', 'API-ul Kubernetes nu răspunde.')),
      );
      req.end(body);
    });
  }
}
