# SAMTEC dashboard (frontend) — working rules

This file is for Claude Code sessions working on the dashboard. The whole-project rules in the repository root `CLAUDE.md` still apply; these add the frontend specifics. Samuel is learning: explain every change in plain language, keep code simple and conventional, and after each piece, briefly quiz him so he can defend it at his final year presentation without help.

## How to work

1. **Mock data first.** Develop with `pnpm dev:web` (from the repository root) and open http://localhost:5173 in Chrome, Edge or Firefox. The mock API in `src/mocks/` behaves exactly like the real backend will — including errors — so the backend never blocks you.
2. **One page at a time, always finished.** A page is finished when it has loading, empty and error states, a test, and `pnpm check` passes. Copy the structure of `src/pages/employees-page.tsx` — it is the reference for every page.
3. **Data only through `$api`** (`src/lib/api.ts`). Never write your own `fetch`. If TypeScript underlines a path, the contract (`packages/contracts/openapi.yaml`) doesn't have it — stop and ask Francis, don't work around it.
4. **Display through the helpers** in `src/lib/format.ts` (money, dates, Ghana time) and errors through `src/lib/problem.ts`.
5. **Components from `src/components/ui/`** (shadcn). Add new ones with `pnpm --filter @samtec/web exec shadcn add <name>`, never by hand-rolling buttons or dialogs.
6. **Accessibility is not optional**: labels on inputs, text on buttons, `aria-hidden` on decorative icons, status never shown by colour alone, everything reachable with Tab and Enter.
7. **Branch → pull request → Francis reviews.** Never push to `main`. Run `/lens-review` before opening the pull request.

## Phase 1 frontend task list (all done)

Each task ended with a working demo in mock mode, a test, and a pull request. Kept here so the next phase's list follows the same shape.

1. **Sign-in page** (`/login`): email + password form → `POST /auth/login`. Handle all three outcomes: `AUTHENTICATED` (go to the dashboard), `TWO_FACTOR_REQUIRED` (go to the code screen), `TWO_FACTOR_SETUP_REQUIRED` (go to the setup screen). Show the error message from `describeApiError` on 401 and the wait time on 429. Mock accounts: see the table in `docs/guides/03-frontend-guide.md` (password `demo-password`, code `123456`).
2. **Two-factor screens**: a 6-digit code screen (`/auth/2fa/verify`) and a setup screen showing the QR code from `otpauthUri` (render with a QR component — ask before adding any dependency) plus the manual key, then `/auth/2fa/enable`.
3. **Session handling**: keep the access token in memory only (module state or context — never `localStorage`), send it as `Authorization: Bearer …` via the `$api` client, call `POST /auth/refresh` when a request answers 401, and sign out on `POST /auth/logout`. Show the signed-in user (from `/auth/me`) and a sign-out button in the app shell.
4. **Route protection**: unauthenticated users land on `/login`; the sidebar shows only what the user's role allows.
5. **Employee detail page** (`/employees/:id`): full record, status badge, current site; show the Ghana Card number only when the API sends it (it is omitted for roles that may not see it).
6. **Sites page** (`/sites`): follow the step-by-step example in `docs/guides/03-frontend-guide.md`.
7. **Switch live mode on**: done once sign-in worked against the real API (`pnpm dev`); the live-mode placeholder was removed from `src/app/router.tsx`, so every page is served in both modes.
8. **Users pages** (ADMIN only): `src/pages/users-page.tsx`, `new-user-page.tsx` (the one-time link is `/set-password#token=…`, shown once) and `user-detail-page.tsx` (edit, switch off/on, reset sign-in, never on your own account). The mock Users API enforces sign-in, ADMIN and the own-account rules like the real one.
9. **Change password**: `src/pages/change-password-page.tsx` at `/account/password`; on success the session is cleared and the sign-in page shows a notice from the router state.
10. **Phase 2 attendance** (`src/lib/attendance.ts` holds every label and rule): worked shifts (`attendance-page.tsx`, a date range of at most 31 days, site and status filters), `my-attendance-page.tsx` for the signed-in employee, the exception queue (`exceptions-page.tsx`) and one exception with its evidence and decision form (`exception-detail-page.tsx`; the API's `allowedActions` decides what the form offers), and the Devices pages (`devices-page.tsx`, `new-device-page.tsx`, `device-detail-page.tsx`; secrets are shown once through `SecretPanel` and never cached).

11. **Phase 3 biometrics** (`src/lib/biometrics.ts` holds every label): the live board (`live-board-page.tsx`, `GET /attendance/punches` refreshed every 5 seconds on the first page only, flagged methods in amber through `PunchMethodBadge`), the Biometrics panel on the employee page (`components/biometrics-panel.tsx`: statuses only; an ADMIN wipes a face, records a withdrawal, asks for an exemption or decides one another ADMIN asked for), the duplicate-enrollment queue (`duplicate-faces-page.tsx`; the decision form sits on each open card because the contract has no single-collision read) and kiosk attempts (`kiosk-attempts-page.tsx`, reached from the Devices page and from a kiosk's page with `?deviceId=`). Every "who may decide" rule is the API's; the pages hide a form only where they already know the answer (you asked, you enrolled) and otherwise show the API's refusal word for word.

12. **Phase 5 ghost detection** (`src/lib/detection.ts` holds every label, the question each rule asks, and the plain words for every threshold and piece of evidence): the alert queue (`detection-page.tsx`, open ones first, with the "Highest risk" panel from `GET /detection/risk-scores` and, for an ADMIN, the "Run the rules now" button), one alert (`detection-alert-page.tsx`; the evidence is whatever the rule cited, shown in plain words, and the decision form closes it as resolved or confirmed fraud with a note that is audited), and the rules (`detection-rules-page.tsx`; an ADMIN switches a rule off or moves its numbers, HR reads them). A supervisor never sees any of it: they are themselves a subject of rule R7.

What Samuel picks up next is in `docs/plan/14-work-split.md`: the kiosk app (`apps/kiosk`, a separate Vite app with plain CSS), then the fake ZKTeco terminal and the gateway (`apps/gateway`). Phase 1's employee forms are now done (`new-employee-page.tsx`, `edit-employee-page.tsx`, `terminate-employee-page.tsx`, sharing `components/employee-form.tsx` and `components/posting-fields.tsx`), so every dashboard screen in Phases 1 to 6 is built.

## Traps to avoid

- The System Status page shows why reading `health.error` before `health.data` matters — read the comment there before writing any new query handling.
- Tests run in the Honolulu time zone on purpose; if a date test fails, you formatted with the computer's local zone instead of the helpers.
- Every protected mock endpoint answers 401 without an access token (`userForRequest` in `src/mocks/handlers/auth.ts`), like the real API. A test that loads data must call `signInForTests()` from `src/test/session.ts` first. The `$api` client adds the token and refreshes it on 401 by itself (`src/lib/api.ts`); pages never handle tokens.
