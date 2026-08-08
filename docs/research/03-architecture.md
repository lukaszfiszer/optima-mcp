# 03 — Architecture

## 3.1 Layers

```mermaid
flowchart TB
    Client["MCP client\n(Claude, ChatGPT, Cursor, Continue, custom agent)"]
    Handlers["MCP tool handlers\nthin: parse input, call domain layer, serialize output"]
    Domain["Domain layer\nknowledge pack (YAML) resolved against actual schema\n— hides Optima-version differences, returns normalized data"]
    Catalog["Schema catalog\nintrospection, fingerprint, cache"]
    Gateway["SQL gateway\nread-only enforcement, params, timeouts,\nrow caps, PII deny-list, audit log"]
    DB["live SQL Server | managed container holding N restored backups"]
    Import["Import worker\ncontainer lifecycle, scan, fingerprint, RESTORE\n— background, never on the query path"]

    Client -->|"MCP over stdio"| Handlers --> Domain --> Catalog --> Gateway -->|"TDS, read-only login"| DB
    Import -->|"sa, import only"| DB
    Import -.->|"source states, progress"| Handlers
```

The import worker ([`08`](08-mcpb-extension.md)) is deliberately off to the side: it is the only component holding a privileged credential, it never serves a tool call, and the query path can't reach it. What crosses back is read-only status — which sources are ready, which are still importing.

The server is a **DB-access wrapper, not a diagnostic engine**: tools return normalized, domain-level data. The domain layer's only job is translating an Optima-version-specific schema into a stable shape — not judging it. Ranking, rule-checking, and interpretation are the calling agent's job.

Handlers hold no business logic, so a REST controller can call the same domain-layer functions later without a rewrite — but that's a one-line consequence of keeping handlers thin, not a layer to build now.

## 3.2 Deployment: local first

**Decided:** v1 is **local desktop only** — the server runs on the user's machine next to their MCP client (Claude Desktop, Claude Code, Cursor, Continue), speaking stdio.

Consequences, all of them simplifying:

- **The DB credential never leaves the machine.** No TLS termination, no auth layer, no multi-tenancy, no secret storage service.
- **We are not a data processor.** No DPA, no data-residency question, no shared-infrastructure risk on a database full of payroll data ([`01`](01-integration-landscape.md)). This is the single largest reason to start local.
- The SQL Server is reachable directly — either the user's existing Optima instance, or a container we manage locally holding the restored backups ([`08`](08-mcpb-extension.md) §8.4).
- Audit log is a local file, which is what an auditor wants anyway.

**Local-first also decides the distribution format.** The install has to be completable by an accountant without a terminal, which is what makes the MCPB bundle the user-facing artefact ([`08`](08-mcpb-extension.md)) rather than a hosted service with an upload form. The two decisions reinforce each other: nothing leaves the machine, and nothing has to be typed.

Streamable HTTP stays in the design (§3.3) because the SDK gives it for free and the domain layer is transport-agnostic, but **hosted deployment is out of scope for v1** and must not drive any v1 decision. Revisit once the tool surface has proven itself.

## 3.3 Vendor neutrality

- Plain MCP, no client-specific extensions. Target spec revision 2025-06-18 minimum; verify the current revision at build time and negotiate down rather than requiring the newest.
- **stdio is the v1 transport.** Streamable HTTP is implemented but unsupported/undocumented until hosted deployment is on the table. Same tool surface either way.
- The MCP tool handlers are a thin protocol adapter over the domain layer (§3.1); they hold no business logic. This is what keeps a future REST adapter additive rather than a rewrite.
- **No sampling or elicitation in the core path.** Optional protocol features with uneven client support; a tool that requires them breaks on half the ecosystem. Optional UX only, with a working fallback.
- `readOnlyHint: true`, `openWorldHint: false` on every tool. These are trust hints, not enforcement — enforcement is §3.7 — but they let clients present the server honestly.
- Output is text/Markdown. Attach structured content where supported, but the primary payload must be readable without a schema the model has to be taught.
- Neutral tool descriptions, no vendor names.

## 3.4 Stack — TypeScript / Node

