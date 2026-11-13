import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createApplication } from "../application.js";
import { migrateWebsiteDatabase } from "../database/migrations.js";
import {
  openWebsiteDatabase,
  type WebsiteDatabase,
} from "../database/sqlite.js";
import { createServices } from "../services/index.js";
import {
  createPublicSite,
  createWebsite,
  type SiteAssets,
} from "../site/index.js";
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
  "favicon.svg": "image/svg+xml",
};

export function createFileAssets(directory: string): SiteAssets {
  return {
    async get(name) {
      const contentType = ASSET_TYPES[name];
      if (!contentType) return null;
      try {
        return {
          body: await readFile(join(directory, name), "utf8"),
          contentType,
        };
      } catch {
        return null;
      }
    },
  };
}

export interface SitePreviewOptions {
  /** Directory holding site.css and site.js (website/site). */
  readonly staticDirectory: string;
  /** "fictional" seeds demonstration records; "empty" leaves only counties. */
  readonly data?: "fictional" | "empty";
  readonly now?: () => Date;
}

export interface SitePreview {
  readonly database: WebsiteDatabase;
  fetch(request: Request): Promise<Response>;
  close(): void;
}

export async function createSitePreview(
  options: SitePreviewOptions,
): Promise<SitePreview> {
  const database = await openWebsiteDatabase(":memory:");
  migrateWebsiteDatabase(database);
  const fictional = (options.data ?? "fictional") === "fictional";
  if (fictional) seedFictionalDirectory(database);

  const services = createServices({ database });
  const website = createWebsite({
    application: createApplication(services),
    site: createPublicSite({
      services,
      assets: createFileAssets(options.staticDirectory),
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
