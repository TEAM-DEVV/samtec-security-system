import { Controller, Get, Param, Query } from '@nestjs/common';
import type { Site, SiteList } from '@samtec/contracts';
import { Caller, OnKiosk, Roles, type SignedInUser } from '../../common/auth.decorators.js';
import { SitesService } from './sites.service.js';
import { idSchema, type ListSitesQuery, listSitesQuerySchema } from './workforce.schemas.js';

/**
 * `/api/v1/sites` (read side). Contract: operations `listSites` and `getSite`.
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

  // No @Roles: the contract answers a GUARD with 404 here, not 403, and the
  // service handles that.
  @Get(':siteId')
  get(
    @Caller() caller: SignedInUser,
    @Param('siteId', { schema: idSchema }) siteId: string,
  ): Promise<Site> {
    return this.sites.get(caller, siteId);
  }
}
