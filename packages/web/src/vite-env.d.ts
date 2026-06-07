/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Provider host (logical domain, e.g. `providera.com`) a separately-hosted
   * client targets by default. Unset → the client defaults to its own origin
   * (the combined single-process deployment). See `lib/provider.ts`.
   */
  readonly VITE_PROVIDER_HOST?: string;
}
