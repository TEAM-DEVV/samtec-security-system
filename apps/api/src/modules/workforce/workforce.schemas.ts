import { z } from 'zod';

/**
 * The rules for every workforce query and path parameter, matching the
 * contract exactly. `strictObject` rejects query parameters we did not ask
 * for, so a typo like `?stauts=` becomes a clear 400 instead of being ignored.
 */

export const idSchema = z.uuid();

const cursor = z.string().min(1).max(200);
const limit = z.coerce.number().int().min(1).max(100).default(25);

export const listEmployeesQuerySchema = z.strictObject({
  limit,
  cursor: cursor.optional(),
  status: z.enum(['PENDING_ENROLLMENT', 'ACTIVE', 'SUSPENDED', 'TERMINATED']).optional(),
  siteId: z.uuid().optional(),
  search: z.string().min(2).max(100).optional(),
});
export type ListEmployeesQuery = z.infer<typeof listEmployeesQuerySchema>;

export const listSitesQuerySchema = z.strictObject({
  limit,
  cursor: cursor.optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  region: z
    .enum([
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
    ])
    .optional(),
});
export type ListSitesQuery = z.infer<typeof listSitesQuerySchema>;
