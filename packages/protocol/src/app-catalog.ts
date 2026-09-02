import { z } from "zod";
import { parseSpaceSlug, parseUsername } from "./public-identifiers.js";

export const SPACE_INSTALLED_APPS_PATH = ".cohub/apps.json";
export const COHUB_APP_CATALOG_ID = "cohub";
export const COHUB_APP_MARKETPLACE_URL =
  "https://cdn.cohub.live/app-market/catalog.v1.json";

export const APP_MARKETPLACE_FORMAT = "cohub.app-marketplace";
export const SPACE_APPS_FORMAT = "cohub.space-apps";
export const APP_CATALOG_FORMAT_VERSION = 1;

export function parseCanonicalAppRef(value: string): string | null {
  const parts = value.trim().split("/");
  if (parts.length !== 3) return null;
  const username = parseUsername(parts[0]);
  const spaceSlug = parseSpaceSlug(parts[1]);
  const appSlug = parseSpaceSlug(parts[2]);
  return username && spaceSlug && appSlug
    ? `${username}/${spaceSlug}/${appSlug}`
    : null;
}

const HttpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "Expected an HTTP(S) URL");

const AppIdSchema = z.uuid();

const AppRefSchema = z.string().transform((value, context) => {
  const ref = parseCanonicalAppRef(value);
  if (!ref) {
    context.addIssue({ code: "custom", message: "Expected username/space/app" });
    return z.NEVER;
  }
  return ref;
});

const OptionalTextSchema = z.string().trim().min(1).max(500).optional();
const OptionalIconSchema = HttpUrlSchema.optional();
const KeywordsSchema = z.array(z.string().trim().min(1).max(60)).max(30).optional();

export const AppMarketplaceEntrySchema = z.object({
  id: AppIdSchema,
  ref: AppRefSchema,
  name: z.string().trim().min(1).max(120),
  description: OptionalTextSchema,
  icon: OptionalIconSchema,
  url: HttpUrlSchema,
  publisher: z.string().trim().min(1).max(120).optional(),
  keywords: KeywordsSchema,
});

export type AppMarketplaceEntry = z.infer<typeof AppMarketplaceEntrySchema>;

export const AppMarketplaceCatalogSchema = z.object({
  format: z.literal(APP_MARKETPLACE_FORMAT),
  version: z.literal(APP_CATALOG_FORMAT_VERSION),
  apps: z.array(AppMarketplaceEntrySchema).max(10_000),
});

export type AppMarketplaceCatalog = z.infer<typeof AppMarketplaceCatalogSchema>;

export const InstalledAppSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("marketplace"),
    catalog: z.union([z.literal(COHUB_APP_CATALOG_ID), HttpUrlSchema]),
    appId: z.string().trim().min(1).max(255),
  }),
  z.object({
    type: z.literal("url"),
    url: HttpUrlSchema,
  }),
]);

export type InstalledAppSource = z.infer<typeof InstalledAppSourceSchema>;

export const InstalledAppSnapshotSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: OptionalTextSchema,
  icon: OptionalIconSchema,
  publisher: z.string().trim().min(1).max(120).optional(),
  keywords: KeywordsSchema,
});

export type InstalledAppSnapshot = z.infer<typeof InstalledAppSnapshotSchema>;

export const InstalledAppSchema = z.object({
  id: AppIdSchema,
  ref: AppRefSchema,
  url: HttpUrlSchema,
  enabled: z.boolean(),
  source: InstalledAppSourceSchema,
  snapshot: InstalledAppSnapshotSchema,
  installedAt: z.iso.datetime(),
});

export type InstalledApp = z.infer<typeof InstalledAppSchema>;

export const SpaceInstalledAppsSchema = z.object({
  format: z.literal(SPACE_APPS_FORMAT),
  version: z.literal(APP_CATALOG_FORMAT_VERSION),
  apps: z.array(InstalledAppSchema).max(1_000),
});

export type SpaceInstalledApps = z.infer<typeof SpaceInstalledAppsSchema>;

export function emptySpaceInstalledApps(): SpaceInstalledApps {
  return { format: SPACE_APPS_FORMAT, version: APP_CATALOG_FORMAT_VERSION, apps: [] };
}

export function marketplaceEntryToInstalledApp(
  entry: AppMarketplaceEntry,
  installedAt = new Date().toISOString(),
): InstalledApp {
  return {
    id: entry.id,
    ref: entry.ref,
    url: entry.url,
    enabled: true,
    source: {
      type: "marketplace",
      catalog: COHUB_APP_CATALOG_ID,
      appId: entry.id,
    },
    snapshot: {
      name: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.icon ? { icon: entry.icon } : {}),
      ...(entry.publisher ? { publisher: entry.publisher } : {}),
      ...(entry.keywords ? { keywords: entry.keywords } : {}),
    },
    installedAt,
  };
}
