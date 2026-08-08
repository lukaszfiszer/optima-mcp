# 07 — Spike 0 findings: real backup, real schema

Empirical run of spikes S1, S2, S3, S4 ([`05`](05-roadmap-and-open-questions.md) §5.1) against a sample Optima company-DB backup. This settles most of what §5.1 marked unverified. Supersedes the disputed/unverified rows in [`02`](02-optima-data-model.md) — that document should be read with this one's corrections applied.

## Setup

No SQL Server or Docker available on the dev machine, so: installed Colima (`colima start --vm-type=vz --vz-rosetta`) as the container runtime, then ran SQL Server 2022 Developer under amd64 emulation on Apple Silicon:

```
docker run -e "ACCEPT_EULA=Y" -e "MSSQL_SA_PASSWORD=<pw>" -e "MSSQL_PID=Developer" \
  -p 1433:1433 --name optima-spike -d --platform linux/amd64 \
  mcr.microsoft.com/mssql/server:2022-latest
```

Restore was a straight `RESTORE DATABASE ... WITH MOVE` — no unwrap step (see S4 below). 13,609 pages, well under a second.

**Confidentiality note:** treat any Optima backup as containing personal-data-adjacent tables by default. The backup file must not be committed to the repo or pushed anywhere, consistent with the "local disk only" posture in [`02`](02-optima-data-model.md) §2.7.

## S4 — What is `.bac`? **Answered: it's a renamed `.bak`.**

`RESTORE HEADERONLY FROM DISK = '...backup.bac'` succeeded **directly**, no unwrapping, no custom container. Header facts:

- `CompressionAlgorithm = MS_XPRESS` — SQL Server's own native backup compression. This is why the file is high-entropy (~7.95–8.0 bits/byte) from almost byte 1: it looked like it could be an opaque/encrypted proprietary wrapper from static analysis alone, but it's just standard backup compression. Static entropy analysis was a dead end here — restoring against a real engine was the only way to know.
- `BackupSize` 113,340,416 vs `CompressedBackupSize` 27,592,277 (matches the file on disk) → ~4.1x compression.
- `DatabaseName` follows the `CDN_<Firma>` convention from [`02`](02-optima-data-model.md) §2.1. `CompatibilityLevel = 160` (SQL Server 2022), `Collation = Polish_CI_AS`.
- Taken by a named service account matching Optima's own scheduled-backup-agent naming pattern, not a manual `BACKUP DATABASE`.
- `FILELISTONLY` showed original Windows paths (`E:\MSSQL\DATA\...`), hence `WITH MOVE` was required — expected and unremarkable.

**Consequence for [`02`](02-optima-data-model.md) §2.7 startup sequence:** the `detect container format, unwrap if needed` step can be dropped for `.bac` — it's not a distinct format from `.bak`, just an extension convention Optima's backup tool uses. `RESTORE HEADERONLY` / `FILELISTONLY` directly against the file (as already planned) is sufficient; no separate unwrap phase exists to build.

The header-string investigation (`MSSQLBAK` ASCII signature at byte 0) that preceded the actual restore was itself a minor red herring — that string is part of SQL Server's own disk-backup media header, not evidence of a Comarch-specific wrapper.

## S1 — Real schema introspection

504 tables, all under schema `CDN`, confirming [`02`](02-optima-data-model.md) §2.3's naming convention.

### Chart of accounts — `CDN.Konta`, prefix `Acc_*` **[confirmed, settles the Acc_/Kto_ dispute]**

Key columns actually present: `Acc_AccId` (PK), `Acc_Numer`/`Acc_NumerIdx`, `Acc_Segment`, `Acc_Nazwa`, `Acc_TypKonta`, `Acc_Rozrachunkowe`, `Acc_Poziom`, `Acc_Analityka`, `Acc_PrevAccId`/`Acc_NextAccId`.

Notable: **no `OkrId`/period FK column on `Konta`.** [`02`](02-optima-data-model.md) §2.2's "each period has its own chart of accounts" is implemented as a **forward-linked chain** (`Acc_PrevAccId` → `Acc_NextAccId`) across period-scoped account rows, not a period foreign key on a shared table. Matters for any tool that walks the chart across periods.

### Entry lines — real table is `CDN.DekretyKonta`, not `CDN.Dekrety` **[corrects §2.4]**

`CDN.Dekrety` does not exist in this schema. The actual fact table is `CDN.DekretyKonta` (prefix `DeK_`):

```
DeK_DeKId, DeK_DeEId, DeK_DeNId (→ DekretyNag), DeK_DziId, DeK_AccId (→ Konta),
DeK_Strona (Wn/Ma side), DeK_DataDok, DeK_Kwota, DeK_KwotaWal, DeK_Waluta, DeK_Bufor
```

`CDN.DekretyElem` also exists (likely per-line elements/splits — not yet characterised). `CDN.DekretyNag` matches the doc's description as-is.

`CDN.Zrodla` also does not exist — the "documented chain `Konta → Dekrety → Zrodla → <doc>`" in §2.4 is unconfirmed as stated and needs re-derivation from the real table names; out of scope for this spike.

### Zestawienia tables — found and confirmed **[settles the "name not established" rows in §2.4]**

