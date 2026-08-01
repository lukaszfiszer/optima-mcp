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
| Plan kont | `CDN.Konta` | likely | Column prefix disputed: one source says `Acc_*`, another `Kto_*`. Must be settled by introspection. Holds number, name, type (aktywa/pasywa/aktywa-pasywa/przychody/koszty/pozabilansowe), rozrachunkowe flag, dictionary binding, parent link, period FK. |
| Dzienniki | `CDN.Dzienniki` | likely | Period-scoped. |
| Entry header | `CDN.DekretyNag` | confirmed | `DeN_DeNId`, `DeN_Dziennik`, `DeN_NrKsiegi`, `DeN_Bufor` (buffer vs booked — critical filter), `DeN_DataDok`. |
| Entry lines | `CDN.Dekrety` | confirmed | Wn/Ma account, amounts, currency. Fact table for all balances. |
| Source doc link | `CDN.Zrodla` | likely | Documented chain `CDN.Konta → CDN.Dekrety → CDN.Zrodla → <doc>`. |
| VAT register header | `CDN.VatNag` | likely | `VaN_DekId = DeN_DeNId`. |
| Zestawienie header | unknown | **unverified** | Name not established. Candidates `CDN.ZestKsieg*`, `CDN.Zestawienia*`. Must be discovered. |
| Zestawienie positions | unknown | **unverified** | Position tree (gałęzie) + definition text per position. |
| Account ↔ position link | unknown | **unverified** | Optima's UI has a per-account "Zestawienia Księgowe" tab, implying either an explicit link table or resolution through masks on the position. Which one determines the design of the reconcile tool (§2.5). Highest-value single discovery. |
| Obroty i salda | — | confirmed as feature | UI: *Księgowość → Obroty i salda*. Whether materialised or computed is unknown. Assume computed; compute ourselves from `CDN.Dekrety` rather than depend on a cache we don't control. |
| Personal data | `CDN.PracEtaty`, `CDN.Kontrahenci` | confirmed | Deny-list by default. |

Trade documents are out of v1 scope. One source describes `CDN.TraNag` discriminated by `trn_gidtyp`, but `GidTyp` is ERP XL terminology and may be a cross-product conflation — **[unverified]**, irrelevant until we go beyond accounting.

## 2.5 Zestawienia księgowe — the formula language

A zestawienie is a user-definable financial statement (Bilans, RZiS, Cash Flow, custom), structured as a tree of positions (gałęzie). Each position has a definition that computes its value. **[confirmed]**

A definition can contain **[confirmed]**:

- **Account functions**: `@Saldo`, `@SaldoWn`, `@SaldoMa`, `@Obroty`, `@ObrotyWn`, `@ObrotyMa`. Optima defaults these by account type — Bilans position on aktywa/aktywa-pasywa → `@SaldoWn`; RZiS position on koszty → `@ObrotyWn`. That default is the invariant our function/type check enforces.
- **Account masks**, including an exclusion mode ("bez kont wskazanych w masce"). Wildcard alphabet (`*`, `?`, ranges) is **[unverified]**, must be determined empirically.
- **Account ranges** ("konto od / konto do").
- Arithmetic and logical operators, references to other positions, system functions, raw SQL.

### Why this is the flagship

A definition written against masks is a stale snapshot of the chart of accounts at the time it was written. Accountants add analytical accounts constantly; masks may or may not pick them up. Optima gives no warning. Symptom appears months later as a balance sheet that doesn't balance, diagnosed by hand position by position.

Expanding every mask and range against the *actual* chart of accounts for the period gives an **account → position coverage matrix**, which yields:

- **Uncovered accounts** — non-zero balance, zero positions reference it → silent understatement. Most common root cause.
- **Double-counted** — referenced by >1 position with the same sign in the same subtree.
- **Dangling references** — mask or range matching nothing.
- **Function/type mismatches** — `@Saldo` on a cost account, `@ObrotyMa` on an asset, measured against Optima's own defaulting rule.
- **Tie-out** — Σ Aktywa − Σ Pasywa; Σ(positions) vs Σ(accounts).

Findings rank by PLN materiality.

**Open risk:** if position definitions are stored as an opaque/serialised blob rather than text, we need to reverse-engineer that format instead of writing a grammar. Spike S2 ([`05`](05-roadmap-and-open-questions.md) §5.1) settles this; everything in the flagship depends on it.

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
- Every generated `SELECT` is built from resolved identifiers, never from a model-produced string ([`03`](03-architecture.md) §3.5).

## 2.7 Backup ingestion

**Format.** Optima accepts `.bac` and `.bak` for restore **[confirmed]**. `.bak` is a standard SQL Server backup. Whether `.bac` is a renamed `.bak`, a compressed container, or a multi-DB archive (config + company) is **[unverified]** — spike S4.

**Pipeline:**

```
backup file
  → detect container format, unwrap if needed
  → RESTORE HEADERONLY / FILELISTONLY (metadata, no commit)
  → ephemeral SQL Server (Linux container, Polish_CI_AS)
  → RESTORE DATABASE ... WITH MOVE, RECOVERY
  → connect read-only, introspect, analyse
  → tear down container, delete restored files
```

Constraints:

- **Restores go forward only.** A 2022 backup won't restore on 2019. The ephemeral engine must be at least as new as the newest backup supported; with Optima 2026 on SQL Server 2025, track the latest engine.
- Collation `Polish_CI_AS` on the instance.
- **Licensing:** Developer edition is free for non-production; Express caps at 10 GB, which real Optima DBs exceed. Needs a decision ([`05`](05-roadmap-and-open-questions.md) §5.3 Q4).
- **Time:** production DBs are commonly tens of GB. Restore is minutes. The tool call must be async (start job → poll) or it blows client timeouts.
- **Confidentiality:** a restored backup is a full copy of the books including payroll. Local, ephemeral, explicitly cleaned up. Never a shared or cloud volume by default.

**Recommendation:** ship backup ingestion as a separate optional workbench (documented Docker Compose), not logic inside the server. The server's only job is talking to a SQL Server it's given a connection string for. Keeps the server small and testable, and makes the messy part (Docker, disk, licensing) opt-in.

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
- [CDN OPT!MA v.14 — Moduł Księga Handlowa (PDF)](https://download.comarch.com/wersje_pliki/opisy/optima/dokumentacja/14.0.1/CDN_OPT!MA_KH_14.pdf)
