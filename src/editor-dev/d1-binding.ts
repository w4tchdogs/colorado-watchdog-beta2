import type {
  D1Binding,
  D1PreparedStatement,
  D1QueryResult,
  D1Value,
} from "../database/d1.js";
import type { WebsiteDatabase } from "../database/sqlite.js";

/**
 * Local D1 binding over the sandbox's synchronous SQL.js database. It exists
 * only so the merged D1-backed banner administration service can run in the
 * disposable local preview with the same guarded-batch semantics it uses
 * against real D1. It is never imported by the application or the Worker.
 */
class LocalStatement implements D1PreparedStatement {
  constructor(
    private readonly database: WebsiteDatabase,
    private readonly sql: string,
    private readonly values: D1Value[] = [],
  ) {}

  bind(...values: D1Value[]): D1PreparedStatement {
    return new LocalStatement(this.database, this.sql, values);
  }

  /** sql.js refuses ArrayBuffer; only primitives and typed arrays bind. */
  private normalized(): (string | number | null | Uint8Array)[] {
    return this.values.map((value) =>
      value instanceof ArrayBuffer ? new Uint8Array(value) : value,
    );
  }

  private statement() {
    return this.database.prepare(this.sql);
  }

  first<Row = Record<string, unknown>>(column?: string): Promise<Row | null> {
    const row = this.statement().get(...this.normalized());
    if (row === undefined) return Promise.resolve(null);
    if (column === undefined) return Promise.resolve(row as Row);
    const value = (row as Record<string, unknown>)[column];
    return Promise.resolve((value === undefined ? null : value) as Row | null);
  }

  all<Row = Record<string, unknown>>(): Promise<D1QueryResult<Row>> {
    const rows = this.statement().all(...this.normalized());
    return Promise.resolve({
      results: rows as Row[],
      success: true,
      meta: { changes: rows.length },
    });
  }

  run(): Promise<D1QueryResult> {
    this.statement().run(...this.normalized());
    const change = this.database.prepare("SELECT changes() AS changes").get() as
      | { changes: number }
      | undefined;
    return Promise.resolve({
      results: [],
      success: true,
      meta: { changes: change?.changes ?? 0 },
    });
  }
}

export function createLocalD1Binding(database: WebsiteDatabase): D1Binding {
  return {
    prepare(sql: string): D1PreparedStatement {
      return new LocalStatement(database, sql);
    },
    batch<T>(statements: D1PreparedStatement[]): Promise<T[]> {
      // One atomic transaction, like a D1 batch. A failure rolls everything back.
      return Promise.resolve(
        database.transaction(() =>
          statements.map(
            (statement) => (statement as LocalStatement).all() as T,
          ),
        )(),
      );
    },
  };
}
