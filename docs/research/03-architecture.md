# 03 — Proposed architecture

## 3.1 Shape of the system

```
┌─────────────────────────────────────────────────────────┐
│  Any MCP client: Claude Desktop/Code, ChatGPT, Cursor,  │
│  Continue, LibreChat, custom agent…                     │
└───────────────────────────┬─────────────────────────────┘
                            │  MCP (stdio | streamable HTTP)
┌───────────────────────────┴─────────────────────────────┐
│  optima-mcp                                             │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Tool layer — accounting domain tools              │  │
│  │  chart-of-accounts / statements / balances / diff │  │
│  └───────────────────┬───────────────────────────────┘  │
│  ┌───────────────────┴───────────────────────────────┐  │
│  │ Analysis engine                                   │  │
│  │  mask expansion · coverage matrix · rule checks   │  │
│  │  materiality ranking · finding model              │  │
│  └───────────────────┬───────────────────────────────┘  │
│  ┌───────────────────┴───────────────────────────────┐  │
│  │ Semantic layer                                    │  │
│  │  knowledge pack (YAML) → resolved against actual  │  │
│  │  schema · concept registry · capability report    │  │
│  └───────────────────┬───────────────────────────────┘  │
│  ┌───────────────────┴───────────────────────────────┐  │
│  │ Schema catalog — introspection + fingerprint      │  │
│  │  + local cache (SQLite)                           │  │
│  └───────────────────┬───────────────────────────────┘  │
│  ┌───────────────────┴───────────────────────────────┐  │
│  │ Safe SQL gateway                                  │  │
│  │  read-only enforcement · parameterisation ·       │  │
│  │  timeouts · row caps · PII deny-list · audit log  │  │
│  └───────────────────┬───────────────────────────────┘  │
└──────────────────────┼──────────────────────────────────┘
                       │ TDS, read-only login
        ┌──────────────┴──────────────┐
        │                             │
  live SQL Server            ephemeral SQL Server
  (customer's Optima)        (restored .bak/.bac)
                             ── optional workbench ──
```

**The layering is the point.** Each layer has one job and can be tested in
isolation: the gateway is where safety lives, the catalog is where version
drift is absorbed, the semantic layer is where Optima knowledge lives, and the
tool layer is a thin, well-described surface for the LLM.

## 3.2 Vendor neutrality

The brief requires agent-agnosticism. Concretely that means:

- **Plain MCP, no client-specific extensions.** Target the current spec
  revision (2025-06-18 at minimum; verify the latest at build time), and
  negotiate down rather than requiring the newest.
- **Both transports.** `stdio` for desktop clients (Claude Desktop, Cursor,
  Continue) and **streamable HTTP** for hosted/remote agents and ChatGPT-style
  connectors. Same tool surface, one code path, transport chosen by config.
- **No sampling / no elicitation in the core path.** Both are optional protocol
  features with uneven client support; a tool that *requires* them silently
  breaks on half the ecosystem. Use them only for genuinely optional UX
  enhancements, with a working fallback.
- **`readOnlyHint: true` and `openWorldHint: false`** on every tool. These are
  UX/trust hints, not enforcement — real enforcement is in the gateway (§3.5) —
  but they let clients present the server honestly and reduce approval friction.
- **Output is text/Markdown, not a bespoke JSON dialect.** Structured content
  can be attached where the spec supports it, but the primary payload must be
  readable by any model without a schema it has to be taught.
- **No prompt injection of vendor names.** Tool descriptions must be neutral
  and model-agnostic.

## 3.3 Recommended stack

| Concern | Recommendation | Why |
|---|---|---|
| Language | **Python 3.12+** | Best fit for the analysis-heavy core (mask expansion, coverage matrices, rule engines); the official `mcp` SDK / FastMCP is mature; `sqlglot` gives us a real SQL parser for the read-only gate; easiest for accounting-domain contributors to read. TypeScript is the credible alternative if the team's centre of gravity is JS — the architecture is unchanged. |
| MCP framework | **official `mcp` SDK (FastMCP)** | Handles both transports, tool annotations, lifecycle. Avoid hand-rolling the protocol. |
| DB driver | **`pyodbc` + msodbcsql18**, `pymssql` fallback | pyodbc has the best fidelity for `DATETIME2`/`DECIMAL`/collation handling that accounting data demands; pymssql (FreeTDS) is the no-system-driver escape hatch. |
| SQL parsing/validation | **`sqlglot`** (T-SQL dialect) | Needed to *prove* a statement is read-only rather than regex-guessing. |
| Local cache | **SQLite** | Schema catalog + resolved knowledge pack + chart-of-accounts snapshots, keyed by schema fingerprint. Keeps repeat analysis fast and token-cheap. |
| Knowledge pack | **YAML**, versioned in-repo | Human-curatable, diffable, reviewable by accounting people who don't write Python. |
| Backup workbench | **Docker Compose + `mcr.microsoft.com/mssql/server`** | Optional, separate from the server (see [`02`](02-optima-data-model.md) §2.7). |
| Packaging | `uvx` / `pipx` one-liner + Docker image | Install friction is the #1 killer of MCP server adoption. `uvx optima-mcp` must just work. |

## 3.4 Connection model

