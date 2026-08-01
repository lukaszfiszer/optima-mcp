# 02 — Optima data model: what we know, what we must discover

*Confidence labels: **[confirmed]** = corroborated by Comarch documentation or
multiple independent sources; **[likely]** = consistent with the naming
conventions and partner sources but not directly documented;
**[unverified]** = working hypothesis, must be validated by introspection
against a real database before any code depends on it.*

> **The most important finding in this document is that the schema is not
> publicly documented and changes between releases.** Every concrete table and
> column name below is a *seed hypothesis for the introspection bootstrap*, not
> a specification. Code must never hardcode a column name it has not verified
> against the connected database at runtime. See §2.6.

## 2.1 Database topology

An Optima installation is **not one database**: **[confirmed]**

```
MS SQL Server instance
├── CDN_KNF_Konfiguracja      ← configuration DB (one per installation)
│     operators, licences, company registry, global settings
└── CDN_<NazwaFirmy>          ← one company DB per company ("baza firmowa")
      CDN_ABC, CDN_XYZ, ...   all business data lives here
```

- Company DBs are prefixed `CDN_`; the configuration DB is `CDN_KNF_*`
  (commonly `CDN_KNF_Konfiguracja`). **[confirmed]**
- A company database is bound to **exactly one** configuration database.
  **[confirmed]**
- **Server collation must be `Polish_CI_AS`**, at both instance and database
  level. **[confirmed]** — this matters for our restore-from-backup path
  (§2.7) and for any string comparison we do on account numbers.
- Optima 2026.5.1 moved to x64 and added official SQL Server 2025 support.
  **[confirmed]**

**Design consequence:** the connection model is *(server, company DB, optional
config DB)*, and a multi-company accounting office is the normal case, not the
exception. Tools must take a company database as an explicit parameter, and a
discovery tool must enumerate what is available.

## 2.2 Everything accounting is scoped by *okres obrachunkowy*

This is the single most consequential domain fact for our tool design.

An **okres obrachunkowy** (accounting period, usually but not necessarily a
fiscal year) is a logical partition of the company database. Critically:
**[confirmed]**

- **Each accounting period has its own chart of accounts.** The plan kont is
  not global — it is re-created (usually copied forward) per period.
- Each period has its own set of **dzienniki cząstkowe** (sub-journals), and
  the main journal is itself scoped to the period.
- Zestawienia księgowe definitions are likewise period-bound.

**Design consequences, all of them non-negotiable:**

1. Every accounting tool takes a period identifier, and the server must
   default it explicitly (and *say* which one it picked) rather than silently
   using "the latest".
2. "Why did my balance sheet break this year?" is very often *"the chart of
   accounts changed when the period was copied forward, and the statement
   definition didn't"*. A **period-to-period diff** is therefore a first-class
   tool, not a nice-to-have. See [`04-tool-surface.md`](04-tool-surface.md).
3. Never join across periods without an explicit period predicate — it is the
   easiest way to produce a plausible, badly wrong number.

## 2.3 Naming conventions

Optima's schema follows a rigid convention that we can exploit for
introspection: **[confirmed]**

- All application tables live in the **`CDN` schema** (`CDN.Kontrahenci`, not
  `dbo.Kontrahenci`).
- **Every column carries a short table-specific prefix**, e.g. table
  `CDN.DekretyNag` → columns `DeN_DeNId`, `DeN_Dziennik`, `DeN_NrKsiegi`,
  `DeN_Bufor`, `DeN_DataDok`. **[confirmed for DekretyNag]**
- Primary keys follow `<Prefix>_<Prefix>Id`; foreign keys reuse the *target*
  table's key name, e.g. `VaN_DekId = DeN_DeNId` joins the VAT register header
  to its accounting entry. **[confirmed]**

This convention is a gift: it means we can **infer the relational graph
mechanically** — match `X_YyyId` columns against known primary keys — without a
documented ER diagram. A large part of the knowledge-pack bootstrap (§2.6) is
exactly this inference, plus human curation of the resulting graph.

## 2.4 Accounting subsystem — seed map

The tables our v1 tools care about. **Treat every name below as a hypothesis.**