| Concept | Table | Prefix |
|---|---|---|
| Header | `CDN.ZestKsiNag` | `ZKN_` |
| Position (tree node + definition) | `CDN.ZestKsiPoz` | `ZKP_` |
| Column definitions (e.g. period columns in a layout) | `CDN.ZestKsiKol` | `ZKK_` |
| Cached/computed results | `CDN.ZestKsiWyniki` | — |
| **Account ↔ position link** | `CDN.ZestawieniaKonta` | `ZKa_` |

`ZestKsiNag` carries `ZKN_Bufor` (buffer-inclusion flag) directly on the statement header — confirms [`05`](05-roadmap-and-open-questions.md)'s "always state period / buffer inclusion" concern is a real, queryable field, not something to infer.

## S2 — Definitions are readable text **[confirmed, not opaque]**

`ZKP_Definicja` is `nvarchar(4000)`. Real examples pulled from the restored DB:

```
@ObrotyMa(752) + @ObrotyMa(762) + @ObrotyMa(770) + @ObrotyMa(702) + @ObrotyMa(731) + @ObrotyMa(741)

@ObrotyWn(751) + @ObrotyWn(761) + ... + @ObrotyWn(401-1-1) + @ObrotyWn(401-2-1) + ...

CHOOSE((@PerSaldo(219)+@PerSaldo(220)+@PerSaldo(221)+@PerSaldo(222))<0,
       (-1*@PerSaldo(219)-@PerSaldo(220)-@PerSaldo(221)-@PerSaldo(222)),0) - @PerSaldo(229-01)

(@Zestawienie(R_POD_BIL, 7)*0,19)
```

Confirms/extends [`02`](02-optima-data-model.md) §2.5:

- Account functions observed in this backup: `@ObrotyMa`, `@ObrotyWn`, `@SaldoMa`, `@SaldoWn`, `@PrzyrostSalda`, `@PerSaldo` (last two not previously listed).
- `CHOOSE(...)` — conditional/branching functions exist in the grammar, not just arithmetic.
- `@Zestawienie(SYMBOL, position_no)` — positions can reference **other statements by symbol**, not just other positions in the same tree. Grammar needs to support cross-statement references.
- Account segment notation uses dashes: `401-1-1`, `229-01`, `464-2` — segment/analytic drill-down is dash-delimited, consistent with `Acc_Segment`.
- Polish decimal comma appears literally in formulas (`*0,19` = ×0.19) — the grammar's number literal must accept comma as decimal separator, not just dot.

Grammar effort (the biggest swing per §5.1) is now the smaller of the two branches — parsing this text, not reverse-engineering a blob.

## S3 — Explicit link table **[confirmed, not mask-resolved — at least not exclusively]**

`CDN.ZestawieniaKonta` is a real link table: `ZKa_AccId` → `Konta.Acc_AccId`, `ZKa_ZKNId` → statement header, `ZKa_ZKPId` → position, `ZKa_Funkcja` (which function this row contributes under — `@ObrotyMa`, `@SaldoWn`, etc). This is populated per-account, per-position, per-function — i.e. Optima appears to **materialise the resolved account set** for each position rather than (only) resolving masks live. This determines the coverage-matrix design in §2.5: the link table itself may already be closer to the desired output than expected, worth checking whether it's kept in sync automatically or only on demand ("przelicz").

## Mask wildcard alphabet — **inconclusive, needs a DB that actually uses masks**

Checked `ZKP_Definicja` and `Konta.Acc_Numer` for `*`, `?`, `[...]` — none found as actual mask wildcards in this backup (the `*` occurrences are arithmetic multiplication, e.g. `-1*@PerSaldo(229)`). Every `ZestawieniaKonta` row in this backup uses direct function-call references (`@ObrotyMa(752)`), not masks or account ranges. Out of 1,003 non-empty position definitions, zero used mask/range syntax.

This is a real, useful negative result — not every real-world install exercises masks — but it means **the mask alphabet question from §5.1 is still open**. Need a second DB (ideally one with a more complex/manually-tuned chart of accounts, e.g. a larger company or one with custom analytics) where masks are actually configured on a zestawienie position.

## Updated status of Phase 0 spikes

| # | Spike | Status |
|---|---|---|
| S1 | Real schema, `Acc_*` settled, zestawienie tables found | **Done** — see above |
| S2 | Definitions readable text or opaque blob | **Done** — readable text, grammar confirmed richer than assumed (`CHOOSE`, cross-statement `@Zestawienie`, comma decimals) |
| S3 | Explicit link vs mask resolution | **Done** — explicit link table exists (`ZestawieniaKonta`); whether it's the *only* mechanism or a cache alongside live mask resolution is still open |
| S4 | `.bac` format | **Done** — renamed `.bak`, `MS_XPRESS`-compressed, no unwrap step needed |
| Mask wildcard alphabet | — | **Still open** — this backup doesn't use masks. Need a second sample DB. |

## Open follow-ups this spike surfaced (not in original §5.1)

1. `CDN.DekretyElem` — uncharacterised, may be VAT/split detail on entry lines.
2. `CDN.Zrodla` doesn't exist as named in §2.4 — the source-document chain needs re-deriving from real table names in a follow-up pass.
3. Whether `ZestawieniaKonta` is kept live-in-sync with the chart of accounts or only recomputed on demand — determines whether the coverage-matrix tool can trust it directly or must always re-resolve from `ZKP_Definicja` itself.
4. Period-to-period chart continuity is a linked list (`Acc_PrevAccId`/`Acc_NextAccId`), not a period FK — worth confirming this generalises before building the period-diff tool from §2.2.
