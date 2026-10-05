import type { CreateSiteRequest, Site, SiteList, UpdateSiteRequest } from '@samtec/contracts';
import { type DefaultBodyType, HttpResponse, http, type PathParams } from 'msw';
import { SITE_STATUSES } from '@/components/site-status-badge';
import { GHANA_REGIONS } from '@/lib/ghana-regions';
import { pageRoles, roleAllowed } from '@/lib/roles';
import { mockSites } from '../data/sites';
import {
  apiUrl,
  conflict,
  forbidden,
  isOneOf,
  isUuid,
  notFound,
  type OrProblem,
  pageOf,
  readLimit,
  unauthorized,
  validationProblem,
} from '../helpers';
import { canSeeSite } from '../scope';
import { userForRequest } from './auth';
import { hasActiveDeviceAtSite } from './devices';
import { hasWorkerPostedTo } from './employees';

/**
 * The mock API keeps its own copy of the sites, so the write handlers can
 * change it without touching the original data. Tests call
 * `resetMockSites()` to start fresh.
 */
let sites: Site[] = mockSites.map((site) => ({ ...site }));

export function resetMockSites(): void {
  sites = mockSites.map((site) => ({ ...site }));
}

const SITE_CODE = /^[A-Z]{3}-\d{2}$/;

export const siteHandlers = [
  http.get<PathParams, DefaultBodyType, OrProblem<SiteList>>(apiUrl('/sites'), ({ request }) => {
    const user = userForRequest(request);
    if (!user) {
      return unauthorized('Sign in to continue.');
    }
    if (!roleAllowed(pageRoles.sites, user.role)) {
      return forbidden();
    }
    const query = new URL(request.url).searchParams;

    const limit = readLimit(query);
    if (limit === undefined) {
      return validationProblem('limit', 'Must be a whole number from 1 to 100.');
    }
    const status = query.get('status');
    if (status !== null && !isOneOf(SITE_STATUSES, status)) {
      return validationProblem('status', `Must be one of ${SITE_STATUSES.join(', ')}.`);
    }
    const region = query.get('region');
    if (region !== null && !isOneOf(GHANA_REGIONS, region)) {
      return validationProblem('region', 'Must be one of the 16 regions of Ghana.');
    }

    const matches = sites
      // A supervisor sees only their own site.
      .filter((site) => canSeeSite(user, site.id))
      .filter((site) => status === null || site.status === status)
      .filter((site) => region === null || site.region === region)
      // Sorted by site code, as the contract promises.
      .sort((a, b) => a.code.localeCompare(b.code));

    const page = pageOf(matches, limit, query.get('cursor'));
    if (!page) {
      return validationProblem(
        'cursor',
        'The cursor is not valid. Start again from the first page.',
      );
    }
    return HttpResponse.json<SiteList>(page);
  }),

  http.post<PathParams, CreateSiteRequest, OrProblem<Site>>(
    apiUrl('/sites'),
    async ({ request }) => {
      const user = userForRequest(request);
      if (!user) {
        return unauthorized('Sign in to continue.');
      }
      if (!roleAllowed(pageRoles.siteChanges, user.role)) {
        return forbidden();
      }
      const body = await request.json();

      if (!SITE_CODE.test(body.code ?? '')) {
        return validationProblem(
          'code',
          'Must look like ACC-01: three capital letters, a dash, two digits.',
        );
      }
      if (!body.name || body.name.length < 2) {
        return validationProblem('name', 'Required.');
      }
      if (!body.clientName || body.clientName.length < 2) {
        return validationProblem('clientName', 'Required.');
      }
      if (!isOneOf(GHANA_REGIONS, body.region ?? '')) {
        return validationProblem('region', 'Must be one of the 16 regions of Ghana.');
      }
      if (!body.city || body.city.length < 2) {
        return validationProblem('city', 'Required.');
      }
      if (body.status !== undefined && !isOneOf(SITE_STATUSES, body.status)) {
        return validationProblem('status', `Must be one of ${SITE_STATUSES.join(', ')}.`);
      }
      if (sites.some((site) => site.code === body.code)) {
        return conflict('A site with this code already exists.');
      }

      const now = new Date().toISOString();
      const site: Site = {
        id: crypto.randomUUID(),
        code: body.code,
        name: body.name,
        clientName: body.clientName,
        region: body.region,
        city: body.city,
        status: body.status ?? 'ACTIVE',
        activeGuardCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      sites.push(site);
      return HttpResponse.json<Site>(site, {
        status: 201,
        headers: { Location: `/api/v1/sites/${site.id}` },
      });
    },
  ),

  http.get<{ siteId: string }, DefaultBodyType, OrProblem<Site>>(
    apiUrl('/sites/:siteId'),
    ({ request, params }) => {
      const user = userForRequest(request);
      if (!user) {
        return unauthorized('Sign in to continue.');
      }
      if (!isUuid(params.siteId)) {
        return validationProblem('siteId', 'Must be a valid ID.');
      }
      // Guards see no sites, supervisors only their own; anything else "does not exist".
      const site = sites.find((candidate) => candidate.id === params.siteId);
      return site && canSeeSite(user, site.id)
        ? HttpResponse.json<Site>(site)
        : notFound('No site exists with this ID.');
    },
  ),

  http.patch<{ siteId: string }, UpdateSiteRequest, OrProblem<Site>>(
    apiUrl('/sites/:siteId'),
    async ({ params, request }) => {
      const user = userForRequest(request);
      if (!user) {
        return unauthorized('Sign in to continue.');
      }
      if (!roleAllowed(pageRoles.siteChanges, user.role)) {
        return forbidden();
      }
      if (!isUuid(params.siteId)) {
        return validationProblem('siteId', 'Must be a valid ID.');
      }
      const site = sites.find((candidate) => candidate.id === params.siteId);
      if (!site) {
        return notFound('No site exists with this ID.');
      }

      const body = await request.json();
      // Like the real API's strict schema: the code can never be changed
      // here, and any other field we did not ask for is a 400.
      const allowed = ['name', 'clientName', 'region', 'city', 'status'];
      const unknown = Object.keys(body).find((key) => !allowed.includes(key));
      if (unknown !== undefined) {
        return validationProblem(unknown, 'Unrecognized field.');
      }
      if (Object.keys(body).length === 0) {
        return validationProblem('body', 'Send at least one field to change.');
      }
      if (body.name !== undefined && body.name.length < 2) {
        return validationProblem('name', 'Must be at least 2 characters.');
      }
      if (body.clientName !== undefined && body.clientName.length < 2) {
        return validationProblem('clientName', 'Must be at least 2 characters.');
      }
      if (body.region !== undefined && !isOneOf(GHANA_REGIONS, body.region)) {
        return validationProblem('region', 'Must be one of the 16 regions of Ghana.');
      }
      if (body.city !== undefined && body.city.length < 2) {
        return validationProblem('city', 'Must be at least 2 characters.');
      }
      if (body.status !== undefined && !isOneOf(SITE_STATUSES, body.status)) {
        return validationProblem('status', `Must be one of ${SITE_STATUSES.join(', ')}.`);
      }

      if (body.status === 'INACTIVE' && site.status !== 'INACTIVE') {
        const postedWorker = hasWorkerPostedTo(site.id);
        const activeDevice = hasActiveDeviceAtSite(site.id);
        if (postedWorker && activeDevice) {
          return conflict(
            'Move every worker off this site and switch off every device at this site before making it inactive.',
          );
        }
        if (postedWorker) {
          return conflict('Move every worker off this site before making it inactive.');
        }
        if (activeDevice) {
          return conflict('Switch off every device at this site before making it inactive.');
        }
      }

      if (body.name !== undefined) site.name = body.name;
      if (body.clientName !== undefined) site.clientName = body.clientName;
      if (body.region !== undefined) site.region = body.region;
      if (body.city !== undefined) site.city = body.city;
      if (body.status !== undefined) site.status = body.status;
      site.updatedAt = new Date().toISOString();
      return HttpResponse.json<Site>(site);
    },
  ),
];
