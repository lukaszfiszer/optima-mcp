# optima-mcp

MCP server for Comarch ERP Optima. Connects any MCP-capable agent (Claude, ChatGPT, Cursor, …) to the data in your Optima installation.

**Status: Phase 1 skeleton.** One tool, `optima_describe_environment`, over a live connection. See [`docs/research/`](docs/research/README.md) for the design.

## Why

Optima ships no public REST API. Getting at your own accounting data programmatically today means commercial middleware, Windows COM automation, or hand-written SQL. This makes the database queryable by an agent — read-only, and without tying you to one AI vendor.

## Principles

- **Read-only.** Never writes. Where a change is the answer, it gives you the steps to take inside Optima.
- **Agent-agnostic.** Plain MCP over stdio and streamable HTTP, no vendor extensions.
- **Domain tools, not raw SQL.** Curated tools returning findings, not a query console that makes the model guess at an undocumented schema.
- **Data stays yours.** Aggregate by default, personal data denied by default, credentials never enter the model context.

## Scope (v1)

Księgowość kontowa:

- **Analiza planu kont** — structural audit of the chart of accounts
- **Zestawienia księgowe** — reconcile statement definitions against the actual chart of accounts; find the accounts your balance sheet is silently missing
- **Obroty i salda**

More domains later.

## Running it (development)

Not published to npm yet — run it from a build of this repo. Speaks stdio, so on its own it just waits for a client; see [Adding it to Claude](#adding-it-to-claude) for the useful form.

```
npm install && npm run build
node dist/index.js "$CS"          # or: OPTIMA_CONNECTION_STRING="$CS" node dist/index.js
```

`$CS` is the whole configuration. Two forms, both standard for their ecosystem:

| Form | Example |
|---|---|
| ADO.NET keywords — preferred | `Server=localhost\OPTIMA;Database=CDN_ABC;User Id=optima_ro;Password=…;Encrypt=true` |
| URI — node-mssql convention | `mssql://optima_ro:…@localhost:1433/CDN_ABC?encrypt=true` |

Add `TrustServerCertificate=true` for a self-signed certificate. The URI form needs the password percent-encoded (`!` → `%21`), which is why the keyword form is preferred.

Supply a login with `db_datareader` and nothing more — that is the control that actually enforces read-only access. The server reports the login's roles in every environment report, so an over-privileged login shows up as a caveat rather than silently.

The connection is fixed at startup — there is no connect tool, and no connection string ever reaches the model. Startup failures are loud and terminal; every statement is logged to stderr as an audit line.

## Adding it to Claude

### Claude Code

```bash
claude mcp add optima \
  --env OPTIMA_CONNECTION_STRING="Server=localhost\OPTIMA;Database=CDN_ABC;User Id=optima_ro;Password=…;Encrypt=true" \
  -- node /path/to/optima-mcp/dist/index.js
```

`--scope user` makes it available in every project; the default is this project only. Check it with `claude mcp list`, remove it with `claude mcp remove optima`.

### Claude Desktop

Edit `claude_desktop_config.json` — *Settings → Developer → Edit Config*, or directly at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "optima": {
      "command": "node",
      "args": ["/path/to/optima-mcp/dist/index.js"],
      "env": {
        "OPTIMA_CONNECTION_STRING": "Server=localhost\\OPTIMA;Database=CDN_ABC;User Id=optima_ro;Password=…;Encrypt=true"
      }
    }
  }
}
```

Backslashes are escaped (`\\`) in JSON, so a named instance reads `localhost\\OPTIMA`. Use absolute paths — the client does not run the command from this directory. Restart Claude Desktop after editing.

### Checking it works

Ask Claude *"opisz środowisko Optima"*, or call `optima_describe_environment` directly. A healthy answer names your company and its accounting periods. If the server can't connect it exits at startup, so it shows up as a failed server in the client rather than as a broken tool call — the reason is on stderr, in the client's MCP log.

## Tools

### `optima_describe_environment`

Reports what we are connected to and what works against it: the data source (live database vs restored backup, with the restore date), the company from its pieczątka (name, NIP, REGON, address), accounting periods with open/closed status, chart-of-accounts size, which schema concepts resolved, and whether the login is genuinely read-only.

### Not yet implemented

Backup ingestion (`--backup`), named connection profiles, and the accounting tools — see [`05`](docs/research/05-roadmap-and-open-questions.md).

## Stack

TypeScript / Node 22+, `@modelcontextprotocol/sdk`, `mssql` (Tedious). No native dependencies.
