import { z } from 'zod';

/**
 * The rules for every user-management input, matching the contract exactly.
 * `strictObject` rejects fields we did not ask for, so nobody can sneak in a
 * `passwordHash`, `isActive` or `companyId`.
 */

export const userIdSchema = z.uuid();

const role = z.enum(['ADMIN', 'HR_PAYROLL', 'SUPERVISOR', 'GUARD']);
const fullName = z.string().min(2).max(120);
const email = z.email('Enter a valid email address.').max(254);

export const listUsersQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(200).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

/** Contract: `CreateUserRequest`. There is no password field: the person chooses their own. */
export const createUserSchema = z.strictObject({
  email,
  fullName,
  role,
  employeeId: z.uuid().optional(),
});
export type CreateUserBody = z.infer<typeof createUserSchema>;

/** Contract: `UpdateUserRequest`. Only sent fields change; `employeeId: null` unlinks. */
export const updateUserSchema = z
  .strictObject({
    email: email.optional(),
    fullName: fullName.optional(),
    role: role.optional(),
    employeeId: z.uuid().nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Send at least one field to change.');
export type UpdateUserBody = z.infer<typeof updateUserSchema>;
