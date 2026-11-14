/// <reference lib="webworker" />
import { createHashService, type HashIn } from './hash-core';

// Hashing runs off the main thread (FE-02: no frozen frames). The protocol lives in hash-core.ts.
const scope = self as unknown as DedicatedWorkerGlobalScope;
const handle = createHashService((m) => scope.postMessage(m));
scope.onmessage = (e: MessageEvent<HashIn>) => void handle(e.data);
