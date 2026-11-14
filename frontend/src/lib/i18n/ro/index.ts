import { auth } from './auth';
import { common } from './common';
import { errors } from './errors';
import { files } from './files';
import { live } from './live';
import { session } from './session';
import { shell } from './shell';
import { upload } from './upload';

// One namespaced key per feature; never spread (spreads silently overwrite colliding keys).
export const ro = { common, errors, auth, session, shell, live, upload, files } as const;
