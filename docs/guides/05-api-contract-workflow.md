# Changing the API contract

The API contract is the agreement between the dashboard and the API. This guide shows how to read it and how to change it safely.

## What the contract is

`packages/contracts/openapi.yaml` lists every request the dashboard can send and every response the API can return. It uses **OpenAPI**, the industry standard for describing web APIs.

Because the contract is written **before** the code (design-first), Samuel can build a page against it using mock data while Francis builds the endpoint. When both are finished, they fit.

## Reading the contract

Here is the health check endpoint, with notes:

```yaml
paths:
  /health:                       # the web address, after /api/v1
    get:                         # the HTTP method
      operationId: getHealth     # a unique name for this operation
      summary: Check that the API and its database are working
      security: []               # empty list: no sign-in needed
      responses:
        "200":                   # what comes back when it works
          description: The API and the database are working.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/HealthResponse"   # the shape of the body
```

And the shape it refers to, further down under `components/schemas`:

```yaml
HealthResponse:
  type: object
  required: [status, time, checks]   # these fields must always be present
  properties:
    status:
      type: string
      enum: [ok, degraded]       # only these two values are allowed
    time:
      type: string
      format: date-time          # a timestamp such as 2026-09-15T08:30:00Z
```

The main building blocks:

| Section | Meaning |
|---|---|
| `paths` | Every endpoint, grouped by address |
| `parameters` | Values in the address or query string, like `?limit=25` or `{employeeId}` |
| `requestBody` | The JSON the dashboard sends, for example when creating an employee |
| `responses` | What comes back for each status code (200, 400, 404 and so on) |
| `components/schemas` | Reusable shapes such as `Employee` or `ProblemDetails` |

**Tip:** install the recommended VS Code extensions (VS Code suggests them when you open the project). The OpenAPI extension shows an outline and a preview of the file.

## How the contract reaches the code

Running `pnpm contracts:generate` turns the YAML into TypeScript types in `packages/contracts/src/generated/api.d.ts`. Both apps import them:

```ts
// In the dashboard or the API
import type { Employee, HealthResponse } from '@samtec/contracts';
```

The dashboard's API client also uses the contract, so this line only compiles if `/employees` really exists and the parameters are right:

```ts
const employees = $api.useQuery('get', '/employees', { params: { query: { limit: 25 } } });
```

## Changing the contract, step by step

Example: the client wants to store each guard's **next of kin phone number**.

1. **Create a branch** just for the contract change:

   ```bash
   git switch main
   git pull
   git switch -c contract/next-of-kin-phone
   ```

2. **Edit `openapi.yaml`.** Add the field to the schemas that need it:

   ```yaml
   Employee:
     required: [..., nextOfKinPhone]
     properties:
       nextOfKinPhone:
         oneOf:
           - $ref: "#/components/schemas/GhanaPhoneNumber"
           - type: "null"
   ```

   Also add it to `CreateEmployeeRequest` and `UpdateEmployeeRequest` if people can set it.

3. **Regenerate the types:**

   ```bash
   pnpm contracts:generate
   ```

4. **Check the contract:**

   ```bash
   pnpm contracts:check
   ```

   This lints the YAML and confirms the generated types are up to date.

5. **Run the type check** to see what the change affects:

   ```bash
   pnpm typecheck
   ```

   TypeScript now points at every place that must change, for example the mock data in `apps/web/src/mocks/data/employees.ts` is missing `nextOfKinPhone`. Update the mocks in this same pull request so the dashboard keeps working.

6. **Commit and open a pull request** titled like `feat(contracts): add next of kin phone to employees`. Both developers must approve contract changes.

7. **After merging,** each developer builds their side: Francis adds the database column and the API logic, Samuel adds the form field and the display.

## Rules

- **Never edit `src/generated/api.d.ts` by hand.** It is overwritten every time types are generated. CI fails if it does not match the YAML.
- **Prefer adding over changing.** Adding a new optional field breaks nothing. Renaming or removing a field breaks both apps, so it needs a plan agreed by both developers.
- **Describe every field** with a plain-English `description`, and give examples with fictional data.
- **Keep sensitive fields out of lists.** For example, `EmployeeListItem` has no Ghana Card number on purpose.
- **Document errors.** Every endpoint lists the error responses it can return, so the dashboard can handle each one.
- **Mock handlers change in the same pull request** as the contract.

## Useful commands

| Command | What it does |
|---|---|
| `pnpm contracts:generate` | Regenerates the TypeScript types from `openapi.yaml` |
| `pnpm contracts:check` | Lints the contract and fails if the types are out of date |
| `pnpm contracts:docs` | Builds a readable HTML page of the whole API in `packages/contracts/dist/api-docs.html` |

Related: [API contract plan](../plan/05-api-contract.md) · [Frontend guide](03-frontend-guide.md) · [Backend guide](04-backend-guide.md)
