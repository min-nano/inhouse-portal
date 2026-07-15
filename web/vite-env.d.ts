/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Clerk の Publishable key(pk_…)。ビルド時に注入する公開値。 */
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
