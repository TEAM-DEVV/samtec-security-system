import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import type { HeartbeatResponse, IngestPunchesResponse } from '@samtec/contracts';
import {
  type HeartbeatBody,
  heartbeatSchema,
  type IngestPunchesBody,
  ingestPunchesSchema,
} from './attendance.schemas.js';
import { CurrentDevice, DeviceSigned, type SignedDevice } from './device-signature.guard.js';
import { IngestService } from './ingest.service.js';

/**
 * `/api/v1/ingest/*`: where devices send punches. Signed by the device, never
 * by a user (`@DeviceSigned`). Contract: the `Ingest` operations.
 */
@Controller('ingest')
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  @Post('punches')
  @HttpCode(200)
  @DeviceSigned('ingest/punches')
  punches(
    @CurrentDevice() device: SignedDevice,
    @Body({ schema: ingestPunchesSchema }) body: IngestPunchesBody,
  ): Promise<IngestPunchesResponse> {
    return this.ingest.ingestPunches(device, body);
  }

  @Post('heartbeat')
  @HttpCode(200)
  @DeviceSigned('ingest/heartbeat')
  heartbeat(
    @CurrentDevice() device: SignedDevice,
    @Body({ schema: heartbeatSchema }) body: HeartbeatBody,
  ): Promise<HeartbeatResponse> {
    return this.ingest.heartbeat(device, body);
  }
}
