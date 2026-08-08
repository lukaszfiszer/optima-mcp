/**
 * Connection resolution.
 *
 * The data source is a single connection string, fixed before the server starts
 * serving MCP (03 §3.6): no connect tool, and the string never reaches the model
 * context — only the derived server/database labels do.
 */

export class ConfigError extends Error {}

/**
 * Takes the connection string from a positional argument, `--connection-string`,
 * or `OPTIMA_CONNECTION_STRING`, in that order.
 */
export function resolveConnectionString(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  let fromArgs: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--connection-string') {
      const next = argv[i + 1];
      if (next === undefined) throw new ConfigError('--connection-string needs a value');
      fromArgs = next;
      i++;
    } else if (arg.startsWith('--connection-string=')) {
      fromArgs = arg.slice('--connection-string='.length);
    } else if (arg.startsWith('--')) {
      throw new ConfigError(`Unknown flag: ${arg}`);
    } else if (fromArgs === undefined) {
      fromArgs = arg;
    } else {
      throw new ConfigError(`Unexpected argument: ${arg}`);
    }
  }

  const connectionString = fromArgs ?? env['OPTIMA_CONNECTION_STRING'];
  if (!connectionString || connectionString.trim().length === 0) {
    throw new ConfigError(
      'No connection string. Pass one as an argument or set OPTIMA_CONNECTION_STRING.',
    );
  }
  return connectionString.trim();
}

/**
 * Server and database for logs and tool output. Best-effort parse of both
 * accepted forms — the authoritative values come from the database itself
 * once connected, this is only for the startup line.
 */
export function describeTarget(connectionString: string): string {
  const url = /^mssql:\/\/[^@]*@([^/?]+)\/?([^?]*)/i.exec(connectionString);
  if (url) return `${url[1]}${url[2] ? ` / ${url[2]}` : ''}`;

  const field = (name: string): string | undefined =>
    new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*([^;]*)`, 'i').exec(connectionString)?.[1]?.trim();

  const server = field('server') ?? field('data source') ?? '?';
  const database = field('database') ?? field('initial catalog') ?? '?';
  return `${server} / ${database}`;
}

export const USAGE = `optima-mcp — read-only MCP server over a Comarch ERP Optima company database

Usage:
  optima-mcp "<connection string>"
  OPTIMA_CONNECTION_STRING="<connection string>" optima-mcp

Both connection-string forms accepted by node-mssql work:

  Server=localhost\\OPTIMA;Database=CDN_ABC;User Id=optima_ro;Password=secret;Encrypt=true
  mssql://optima_ro:secret@localhost:1433/CDN_ABC?encrypt=true

Add TrustServerCertificate=true for an on-prem instance with a self-signed
certificate.

The server speaks MCP over stdio. Use a login with db_datareader and nothing
more — that is what enforces read-only access.
`;
