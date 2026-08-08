/**
 * MCP protocol adapter. Thin by design (03 §3.3): parse input, call the
 * domain layer, serialize output. No business logic lives here.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { describeEnvironment } from '../domain/environment.js';
import { formatEnvironment } from './format.js';

export function createServer(db: Db): McpServer {
  const server = new McpServer(
    { name: 'optima-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'optima_describe_environment',
    {
      title: 'Opisz środowisko Optima',
      description:
        'Zwraca informacje o podłączonej bazie danych Comarch ERP Optima: źródło danych ' +
        '(baza produkcyjna czy odtworzona kopia), dane firmy z pieczątki (nazwa, NIP, REGON, adres), ' +
        'okresy obrachunkowe wraz ze statusem, oraz które obiekty schematu udało się rozpoznać. ' +
        'Wywołaj to jako pierwsze, przed jakąkolwiek analizą księgową.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const environment = await describeEnvironment(db);
      return {
        content: [{ type: 'text' as const, text: formatEnvironment(environment) }],
        structuredContent: environment as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}
