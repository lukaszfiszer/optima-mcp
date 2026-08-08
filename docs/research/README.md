# Research — optima-mcp

MCP server exposing Comarch ERP Optima data to any AI agent. Read-only, accounting-first.

Research date 2026-08. Claims carry confidence labels; **[unverified]** items must be checked against a real install before code depends on them.

| Doc | Contents |
|---|---|
| [01 — Integration options](01-integration-landscape.md) | Available access paths and why direct read-only SQL is the only viable one; support posture; personal-data constraint; feasibility |
| [02 — Optima data model](02-optima-data-model.md) | Topology, period scoping, naming conventions, accounting table seed map, zestawienia formula language, the undocumented-schema problem, backup ingestion |
| [03 — Architecture](03-architecture.md) | NFRs (incl. REST extensibility), layered core + adapters, MCP transports, TypeScript stack, safety, output/context |
| [04 — Tool surface](04-tool-surface.md) | The one v1 tool (database introspection); rules for the rest; what's excluded by design |
| [05 — Roadmap](05-roadmap-and-open-questions.md) | Four blocking spikes, phases, risks, decisions needed |
| [06 — Backup ingestion setup](06-backup-ingestion-setup.md) | Why the auth-page idea doesn't work, the CLI entry point, startup state machine, on-disk state, failure messages |

## Summary

**Feasible.** Optima ships no public REST API by policy, but does ship its own admin SQL console — Comarch already expects power users to read the DB directly. Direct read-only SQL is the only licence-free, vendor-neutral path.

**The hard part is the schema, not MCP.** Optima's DB is undocumented and drifts across releases; research couldn't even settle the column prefix on `CDN.Konta`, and the zestawienia table names are unknown. So: introspect the connected DB at runtime and resolve a curated, versioned knowledge pack against it. Never hardcode. That knowledge pack is the IP; the protocol plumbing is a weekend.

**Accounting is the right v1** — aggregate, low-PII, small enough to reason about, read-only by nature.

**Flagship capability is statement reconciliation** ([02](02-optima-data-model.md) §2.5): expand every mask in every zestawienie position against the actual chart of accounts, build the coverage matrix, surface uncovered accounts, double-counting, dangling references and function/type mismatches, ranked by PLN. Diagnoses "bilans się nie bilansuje" in seconds — currently done by hand, position by position. Not yet specified as a tool: the schema it depends on is unknown until the spikes run.

**Tool surface is one tool for now** — database introspection ([04](04-tool-surface.md)). The accounting tools get specified individually, each immediately before it's built.

**Stack:** TypeScript on Node 24, `@modelcontextprotocol/sdk`, `mssql`/Tedious (pure JS, no native deps), `decimal.js` for money, built-in `node:sqlite` for cache. `npx optima-mcp` with zero system prerequisites.

**Local desktop, stdio.** Credential never leaves the machine; we never become a data processor for a DB full of payroll. Data source is fixed at startup — either a live connection or a backup restored once at launch:

```
npx optima-mcp --profile biuro-klient-abc
npx optima-mcp --backup ./CDN_ABC.bac
```

No open-source engine can restore a `.bak` (Babelfish is protocol-compatible, not storage-compatible; OrcaMDF is abandoned). Restore target defaults to the SQL Server the user already runs Optima on; free fallback is Express 2025, whose database cap rose from 10 GB to 50 GB.

**Four spikes block detailed design** ([05](05-roadmap-and-open-questions.md) §5.1), all needing the same thing: access to one real Optima DB with Księga Handlowa data. That's the critical path.