| Concept | Table (hypothesis) | Confidence | Notes |
|---|---|---|---|
| Chart of accounts (plan kont) | `CDN.Konta` | **[likely]** | Referenced by partner sources. Column prefix unconfirmed — one source suggests `Acc_*`, another `Kto_*`; **this contradiction is itself a finding** and must be settled by introspection. Holds account number, name, type (aktywa / pasywa / aktywa-pasywa / przychody / koszty / pozabilansowe), settlement flag (rozrachunkowe), dictionary binding, parent/synthetic link, period FK. |
| Journals (dzienniki) | `CDN.Dzienniki` | **[likely]** | Sub-journals, period-scoped. |
| Journal entry header | `CDN.DekretyNag` | **[confirmed]** | `DeN_DeNId`, `DeN_Dziennik`, `DeN_NrKsiegi`, `DeN_Bufor` (buffer vs booked — **critical filter**, buffer entries are provisional), `DeN_DataDok`. |
| Journal entry lines (dekrety) | `CDN.Dekrety` | **[confirmed]** | Debit/credit account, amounts, currency. The fact table for all balances. |
| Link to source document | `CDN.Zrodla` | **[likely]** | Documented relationship chain `CDN.Konta → CDN.Dekrety → CDN.Zrodla → <source document>`. |
| VAT register header | `CDN.VatNag` | **[likely]** | Joins via `VaN_DekId = DeN_DeNId`. |
| Statement (zestawienie) header | *unknown* | **[unverified]** | Name not established by research — candidates `CDN.ZestKsieg*`, `CDN.Zestawienia*`. **Must be discovered.** |
| Statement positions | *unknown* | **[unverified]** | Holds the position tree (gałęzie), and the definition text per position. |
| Account ↔ statement position link | *unknown* | **[unverified]** | Optima's UI exposes a per-account "Zestawienia Księgowe" tab, implying either an explicit link table or resolution through masks stored on the position. **Which of the two it is determines the whole design of the reconcile tool** (see §2.5) and is the highest-value single discovery task in the project. |
| Turnovers & balances (obroty i salda) | — | **[confirmed as a feature]** | Exposed in the UI under *Księgowość → Obroty i salda*. Whether it is materialised in a table or computed from `CDN.Dekrety` on the fly is unknown; assume **computed**, and compute it ourselves from `CDN.Dekrety` so we are not dependent on a cache we don't control. |
| Personal data | `CDN.PracEtaty`, `CDN.Kontrahenci` | **[confirmed]** | Deny-list these by default (see [`01`](01-integration-landscape.md) §1.3). |

Non-accounting tables (trade documents, `CDN.TraNag` and friends) are **out of
v1 scope**. One partner source describes a `TraNag` header discriminated by
`trn_gidtyp`, but `GidTyp` is ERP XL terminology and this may be a
cross-product conflation — flagged as **[unverified]**, and irrelevant until we
extend beyond accounting.

## 2.5 Zestawienia księgowe — the formula language

This is the technical heart of the flagship tool, so it gets its own treatment.

**What a zestawienie is:** a user-definable financial statement (Bilans, Rachunek
Zysków i Strat, Cash Flow, plus arbitrary custom reports), structured as a
**tree of positions** ("gałęzie"). Each position has a definition that computes
its value. **[confirmed]**

**What a definition can contain:** **[confirmed]**

- **Account functions** — `@Saldo`, `@SaldoWn`, `@SaldoMa`, `@Obroty`,
  `@ObrotyWn`, `@ObrotyMa` applied to an account or account set. Optima
  defaults these by account type: a Bilans position on an asset or
  asset-liability account defaults to `@SaldoWn`; an RZiS position on a cost
  account defaults to `@ObrotyWn`. **[confirmed]** — this default is exactly
  the invariant our "sign/function mismatch" check should enforce.
- **Account masks** — wildcard patterns over account numbers, plus an
  *exclusion* mode ("bez kont wskazanych w masce"). **[confirmed]** The exact
  wildcard alphabet (`*`, `?`, ranges) is **[unverified]** and must be
  determined empirically.
- **Account ranges** — "konto od / konto do". **[confirmed]**
- **Arithmetic and logical operators**, references to other positions, system
  functions, and **raw SQL queries**. **[confirmed]**

**Why this is the killer feature.** A definition written against masks and
ranges is a *stale snapshot of the chart of accounts at the moment it was
written*. When an accountant adds analytical accounts — which happens
constantly — the masks may or may not pick them up. Nothing in Optima warns
you. The symptom appears months later as a balance sheet that doesn't balance,
and the diagnosis today is a manual, position-by-position audit.

