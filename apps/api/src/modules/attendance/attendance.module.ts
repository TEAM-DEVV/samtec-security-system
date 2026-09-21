import { Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';
import { IdentityModule } from '../identity/identity.module.js';
import { WorkforceModule } from '../workforce/workforce.module.js';
import {
  BIOMETRIC_PROVIDER,
  type BiometricProvider,
  MockBiometricProvider,
} from './biometric-provider.js';
import { DeviceSignatureGuard } from './device-signature.guard.js';
import { DevicesController } from './devices.controller.js';
import { DevicesService } from './devices.service.js';
import { IngestController } from './ingest.controller.js';
import { IngestService } from './ingest.service.js';

/**
 * The attendance module: devices, punches, work segments and the exception
 * queue (docs/plan/12-attendance-design.md). It owns those tables, and asks
 * the workforce module about employees and sites instead of reading them.
 * Imports point one way only: attendance → workforce → identity.
 */
@Module({
  imports: [IdentityModule, WorkforceModule],
  controllers: [DevicesController, IngestController],
  providers: [
    DevicesService,
    IngestService,
    DeviceSignatureGuard,
    {
      // The BIOMETRIC_PROVIDER setting picks the provider. Phase 3 adds a case
      // per real provider; TypeScript then insists every setting is handled.
      provide: BIOMETRIC_PROVIDER,
      inject: [AppConfig],
      useFactory: (config: AppConfig): BiometricProvider => {
        switch (config.biometricProvider) {
          case 'mock':
            return new MockBiometricProvider();
        }
      },
    },
  ],
  exports: [BIOMETRIC_PROVIDER],
})
export class AttendanceModule {}
