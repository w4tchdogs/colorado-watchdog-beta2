export interface StoredObject {
  readonly body: Uint8Array;
  readonly byteSize: number;
  readonly metadata: Readonly<Record<string, string>>;
}

/** Storage API maps directly to immutable R2 object operations; it never deletes. */
export interface ImmutableObjectStorage {
  putIfAbsent(
    key: string,
    body: Uint8Array,
    metadata: Readonly<Record<string, string>>,
  ): Promise<"created" | "exists">;
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<{
    readonly byteSize: number;
    readonly metadata: Readonly<Record<string, string>>;
  } | null>;
  listKeys(prefix: string): Promise<readonly string[]>;
}

/** Disposable adapter for tests and local development. Each instance owns its objects. */
export class MemoryBannerObjectStorage implements ImmutableObjectStorage {
  private readonly objects = new Map<string, StoredObject>();
  private readonly hiddenForTest = new Set<string>();
  writes = 0;

  async putIfAbsent(
    key: string,
    body: Uint8Array,
    metadata: Readonly<Record<string, string>>,
  ): Promise<"created" | "exists"> {
    const prior = this.objects.get(key);
    if (prior) return "exists";
    this.objects.set(key, {
      body: new Uint8Array(body),
      byteSize: body.byteLength,
      metadata: { ...metadata },
    });
    this.writes += 1;
    return "created";
  }

  async get(key: string): Promise<StoredObject | null> {
    if (this.hiddenForTest.has(key)) return null;
    const object = this.objects.get(key);
    return object
      ? {
          ...object,
          body: new Uint8Array(object.body),
          metadata: { ...object.metadata },
        }
      : null;
  }

  async head(key: string) {
    if (this.hiddenForTest.has(key)) return null;
    const object = this.objects.get(key);
    return object
      ? { byteSize: object.byteSize, metadata: { ...object.metadata } }
      : null;
  }

  async listKeys(prefix: string): Promise<readonly string[]> {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix) && !this.hiddenForTest.has(key))
      .sort();
  }

  /** Fault injection used only by tests to model an externally damaged object. */
  corruptForTest(key: string, body: Uint8Array): void {
    const object = this.objects.get(key);
    if (!object) throw new Error("Object does not exist");
    this.objects.set(key, { ...object, body: new Uint8Array(body) });
  }

  hideForTest(key: string): void {
    this.hiddenForTest.add(key);
  }

  revealForTest(key: string): void {
    this.hiddenForTest.delete(key);
  }

  keys(): readonly string[] {
    return [...this.objects.keys()].sort();
  }
}

/** Small structural subset of the Cloudflare Workers R2 bucket binding. */
export interface R2BucketLike {
  put(
    key: string,
    value: Uint8Array,
    options: {
      readonly onlyIf: { readonly etagDoesNotMatch: "*" };
      readonly customMetadata: Readonly<Record<string, string>>;
    },
  ): Promise<{
    readonly size: number;
    readonly customMetadata?: Record<string, string>;
  } | null>;
  get(key: string): Promise<{
    readonly size: number;
    readonly customMetadata?: Record<string, string>;
    readonly arrayBuffer: () => Promise<ArrayBuffer>;
  } | null>;
  head(key: string): Promise<{
    readonly size: number;
    readonly customMetadata?: Record<string, string>;
  } | null>;
  list(options: {
    readonly prefix: string;
    readonly cursor?: string;
  }): Promise<{
    readonly objects: readonly { readonly key: string }[];
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
}

/** Adapter for a Workers R2 binding; write-once uses R2's atomic conditional PUT. */
export class R2BannerObjectStorage implements ImmutableObjectStorage {
  constructor(private readonly bucket: R2BucketLike) {}

  async putIfAbsent(
    key: string,
    body: Uint8Array,
    metadata: Readonly<Record<string, string>>,
  ): Promise<"created" | "exists"> {
    const result = await this.bucket.put(key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: { ...metadata },
    });
    return result ? "created" : "exists";
  }

  async get(key: string): Promise<StoredObject | null> {
    const object = await this.bucket.get(key);
    return object
      ? {
          body: new Uint8Array(await object.arrayBuffer()),
          byteSize: object.size,
          metadata: object.customMetadata ?? {},
        }
      : null;
  }

  async head(key: string) {
    const object = await this.bucket.head(key);
    return object
      ? { byteSize: object.size, metadata: object.customMetadata ?? {} }
      : null;
  }

  async listKeys(prefix: string): Promise<readonly string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({
        prefix,
        ...(cursor ? { cursor } : {}),
      });
      keys.push(...page.objects.map(({ key }) => key));
      cursor = page.truncated ? page.cursor : undefined;
      if (page.truncated && !cursor)
        throw new Error(
          "R2 object listing was truncated without a continuation cursor",
        );
    } while (cursor);
    return keys.sort();
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
