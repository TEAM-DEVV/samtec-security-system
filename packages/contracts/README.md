# @samtec/contracts

The SAMTEC API contract: the single agreement between the dashboard and the API.

| File | What it is |
|---|---|
| `openapi.yaml` | The contract itself, in OpenAPI 3.1. **Edit this file.** |
| `src/generated/api.d.ts` | TypeScript types generated from the contract. **Never edit it by hand.** |
| `src/index.ts` | Makes the types available as `@samtec/contracts` |
| `redocly.yaml` | Lint rules for the contract |

Step-by-step guide: [Changing the API contract](../../docs/guides/05-api-contract-workflow.md).

## Commands

Run these from the repository root.

| Command | What it does |
|---|---|
| `pnpm contracts:generate` | Regenerates the types after you edit `openapi.yaml` |
| `pnpm contracts:check` | Lints the contract and fails if the types are out of date. CI runs this. |
| `pnpm contracts:docs` | Builds a readable API reference at `packages/contracts/dist/api-docs.html`. Viewing it needs an internet connection. |

## Using the types

This package contains only types, so always import it with `import type`:

```ts
import type { Employee, HealthResponse, paths } from '@samtec/contracts';
```
