/**
 * The settings the dashboard reads from `.env` files, so TypeScript knows their
 * names and types. Only names starting with `VITE_` reach the browser.
 */
interface ImportMetaEnv {
  /** Where the SAMTEC API runs, for example http://localhost:3000/api/v1. */
  readonly VITE_API_BASE_URL?: string;
}
