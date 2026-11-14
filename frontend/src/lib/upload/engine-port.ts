import { uploadEngine } from './engine';

/** What auth and the shell need from the upload engine. */
export interface UploadControl {
  pauseAll(reason: 'session' | 'logout'): void;
  resumeAll(ownerUserId: string): void;
  restoreAndResume(userId: string): Promise<void>;
}

// The real engine (slice 6b), built lazily on first use; tests swap it with setUploadControl.
let current: UploadControl = uploadEngine;

export function getUploadControl(): UploadControl {
  return current;
}

export function setUploadControl(control: UploadControl): void {
  current = control;
}
