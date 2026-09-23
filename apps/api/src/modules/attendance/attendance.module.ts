import { Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';
import { IdentityModule } from '../identity/identity.module.js';
import { WorkforceModule } from '../workforce/workforce.module.js';
import { AttendanceController } from './attendance.controller.js';
import { AttendanceService } from './attendance.service.js';
import { AttendanceFactsService } from './attendance-facts.service.js';
import {
  BIOMETRIC_PROVIDER,
  type BiometricProvider,
  MockBiometricProvider,
} from './biometric-provider.js';
import { BiometricRetentionService } from './biometric-retention.service.js';
import { BiometricReviewsController } from './biometric-reviews.controller.js';
import { BiometricReviewsService } from './biometric-reviews.service.js';
import { BiometricsController } from './biometrics.controller.js';
import { BiometricsService } from './biometrics.service.js';
import { ClockInController } from './clock-in.controller.js';
import { ClockInService } from './clock-in.service.js';
import { DeviceSignatureGuard } from './device-signature.guard.js';
import { DevicesController } from './devices.controller.js';
import { DevicesService } from './devices.service.js';
import { FaceProvider } from './face-provider.js';
import { GatewayController } from './gateway.controller.js';
import { GatewayService } from './gateway.service.js';
import { IngestController } from './ingest.controller.js';
import { IngestService } from './ingest.service.js';
import { KioskOperatorGuard } from './kiosk-operator.guard.js';
import { PairingService } from './pairing.service.js';
import { PasskeysService } from './passkeys.service.js';

/**
 * The attendance module: devices, punches, work segments and the exception
 * queue (docs/plan/12-attendance-design.md). It owns those tables, and asks
 * the workforce module about employees and sites instead of reading them.
 * Imports point one way only: attendance → workforce → identity.
 */
@Module({
  imports: [IdentityModule, WorkforceModule],
  controllers: [
    DevicesController,
    IngestController,
    GatewayController,
    AttendanceController,
    BiometricsController,
    BiometricReviewsController,
    ClockInController,
  ],
  providers: [
    AttendanceService,
    AttendanceFactsService,
    BiometricsService,
    BiometricReviewsService,
    BiometricRetentionService,
    ClockInService,
    DevicesService,
    GatewayService,
    IngestService,
    PairingService,
    PasskeysService,
    DeviceSignatureGuard,
    KioskOperatorGuard,
    // Faces do not go through BIOMETRIC_PROVIDER: the kiosk's model makes the
    // numbers, and this server only compares them (docs/plan/13 section 3).
    FaceProvider,
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
  exports: [BIOMETRIC_PROVIDER, FaceProvider, AttendanceFactsService],
})
export class AttendanceModule {}
