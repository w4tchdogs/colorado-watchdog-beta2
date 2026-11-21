import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createApplication } from "../application.js";
import { AsyncD1Database } from "../database/d1.js";
import { migrateWebsiteDatabase } from "../database/migrations.js";
import {
  openWebsiteDatabase,
  type WebsiteDatabase,
} from "../database/sqlite.js";
import { createLocalD1Binding } from "../editor-dev/d1-binding.js";
import { D1BannerPublicService } from "../services/banner-public.js";
import type { ImmutableObjectStorage } from "../services/banner-storage.js";
import { D1CountyStructurePublicService } from "../services/county-structure-public.js";
import { createD1PublicReadServices } from "../services/d1-public-reads.js";
import { createServices } from "../services/index.js";
import type { BannerSource } from "../site/banner.js";
import { createD1EditorialSource } from "../site/d1-editorial-source.js";
import {
  createPublicSite,
  createWebsite,
  type SiteAssets,
} from "../site/index.js";
import {
  bannerFixtureAsset,
  createFixtureBannerSource,
} from "./banner-fixtures.js";
import {
  fictionalEditorialSource,
  seedFictionalDirectory,
} from "./preview-data.js";

/**
 * Local public-site preview. Development only: it always uses a fresh
 * in-memory Website database, reads no environment or database path, never
 * touches the Profiles research database, and is not imported by the Worker.
 */
const ASSET_TYPES: Readonly<Record<string, string>> = {
  "site.css": "text/css; charset=utf-8",
  "site.js": "text/javascript; charset=utf-8",
  "community-voices.css": "text/css; charset=utf-8",
  "brand-logo-white.png": "image/png",
  "brand-logo-white-large.png": "image/png",
  "brand-mascot-standing.png": "image/png",
  "brand-mascot-lying.png": "image/png",
  "brand-mascot-sit-alert.png": "image/png",
  "favicon-light.png": "image/png",
  "favicon-dark.png": "image/png",
};

export function createFileAssets(directory: string): SiteAssets {
  return {
    async get(name) {
      const contentType = ASSET_TYPES[name];
      if (!contentType) return null;
      try {
        const bytes = await readFile(join(directory, name));
        return {
          body: contentType.startsWith("text/")
            ? bytes.toString("utf8")
            : new Uint8Array(bytes),
          contentType,
        };
      } catch {
        return null;
      }
    },
  };
}

/** Adds the generated synthetic banner test patterns to the static files. */
function withBannerFixtures(assets: SiteAssets): SiteAssets {
  return {
    async get(name) {
      const pattern = bannerFixtureAsset(name);
      return pattern === null
        ? assets.get(name)
        : { body: pattern, contentType: "image/svg+xml" };
    },
  };
}

export interface SitePreviewOptions {
  /** Directory holding site.css and site.js (website/site). */
  readonly staticDirectory: string;
  /** "fictional" seeds demonstration records; "empty" leaves only counties. */
  readonly data?: "fictional" | "empty";
  /** Show synthetic banner test patterns on a few counties. */
  readonly bannerFixtures?: boolean;
  /** With bannerFixtures, false leaves the homepage on the branded fallback. */
  readonly homeBannerFixtures?: boolean;
  /** Banner records to render instead of the built-in fixtures (tests). */
  readonly banners?: BannerSource;
  readonly bannerDelivery?: {
    deliver(versionId: string): Promise<{
      body: Uint8Array;
      contentType: "image/jpeg" | "image/png";
    } | null>;
  };
  readonly now?: () => Date;
}

export interface SitePreview {
  readonly database: WebsiteDatabase;
  fetch(request: Request): Promise<Response>;
  close(): void;
}

/** The dashboard owns this database and closes it when both previews stop. */
export function createDraftSitePreview(
  database: WebsiteDatabase,
  staticDirectory: string,
  bannerStorage: ImmutableObjectStorage,
) {
  const localD1 = new AsyncD1Database(createLocalD1Binding(database));
  const banners = new D1BannerPublicService(localD1, bannerStorage);
  return createWebsite({
    application: createApplication(createServices({ database })),
    site: createPublicSite({
      services: createD1PublicReadServices(localD1),
      countyStructure: new D1CountyStructurePublicService(localD1),
      banners,
      bannerDelivery: banners,
      editorial: createD1EditorialSource(localD1),
      assets: createFileAssets(staticDirectory),
      preview: "draft-review",
    }),
  });
}

export async function createSitePreview(
  options: SitePreviewOptions,
): Promise<SitePreview> {
  const database = await openWebsiteDatabase(":memory:");
  migrateWebsiteDatabase(database);
  const fictional = (options.data ?? "fictional") === "fictional";
  if (fictional) seedFictionalDirectory(database);

  const services = createServices({ database });
  const files = createFileAssets(options.staticDirectory);
  const website = createWebsite({
    application: createApplication(services),
    site: createPublicSite({
      services,
      assets: options.bannerFixtures ? withBannerFixtures(files) : files,
      ...(options.banners
        ? { banners: options.banners }
        : options.bannerFixtures
          ? {
              banners: createFixtureBannerSource({
                home: options.homeBannerFixtures ?? true,
              }),
            }
          : {}),
      ...(options.bannerDelivery
        ? { bannerDelivery: options.bannerDelivery }
        : {}),
      preview: fictional,
      ...(fictional ? { editorial: fictionalEditorialSource } : {}),
      ...(options.now ? { now: options.now } : {}),
    }),
  });

  return {
    database,
    fetch: (request) => website.fetch(request),
    close: () => database.close(),
  };
}
