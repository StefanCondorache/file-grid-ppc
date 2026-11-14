import { auth } from './auth';
import { common } from './common';
import { errors } from './errors';

// One namespaced key per feature; never spread (spreads silently overwrite colliding keys).
export const ro = { common, errors, auth } as const;
