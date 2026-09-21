import type {
  ChangePasswordRequest,
  CreateUserRequest,
  SetPasswordRequest,
  UpdateUserRequest,
  UserAccount,
  UserAccountList,
  UserAccountWithPasswordSetup,
  UserRole,
} from '@samtec/contracts';
import { HttpResponse, http, type PathParams } from 'msw';
import { mockAccounts } from '../data/accounts';
import { mockEmployees } from '../data/employees';
import { MOCK_PASSWORD } from '../data/users';
import {
  apiUrl,
  conflict,
  isOneOf,
  isUuid,
  notFound,
  type OrProblem,
  pageOf,
  readLimit,
  validationProblem,
} from '../helpers';

/**
 * The mock Users API (ADMIN screens) plus choosing and changing a password.
 * It keeps its own copy of the accounts, so the write handlers can change it;
 * tests call `resetMockUsers()` to start fresh.
 *
 * Simplifications, on purpose, until the sign-in screens have landed:
 * - It does not check who is calling, so the ADMIN-only rule and the
 *   never-on-your-own-account rule (both enforced by the real API) are not
 *   imitated yet.
 * - Accounts created here cannot sign in to the mock API.
 */
let accounts: UserAccount[] = mockAccounts.map((account) => ({ ...account }));
/** One-time password link tokens, mapped to the account they belong to. */
let passwordLinks = new Map<string, string>();
/** Accounts whose owner has not chosen a password yet (the real API: no password hash). */
let awaitingPassword = new Set<string>();

export function resetMockUsers(): void {
  accounts = mockAccounts.map((account) => ({ ...account }));
  passwordLinks = new Map();
  awaitingPassword = new Set();
}

function deleteLinks(accountId: string): void {
  for (const [token, owner] of passwordLinks) {
    if (owner === accountId) passwordLinks.delete(token);
  }
}

const ROLES: readonly UserRole[] = ['ADMIN', 'HR_PAYROLL', 'SUPERVISOR', 'GUARD'];
const NO_SUCH_ACCOUNT = 'No user account exists with this ID.';

/** SUPERVISOR and GUARD must be linked to an employee; ADMIN and HR_PAYROLL never are. */
function linkProblem(role: UserRole, employeeId: string | null) {
  const needsLink = role === 'SUPERVISOR' || role === 'GUARD';
  if (needsLink && employeeId === null) {
    return validationProblem(
      'employeeId',
      'SUPERVISOR and GUARD accounts must be linked to an employee.',
    );
  }
  if (!needsLink && employeeId !== null) {
    return validationProblem(
      'employeeId',
      'ADMIN and HR_PAYROLL accounts are not linked to an employee.',
    );
  }
  return undefined;
}

/** The same checks the real API makes on an employee link. */
function employeeProblem(employeeId: string, exceptAccountId?: string) {
  const employee = mockEmployees.find((candidate) => candidate.id === employeeId);
  if (!employee) {
    return validationProblem('employeeId', 'No employee exists with this ID.');
  }
  if (employee.status === 'TERMINATED') {
    return conflict('This employee has left the company.');
  }
  if (accounts.some((a) => a.employeeId === employeeId && a.id !== exceptAccountId)) {
    return conflict('This employee already has a sign-in account.');
  }
  return undefined;
}

/** A fresh one-time link, valid 72 hours, like the real API's. */
function issueLink(accountId: string) {
  deleteLinks(accountId);
  awaitingPassword.add(accountId);
  const token = `mock-link-${crypto.randomUUID()}`;
  passwordLinks.set(token, accountId);
  return { token, expiresAt: new Date(Date.now() + 72 * 3_600_000).toISOString() };
}

const noStore = { 'Cache-Control': 'no-store' };

/** The contract's rules for an email and a full name, shared by create and update. */
function emailProblem(email: unknown) {
  return typeof email === 'string' && /^[^@\s]+@[^@\s]+$/.test(email) && email.length <= 254
    ? undefined
    : validationProblem('email', 'Enter a valid email address.');
}

function fullNameProblem(fullName: unknown) {
  return typeof fullName === 'string' && fullName.length >= 2 && fullName.length <= 120
    ? undefined
    : validationProblem('fullName', 'Must be 2 to 120 characters long.');
}

