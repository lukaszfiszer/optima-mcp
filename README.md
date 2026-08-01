# optima-mcp

An **MCP server for Comarch ERP Optima** — connect the AI agent of your choice
(Claude, ChatGPT, Cursor, or anything else that speaks MCP) to the data in your
Optima installation.

> **Status: research / technical discovery.** No implementation yet. See
> [`docs/research/`](docs/research/README.md).

## Why

Comarch ERP Optima ships no public REST API. Getting at your own accounting data
programmatically today means commercial middleware, Windows COM automation, or
hand-written SQL. This project makes the database queryable by an AI agent —
safely, read-only, and without tying you to a single AI vendor.

## Principles

- **Read-only, always.** The server never writes to your database. Where a
  change is the answer, it tells you the steps to take inside Optima.
- **Agent-agnostic.** Plain MCP over stdio and streamable HTTP. No
  vendor-specific extensions.
- **Domain tools, not raw SQL.** Curated accounting tools that return
  *findings* — not a query console that makes the model guess at an
  undocumented schema.
- **Your data stays yours.** Aggregate by default, personal data denied by
  default, credentials never enter the model's context.

## Scope (v1)

Accounting — *księgowość kontowa*:

- **Analiza planu kont** — structural audit of the chart of accounts
- **Zestawienia księgowe** — reconcile statement definitions against the actual
  chart of accounts; find the accounts your balance sheet is silently missing
- **Obroty i salda** — turnovers and balances

More domains later.

## Documentation

- [Research & technical discovery](docs/research/README.md)
