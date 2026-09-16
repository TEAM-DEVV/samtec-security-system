interface ImportMetaEnv {
  /** Base URL of the SAMTEC API, for example http://localhost:3000/api/v1 */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
