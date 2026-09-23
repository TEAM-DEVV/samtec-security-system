import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import type {
  BiometricConsent,
  BiometricConsentText,
  FaceEnrollmentResult,
} from '@samtec/contracts';
import type { Response } from 'express';
import { Caller, OnKiosk, type SignedInUser } from '../../common/auth.decorators.js';
import {
  type EnrollFaceBody,
  enrollFaceSchema,
  type RecordConsentBody,
  recordConsentSchema,
} from './attendance.schemas.js';
import { BiometricsService } from './biometrics.service.js';
import { CurrentDevice, type SignedDevice } from './device-signature.guard.js';
import { KioskOperator } from './kiosk-operator.guard.js';

/**
 * `/api/v1/biometrics/*` and the kiosk's ADMIN routes. Contract: the
 * `Biometrics` and `Kiosk` operations; the rules are in docs/plan/13 section 2.
 */
@Controller()
export class BiometricsController {
  constructor(private readonly biometrics: BiometricsService) {}

  /** Any signed-in role may read the wording, including on a kiosk. */
  @OnKiosk()
  @Get('biometrics/consent-text')
  consentText(): BiometricConsentText {
    return this.biometrics.consentText();
  }

  @KioskOperator('kiosk/consents')
  @Post('kiosk/consents')
  async recordConsent(
    @Caller() caller: SignedInUser,
    @CurrentDevice() device: SignedDevice,
    @Body({ schema: recordConsentSchema }) body: RecordConsentBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BiometricConsent> {
    const { consent, created } = await this.biometrics.recordConsent(caller, device, body);
    // 201 for a new consent, 200 for the one this worker already gave.
    response.status(created ? 201 : 200);
    return consent;
  }

  @KioskOperator('kiosk/face-enrollments')
  @Post('kiosk/face-enrollments')
  enrollFace(
    @Caller() caller: SignedInUser,
    @CurrentDevice() device: SignedDevice,
    @Body({ schema: enrollFaceSchema }) body: EnrollFaceBody,
  ): Promise<FaceEnrollmentResult> {
    return this.biometrics.enrollFace(caller, device, body);
  }
}