**What we can do that a human can't do cheaply:** expand every mask and range
in every position against the *actual* chart of accounts for the period, and
build a full **account → position coverage matrix**. That immediately yields:

- **Uncovered accounts** — non-zero balance, referenced by zero positions →
  silent understatement. *The single most common root cause.*
- **Double-counted accounts** — referenced by more than one position with the
  same sign in the same subtree → overstatement.
- **Dangling references** — a mask or range matching nothing → definition
  written for a chart of accounts that no longer exists.
- **Function/type mismatches** — `@Saldo` on a cost account, `@ObrotyMa` on an
  asset, etc., measured against Optima's own defaulting rule.
- **Tie-out** — Σ Aktywa − Σ Pasywa, and Σ(all positions) vs Σ(all accounts).

Every finding can be **ranked by materiality in PLN**, which is what makes the
output actionable rather than a wall of lint.

**Open technical risk:** if position definitions are stored as an opaque blob
or a proprietary serialised expression rather than readable text, we need a
parser for that format. If they are stored as text, we need a small grammar
(masks + functions + arithmetic + position refs + embedded SQL). **Determining
which is the first spike of the project** — everything else in the flagship
tool depends on it.

## 2.6 The core engineering problem: an undocumented, drifting schema

Comarch does not publish an ER diagram or data dictionary for Optima. What
exists publicly:

- The per-release **"Struktura zbioru danych osobowych"** PDF — a genuinely
  useful *inventory of table names*, published per version, but scoped to
  personal-data tables and without column semantics. Still the best public
  starting point.
- Technical bulletins (OPT043 *Zaawansowane schematy księgowe*, OPT057, OPT074
  *Dodawanie kolumn użytkownika*) which leak real table and column names in
  their SQL examples. **OPT043 is the richest accounting source found.**
- Partner integration docs and the Comarch community forum
  (spolecznosc.comarch.pl), forum ERP XL — fragmentary, version-ambiguous.

And the schema **changes across releases** (Optima ships several versions a
year; 2026.5.1 alone changed architecture and engine support).

### The answer: introspect first, curate second

The architecture must invert the usual ORM assumption. Instead of *"here is the
schema, generate queries"*, we do:

```
1. FINGERPRINT   detect Optima version + schema hash from the connected DB
2. INTROSPECT    read INFORMATION_SCHEMA / sys.* — tables, columns, types,
                 PKs, FKs, indexes; infer the relational graph from the
                 X_YyyId naming convention (§2.3)
3. MATCH         resolve the semantic knowledge pack against the *actual*
                 schema; any concept whose tables/columns are absent is
                 reported as unsupported rather than guessed at
4. ANALYSE       run only queries built from resolved, verified identifiers
```

The **knowledge pack** — a versioned, human-curated YAML mapping from domain
concepts ("chart of accounts", "account type", "journal entry line") to
physical tables/columns, with per-entry confidence and version applicability —
is the actual intellectual property of this project. The MCP plumbing is a
weekend; the knowledge pack is the product.

Practical consequences:

- **Graceful degradation is a feature.** On an unrecognised schema the server
  reports which concepts it could and could not resolve, and offers the tools
  that still work. It never fabricates a column name.
- The pack should be **contributable** — a "schema report" command that emits
  an anonymised introspection dump (names and types only, no data) is how the
  pack grows to cover versions we don't have access to.
- Assume every `SELECT` we generate is built from resolved identifiers, never
  from a string the LLM produced. (Enforcement details in
  [`03-architecture.md`](03-architecture.md) §3.5.)

## 2.7 Ingestion path B: from a backup file

The brief allows the user to supply a backup instead of a live connection.

**Format.** Optima accepts `.bac` and `.bak` for restore. **[confirmed]** `.bak`
is a standard SQL Server backup. `.bac` is Optima's own wrapper produced by its
backup feature and is **[unverified]** as to whether it is a plain renamed
`.bak`, a compressed container, or a multi-database archive (config + company).
**Determining this is a required spike** — it decides whether we can hand the
file straight to `RESTORE` or need an unwrap step.

**Restore pipeline (proposed):**