| Concern | Choice | Notes |
|---|---|---|
| Runtime | **Node 24 LTS**, TypeScript, ESM | Node 24 gives stable built-in `node:sqlite` and `node:test`, so we can avoid native deps entirely (see cache row). |
| MCP | **`@modelcontextprotocol/sdk`** | Official TS SDK. Handles both transports, tool annotations, lifecycle. Don't hand-roll the protocol. |
| Tool schemas | **`zod`** | Already an SDK dependency; JSON Schema is generated from it. |
| DB driver | **`mssql`** (node-mssql, Tedious driver) | Pure JS — no ODBC system driver, no native build. Meaningful advantage over the Python path: `npx optima-mcp` works with zero system prerequisites. Supports SQL auth, Entra ID, encryption, pooling, per-request timeouts and cancellation. |
| Decimal handling | **`decimal.js`** + cast in SQL | See §3.5. Non-negotiable. |
| SQL parsing | **`node-sql-parser`** (`transactsql` dialect) | Used to *prove* a statement is read-only rather than regex-guessing. Belt-and-braces: we generate all SQL ourselves from resolved identifiers anyway. |
| Local cache | **`node:sqlite`** (built-in) | Schema catalog, resolved knowledge pack, chart-of-accounts snapshots, keyed by schema fingerprint. Degrades to in-memory when the host runtime predates 22.5 — under MCPB the host supplies Node ([`08`](08-mcpb-extension.md) §8.5). The import registry is a plain JSON file for the same reason. `better-sqlite3` is rejected: a native build defeats the zero-prerequisite install. |
| Container control | **`docker` CLI via `child_process`** | No Docker SDK dependency: we need six commands (`info`, `run`, `start`, `stop`, `inspect`, `volume rm`) and CLI compatibility is what Colima, Rancher and Podman actually provide ([`08`](08-mcpb-extension.md) §8.4). |
| Distribution | **`@anthropic-ai/mcpb`** → one `.mcpb` | The user-facing install ([`08`](08-mcpb-extension.md) §8.9). `mcpb validate` in CI. |
| Knowledge pack | **`yaml`** | Diffable, reviewable by accounting people who don't write TS. |
| Tests | **`vitest`** + testcontainers-style SQL Server fixture | Fixture DB is how we regression-test knowledge-pack resolution across Optima versions. |
| Build / dist | **`tsup`/esbuild** → single bundled ESM CLI | Install friction kills MCP server adoption. `npx optima-mcp` must just work. Docker image as the second option. |
| Package manager | `pnpm` | |

## 3.5 JS-specific hazard: decimals

JS `Number` is float64. Tedious returns SQL `DECIMAL`/`NUMERIC`/`MONEY` as `Number`, which silently loses exactness. For accounting output that is a correctness bug, not a rounding nit.

Rules:

1. **Aggregate in SQL, not in JS.** `SUM()` server-side; bring across totals, not rows to add up. This is also the right call for context economy (§3.9).
2. **Cast on the way out**: `CAST(SUM(x) AS VARCHAR(40))`, parse into `decimal.js`. Never let a monetary value transit as a JS `Number`.
3. Any arithmetic done while shaping a response (e.g. summing a returned page) uses `Decimal`, never `number`.
4. Format once, at output, with explicit scale.

Worth a lint rule and a test that fails on any `number`-typed monetary field.

## 3.6 Connection model and startup

Two modes, mutually exclusive, both **fixed by configuration** before the process starts. There is no connect tool and no restore tool — the model can never choose or change what it is looking at.

```
# A. live connection to an existing Optima database
npx optima-mcp "Server=localhost\OPTIMA;Database=CDN_ABC;User Id=optima_ro;Password=…"

# B. one or more folders of backups → managed container, N databases  ([`08`] §8.4–8.6)
npx optima-mcp --backup-dir "D:\Kopie" --backup-dir "E:\Kopie-klientow"
npx optima-mcp --backup-dir "D:\Kopie" --restore-target "localhost\OPTIMA"   # own instance

# helper
npx optima-mcp clean                    # drop imported DBs, container and volume
```

Under MCPB the same two modes are a directory picker and a text field ([`08`](08-mcpb-extension.md) §8.2); the CLI is the developer and CI surface for the identical code path.

**What "fixed" means.** In mode B the *set of sources* is fixed at startup, but a given database becomes queryable when its import finishes, which may be minutes later ([`08`](08-mcpb-extension.md) §8.6). Tools against a not-yet-ready source are refused with progress, never queued and never answered from a neighbouring database.

Profile shape:

