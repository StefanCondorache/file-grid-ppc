/** What auth and the shell need from the upload engine. No-op until the engine (slice 6b) registers itself. */
export interface UploadControl {
  pauseAll(reason: 'session' | 'logout'): void;
  resumeAll(ownerUserId: string): void;
  restoreAndResume(userId: string): Promise<void>;
}

const noop: UploadControl = {
  pauseAll: () => {},
  resumeAll: () => {},
  restoreAndResume: async () => {},
};

let current: UploadControl = noop;

export function getUploadControl(): UploadControl {
  return current;
}

export function setUploadControl(control: UploadControl): void {
  current = control;
}
