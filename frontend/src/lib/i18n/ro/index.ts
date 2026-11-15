import { audit } from './audit';
import { auth } from './auth';
import { common } from './common';
import { demo } from './demo';
import { errors } from './errors';
import { files } from './files';
import { integrity } from './integrity';
import { live } from './live';
import { map } from './map';
import { meters } from './meters';
import { monitoring } from './monitoring';
import { policies } from './policies';
import { session } from './session';
import { shell } from './shell';
import { statistics } from './statistics';
import { upload } from './upload';

// One namespaced key per feature; never spread (spreads silently overwrite colliding keys).
export const ro = { common, errors, auth, session, shell, live, upload, statistics, audit, files, integrity, monitoring, demo, meters, policies, map } as const;
