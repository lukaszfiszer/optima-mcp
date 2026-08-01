# 04 — Proposed tool surface (v1)

Design rules applied throughout:

- Every tool is annotated `readOnlyHint: true`, `openWorldHint: false`.
- Every accounting tool takes `profile` and `period` (okres obrachunkowy)
  explicitly, and **states in its output which period it used**
  ([`02`](02-optima-data-model.md) §2.2).
- Every tool returns a findings document, not a table dump
  ([`03`](03-architecture.md) §3.6, §3.7).
- Small surface. Nine tools, not thirty — an LLM chooses well from a short,
  clearly-differentiated menu and badly from a long one.

---

## Discovery

### `optima_describe_environment`
`profile` → what we're connected to.

Optima version and schema fingerprint · company databases visible · accounting
periods with date ranges and open/closed status · which knowledge-pack concepts
resolved against this schema and which did not · whether the login is
appropriately read-only.

**This is the honest-capabilities tool.** It tells the agent up front what will
and won't work on this installation, instead of letting it discover that
through failures.

### `optima_schema_map`
`profile`, `concept?` → the resolved physical mapping for a domain concept, with
confidence levels and the inferred relational graph. Also available as an MCP
resource. Primarily for debugging and for growing the knowledge pack.

---

## Chart of accounts — *analiza planu kont*

### `optima_chart_of_accounts_overview`
`profile`, `period` → structural picture.

Account count by zespół (0–8) and by type (aktywa / pasywa / aktywa-pasywa /
przychody / koszty / pozabilansowe) · analytic depth distribution · settlement
(rozrachunkowe) accounts · dictionary-bound accounts · how many carry balances.

### `optima_chart_of_accounts_analyze`
`profile`, `period`, `checks?`, `account_prefix?` → the hygiene audit.

Rule catalogue for v1:

| Check | What it catches |
|---|---|
| Synthetic accounts posted to directly | Postings that should have gone to analytics — breaks reporting granularity |
| Type inconsistent with number | e.g. a zespół-4 account typed as *aktywa*; drives wrong statement defaults |
| Balance on the wrong side vs declared type | An asset account sitting credit — either a misposting or a mistyped account |
| Inconsistent analytic depth under one synthetic | `201-1-1` alongside `201-2` — the classic cause of masks missing accounts |
| Dead accounts | Exist, never posted to in the period — clutter that hides real accounts |
| Settlement flag inconsistent within a group | Some `201-*` rozrachunkowe, some not |
| Dictionary binding inconsistent within a group | Some analytics bound to kontrahenci, some manual |
| Naming inconsistency | Same counterparty named differently across analytics |
| **Not referenced by any zestawienie** | Cross-check into the statements domain — the bridge to the flagship tool |

Findings ranked by PLN materiality, each with evidence and remediation.

### `optima_chart_of_accounts_diff`
`profile`, `period_a`, `period_b` → what changed when the chart was carried
forward.

Added / removed / retyped / re-flagged accounts, and — critically — **which of
those changes are not reflected in the statement definitions.** Because the
chart of accounts is per-period ([`02`](02-optima-data-model.md) §2.2), this
"copied the chart forward but not the report" gap is a structural, recurring
failure mode rather than a one-off mistake, which is exactly what makes it
worth a dedicated tool.

---

## Statements — *zestawienia księgowe*

### `optima_statements_list`
`profile`, `period` → available zestawienia (Bilans, RZiS, Cash Flow, custom),
with position counts and last-modified where available.

### `optima_statement_definition`
`profile`, `period`, `statement`, `position?` → the parsed definition tree.

Each position with its raw definition, the parsed form (account functions,
masks, ranges, arithmetic, position references, embedded SQL), and **the
concrete list of accounts each mask currently expands to.** Seeing the
expansion is often enough for an accountant to spot the problem unaided.

### `optima_statement_reconcile` ⭐ **flagship**
`profile`, `period`, `statement`, `materiality_threshold?` → the coverage audit.

Builds the full **account → position coverage matrix** by expanding every mask
and range against the actual chart of accounts, then reports:

- **Uncovered accounts** — non-zero balance/turnover, referenced by zero
  positions. *The most common root cause of a balance sheet that doesn't
  balance.* Each with the amount at stake and a suggested position to add it to.
- **Double-counted accounts** — referenced by more than one position with the
  same sign in the same subtree.
- **Dangling references** — masks and ranges matching nothing; a definition
  written against a chart of accounts that no longer exists.
- **Function/type mismatches** — measured against Optima's own defaulting rule
  (`@SaldoWn` for aktywa/aktywa-pasywa in a Bilans, `@ObrotyWn` for koszty in
  an RZiS — [`02`](02-optima-data-model.md) §2.5).
- **Tie-out** — Σ Aktywa − Σ Pasywa; Σ(positions) vs Σ(accounts); and the
  residual, decomposed by cause.

Output: findings ranked by PLN, each with UI-step remediation and a `SELECT`
snippet to verify ([`03`](03-architecture.md) §3.6).

### `optima_statement_adapt`
`profile`, `period`, `statement`, `target_period?` → *dostosowywanie zestawień
do planu kont.*

Takes the reconcile findings and produces an **ordered remediation plan**: for
each uncovered account, the position it should belong to (inferred from account
number, type, name similarity, and where its siblings already sit), expressed
either as a narrower mask change or an explicit addition — with the impact of
each change on the statement's totals stated before the user makes it.

Also runs in "port a definition from period A to period B" mode, which is the
common request when a new accounting year opens.

---

## Balances

### `optima_account_balances`
`profile`, `period`, `account_mask?`, `date_from?`, `date_to?`,
`include_buffer?` → obroty i salda.

Computed from `CDN.Dekrety` rather than trusting any cached aggregate
([`02`](02-optima-data-model.md) §2.4). **`include_buffer` defaults to `false`
and the choice is always stated in the output** — silently mixing provisional
buffer entries (`DeN_Bufor`) into a reported balance produces numbers that look
right and are wrong, which is worse than an error.

---

## Deliberately *not* in v1

- Anything that writes. Ever. ([`01`](01-integration-landscape.md) §1.2)
- A generic `run_sql` tool. It looks attractive and it is a trap: it makes the
  model responsible for schema correctness on an undocumented, drifting schema
  ([`02`](02-optima-data-model.md) §2.6), it defeats the PII deny-list, and it
  produces confidently wrong numbers. If a raw-query escape hatch is needed
  later, it should be `SELECT`-only, gated behind explicit opt-in, and should
  route through the same statement gate — but the whole thesis of this design
  is that *curated domain tools beat raw SQL access* for a schema nobody has
  documented.
- Trade documents, payroll, CRM, warehouse. Later phases, after the accounting
  wedge proves the architecture.
- Multi-company consolidation. Wants its own design pass.
