# 03 — Architecture

## 3.1 Layers

```
MCP client (Claude, ChatGPT, Cursor, Continue, custom agent)
        │  MCP over stdio | streamable HTTP
┌───────┴──────────────────────────────────────────────┐
│ optima-mcp                                           │
│                                                      │
│ Tool layer        accounting domain tools            │
│ Analysis engine   mask expansion, coverage matrix,   │
│                   rule checks, materiality ranking   │
│ Semantic layer    knowledge pack (YAML) resolved     │
│                   against actual schema              │
│ Schema catalog    introspection, fingerprint, cache  │
│ SQL gateway       read-only enforcement, params,     │
│                   timeouts, row caps, PII deny-list, │
│                   audit log                          │
└───────┬──────────────────────────────────────────────┘
        │ TDS, read-only login
   live SQL Server  |  ephemeral SQL Server (restored backup, optional)
```

Each layer is independently testable. Safety lives in the gateway, version drift in the catalog, Optima knowledge in the semantic layer, and the tool layer stays thin.

## 3.2 Vendor neutrality

- Plain MCP, no client-specific extensions. Target spec revision 2025-06-18 minimum; verify the current revision at build time and negotiate down rather than requiring the newest.
- **Both transports.** stdio for desktop clients, streamable HTTP for hosted agents and ChatGPT-style connectors. Same tool surface, transport chosen by config.
- **No sampling or elicitation in the core path.** Optional protocol features with uneven client support; a tool that requires them breaks on half the ecosystem. Optional UX only, with a working fallback.
- `readOnlyHint: true`, `openWorldHint: false` on every tool. These are trust hints, not enforcement — enforcement is §3.5 — but they let clients present the server honestly.
- Output is text/Markdown. Attach structured content where supported, but the primary payload must be readable without a schema the model has to be taught.
- Neutral tool descriptions, no vendor names.

## 3.3 Stack — TypeScript / Node

| Concern | Choice | Notes |
|---|---|---|
| Runtime | **Node 24 LTS**, TypeScript, ESM | Node 24 gives stable built-in `node:sqlite` and `node:test`, so we can avoid native deps entirely (see cache row). |
| MCP | **`@modelcontextprotocol/sdk`** | Official TS SDK. Handles both transports, tool annotations, lifecycle. Don't hand-roll the protocol. |
| Tool schemas | **`zod`** | Already an SDK dependency; JSON Schema is generated from it. |
| DB driver | **`mssql`** (node-mssql, Tedious driver) | Pure JS — no ODBC system driver, no native build. Meaningful advantage over the Python path: `npx optima-mcp` works with zero system prerequisites. Supports SQL auth, Entra ID, encryption, pooling, per-request timeouts and cancellation. |
| Decimal handling | **`decimal.js`** + cast in SQL | See §3.4. Non-negotiable. |
| SQL parsing | **`node-sql-parser`** (`transactsql` dialect) | Used to *prove* a statement is read-only rather than regex-guessing. Belt-and-braces: we generate all SQL ourselves from resolved identifiers anyway. |
| Local cache | **`node:sqlite`** (built-in) | Schema catalog, resolved knowledge pack, chart-of-accounts snapshots, keyed by schema fingerprint. `better-sqlite3` is the fallback if we need a Node 22 baseline, at the cost of a native build. |
| Knowledge pack | **`yaml`** | Diffable, reviewable by accounting people who don't write TS. |
| Tests | **`vitest`** + testcontainers-style SQL Server fixture | Fixture DB is how we regression-test knowledge-pack resolution across Optima versions. |
| Build / dist | **`tsup`/esbuild** → single bundled ESM CLI | Install friction kills MCP server adoption. `npx optima-mcp` must just work. Docker image as the second option. |
| Package manager | `pnpm` | |

## 3.4 JS-specific hazard: decimals

JS `Number` is float64. Tedious returns SQL `DECIMAL`/`NUMERIC`/`MONEY` as `Number`, which silently loses exactness. For accounting output that is a correctness bug, not a rounding nit.

Rules:

1. **Aggregate in SQL, not in JS.** `SUM()` server-side; bring across totals, not rows to add up. This is also the right call for context economy (§3.7).
2. **Cast on the way out**: `CAST(SUM(x) AS VARCHAR(40))`, parse into `decimal.js`. Never let a monetary value transit as a JS `Number`.
3. All arithmetic in the analysis engine (materiality ranking, tie-out residuals, Σ Aktywa − Σ Pasywa) uses `Decimal`.
4. Format once, at output, with explicit scale.

