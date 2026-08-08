# optima-mcp

MCP server for Comarch ERP Optima. Connects any MCP-capable agent (Claude, ChatGPT, Cursor, …) to the data in your Optima installation.

**Status: research only, no implementation.** See [`docs/research/`](docs/research/README.md).

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

## Usage (planned)

Runs locally, next to your MCP client, over stdio. Point it at a live Optima database or at a backup file:

```
npx optima-mcp --profile biuro-klient-abc     # existing database
npx optima-mcp --backup ./CDN_ABC.bac         # restore once at startup, then serve
```

## Stack

TypeScript / Node 24, `@modelcontextprotocol/sdk`, `mssql` (Tedious). No native dependencies — `npx optima-mcp`.
