import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type {
  KioskFingerprintOptionsResponse,
  KioskIdentifyResponse,
  KioskPunchResponse,
} from '@samtec/contracts';
import type { Request } from 'express';
import {
  type AssistedPunchBody,
  assistedPunchSchema,
  type FingerprintOptionsBody,
  fingerprintOptionsSchema,
  type KioskConfirmBody,
  type KioskIdentifyBody,
  type KioskNotMeBody,
  kioskConfirmSchema,
  kioskIdentifySchema,
  kioskNotMeSchema,
} from './attendance.schemas.js';
import { clientAddress } from './client-address.js';
import { ClockInService } from './clock-in.service.js';
import { CurrentDevice, DeviceSigned, type SignedDevice } from './device-signature.guard.js';

/**
 * `/api/v1/kiosk/*`: clocking in at the gate. Contract: the `Kiosk`
 * operations.
 *
 * These five are signed by the **device alone** — no user token — because
 * the person in front of the kiosk is a guard with no account of their own.
 * The kiosk set-up routes (consent, enrollment) are the other way round:
 * they also need an ADMIN signed in on that kiosk.
 */
@Controller('kiosk')
export class ClockInController {
  constructor(private readonly clockIn: ClockInService) {}

  @Post('identify')
  @HttpCode(200)
  @DeviceSigned('kiosk/identify')
  identify(
    @CurrentDevice() device: SignedDevice,
    @Body({ schema: kioskIdentifySchema }) body: KioskIdentifyBody,
    @Req() request: Request,
  ): Promise<KioskIdentifyResponse> {
    return this.clockIn.identify(device, body, clientAddress(request));
  }

  @Post('not-me')
  @HttpCode(204)
  @DeviceSigned('kiosk/not-me')
  notMe(
    @CurrentDevice() device: SignedDevice,
    @Body({ schema: kioskNotMeSchema }) body: KioskNotMeBody,
    @Req() request: Request,
  ): Promise<void> {
    return this.clockIn.notMe(device, body, clientAddress(request));
  }

  @Post('confirm')
  @HttpCode(200)
  @DeviceSigned('kiosk/confirm')
  confirm(
    @CurrentDevice() device: SignedDevice,
    @Body({ schema: kioskConfirmSchema }) body: KioskConfirmBody,
  ): Promise<KioskPunchResponse> {
    return this.clockIn.confirm(device, body);
  }

  @Post('fingerprint-options')
  @HttpCode(200)
  @DeviceSigned('kiosk/fingerprint-options')
  fingerprintOptions(
    @CurrentDevice() device: SignedDevice,
    @Body({ schema: fingerprintOptionsSchema }) body: FingerprintOptionsBody,
    @Req() request: Request,
  ): Promise<KioskFingerprintOptionsResponse> {
    return this.clockIn.fingerprintOptions(device, body, clientAddress(request));
  }

  @Post('assisted-punches')
  @HttpCode(200)
  @DeviceSigned('kiosk/assisted-punches')
  assistedPunch(
    @CurrentDevice() device: SignedDevice,
    @Body({ schema: assistedPunchSchema }) body: AssistedPunchBody,
  ): Promise<KioskPunchResponse> {
    return this.clockIn.assistedPunch(device, body);
  }
}
