import type { GhanaRegion, Site, SiteList, SiteStatus } from '@samtec/contracts';
import { type DefaultBodyType, HttpResponse, http, type PathParams } from 'msw';
import { mockSites } from '../data/sites';
import {
  apiUrl,
  isOneOf,
  isUuid,
  notFound,
  type OrProblem,
  pageOf,
  readLimit,
  unauthorized,
  validationProblem,
} from '../helpers';
import { userForRequest } from './auth';

const SITE_STATUSES: readonly SiteStatus[] = ['ACTIVE', 'INACTIVE'];

const GHANA_REGIONS: readonly GhanaRegion[] = [
  'AHAFO',
  'ASHANTI',
  'BONO',
  'BONO_EAST',
  'CENTRAL',
  'EASTERN',
  'GREATER_ACCRA',
  'NORTH_EAST',
  'NORTHERN',
  'OTI',
  'SAVANNAH',
  'UPPER_EAST',
  'UPPER_WEST',
  'VOLTA',
  'WESTERN',
  'WESTERN_NORTH',
];

export const siteHandlers = [
  http.get<PathParams, DefaultBodyType, OrProblem<SiteList>>(apiUrl('/sites'), ({ request }) => {
    if (!userForRequest(request)) {
      return unauthorized('Sign in to continue.');
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
      if (!userForRequest(request)) {
        return unauthorized('Sign in to continue.');
      }
      if (!isUuid(params.siteId)) {
        return validationProblem('siteId', 'Must be a valid ID.');
      }
      const site = mockSites.find((candidate) => candidate.id === params.siteId);
      return site ? HttpResponse.json<Site>(site) : notFound('No site exists with this ID.');
    },
  ),
];
