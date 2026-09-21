import type { Device } from '@samtec/contracts';
import { mockSites } from './sites';

// Fictional terminals only, one per site, like the local seed (see SECURITY.md).

/** The first five sites each have one mock terminal. */
export const mockDevices: Device[] = mockSites.slice(0, 5).map((site, index) => ({
  id: `01927c3e-4444-7ddd-8eee-${String(index + 1).padStart(12, '0')}`,
  name: `Mock terminal ${site.code}`,
  siteId: site.id,
  kind: 'MOCK',
  status: 'ACTIVE',
  lastSeenAt: '2026-09-22T08:00:00Z',
  // The Tema terminal's clock runs 7 minutes fast: the Devices page flags it.
  lastClockDriftSeconds: site.code === 'TEM-01' ? 420 : 2,
  failedSignatureCount: 0,
  lastFailedSignatureAt: null,
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-09-01T08:00:00Z',
}));
