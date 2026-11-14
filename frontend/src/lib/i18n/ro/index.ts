import { auth } from './auth';
import { common } from './common';
import { errors } from './errors';
import { session } from './session';

// One namespaced key per feature; never spread (spreads silently overwrite colliding keys).
export const ro = { common, errors, auth, session } as const;
