# 02 — Optima data model

Every concrete table/column name here is a seed hypothesis for introspection bootstrap, not a spec. The schema is undocumented and changes between releases. Do not hardcode names that haven't been verified at runtime. See §2.6.

## 2.1 Topology

**[confirmed]**

```
MS SQL Server instance
├── CDN_KNF_Konfiguracja   config DB, one per installation
│                          operators, licences, company registry, settings
└── CDN_<Firma>            one company DB per company; all business data
```

- Company DBs prefixed `CDN_`, config DB `CDN_KNF_*`.
- A company DB binds to exactly one config DB.
- Server and DB collation must be `Polish_CI_AS`. Matters for the restore path (§2.7) and for account-number string comparison.
- Optima 2026.5.1 moved to x64, added SQL Server 2025 support.

Connection model is *(server, company DB, optional config DB)*. Multi-company (biuro rachunkowe) is the normal case.

## 2.2 Period scoping

**[confirmed]** An *okres obrachunkowy* is a logical partition of the company DB:

- **Each period has its own chart of accounts.** Not global — recreated (usually copied forward) per period.
- Each period has its own dzienniki cząstkowe; the main journal is period-scoped.
- Zestawienia definitions are period-bound.

Consequences:

1. Every accounting tool takes a period, and states which one it used.
2. "Why did my balance sheet break this year" is usually *the chart was copied forward, the statement definition wasn't*. Period diff is a first-class tool.
3. Never join across periods without an explicit period predicate.

## 2.3 Naming conventions

**[confirmed]**

- All application tables in schema `CDN` (`CDN.Kontrahenci`, not `dbo.`).
- Every column carries a short table-specific prefix: `CDN.DekretyNag` → `DeN_DeNId`, `DeN_Dziennik`, `DeN_NrKsiegi`, `DeN_Bufor`, `DeN_DataDok`.
- PKs are `<Prefix>_<Prefix>Id`. FKs reuse the target's key name: `VaN_DekId = DeN_DeNId`.

This lets us infer the relational graph mechanically — match `X_YyyId` columns against known PKs — without an ER diagram. Most of the knowledge-pack bootstrap (§2.6) is this inference plus human curation.

## 2.4 Accounting tables — seed map

