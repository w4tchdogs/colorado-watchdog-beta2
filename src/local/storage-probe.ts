import type { StorageProbe } from "../contracts/storage.js";
import type { WebsiteDatabase } from "../database/sqlite.js";

export function createLocalStorageProbe(
  database: WebsiteDatabase,
): StorageProbe {
  return {
    async check() {
      database.prepare("SELECT 1").get();
    },
  };
}
