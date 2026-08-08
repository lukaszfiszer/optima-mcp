#!/usr/bin/env node
/**
 * CLI entry point. The connection is resolved and opened before a single MCP
 * message is served — startup failures are loud and terminal (03 §3.6).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, USAGE, describeTarget, resolveConnectionString } from './config.js';
import { Db } from './db.js';
import { createServer } from './mcp/server.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }

  const connectionString = resolveConnectionString(argv);

  // Never log the connection string itself — it carries the password.
  log(`łączenie: ${describeTarget(connectionString)}`);
  const db = await Db.connect(connectionString);
  log(`połączono z bazą "${db.label}"`);

  const server = createServer(db);
  await server.connect(new StdioServerTransport());
  log('serwer MCP gotowy (stdio)');

  const shutdown = async () => {
    await server.close().catch(() => {});
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function log(message: string): void {
  process.stderr.write(`[optima-mcp] ${message}\n`);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`[optima-mcp] ${error.message}\n\n${USAGE}`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[optima-mcp] uruchomienie nieudane: ${message}\n`);
  }
  process.exit(1);
});
