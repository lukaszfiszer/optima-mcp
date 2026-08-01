# Research & technical discovery — optima-mcp

High-level research for an **MCP server exposing Comarch ERP Optima data to any
AI agent**, read-only, accounting-first.

Conducted 2026-08. Every claim carries a confidence label; anything marked
**[unverified]** is a working hypothesis that must be validated against a real
installation before code depends on it.

| Doc | Contents |
|---|---|
| [01 — Integration landscape & feasibility](01-integration-landscape.md) | Why Optima has no usable API and direct read-only SQL is the only viable substrate; the support/warranty posture and the RODO/GDPR constraint that shape the whole architecture; feasibility verdict |
| [02 — Optima data model](02-optima-data-model.md) | Database topology, period scoping, naming conventions, accounting table seed map, the *zestawienia księgowe* formula language, the undocumented-schema problem and the introspect-first answer, backup ingestion |
| [03 — Proposed architecture](03-architecture.md) | Layered design, vendor neutrality, stack recommendation, connection model, five-layer read-only enforcement, output contract, context economy |
| [04 — Tool surface (v1)](04-tool-surface.md) | Nine proposed tools, with the statement-reconciliation flagship; and what is deliberately excluded |
| [05 — Roadmap & open questions](05-roadmap-and-open-questions.md) | Phasing, the four blocking spikes, risk register, decisions needed from the project owner |

## The short version

**Feasible.** Optima ships no public REST API by deliberate policy, but it does
ship its own SQL console — Comarch already expects power users to read the
database directly. Read-only SQL is therefore the only licence-free,
vendor-neutral, agent-friendly access path, and it is a sanctioned one.

**The hard part is not MCP — it's the schema.** Optima's database is
undocumented and drifts across releases. The architecture must **introspect the
connected database at runtime and resolve a curated, versioned knowledge pack
against it**, never hardcode a column name. That knowledge pack, not the
protocol plumbing, is the real intellectual property of this project.

**The accounting wedge is the right v1** — the data is aggregate and low-PII,
it is small enough to reason about, and it is read-only by nature.

**The flagship tool is statement reconciliation.** Expand every mask in every
*zestawienie księgowe* position against the actual chart of accounts, build the
coverage matrix, and surface uncovered accounts, double-counting, dangling
references and function/type mismatches — ranked by PLN impact. This diagnoses
"bilans się nie bilansuje" in seconds, a problem currently solved by hand,
position by position.

**Four spikes block detailed design** (see [05](05-roadmap-and-open-questions.md)
§5.1) and all four need the same thing: **access to one real Optima database
with Księga Handlowa data.** That access is the project's critical path.
