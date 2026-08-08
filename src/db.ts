/**
 * SQL gateway. Every query in the process goes through `query()`.
 *
 * All SQL is generated in this repo from literal, hardcoded text — never from
 * model output — so the statement gate here is a backstop, not the primary
 * control. The primary control is a `db_datareader`-only login (03 §3.7).
 */
import sql from 'mssql';

/** Per-query timeout. Long enough for an aggregate, short enough to fail fast. */
export const QUERY_TIMEOUT_MS = 30_000;

/** Hard row cap on any single result set (03 §3.9). */
export const ROW_CAP = 1_000;

export class SqlGatewayError extends Error {}

/** Rejects anything that is not a single read-only statement. */
export function assertReadOnly(statement: string): void {
  const stripped = statement
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();

  if (!/^(select|with)\b/i.test(stripped)) {
    throw new SqlGatewayError('Only SELECT statements are permitted');
  }
  const forbidden =
    /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|exec|execute|sp_executesql|backup|restore)\b/i;
  const match = forbidden.exec(stripped);
  if (match) {
    throw new SqlGatewayError(`Statement contains a forbidden keyword: ${match[1]!.toUpperCase()}`);
  }
  if (/\binto\b/i.test(stripped)) {
    throw new SqlGatewayError('SELECT ... INTO is not permitted');
  }
  // One statement only. A trailing semicolon is fine; an interior one is not.
  if (stripped.replace(/;\s*$/, '').includes(';')) {
    throw new SqlGatewayError('Multi-statement batches are not permitted');
  }
}

export interface QueryResult<T> {
  rows: T[];
  /** True when the row cap kicked in — never silently drop rows (03 §3.9). */
  truncated: boolean;
}

/**
 * node-mssql parses the ADO form (`Server=…;Database=…`) itself, but hands back
 * an empty config for the `mssql://` URL form, which then fails deep inside
 * connect with an unhelpful message. So we handle URLs here and pass the ADO
 * form straight through.
 */
export function parseConnectionString(connectionString: string): string | sql.config {
  if (!/^mssql:\/\//i.test(connectionString)) return connectionString;

  const url = new URL(connectionString);
  const flag = (name: string): boolean | undefined => {
    const value = url.searchParams.get(name);
    return value === null ? undefined : ['1', 'true', 'yes'].includes(value.toLowerCase());
  };

  return {
    server: decodeURIComponent(url.hostname),
    port: url.port ? Number.parseInt(url.port, 10) : undefined,
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || undefined,
    user: decodeURIComponent(url.username) || undefined,
    password: decodeURIComponent(url.password) || undefined,
    options: {
      encrypt: flag('encrypt') ?? true,
      trustServerCertificate: flag('trustServerCertificate') ?? false,
      instanceName: url.searchParams.get('instanceName') ?? undefined,
    },
  };
}

export class Db {
  private constructor(
    private readonly pool: sql.ConnectionPool,
    /** Database name, used to label audit lines and tool output. */
    readonly label: string,
  ) {}

  static async connect(connectionString: string): Promise<Db> {
    // The constructor parses the string into `config`, which @types/mssql does
    // not expose. We read it back for the database label and override only the
    // operational settings we own — server, auth and encryption stay the
    // caller's, exactly as they wrote them.
    const pool = new sql.ConnectionPool(parseConnectionString(connectionString)) as sql.ConnectionPool & {
      config: sql.config;
    };

    pool.config.requestTimeout = QUERY_TIMEOUT_MS;
    pool.config.options = {
      ...pool.config.options,
      // Read dates as UTC so a `datetime` column (which carries no zone)
      // formats back to the same calendar day the accountant sees in Optima,
      // regardless of the machine's timezone.
      useUTC: true,
    };
    pool.config.pool = { ...pool.config.pool, min: 0, max: 4, idleTimeoutMillis: 30_000 };

    await pool.connect();
    return new Db(pool, pool.config.database ?? 'optima');
  }

  /** Runs a single read-only statement under the row cap and timeout. */
  async query<T = Record<string, unknown>>(
    statement: string,
    params: Record<string, string | number> = {},
  ): Promise<QueryResult<T>> {
    assertReadOnly(statement);

    const request = this.pool.request();
    for (const [key, value] of Object.entries(params)) request.input(key, value);

    const started = Date.now();
    const result = await request.query<T>(statement);
    const all = result.recordset ?? [];
    const truncated = all.length > ROW_CAP;
    const rows = truncated ? all.slice(0, ROW_CAP) : all;

    audit(this.label, statement, rows.length, Date.now() - started);
    return { rows: rows as T[], truncated };
  }

  /** Convenience for single-row lookups. */
  async queryOne<T = Record<string, unknown>>(
    statement: string,
    params: Record<string, string | number> = {},
  ): Promise<T | undefined> {
    const { rows } = await this.query<T>(statement, params);
    return rows[0];
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}

/**
 * Audit log. stderr for now — a customer's auditor will ask what this thing
 * did to the books, and stdio clients capture stderr to a log file.
 */
function audit(database: string, statement: string, rows: number, ms: number): void {
  const entry = {
    ts: new Date().toISOString(),
    database,
    rows,
    ms,
    sql: statement.replace(/\s+/g, ' ').trim(),
  };
  process.stderr.write(`[optima-mcp:audit] ${JSON.stringify(entry)}\n`);
}
