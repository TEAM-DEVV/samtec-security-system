import { Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Site, SiteList } from '@samtec/contracts';
import type { Response } from 'express';
import { Caller, OnKiosk, Roles, type SignedInUser } from '../../common/auth.decorators.js';
import { SitesService } from './sites.service.js';
import {
  type CreateSiteBody,
  createSiteSchema,
  idSchema,
  type ListSitesQuery,
  listSitesQuerySchema,
  type UpdateSiteBody,
  updateSiteSchema,
} from './workforce.schemas.js';

/**
 * `/api/v1/sites`. Contract: operations `listSites`, `getSite`, `createSite`
 * and `updateSite`.
 */
@Controller('sites')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  // The kiosk asks which site it stands at when it registers itself.
  @OnKiosk()
  @Get()
  @Roles('ADMIN', 'HR_PAYROLL', 'SUPERVISOR')
  list(
    @Caller() caller: SignedInUser,
    @Query({ schema: listSitesQuerySchema }) query: ListSitesQuery,
  ): Promise<SiteList> {
    return this.sites.list(caller, query);
  }

  @Post()
  @Roles('ADMIN', 'HR_PAYROLL')
  async create(
    @Caller() caller: SignedInUser,
    @Body({ schema: createSiteSchema }) body: CreateSiteBody,
    // passthrough keeps Nest in charge of the response; we only add a header.
    @Res({ passthrough: true }) response: Response,
  ): Promise<Site> {
    const site = await this.sites.create(caller, body);
    response.status(201).setHeader('Location', `/api/v1/sites/${site.id}`);
    return site;
  }

  // No @Roles: the contract answers a GUARD with 404 here, not 403, and the
  // service handles that.
  @Get(':siteId')
  get(
    @Caller() caller: SignedInUser,
    @Param('siteId', { schema: idSchema }) siteId: string,
  ): Promise<Site> {
    return this.sites.get(caller, siteId);
  }

  @Patch(':siteId')
  @Roles('ADMIN', 'HR_PAYROLL')
  update(
    @Caller() caller: SignedInUser,
    @Param('siteId', { schema: idSchema }) siteId: string,
    @Body({ schema: updateSiteSchema }) body: UpdateSiteBody,
  ): Promise<Site> {
    return this.sites.update(caller, siteId, body);
  }
}