```
connection profile:
  name           "biuro-klient-abc"
  server         host,port | named instance
  auth           SQL login (read-only) | Windows/Kerberos | Entra ID
  company_db     CDN_ABC
  config_db      CDN_KNF_Konfiguracja        (optional)
  encrypt        yes (default; TrustServerCertificate opt-in for on-prem)
```

Profiles are configured **out of band** — env vars, a config file, or a secrets
manager — and referenced by name from tools. **Connection strings never travel
through the model context.** An agent asks for `profile="biuro-klient-abc"`, not
for a host and password. This is both a security property and a usability one:
the LLM cannot leak a credential it has never seen.

## 3.5 Read-only enforcement — defence in depth

No single mechanism is trusted. All five apply:

1. **Database permissions.** The documented, recommended, and *only actually
   sufficient* control: a login granted `db_datareader` (further restricted by
   `DENY SELECT` on the personal-data tables) and nothing else. The install
   docs must ship the exact `CREATE LOGIN` / `CREATE USER` / `GRANT` script,
   and the server should warn loudly when it detects it is connected as
   something more privileged.
2. **Connection-level.** `ApplicationIntent=ReadOnly` where a readable
   secondary exists; `READ COMMITTED SNAPSHOT` or explicit `WITH (NOLOCK)`
   discipline so we never block a live accounting system. **Blocking the
   customer's month-end close is the fastest way to get uninstalled.**
3. **Statement gate.** Every statement is parsed with `sqlglot` and rejected
   unless it is a single `SELECT`/CTE — no DML, no DDL, no `EXEC`, no
   `sp_executesql`, no multi-statement batches, no `INTO`. Parser-based, not
   regex-based.
4. **Resource limits.** Per-query timeout, row cap, result-size cap, and a
   concurrency limit. An LLM will eventually ask for `SELECT * FROM
   CDN.Dekrety`; the server must decline gracefully and suggest an aggregate.
5. **Audit log.** Every statement executed, with profile, timestamp, row count
   and duration, written locally. Accounting customers will be asked by their
   auditor what this thing did to their books; we should be able to answer.

Additionally: a **PII deny-list** derived from Comarch's "Struktura zbioru
danych osobowych" inventory, applied at the gateway. Tables on it are
unreadable by default; reading them requires an explicit, per-profile opt-in,
and results pass through a redaction step.

## 3.6 Output contract

The brief specifies: read-only, text output, "suggested steps to perform or SQL
snippet the user will execute". Refining that into a rule the implementation
can follow:

**Every tool returns a *findings document*, not a data dump.** Structure:

```
SUMMARY        one paragraph: what was checked, on which DB/period, verdict
FINDINGS       ranked by materiality (PLN), each with:
                 · what is wrong
                 · evidence (accounts, positions, amounts)
                 · why it matters
                 · REMEDIATION
NEXT STEPS     what to run next, which tool, which drill-down
CAVEATS        unresolved schema concepts, buffer entries included/excluded,
               assumptions made
```

**Remediation comes in exactly two flavours, and this distinction is
load-bearing:**

- **UI steps** — the default and preferred form for anything that *changes*
  Optima data. "Księgowość → Zestawienia księgowe → Bilans → pozycja B.II.3 →
  dodaj maskę `4-9-*`." The Optima UI applies the business-logic validation we
  cannot replicate, and it keeps the customer inside supported behaviour
  ([`01`](01-integration-landscape.md) §1.2).
- **SQL snippets — `SELECT` only.** Verification and drill-down queries the
  user can paste into Optima's own SQL console or SSMS to confirm a finding, or
  to pull a detail list we deliberately didn't put in the model's context.

> **Recommendation, flagged for your decision:** the brief says "SQL snippet
> user will execute on the DB server", which could be read as including
> mutations. I'd narrow it to read-only SQL and route all writes through UI
> steps. Emitting `UPDATE CDN.<statement positions> SET …` would bypass
> Optima's validation, is the standard way Optima databases get corrupted, and
> would likely void the customer's support arrangement. The value we add is
> the *diagnosis*, which is read-only either way. If you want write-SQL
> generation anyway, it should be a separately-gated, clearly-labelled,
> off-by-default mode — say the word and I'll design it that way.

**Language:** findings should be produced in **Polish domain terminology**
(plan kont, obroty, salda, zestawienie, gałąź, bufor) regardless of the
conversation language — those are the words on the Optima screens the user is
looking at. Surrounding prose follows the user's language.

## 3.7 Context economy

A real chart of accounts runs to thousands of accounts; `CDN.Dekrety` runs to
millions of rows. Naively surfacing these destroys the context window and the
answer quality with it.

Principles:

- **The model sees findings, not tables.** Aggregation and rule evaluation
  happen in Python, deterministically. The LLM's job is interpretation,
  prioritisation and explanation — not arithmetic over 5,000 rows.
- **Progressive disclosure.** Summary tool → drill-down tool → detail tool.
  Each level takes an explicit narrowing argument.
- **Hard caps with honest truncation.** Never silently drop rows; say "showing
  20 of 347 findings, ranked by PLN impact; call `…` with
  `account_prefix=` to narrow."
- **Cache by fingerprint.** Schema and chart-of-accounts snapshots are cached
  against the schema fingerprint so a multi-tool conversation doesn't
  re-introspect on every call.
- **MCP resources for reference material** (the resolved schema map, the
  knowledge pack, account-type conventions) so clients can pull them on demand
  instead of us pushing them into every tool result.
