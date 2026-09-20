import type { Site, SiteList } from '@samtec/contracts';
import { type DefaultBodyType, HttpResponse, http, type PathParams } from 'msw';
import { SITE_STATUSES } from '@/components/site-status-badge';
import { GHANA_REGIONS } from '@/lib/ghana-regions';
import { pageRoles, roleAllowed } from '@/lib/roles';
import { mockSites } from '../data/sites';
import {
  apiUrl,
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

    const matches = mockSites
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
      const site = mockSites.find((candidate) => candidate.id === params.siteId);
      return site && canSeeSite(user, site.id)
        ? HttpResponse.json<Site>(site)
        : notFound('No site exists with this ID.');
    },
  ),
];
