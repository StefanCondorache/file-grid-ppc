import { Global, Logger, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { Keyring } from '../crypto/keys';
import { KEYRING, ObjectStoreService } from './object-store.service';

/** The keyring from FILEGRID_KEK*; null (encryption refused with 503) when no key is configured. */
function keyringFrom(config: AppConfig): Keyring | null {
  if (!config.kekEnv.FILEGRID_KEK) {
    new Logger('Crypto').warn('FILEGRID_KEK is not set: encrypted categories are unavailable');
    return null;
  }
  return Keyring.fromEnv(config.kekEnv);
}

@Global()
@Module({
  providers: [
    { provide: KEYRING, useFactory: keyringFrom, inject: [APP_CONFIG] },
    ObjectStoreService,
  ],
  exports: [KEYRING, ObjectStoreService],
})
export class ObjectStoreModule {}
