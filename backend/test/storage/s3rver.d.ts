// Minimal types for the s3rver dev dependency (test-only S3-compatible server; it ships none).
declare module 's3rver' {
  import type { AddressInfo } from 'node:net';

  interface S3rverOptions {
    address?: string;
    port?: number;
    silent?: boolean;
    directory?: string;
    configureBuckets?: { name: string; configs: unknown[] }[];
  }

  export default class S3rver {
    constructor(options: S3rverOptions);
    run(): Promise<AddressInfo>;
    close(): Promise<void>;
  }
}
