# Research — optima-mcp

MCP server exposing Comarch ERP Optima data to any AI agent. Read-only, accounting-first.

Research date 2026-08. Claims carry confidence labels; **[unverified]** items must be checked against a real install before code depends on them.

| Doc | Contents |
|---|---|
| [01 — Integration options](01-integration-landscape.md) | Available access paths and why direct read-only SQL is the only viable one; support posture; personal-data constraint; feasibility |
| [02 — Optima data model](02-optima-data-model.md) | Topology, period scoping, naming conventions, accounting table seed map, zestawienia formula language, the undocumented-schema problem, backup ingestion |
| [03 — Architecture](03-architecture.md) | Layers, vendor neutrality, TypeScript stack, decimal hazard, connection model, read-only enforcement, output contract, context economy |
| [04 — Tool surface](04-tool-surface.md) | Nine v1 tools; what's excluded and why |
| [05 — Roadmap](05-roadmap-and-open-questions.md) | Four blocking spikes, phases, risks, decisions needed |

## Summary

**Feasible.** Optima ships no public REST API by policy, but does ship its own admin SQL console — Comarch already expects power users to read the DB directly. Direct read-only SQL is the only licence-free, vendor-neutral path.

**The hard part is the schema, not MCP.** Optima's DB is undocumented and drifts across releases; research couldn't even settle the column prefix on `CDN.Konta`, and the zestawienia table names are unknown. So: introspect the connected DB at runtime and resolve a curated, versioned knowledge pack against it. Never hardcode. That knowledge pack is the IP; the protocol plumbing is a weekend.

**Accounting is the right v1** — aggregate, low-PII, small enough to reason about, read-only by nature.

**Flagship is statement reconciliation.** Expand every mask in every zestawienie position against the actual chart of accounts, build the coverage matrix, surface uncovered accounts, double-counting, dangling references and function/type mismatches, ranked by PLN. Diagnoses "bilans się nie bilansuje" in seconds — currently done by hand, position by position.

**Stack:** TypeScript on Node 24, `@modelcontextprotocol/sdk`, `mssql`/Tedious (pure JS, no native deps), `decimal.js` for money, built-in `node:sqlite` for cache. `npx optima-mcp` with zero system prerequisites.

**Four spikes block detailed design** ([05](05-roadmap-and-open-questions.md) §5.1), all needing the same thing: access to one real Optima DB with Księga Handlowa data. That's the critical path.