```
backup file
  → detect container format (.bak vs .bac; unwrap if needed)
  → RESTORE HEADERONLY / FILELISTONLY   (read metadata without committing)
  → spin ephemeral SQL Server (Linux container, Polish_CI_AS)
  → RESTORE DATABASE ... WITH MOVE, RECOVERY
  → connect read-only, introspect, analyse
  → tear down container + delete restored files
```

Hard constraints to design around:

- **SQL Server restores forward only.** A backup from SQL Server 2022 cannot be
  restored on 2019. The ephemeral engine must be **at least as new as the
  newest backup we intend to support** — with Optima 2026 supporting SQL Server
  2025, the container should track the latest available engine.
- **Collation `Polish_CI_AS`** on the instance, or string handling misbehaves.
- **Licensing:** the Developer edition container is free for non-production;
  Express has a 10 GB database cap that real Optima databases blow through
  routinely. This needs an explicit decision — see
  [`05-risks-and-open-questions.md`](05-risks-and-open-questions.md).
- **Disk and time:** production Optima databases are commonly tens of GB. A
  restore is minutes, not seconds. The MCP tool call must be **asynchronous**
  (start job → poll status) or it will blow every client's timeout.
- **Confidentiality:** a restored backup is a full copy of the customer's
  books, including payroll. It must land in a local, ephemeral, explicitly
  cleaned-up location — never a shared or cloud volume by default.

**Recommendation:** treat backup ingestion as a **separate, optional
"workbench" component** shipped alongside the MCP server (a documented Docker
Compose stack), not as logic inside the server process. The MCP server's only
job is to talk to a SQL Server it is given a connection string for. This keeps
the server small, testable, and deployable in the far simpler live-connection
case — and it means the messy part (Docker, disk, licensing) is opt-in.

---

## Sources

- [Bazy danych — Baza Wiedzy Comarch ERP Optima](https://pomoc.comarch.pl/optima/pl/2021_5/index.php/dokumentacja/bazy-danych/)
- [Okresy obrachunkowe — Baza Wiedzy Comarch ERP Optima](https://pomoc.comarch.pl/optima/pl/2023/index.php/dokumentacja/okresy-obrachunkowe/)
- [OPT043 — Zaawansowane schematy księgowe](https://pomoc.comarch.pl/optima/pl/2021_5/index.php/dokumentacja/opt043-zaawansowane-schematy-ksiegowe/) ([PDF](https://www.comarch.pl/files-pl/file_253/OPT043-Zaawansowane-schematy-ksiegowe.pdf))
- [OPT074 — Dodawanie kolumn użytkownika na listach](https://pomoc.comarch.pl/optima/pl/2018/index.php/dokumentacja/opt074-dodawanie-kolumn-uzytkownika-na-listach/)
- [Zestawienia księgowe — informacje ogólne](https://pomoc.comarch.pl/optima/pl/2021_5/index.php/dokumentacja/zestawienia-ksiegowe-informacje-ogolne/)
- [Formularz konta — zakładka Zestawienia Księgowe](https://pomoc.comarch.pl/optima/pl/2024/index.php/dokumentacja/formularz-konta-zakladka-zestawienia-ksiegowe/)
- [Zestawienie Obrotów i sald](https://pomoc.comarch.pl/optima/pl/2018/index.php/dokumentacja/zestawienie-obrotow-i-sald/)
- [Plan kont — Baza Wiedzy Comarch ERP Optima](https://pomoc.comarch.pl/optima/pl/2026_5/dokumentacja/plan-kont/)
- [Zapisy księgowe — zakładka Konto](https://pomoc.comarch.pl/optima/pl/2022/index.php/dokumentacja/zapisy-ksiegowe-zakladka-konto/)
- [Wymagania sprzętowe i programowe (Optima 2026)](https://pomoc.comarch.pl/optima/pl/2026/dokumentacja/wymagania-sprzetowe-i-programowe/)
- [Nowości Comarch ERP Optima 2026.5.1 (x64, SQL Server 2025)](https://www.systemyit.pl/nowosci-comarch-erp-optima-2026-5-1-x64-i-sql-server-2025/)
- [Request to restore the database from backup — Comarch ERP Optima Cloud KB](https://help.comarch.com/optimacloud/index.php/documentation/request-database-backup/)
- [System CDN OPT!MA v.14 — Moduł Księga Handlowa (PDF)](https://download.comarch.com/wersje_pliki/opisy/optima/dokumentacja/14.0.1/CDN_OPT!MA_KH_14.pdf)