```
profile:
  name        "biuro-klient-abc"
  server      host,port | named instance
  auth        SQL login (read-only) | Windows/Kerberos
  company_db  CDN_ABC
  config_db   CDN_KNF_Konfiguracja      (optional)
  encrypt     true (default; trustServerCertificate opt-in for on-prem)
```

Profiles are configured out of band — env vars, the extension's config UI, or a local config file — and referenced by name. **Connection strings never enter the model context.** Tools take a source label like `database="CDN_ABC (kopia 2026-07-31)"`, never a host, a password, or a file path ([`08`](08-mcpb-extension.md) §8.7). The model can't leak a credential it never sees.

**Startup failures are loud and specific.** Unreachable server, wrong collation, over-privileged login, backup that won't restore, engine too old for the backup — each fails with its own actionable message ([`06`](06-backup-ingestion-setup.md) §6.5, [`08`](08-mcpb-extension.md) §8.10), not as a vague tool error three turns into a conversation.

Whether they are *terminal* depends on who is watching. On the CLI, exit — stderr is visible. Under MCPB, a configuration or environment failure must instead keep the server alive and answer every tool call with the message ([`08`](08-mcpb-extension.md) §8.3): an extension user sees a dead entry in a list, never a stderr line, so exiting cleanly hides the one thing they need to read.

## 3.7 Read-only enforcement

Five layers, none trusted alone:

1. **DB permissions.** The only actually sufficient control: a login with `db_datareader` plus `DENY SELECT` on personal-data tables, nothing else. Ship the exact `CREATE LOGIN`/`CREATE USER`/`GRANT` script; warn loudly when connected as anything more privileged. In container mode we create that login ourselves and additionally `SET READ_ONLY` on every imported database — the `sa` credential `RESTORE` requires belongs to the import worker alone and never touches the query path ([`08`](08-mcpb-extension.md) §8.8).
2. **Connection level.** `ApplicationIntent=ReadOnly` where a readable secondary exists; snapshot isolation or explicit `WITH (NOLOCK)` so we never block a live system. Blocking a month-end close is the fastest route to being uninstalled.
3. **Statement gate.** Parse with `node-sql-parser`; reject unless a single `SELECT`/CTE. No DML, DDL, `EXEC`, `sp_executesql`, multi-statement batches, or `INTO`.
4. **Resource limits.** Per-query timeout, row cap, result-size cap, concurrency limit. An LLM will eventually ask for `SELECT * FROM CDN.Dekrety`; decline gracefully and suggest an aggregate.
5. **Audit log.** Every statement, with profile, timestamp, row count, duration, written locally. Customers will be asked by their auditor what this thing did to the books.

Plus a **PII deny-list** from Comarch's personal-data inventory, applied at the gateway. Denied by default; explicit per-profile opt-in, results pass through redaction.

## 3.8 Output contract

Every tool returns normalized domain data, not a raw table dump and not a diagnosis:

```
DATA        the requested domain entities (accounts, balances, journal
            lines, ...), same shape regardless of Optima version
META        which DB/profile/period, row count, truncation info
CAVEATS     unresolved schema concepts, assumptions made while normalizing
```

The server does not rank, interpret, or recommend — that's the calling agent's job on top of normalized data. Verification and drill-down beyond a tool's own parameters is a read-only SQL snippet the user can paste into Optima's SQL console or SSMS; the server never emits `UPDATE`/`INSERT`/`DELETE` (§3.7).

**Language:** field values use Polish domain terms (plan kont, obroty, salda, zestawienie, gałąź, bufor) regardless of conversation language — those are the words on the screen the user is looking at. Surrounding prose follows the user's language.

## 3.9 Context economy

A real chart of accounts runs to thousands of accounts; `CDN.Dekrety` to millions of rows.

- **The model sees normalized domain data, not raw Optima tables.** Aggregation happens in SQL/TS, deterministically; the LLM doesn't do arithmetic over 5,000 rows.
- **Progressive disclosure.** Summary → drill-down → detail, each taking an explicit narrowing argument.
- **Hard caps with honest truncation.** Never silently drop rows. "Showing 20 of 347 rows; narrow with `account_prefix=`."
- **Cache by fingerprint** so a multi-tool conversation doesn't re-introspect per call.
- **MCP resources** for reference material (resolved schema map, knowledge pack, account-type conventions) so clients pull on demand instead of us pushing into every result.
