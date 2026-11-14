/** Structural subset of Cloudflare D1 used by internal asynchronous services. */
export type D1Value = string | number | null | ArrayBuffer | Uint8Array;

export interface D1QueryResult<Row = Record<string, unknown>> {
  readonly results?: Row[];
  readonly success: boolean;
  readonly meta?: { readonly changes?: number; readonly last_row_id?: number };
  readonly error?: string;
}

export interface D1BatchStatement {
  bind(...values: D1Value[]): D1BatchStatement;
}

export interface D1PreparedStatement extends D1BatchStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<Row = Record<string, unknown>>(column?: string): Promise<Row | null>;
  all<Row = Record<string, unknown>>(): Promise<D1QueryResult<Row>>;
  run(): Promise<D1QueryResult>;
}

export interface D1Binding {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1BatchStatement[]): Promise<T[]>;
}

const MAX_RESULT_ROWS = 1_000;

/** Explicit async query boundary; it cannot be used as a WebsiteDatabase transaction. */
export class AsyncD1Database {
  constructor(private readonly binding: D1Binding) {}

  async first<Row>(
    sql: string,
    values: readonly D1Value[] = [],
  ): Promise<Row | null> {
    const result = await this.statement(sql, values).first<Row>();
    return result;
  }

  async readDependencyGeneration(): Promise<number> {
    const row = await this.first<{ generation: unknown }>(
      "SELECT generation FROM website_dependency_generation WHERE id = 1",
    );
    if (
      !row ||
      typeof row.generation !== "number" ||
      !Number.isSafeInteger(row.generation) ||
      row.generation < 0
    ) {
      throw new Error("Website dependency generation is unavailable");
    }
    return row.generation;
  }

  async all<Row>(
    sql: string,
    limit: number,
    values: readonly D1Value[] = [],
  ): Promise<readonly Row[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULT_ROWS) {
      throw new RangeError(
        `D1 result limit must be between 1 and ${MAX_RESULT_ROWS}`,
      );
    }
    const bounded = `SELECT * FROM (${sql}) AS bounded_d1_result LIMIT ?`;
    const result = await this.statement(bounded, [...values, limit]).all<Row>();
    if (!result.success || result.error) throw new Error("D1 read failed");
    const rows = result.results ?? [];
    if (rows.length > limit)
      throw new Error("D1 returned more rows than requested");
    return rows;
  }

  async run(
    sql: string,
    values: readonly D1Value[] = [],
  ): Promise<D1QueryResult> {
    const result = await this.statement(sql, values).run();
    if (!result.success || result.error) throw new Error("D1 statement failed");
    return result;
  }

  /** D1 batch is the atomic boundary; callers must fully prepare every statement first. */
  async batch(
    statements: readonly D1BatchStatement[],
  ): Promise<readonly unknown[]> {
    if (statements.length === 0) throw new Error("D1 batch cannot be empty");
    try {
      return await this.binding.batch([...statements]);
    } catch (cause) {
      throw new Error("D1 atomic batch failed", { cause });
    }
  }

  /**
   * Places the dependency and current-principal assertion before all mutations.
   * The caller supplies the remaining prepared statements and the assertion-row
   * cleanup as the final statement in that same atomic batch.
   */
  guardedBatch(
    generation: number,
    principal: {
      accountId: string;
      identityId: string;
      provider: string;
      kind: string;
      role: string;
    },
    statements: readonly D1BatchStatement[],
  ): Promise<readonly unknown[]> {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new RangeError("Invalid captured dependency generation");
    }
    const assertion = this.prepare(
      `INSERT INTO website_dependency_assertions (id, valid)
       SELECT 1, CASE WHEN g.generation = ? AND EXISTS (
         SELECT 1 FROM identities i JOIN accounts a ON a.id = i.account_id
         WHERE a.id = ? AND i.id = ? AND i.provider = ?
           AND a.kind = ? AND a.role = ? AND a.status = 'active'
           AND i.revoked_at IS NULL
           AND (i.expires_at IS NULL OR i.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ) THEN 1 ELSE 0 END
       FROM website_dependency_generation g WHERE g.id = 1`,
      [
        generation,
        principal.accountId,
        principal.identityId,
        principal.provider,
        principal.kind,
        principal.role,
      ],
    );
    const cleanup = this.prepare(
      "DELETE FROM website_dependency_assertions WHERE id = 1",
    );
    const versionCleanup = this.prepare("DELETE FROM website_write_assertions");
    return this.batch([assertion, ...statements, versionCleanup, cleanup]);
  }

  prepare(sql: string, values: readonly D1Value[] = []): D1BatchStatement {
    return this.statement(sql, values);
  }

  private statement(
    sql: string,
    values: readonly D1Value[],
  ): D1PreparedStatement {
    return this.binding.prepare(sql).bind(...values);
  }
}
