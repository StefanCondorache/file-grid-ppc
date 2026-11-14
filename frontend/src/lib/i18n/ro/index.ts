import { auth } from './auth';
import { common } from './common';
import { demo } from './demo';
import { errors } from './errors';
import { live } from './live';
import { monitoring } from './monitoring';
import { session } from './session';
import { shell } from './shell';
import { upload } from './upload';

// One namespaced key per feature; never spread (spreads silently overwrite colliding keys).
export const ro = { common, errors, auth, session, shell, live, upload, monitoring, demo } as const;
