/**
 * @samtec/contracts: TypeScript types generated from `openapi.yaml`.
 *
 * Always import with `import type`, because this package only contains types:
 *
 *   import type { Employee, paths } from '@samtec/contracts';
 *
 * Never edit `src/generated/api.d.ts` by hand. Change `openapi.yaml`, then run
 * `pnpm contracts:generate` from the repository root.
 */
export type * from './generated/api.js';

/**
 * The one runtime value in this package lives at its own subpath, so the line
 * above stays true: importing `@samtec/contracts` gives you types and nothing
 * else.
 *
 *   import { DEVICE_SIGNATURE_VECTOR } from '@samtec/contracts/device-signature-vector';
 *
 * It is the worked example of a signed device request, asserted by a test on
 * the kiosk side and again on the API side.
 */
