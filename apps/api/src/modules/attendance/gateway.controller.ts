import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import type { TerminalEnrollmentsResponse, TerminalRosterResponse } from '@samtec/contracts';
import {
  type TerminalEnrollmentsBody,
  type TerminalRosterBody,
  terminalEnrollmentsSchema,
  terminalRosterSchema,
} from './attendance.schemas.js';
import { CurrentDevice, DeviceSigned, type SignedDevice } from './device-signature.guard.js';
import { GatewayService } from './gateway.service.js';

/**
 * `/api/v1/ingest/roster` and `/api/v1/ingest/enrollments`: what a ZKTeco
 * terminal asks for and reports, through the gateway. Contract: the `Ingest`
 * operations; the rules are in docs/plan/13 section 5.
 *
 * Signed by the terminal alone, like its punches. No user is present at a
 * gate at four in the morning.
 */
@Controller('ingest')
export class GatewayController {
  constructor(private readonly gateway: GatewayService) {}

  @Post('roster')
  @HttpCode(200)
  @DeviceSigned('ingest/roster')
  roster(
    @CurrentDevice() device: SignedDevice,
    @Body({ schema: terminalRosterSchema }) _body: TerminalRosterBody,
  ): Promise<TerminalRosterResponse> {
    return this.gateway.roster(device);
  }

  @Post('enrollments')
  @HttpCode(200)
  @DeviceSigned('ingest/enrollments')
  enrollments(
    @CurrentDevice() device: SignedDevice,
    @Body({ schema: terminalEnrollmentsSchema }) body: TerminalEnrollmentsBody,
  ): Promise<TerminalEnrollmentsResponse> {
    return this.gateway.recordEnrollments(device, body);
  }
}
