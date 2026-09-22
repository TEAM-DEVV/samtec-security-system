import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Device, DeviceList, DeviceWithSecret } from '@samtec/contracts';
import type { Response } from 'express';
import { Caller, OnKiosk, Roles, type SignedInUser } from '../../common/auth.decorators.js';
import {
  idSchema,
  type ListDevicesQuery,
  listDevicesQuerySchema,
  type RegisterDeviceBody,
  registerDeviceSchema,
  type UpdateDeviceBody,
  updateDeviceSchema,
} from './attendance.schemas.js';
import { DevicesService } from './devices.service.js';

/** `/api/v1/devices`. Contract: the `Devices` operations. ADMIN only. */
@Controller('devices')
@Roles('ADMIN')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @OnKiosk()
  @Get()
  list(
    @Caller() caller: SignedInUser,
    @Query({ schema: listDevicesQuerySchema }) query: ListDevicesQuery,
  ): Promise<DeviceList> {
    return this.devices.list(caller, query);
  }

  // A kiosk sets itself up, and may only register a kiosk (the service checks).
  @OnKiosk()
  @Post()
  async register(
    @Caller() caller: SignedInUser,
    @Body({ schema: registerDeviceSchema }) body: RegisterDeviceBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DeviceWithSecret> {
    const registered = await this.devices.register(caller, body);
    response
      .status(201)
      .setHeader('Location', `/api/v1/devices/${registered.device.id}`)
      // The body holds the device's secret: no browser or proxy may keep it.
      .setHeader('Cache-Control', 'no-store');
    return registered;
  }

  @Get(':deviceId')
  get(
    @Caller() caller: SignedInUser,
    @Param('deviceId', { schema: idSchema }) deviceId: string,
  ): Promise<Device> {
    return this.devices.get(caller, deviceId);
  }

  @Patch(':deviceId')
  update(
    @Caller() caller: SignedInUser,
    @Param('deviceId', { schema: idSchema }) deviceId: string,
    @Body({ schema: updateDeviceSchema }) body: UpdateDeviceBody,
  ): Promise<Device> {
    return this.devices.update(caller, deviceId, body);
  }

  @OnKiosk()
  @Post(':deviceId/rotate-secret')
  @HttpCode(200)
  async rotateSecret(
    @Caller() caller: SignedInUser,
    @Param('deviceId', { schema: idSchema }) deviceId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DeviceWithSecret> {
    const rotated = await this.devices.rotateSecret(caller, deviceId);
    response.setHeader('Cache-Control', 'no-store');
    return rotated;
  }
}