| Concept | Table | Conf. | Notes |
|---|---|---|---|
| Plan kont | `CDN.Konta` | **confirmed** | Prefix is `Acc_*` — settled by introspection ([`07`](07-spike-0-findings.md) §S1), the `Kto_*` source was wrong. Holds number (`Acc_Numer`), name, type (`Acc_TypKonta`), rozrachunkowe flag, dictionary binding, parent link (`Acc_ParId`). No period FK column — period continuity is a forward-linked chain (`Acc_PrevAccId`/`Acc_NextAccId`), not a shared table with a period key. |
| Dzienniki | `CDN.Dzienniki` | likely | Period-scoped. |
| Entry header | `CDN.DekretyNag` | confirmed | `DeN_DeNId`, `DeN_Dziennik`, `DeN_NrKsiegi`, `DeN_Bufor` (buffer vs booked — critical filter), `DeN_DataDok`. |
| Entry lines | `CDN.DekretyKonta` | **confirmed** | Not `CDN.Dekrety` (doesn't exist) — real table is `CDN.DekretyKonta`, prefix `DeK_*`: `DeK_DeNId` (→ header), `DeK_AccId` (→ Konta), `DeK_Strona` (Wn/Ma), `DeK_Kwota`, `DeK_KwotaWal`, `DeK_Bufor`. `CDN.DekretyElem` also exists, uncharacterised. See [`07`](07-spike-0-findings.md). |
| Source doc link | unknown | **unverified** | `CDN.Zrodla` does not exist in the real schema — the documented chain was wrong. Needs re-deriving from real table names. |
| VAT register header | `CDN.VatNag` | likely | `VaN_DekId = DeN_DeNId`. |
| Zestawienie header | `CDN.ZestKsiNag` | **confirmed** | Prefix `ZKN_*`. Carries `ZKN_Bufor` directly on the header. Found and verified in [`07`](07-spike-0-findings.md) §S1. |
| Zestawienie positions | `CDN.ZestKsiPoz` | **confirmed** | Prefix `ZKP_*`. Position tree (`ZKP_Poziom`, `ZKP_Lisc`) + `ZKP_Definicja nvarchar(4000)` — readable formula text, not a blob. |
| Account ↔ position link | `CDN.ZestawieniaKonta` | **confirmed** | Prefix `ZKa_*`. Explicit link table: `ZKa_AccId` → `Konta.Acc_AccId`, `ZKa_ZKNId` → header, `ZKa_ZKPId` → position, `ZKa_Funkcja` → which account-function this row feeds. Highest-value discovery from Spike 0 — see [`07`](07-spike-0-findings.md) §S3 for the open question of whether it's authoritative or a cache. |
| Obroty i salda | — | confirmed as feature | UI: *Księgowość → Obroty i salda*. Whether materialised or computed is unknown. Assume computed; compute ourselves from `CDN.DekretyKonta` rather than depend on a cache we don't control. |
| Personal data | `CDN.PracEtaty`, `CDN.Kontrahenci` | confirmed | Deny-list by default. |

Trade documents are out of v1 scope. One source describes `CDN.TraNag` discriminated by `trn_gidtyp`, but `GidTyp` is ERP XL terminology and may be a cross-product conflation — **[unverified]**, irrelevant until we go beyond accounting.

## 2.5 Zestawienia księgowe — the formula language

A zestawienie is a user-definable financial statement (Bilans, RZiS, Cash Flow, custom), structured as a tree of positions (gałęzie). Each position has a definition that computes its value. **[confirmed]**

A definition can contain **[confirmed]**:

- **Account functions**: `@Saldo`, `@SaldoWn`, `@SaldoMa`, `@Obroty`, `@ObrotyWn`, `@ObrotyMa`, plus `@PrzyrostSalda` and `@PerSaldo` observed in a sample backup but not previously documented ([`07`](07-spike-0-findings.md) §S2). Optima defaults these by account type — Bilans position on aktywa/aktywa-pasywa → `@SaldoWn`; RZiS position on koszty → `@ObrotyWn`. That default is the invariant our function/type check enforces.
- **Cross-statement references**: `@Zestawienie(SYMBOL, position_no)` — a position can reference a position in a *different* statement by symbol, not just within its own tree. Confirmed in a real formula: `@Zestawienie(R_POD_BIL, 7)`.
- **Conditional logic**: `CHOOSE(condition, a, b)` observed in real formulas — the grammar has branching, not just arithmetic.
- **Account masks**, including an exclusion mode ("bez kont wskazanych w masce"). Wildcard alphabet (`*`, `?`, ranges) is **[still unverified]** — the sample backup checked in Spike 0 uses zero masks (all 1,003 non-empty position definitions use direct function-call references instead, backed by the explicit `ZestawieniaKonta` link table). Need a second sample DB where masks are actually configured. See [`07`](07-spike-0-findings.md).
- **Account ranges** ("konto od / konto do") — likewise unobserved in the one DB checked so far.
- Arithmetic and logical operators (note: **decimal literals use a comma**, e.g. `*0,19`, not a dot), references to other positions, system functions, raw SQL.

### Why this is the flagship

A definition written against masks is a stale snapshot of the chart of accounts at the time it was written. Accountants add analytical accounts constantly; masks may or may not pick them up. Optima gives no warning. Symptom appears months later as a balance sheet that doesn't balance, diagnosed by hand position by position.

Expanding every mask and range against the *actual* chart of accounts for the period gives an **account → position coverage matrix**, which yields:

- **Uncovered accounts** — non-zero balance, zero positions reference it → silent understatement. Most common root cause.
- **Double-counted** — referenced by >1 position with the same sign in the same subtree.
- **Dangling references** — mask or range matching nothing.
- **Function/type mismatches** — `@Saldo` on a cost account, `@ObrotyMa` on an asset, measured against Optima's own defaulting rule.
- **Tie-out** — Σ Aktywa − Σ Pasywa; Σ(positions) vs Σ(accounts).

Findings rank by PLN materiality.

**Resolved:** definitions are stored as readable text in `ZKP_Definicja nvarchar(4000)`, not an opaque blob. Spike S2 ([`07`](07-spike-0-findings.md)) settles this — grammar it is, not reverse-engineering.

## 2.6 The schema problem

Comarch publishes no ER diagram or data dictionary. What exists:

- **Struktura zbioru danych osobowych** PDF, per release — useful inventory of table *names*, but scoped to personal-data tables, no column semantics. Best public starting point.
- Technical bulletins (OPT043 *Zaawansowane schematy księgowe*, OPT057, OPT074) leak real table/column names in SQL examples. OPT043 is the richest accounting source found.
- Partner integration docs, spolecznosc.comarch.pl, forum ERP XL — fragmentary, version-ambiguous.

And the schema changes across releases (several versions a year; 2026.5.1 alone changed architecture and engine support).

### Answer: introspect first, curate second

```
1. FINGERPRINT  detect Optima version + schema hash from the connected DB
2. INTROSPECT   INFORMATION_SCHEMA / sys.* — tables, columns, types, PKs, FKs,
                indexes; infer relational graph from the X_YyyId convention (§2.3)
3. RESOLVE      match knowledge pack against actual schema; any concept whose
                tables/columns are absent is reported unsupported, not guessed
4. ANALYSE      run only queries built from resolved identifiers
```

The **knowledge pack** — versioned YAML mapping domain concepts to physical tables/columns, with per-entry confidence and version applicability — is the actual IP. The MCP plumbing is a weekend.

- **Graceful degradation:** on an unrecognised schema, report which concepts resolved and which didn't, offer the tools that still work. Never fabricate a column name.
- **Contributable:** a schema-report command emitting an anonymised introspection dump (names and types, no data) is how the pack covers versions we don't have access to.
- Every generated `SELECT` is built from resolved identifiers, never from a model-produced string ([`03`](03-architecture.md) §3.7).

## 2.7 Backup ingestion

**Decided:** ingestion is **configuration, not a tool** — the user points the server at a directory of backups, and it imports every one of them. The set of sources is fixed before the process starts; individual databases become queryable as their imports finish ([`08`](08-mcpb-extension.md) §8.6). No restore tool, no connect tool in the surface ([`04`](04-tool-surface.md)).

```
npx optima-mcp --backup-dir "D:\Kopie"                        # all backups in the folder
npx optima-mcp "Server=...;Database=CDN_ABC;..."              # live connection instead
```

Setup UX, entry points and the state machine: [`06`](06-backup-ingestion-setup.md) for the per-file mechanics, [`08`](08-mcpb-extension.md) for the current end-to-end design.

**Format.** Optima accepts `.bac` and `.bak` for restore **[confirmed]**. `.bac` **is** a renamed `.bak` — `RESTORE HEADERONLY`/`RESTORE DATABASE` work directly against it, no unwrap step. It's compressed with SQL Server's own native `MS_XPRESS` backup compression (not a Comarch-specific container). Settled empirically in [`07`](07-spike-0-findings.md) §S4.

### Startup sequence

Per backup file; [`08`](08-mcpb-extension.md) §8.5 is the current version, which runs this loop over every file in the configured directories, serially, off the startup path.

```
--backup <path>
  → fingerprint file (size + mtime + hash)
  → already restored under this fingerprint? → skip to connect
  → RESTORE HEADERONLY / FILELISTONLY (metadata, no commit — .bac needs no unwrap, see §2.7 Format)
  → ensure target engine reachable (§2.7.1)
  → RESTORE DATABASE ... WITH MOVE, RECOVERY
  → record fingerprint → DB name in local state
  → connect read-only, introspect, serve
```

**Fingerprint-and-skip is what makes this workable.** A first restore of a 20 GB database is minutes; stdio clients have startup timeouts and will kill the process. So:

- Second and subsequent launches are instant — the imported DB is reused. Per file, this is exactly "import only if the backup changed".
- A backup that *is* new or changed still takes minutes, so the import runs in the background with reported progress rather than blocking startup ([`08`](08-mcpb-extension.md) §8.6). That also covers someone dropping a fresh backup into an already-configured folder.

**Lifecycle:** imported databases persist between runs (that's the point of the fingerprint cache). `optima-mcp clean` removes them along with the container and its volume. Each carries a name marking it as ours (`OPTIMAMCP_<company>_<fingerprint>`) so cleanup is unambiguous and we never touch a database we didn't create. Removal is that deliberate command and nothing else — a flag that silently discards an hour of restoring is a bad thing to have within reach.

**Confidentiality:** a restored backup is a full copy of the books including payroll. Local disk only, never a shared or cloud volume by default. Persistence-by-default is a deliberate usability trade-off and must be documented loudly, with `clean` as the escape hatch — more loudly in container mode, where the copies live on a Docker volume the user can't see in their file manager ([`08`](08-mcpb-extension.md) §8.8).

### 2.7.1 Where to restore — engine options

**There is no open-source engine that can restore a `.bak`.** The format is proprietary and undocumented. Checked:

| Option | Verdict |
|---|---|
| **Babelfish for PostgreSQL** (Apache 2.0) | Implements the TDS wire protocol and T-SQL dialect over PostgreSQL — for *applications*, not storage compatibility. Cannot restore `.bak`; migration requires extracting DDL and moving data separately (AWS DMS/SCT or bcp). A `.bak`/BACPAC restore path is an open feature request, not a feature. **Rejected.** |
| **OrcaMDF** (C#, open source) | Parses MDF files without SQL Server. Author's own description is "highly experimental, lots of special cases not supported or outright ignored"; last commits ~11 years ago. Reads MDF, not `.bak`. **Rejected** — cannot be trusted for accounting figures. |
| Commercial recovery tools (Stellar, Cigati, SysTools) | Proprietary, paid, forensic-recovery oriented. Wrong tool, wrong licence. **Rejected.** |
| FreeTDS | Client library, not a server. **N/A** |

So the target is Microsoft SQL Server. Three ways to get one:

**The default is option 2, Express, run in a container we manage** ([`08`](08-mcpb-extension.md) §8.4). Option 1 is the escape hatch for databases over Express's 50 GB cap. Option 3 is excluded — and on the 2025 images `Developer` isn't even a valid `MSSQL_PID`.

**1. The user's own existing instance.** Anyone running Optima already has a licensed SQL Server. Restoring a backup into it costs nothing, adds no install step, and raises no licensing question — but it costs the user an instance name and a `CREATE DATABASE` login at setup time, and defaulting to the instance that runs their live Optima invites restoring a client's backup into production. Reachable through `OPTIMA_RESTORE_TARGET`:

```
npx optima-mcp --backup-dir "D:\Kopie" --restore-target "localhost\OPTIMA"
```

**2. SQL Server 2025 Express — the default, in a container.** For someone holding a backup with no server (an accountant handed a client's `.bac`), and for everyone else too, because it needs no configuration at all. **Express 2025 raised the max relational database size from 10 GB to 50 GB** **[confirmed — Microsoft Learn]**: 10 GB excluded most real Optima databases, 50 GB covers the large majority. Free for production use, so no licensing grey area. Still capped on CPU (lesser of 1 socket / 4 cores) and buffer pool, so restore and analysis are slower — acceptable for a one-time import. Databases over 50 GB fall back to option 1.

**3. Developer Edition — avoid.** Full Enterprise features, no size cap, free — but licensed strictly for development, test and demonstration, **not production**. A user analysing their own live books is production use. Don't build a default that pushes users into an EULA breach. Mention it only for our own dev and CI.

### Constraints regardless of option

- **Restores go forward only.** A 2022 backup won't restore on 2019. Whatever engine we target must be at least as new as the newest backup supported; with Optima 2026 on SQL Server 2025, track the latest.
- Collation `Polish_CI_AS` on the instance.
- **A container runtime is a hard requirement of backup mode** ([`08`](08-mcpb-extension.md) §8.4) — it's what removes the "find your instance name" step from setup. The live-connection mode needs no container, and remains the answer for anyone who won't install Docker.

## Sources

- [Bazy danych — Comarch KB](https://pomoc.comarch.pl/optima/pl/2021_5/index.php/dokumentacja/bazy-danych/)
- [Okresy obrachunkowe](https://pomoc.comarch.pl/optima/pl/2023/index.php/dokumentacja/okresy-obrachunkowe/)
- [OPT043 — Zaawansowane schematy księgowe](https://pomoc.comarch.pl/optima/pl/2021_5/index.php/dokumentacja/opt043-zaawansowane-schematy-ksiegowe/) ([PDF](https://www.comarch.pl/files-pl/file_253/OPT043-Zaawansowane-schematy-ksiegowe.pdf))
- [OPT074 — Dodawanie kolumn użytkownika](https://pomoc.comarch.pl/optima/pl/2018/index.php/dokumentacja/opt074-dodawanie-kolumn-uzytkownika-na-listach/)
- [Zestawienia księgowe — informacje ogólne](https://pomoc.comarch.pl/optima/pl/2021_5/index.php/dokumentacja/zestawienia-ksiegowe-informacje-ogolne/)
- [Formularz konta — zakładka Zestawienia Księgowe](https://pomoc.comarch.pl/optima/pl/2024/index.php/dokumentacja/formularz-konta-zakladka-zestawienia-ksiegowe/)
- [Zestawienie obrotów i sald](https://pomoc.comarch.pl/optima/pl/2018/index.php/dokumentacja/zestawienie-obrotow-i-sald/)
- [Plan kont](https://pomoc.comarch.pl/optima/pl/2026_5/dokumentacja/plan-kont/)
- [Zapisy księgowe — zakładka Konto](https://pomoc.comarch.pl/optima/pl/2022/index.php/dokumentacja/zapisy-ksiegowe-zakladka-konto/)
- [Wymagania sprzętowe i programowe, Optima 2026](https://pomoc.comarch.pl/optima/pl/2026/dokumentacja/wymagania-sprzetowe-i-programowe/)
- [Optima 2026.5.1 — x64, SQL Server 2025](https://www.systemyit.pl/nowosci-comarch-erp-optima-2026-5-1-x64-i-sql-server-2025/)
- [Restore z kopii — Comarch Optima Cloud KB](https://help.comarch.com/optimacloud/index.php/documentation/request-database-backup/)
- [Editions and supported features of SQL Server 2025 — Microsoft Learn](https://learn.microsoft.com/en-us/sql/sql-server/editions-and-components-of-sql-server-2025?view=sql-server-ver17)
- [What's new in SQL Server 2025 — Microsoft Learn](https://learn.microsoft.com/en-us/sql/sql-server/what-s-new-in-sql-server-2025?view=sql-server-ver17)
- [SQL Express 2025 database size limit — Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/5868994/sql-express-2025-database-size-limit)
- [Using Babelfish to migrate to PostgreSQL](https://babelfishpg.org/docs/usage/migration/) · [Migrating a SQL Server database to Babelfish — AWS](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/babelfish-migration.html) · [BACPAC restore feature request](https://github.com/babelfish-for-postgresql/babelfish_extensions/issues/4613)
- [OrcaMDF — C# MDF parser](https://github.com/improvedk/OrcaMDF)
- [CDN OPT!MA v.14 — Moduł Księga Handlowa (PDF)](https://download.comarch.com/wersje_pliki/opisy/optima/dokumentacja/14.0.1/CDN_OPT!MA_KH_14.pdf)
