# 04 — Tool surface

**Scope: one tool.** Everything else is deferred and will be specified individually, immediately before it is built. Designing a tool surface against a schema we haven't introspected yet ([`02`](02-optima-data-model.md) §2.6) would be guesswork — the introspection tool is what makes the rest specifiable.

## Rules for any tool

- `readOnlyHint: true`, `openWorldHint: false`.
- No connect tool, no restore tool. The data source is fixed at server startup from CLI arguments ([`03`](03-architecture.md) §3.7).
- Findings documents, not table dumps ([`03`](03-architecture.md) §3.9).
- Small surface. Models choose well from a short, clearly differentiated menu and badly from a long one.

## v1: `optima_describe_environment`

The database introspection tool. Reports what we are connected to and what we can actually do with it.

`profile?` — optional, defaults to the single configured source; only matters when several are configured.

Returns:

- **Source** — live connection or restored backup, with the backup's filename and date. Analysing a three-month-old backup and reporting it as current is a plausible and expensive mistake.
- **Installation** — Optima version, schema fingerprint, company databases visible, accounting periods with date ranges and open/closed status ([`02`](02-optima-data-model.md) §2.2).
- **Schema resolution** — which knowledge-pack concepts resolved against this schema and which didn't, with confidence levels and the inferred relational graph. Optionally narrowed to one concept. Also exposed as an MCP resource so clients can pull it without a tool call.
- **Posture** — whether the login is appropriately read-only ([`03`](03-architecture.md) §3.8).

Two jobs: tell the agent up front what will and won't work rather than letting it discover that through failures, and give us the raw material to build the knowledge pack and specify the accounting tools.

## Deferred

Named only. Each gets its own analysis before development:

- Chart of accounts — *analiza planu kont*
- Zestawienia księgowe — definitions, reconciliation against the chart of accounts, adaptation
- Obroty i salda

## Excluded by design

- **Anything that writes.** ([`01`](01-integration-landscape.md))
- **A generic `run_sql` tool.** Looks attractive, is a trap: makes the model responsible for schema correctness on an undocumented drifting schema ([`02`](02-optima-data-model.md) §2.6), defeats the PII deny-list, produces confidently wrong numbers. If a raw-query escape hatch is ever needed it must be `SELECT`-only, explicitly opt-in, and routed through the same statement gate. The thesis of this design is that curated domain tools beat raw SQL on a schema nobody has documented.
- Trade documents, payroll, CRM, warehouse.
- Multi-company consolidation.