Worth a lint rule and a test that fails on any `number`-typed monetary field.

## 3.5 Connection model

```
profile:
  name        "biuro-klient-abc"
  server      host,port | named instance
  auth        SQL login (read-only) | Windows/Kerberos | Entra ID
  company_db  CDN_ABC
  config_db   CDN_KNF_Konfiguracja      (optional)
  encrypt     true (default; trustServerCertificate opt-in for on-prem)
```

Profiles are configured out of band — env vars, config file, or secrets manager — and referenced by name. **Connection strings never enter the model context.** An agent passes `profile="biuro-klient-abc"`, not a host and password. The model can't leak a credential it never sees.

## 3.6 Read-only enforcement

Five layers, none trusted alone:

1. **DB permissions.** The only actually sufficient control: a login with `db_datareader` plus `DENY SELECT` on personal-data tables, nothing else. Ship the exact `CREATE LOGIN`/`CREATE USER`/`GRANT` script; warn loudly when connected as anything more privileged.
2. **Connection level.** `ApplicationIntent=ReadOnly` where a readable secondary exists; snapshot isolation or explicit `WITH (NOLOCK)` so we never block a live system. Blocking a month-end close is the fastest route to being uninstalled.
3. **Statement gate.** Parse with `node-sql-parser`; reject unless a single `SELECT`/CTE. No DML, DDL, `EXEC`, `sp_executesql`, multi-statement batches, or `INTO`.
4. **Resource limits.** Per-query timeout, row cap, result-size cap, concurrency limit. An LLM will eventually ask for `SELECT * FROM CDN.Dekrety`; decline gracefully and suggest an aggregate.
5. **Audit log.** Every statement, with profile, timestamp, row count, duration, written locally. Customers will be asked by their auditor what this thing did to the books.

Plus a **PII deny-list** from Comarch's personal-data inventory, applied at the gateway. Denied by default; explicit per-profile opt-in, results pass through redaction.

## 3.7 Output contract

Every tool returns a findings document, not a data dump:

```
SUMMARY     what was checked, which DB/period, verdict
FINDINGS    ranked by PLN materiality; each: what's wrong, evidence
            (accounts, positions, amounts), why it matters, remediation
NEXT STEPS  which tool to call next, which drill-down
CAVEATS     unresolved schema concepts, buffer entries in/out, assumptions
```

Remediation comes in two forms:

- **UI steps** — default for anything that changes Optima data. "Księgowość → Zestawienia księgowe → Bilans → pozycja B.II.3 → dodaj maskę `4-9-*`." The Optima UI applies business-logic validation we can't replicate, and keeps the customer inside supported behaviour ([`01`](01-integration-landscape.md)).
- **SQL snippets, `SELECT` only** — verification and drill-down the user can paste into Optima's SQL console or SSMS.

> **Decision needed.** The brief says "SQL snippet user will execute", which could include mutations. I've narrowed it to read-only SQL, with writes as UI steps: emitting `UPDATE` against Optima tables bypasses validation, is the standard way these DBs get corrupted, and would likely void the customer's support arrangement. The value we add is the diagnosis, which is read-only either way. If you want write-SQL, it should be separately gated, clearly labelled and off by default — say so and I'll design it.

**Language:** findings use Polish domain terms (plan kont, obroty, salda, zestawienie, gałąź, bufor) regardless of conversation language — those are the words on the screen the user is looking at. Surrounding prose follows the user's language.

## 3.8 Context economy

A real chart of accounts runs to thousands of accounts; `CDN.Dekrety` to millions of rows.

- **The model sees findings, not tables.** Aggregation and rule evaluation happen in TS, deterministically. The LLM interprets and prioritises; it doesn't do arithmetic over 5,000 rows.
- **Progressive disclosure.** Summary → drill-down → detail, each taking an explicit narrowing argument.
- **Hard caps with honest truncation.** Never silently drop rows. "Showing 20 of 347 findings by PLN impact; narrow with `account_prefix=`."
- **Cache by fingerprint** so a multi-tool conversation doesn't re-introspect per call.
- **MCP resources** for reference material (resolved schema map, knowledge pack, account-type conventions) so clients pull on demand instead of us pushing into every result.
