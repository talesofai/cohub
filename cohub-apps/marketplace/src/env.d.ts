interface ImportMetaEnv {
  /** Catalog URL injected at build time via the `CATALOG_URL` env variable. */
  readonly __CATALOG_URL__: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
