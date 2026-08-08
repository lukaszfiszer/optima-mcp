# 04 — Tool surface

**Scope: one tool.** Everything else is deferred and will be specified individually, immediately before it is built. Designing a tool surface against a schema we haven't introspected yet ([`02`](02-optima-data-model.md) §2.6) would be guesswork — the introspection tool is what makes the rest specifiable.

## Rules for any tool

- `readOnlyHint: true`, `openWorldHint: false`.
- No connect tool, no restore tool. The set of data sources is fixed by configuration, not chosen by the model ([`03`](03-architecture.md) §3.6). Sources may become ready *after* startup ([`08`](08-mcpb-extension.md) §8.6) — the model can see that happening, and can do nothing to change it.
- **Every data-returning tool takes `database?`** naming one source ([`08`](08-mcpb-extension.md) §8.7). Omitted with exactly one ready source → that one. Omitted with several → refuse and list them. Never infer "probably the newest": right shape with the wrong company is the one wrong answer that looks entirely correct.
- Source labels are readable and stable (`CDN_ABC (kopia 2026-07-31)`) — never internal database names, never file paths.
- Findings documents, not table dumps ([`03`](03-architecture.md) §3.8, §3.9).
- Small surface. Models choose well from a short, clearly differentiated menu and badly from a long one.

## v1: `optima_describe_environment`

The database introspection tool. Reports what we are connected to and what we can actually do with it.

No arguments — it reports **all** configured sources. It is also the progress UI for background imports: there is deliberately no second `optima_import_status` tool, because an agent asked "what can you see?" reaches for this one, and a competing status tool would get called instead of it half the time.

Returns:

- **Sources** — one entry per configured source: live connection or imported backup, with filename and backup date, plus import state (`queued`, `importing 43%`, `ready`, `failed <reason>`, `skipped <reason>`). Analysing a three-month-old backup and reporting it as current is a plausible and expensive mistake; so is concluding a company is missing when its import simply hasn't finished.
- **Installation** — Optima version, schema fingerprint, company databases visible, accounting periods with date ranges and open/closed status ([`02`](02-optima-data-model.md) §2.2).
- **Schema resolution** — which knowledge-pack concepts resolved against this schema and which didn't, with confidence levels and the inferred relational graph. Optionally narrowed to one concept. Also exposed as an MCP resource so clients can pull it without a tool call.
- **Posture** — whether the login is appropriately read-only ([`03`](03-architecture.md) §3.7), and in container mode: total disk occupied by imported copies, and how to remove them ([`08`](08-mcpb-extension.md) §8.8).

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
- **Multi-company consolidation** — excluded even though several databases are served at once ([`08`](08-mcpb-extension.md) §8.7). Selecting among sources is not aggregating across them. Comparing two dated backups of the *same* company is a plausible later tool and gets its own specification.
- **Anything that mutates the configured sources** — importing, re-importing, dropping, retargeting. Removal is `optima-mcp clean`, a deliberate user action, not something an agent can be talked into.
