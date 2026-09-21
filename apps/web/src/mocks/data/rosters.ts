import type { Post, ShiftPattern } from '@samtec/contracts';
import { mockSites } from './sites';

// Fictional rosters only, like all mock data (see SECURITY.md).

/** Two posts per site: a main gate needing two guards, and a reception. */
export const mockPosts: Post[] = mockSites.flatMap((site, siteIndex) => [
  {
    id: `01927c3e-2222-7bbb-8ccc-${String(siteIndex * 2 + 1).padStart(12, '0')}`,
    siteId: site.id,
    name: 'Main Gate',
    requiredGuards: 2,
    status: 'ACTIVE',
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T08:00:00Z',
  },
  {
    id: `01927c3e-2222-7bbb-8ccc-${String(siteIndex * 2 + 2).padStart(12, '0')}`,
    siteId: site.id,
    name: 'Reception',
    requiredGuards: 1,
    status: 'ACTIVE',
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T08:00:00Z',
  },
]);

/** The two classic 12-hour patterns; the night shift crosses midnight. */
export const mockShiftPatterns: ShiftPattern[] = [
  {
    id: '01927c3e-3333-7ccc-8ddd-000000000001',
    name: 'Day Shift',
    startTime: '06:00',
    endTime: '18:00',
    crossesMidnight: false,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T08:00:00Z',
  },
  {
    id: '01927c3e-3333-7ccc-8ddd-000000000002',
    name: 'Night Shift',
    startTime: '18:00',
    endTime: '06:00',
    crossesMidnight: true,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T08:00:00Z',
  },
];
