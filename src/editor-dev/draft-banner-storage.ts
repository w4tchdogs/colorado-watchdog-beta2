import type { WebsiteDatabase } from "../database/sqlite.js";
import type {
  ImmutableObjectStorage,
  StoredObject,
} from "../services/banner-storage.js";

/** Local-only image copies, stored atomically in the private draft file. */
export class DraftBannerObjectStorage implements ImmutableObjectStorage {
  constructor(private readonly database: WebsiteDatabase) {
    database.exec(`CREATE TABLE IF NOT EXISTS draft_banner_objects (
      object_key TEXT PRIMARY KEY NOT NULL,
      body BLOB NOT NULL,
      metadata_json TEXT NOT NULL
    ) STRICT`);
  }

  async putIfAbsent(
    key: string,
    body: Uint8Array,
    metadata: Readonly<Record<string, string>>,
  ): Promise<"created" | "exists"> {
    const inserted = this.database
      .prepare(`INSERT INTO draft_banner_objects (object_key, body, metadata_json)
        VALUES (?, ?, ?) ON CONFLICT(object_key) DO NOTHING RETURNING object_key`)
      .get(key, body, JSON.stringify(metadata));
    return inserted ? "created" : "exists";
  }

  async get(key: string): Promise<StoredObject | null> {
    const row = this.database
      .prepare(
        "SELECT body, metadata_json FROM draft_banner_objects WHERE object_key = ?",
      )
      .get(key);
    if (!row) return null;
    const body = row.body as Uint8Array;
    return {
      body,
      byteSize: body.byteLength,
      metadata: JSON.parse(String(row.metadata_json)),
    };
  }

  async head(key: string) {
    const row = this.database
      .prepare(`SELECT length(body) AS byte_size, metadata_json
        FROM draft_banner_objects WHERE object_key = ?`)
      .get(key);
    return row
      ? {
          byteSize: Number(row.byte_size),
          metadata: JSON.parse(String(row.metadata_json)),
        }
      : null;
  }

  async listKeys(prefix: string): Promise<readonly string[]> {
    return this.database
      .prepare(`SELECT object_key FROM draft_banner_objects
        WHERE substr(object_key, 1, length(?)) = ? ORDER BY object_key`)
      .all(prefix, prefix)
      .map((row) => String(row.object_key));
  }
}
