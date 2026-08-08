# Research — optima-mcp

MCP server exposing Comarch ERP Optima data to any AI agent. Read-only, accounting-first.

Research date 2026-08. Claims carry confidence labels; **[unverified]** items must be checked against a real install before code depends on them.

| Doc | Contents |
|---|---|
| [01 — Integration options](01-integration-landscape.md) | Available access paths and why direct read-only SQL is the only viable one; support posture; personal-data constraint; feasibility |
| [02 — Optima data model](02-optima-data-model.md) | Topology, period scoping, naming conventions, accounting table seed map, zestawienia formula language, the undocumented-schema problem, backup ingestion |
| [03 — Architecture](03-architecture.md) | Layers, local-first deployment, TypeScript stack, decimal hazard, CLI and startup, read-only enforcement, output contract, context economy |
| [04 — Tool surface](04-tool-surface.md) | The one v1 tool (database introspection); rules for the rest; what's excluded by design |
| [05 — Roadmap](05-roadmap-and-open-questions.md) | Four blocking spikes, phases, risks, decisions needed |
| [06 — Backup ingestion setup](06-backup-ingestion-setup.md) | Why a browser page can't pick the backup and a native picker must, entry points, why the restore is preflighted, on-disk state |
| [07 — Spike 0 findings](07-spike-0-findings.md) | Empirical run against a real backup: `.bac` is a renamed `.bak`, real schema, `Acc_*` settled, zestawienia tables found, definitions are readable text |
| [08 — MCPB extension](08-mcpb-extension.md) | **Current deliverable.** Config UI (folder of backups \| SQL server URL), managed SQL Server container, scan/fingerprint/background import, multi-database tool surface, packaging, failure messages, diagnostic logging |

## Summary

**Feasible.** Optima ships no public REST API by policy, but does ship its own admin SQL console — Comarch already expects power users to read the DB directly. Direct read-only SQL is the only licence-free, vendor-neutral path.

**The hard part is the schema, not MCP.** Optima's DB is undocumented and drifts across releases; research couldn't even settle the column prefix on `CDN.Konta`, and the zestawienia table names are unknown. So: introspect the connected DB at runtime and resolve a curated, versioned knowledge pack against it. Never hardcode. That knowledge pack is the IP; the protocol plumbing is a weekend.

**Accounting is the right v1** — aggregate, low-PII, small enough to reason about, read-only by nature.

**Flagship capability is statement reconciliation** ([02](02-optima-data-model.md) §2.5): expand every mask in every zestawienie position against the actual chart of accounts, build the coverage matrix, surface uncovered accounts, double-counting, dangling references and function/type mismatches, ranked by PLN. Diagnoses "bilans się nie bilansuje" in seconds — currently done by hand, position by position. Not yet specified as a tool: the schema it depends on is unknown until the spikes run.

**Tool surface is one tool for now** — database introspection ([04](04-tool-surface.md)). The accounting tools get specified individually, each immediately before it's built.

**Stack:** TypeScript on Node, `@modelcontextprotocol/sdk`, `mssql`/Tedious (pure JS, no native deps), `decimal.js` for money, `node:sqlite` for cache where the host runtime offers it, JSON for the import registry where it doesn't. Distribution is an `.mcpb` bundle; `npx optima-mcp` for development, with zero system prerequisites in live mode.

**Local desktop, stdio.** Credential never leaves the machine; we never become a data processor for a DB full of payroll. The set of data sources is fixed by configuration, never chosen by the model — two mutually exclusive modes ([08](08-mcpb-extension.md)):

```
a folder (or several) of .bac / .bak files   → managed SQL Server container, N databases
a SQL Server URL                             → live read-only connection
```

No open-source engine can restore a `.bak` (Babelfish is protocol-compatible, not storage-compatible; OrcaMDF is abandoned), so the target is Microsoft SQL Server — by default an **Express container we manage**, free for production use and capped at 50 GB; the user's own instance is the escape hatch above that.

**The install is an MCPB bundle** — the user picks a folder in a native dialog and never opens a terminal or edits JSON. Three things follow from that ([08](08-mcpb-extension.md)): a directory means several company databases served at once, several multi-GB restores can't fit in a startup timeout so the import runs behind the serving boundary with reported progress, and a container runtime becomes a hard dependency of the backup mode. A fourth follows from the user having no terminal: the extension keeps its own rotating log file, with a startup banner naming the runtime, the resolved `docker`, and the mode, because that is the only way to debug an install on a machine we can't see ([08](08-mcpb-extension.md) §8.12).

The host runs a bundled `type: "node"` server in an Electron `utilityProcess` on its own embedded Node, so `compatibility.runtimes.node` is declared with a floor that built-in clears — a higher one makes the host fall back to a system Node instead ([08](08-mcpb-extension.md) §8.9, §8.13).

**Status:** Phase 1 skeleton delivered (live connection, `optima_describe_environment`). Phase 2 is the extension. Spikes S1–S4 are answered empirically ([07](07-spike-0-findings.md)); the mask-wildcard alphabet is the one open spike and needs a second real DB whose zestawienia actually use masks.