function findAccount(userId: string) {
  if (!isUuid(userId)) {
    return { problem: validationProblem('userId', 'Must be a valid ID.') };
  }
  const account = accounts.find((candidate) => candidate.id === userId);
  return account ? { account } : { problem: notFound(NO_SUCH_ACCOUNT) };
}

// TODO(after the sign-in stack lands): answer 401 without a token and 403 for
// every role except ADMIN, and refuse changes to the caller's own account.
export const userHandlers = [
  http.get<PathParams, never, OrProblem<UserAccountList>>(apiUrl('/users'), ({ request }) => {
    const query = new URL(request.url).searchParams;
    const limit = readLimit(query);
    if (limit === undefined) {
      return validationProblem('limit', 'Must be a whole number from 1 to 100.');
    }
    const page = pageOf(accounts, limit, query.get('cursor'));
    return page
      ? HttpResponse.json<UserAccountList>(page)
      : validationProblem('cursor', 'The cursor is not valid. Start again from the first page.');
  }),

  http.post<PathParams, CreateUserRequest, OrProblem<UserAccountWithPasswordSetup>>(
    apiUrl('/users'),
    async ({ request }) => {
      const body = await request.json();
      const badDetails = emailProblem(body.email) ?? fullNameProblem(body.fullName);
      if (badDetails) {
        return badDetails;
      }
      if (!isOneOf(ROLES, body.role ?? '')) {
        return validationProblem('role', `Must be one of ${ROLES.join(', ')}.`);
      }
      const employeeId = body.employeeId ?? null;
      const badLink =
        linkProblem(body.role, employeeId) ?? (employeeId && employeeProblem(employeeId));
      if (badLink) {
        return badLink;
      }
      const email = body.email.trim().toLowerCase();
      if (accounts.some((account) => account.email === email)) {
        return conflict('An account with this email already exists.');
      }

      const now = new Date().toISOString();
      const account: UserAccount = {
        id: crypto.randomUUID(),
        email,
        fullName: body.fullName,
        role: body.role,
        status: 'AWAITING_PASSWORD',
        twoFactorEnabled: false,
        employeeId,
        createdAt: now,
        updatedAt: now,
      };
      accounts.push(account);
      return HttpResponse.json<UserAccountWithPasswordSetup>(
        { user: account, passwordSetup: issueLink(account.id) },
        { status: 201, headers: { Location: `/api/v1/users/${account.id}`, ...noStore } },
      );
    },
  ),

  http.get<{ userId: string }, never, OrProblem<UserAccount>>(
    apiUrl('/users/:userId'),
    ({ params }) => {
      const found = findAccount(params.userId);
      return found.account ? HttpResponse.json<UserAccount>(found.account) : found.problem;
    },
  ),

  http.patch<{ userId: string }, UpdateUserRequest, OrProblem<UserAccount>>(
    apiUrl('/users/:userId'),
    async ({ params, request }) => {
      const found = findAccount(params.userId);
      if (!found.account) {
        return found.problem;
      }
      const account = found.account;
      const body = await request.json();
      const allowed = ['email', 'fullName', 'role', 'employeeId'];
      const unknown = Object.keys(body).find((key) => !allowed.includes(key));
      if (unknown !== undefined) {
        return validationProblem(unknown, 'Unrecognized field.');
      }
      if (Object.keys(body).length === 0) {
        return validationProblem('body', 'Send at least one field to change.');
      }
      // Same rules as creating an account, applied to the fields that were sent.
      const badDetails =
        (body.email !== undefined ? emailProblem(body.email) : undefined) ??
        (body.fullName !== undefined ? fullNameProblem(body.fullName) : undefined);
      if (badDetails) {
        return badDetails;
      }
      if (body.role !== undefined && !isOneOf(ROLES, body.role)) {
        return validationProblem('role', `Must be one of ${ROLES.join(', ')}.`);
      }
      if (account.status === 'DEACTIVATED') {
        return conflict('This account is switched off. Reactivate it first.');
      }
      const role = body.role ?? account.role;
      const employeeId = body.employeeId === undefined ? account.employeeId : body.employeeId;
      const badLink =
        linkProblem(role, employeeId) ??
        (employeeId &&
          employeeId !== account.employeeId &&
          employeeProblem(employeeId, account.id));
      if (badLink) {
        return badLink;
      }
      if (body.email !== undefined) {
        const email = body.email.trim().toLowerCase();
        if (accounts.some((other) => other.email === email && other.id !== account.id)) {
          return conflict('An account with this email already exists.');
        }
        account.email = email;
      }
      if (body.fullName !== undefined) account.fullName = body.fullName;
      account.role = role;
      account.employeeId = employeeId;
      account.updatedAt = new Date().toISOString();
      return HttpResponse.json<UserAccount>(account);
    },
  ),

  http.post<{ userId: string }, never, OrProblem<UserAccount>>(
    apiUrl('/users/:userId/deactivate'),
    ({ params }) => {
      const found = findAccount(params.userId);
      if (!found.account) {
        return found.problem;
      }
      if (found.account.status === 'DEACTIVATED') {
        return conflict('This account is already switched off.');
      }
      found.account.status = 'DEACTIVATED';
      deleteLinks(found.account.id);
      found.account.updatedAt = new Date().toISOString();
      return HttpResponse.json<UserAccount>(found.account);
    },
  ),

  http.post<{ userId: string }, never, OrProblem<UserAccount>>(
    apiUrl('/users/:userId/reactivate'),
    ({ params }) => {
      const found = findAccount(params.userId);
      if (!found.account) {
        return found.problem;
      }
      const account = found.account;
      if (account.status !== 'DEACTIVATED') {
        return conflict('This account is already switched on.');
      }
      const employee = mockEmployees.find((candidate) => candidate.id === account.employeeId);
      if (employee?.status === 'TERMINATED') {
        return conflict('This account belongs to an employee who has left the company.');
      }
      // An account whose owner never chose a password is still waiting for one.
      account.status = awaitingPassword.has(account.id) ? 'AWAITING_PASSWORD' : 'ACTIVE';
      account.updatedAt = new Date().toISOString();
      return HttpResponse.json<UserAccount>(account);
    },
  ),

  http.post<{ userId: string }, never, OrProblem<UserAccountWithPasswordSetup>>(
    apiUrl('/users/:userId/reset-sign-in'),
    ({ params }) => {
      const found = findAccount(params.userId);
      if (!found.account) {
        return found.problem;
      }
      const account = found.account;
      if (account.status === 'DEACTIVATED') {
        return conflict('This account is switched off. Reactivate it first.');
      }
      account.status = 'AWAITING_PASSWORD';
      account.twoFactorEnabled = false;
      account.updatedAt = new Date().toISOString();
      return HttpResponse.json<UserAccountWithPasswordSetup>(
        { user: account, passwordSetup: issueLink(account.id) },
        { headers: noStore },
      );
    },
  ),

  http.post<PathParams, SetPasswordRequest, OrProblem<undefined>>(
    apiUrl('/auth/set-password'),
    async ({ request }) => {
      const body = await request.json();
      const accountId = passwordLinks.get(body.token ?? '');
      const account = accounts.find((candidate) => candidate.id === accountId);
      if (!account || account.status === 'DEACTIVATED') {
        return validationProblem(
          'token',
          'This link has expired or was already used. Ask an administrator for a new one.',
        );
      }
      if ((body.newPassword ?? '').length < 12 || body.newPassword.length > 128) {
        return validationProblem(
          'newPassword',
          'Use at least 12 characters. A short sentence works well.',
        );
      }
      passwordLinks.delete(body.token);
      awaitingPassword.delete(account.id);
      account.status = 'ACTIVE';
      account.updatedAt = new Date().toISOString();
      return new HttpResponse(null, { status: 204 });
    },
  ),

  http.post<PathParams, ChangePasswordRequest, OrProblem<undefined>>(
    apiUrl('/auth/change-password'),
    async ({ request }) => {
      const body = await request.json();
      // Like the real API: a wrong current password is a 400, never a 401.
      if (body.currentPassword !== MOCK_PASSWORD) {
        return validationProblem('currentPassword', 'Your current password is incorrect.');
      }
      if ((body.newPassword ?? '').length < 12 || body.newPassword.length > 128) {
        return validationProblem(
          'newPassword',
          'Use at least 12 characters. A short sentence works well.',
        );
      }
      if (body.newPassword === body.currentPassword) {
        return validationProblem(
          'newPassword',
          'Choose a password different from your current one.',
        );
      }
      return new HttpResponse(null, { status: 204 });
    },
  ),
];
