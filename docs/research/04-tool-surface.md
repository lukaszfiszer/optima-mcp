# 04 — Tool surface (v1)

Rules applied throughout:

- `readOnlyHint: true`, `openWorldHint: false` on every tool.
- Every accounting tool takes `profile` and `period`, and states which period it used ([`02`](02-optima-data-model.md) §2.2).
- Findings documents, not table dumps ([`03`](03-architecture.md) §3.7, §3.8).
- Nine tools, not thirty. Models choose well from a short, clearly differentiated menu.

## Discovery

**`optima_describe_environment`** · `profile`

Optima version and schema fingerprint; company DBs visible; accounting periods with date ranges and open/closed status; which knowledge-pack concepts resolved against this schema and which didn't; whether the login is appropriately read-only.

Tells the agent up front what will and won't work, instead of letting it find out through failures.

**`optima_schema_map`** · `profile`, `concept?`

Resolved physical mapping for a domain concept, with confidence levels and the inferred relational graph. Also exposed as an MCP resource. For debugging and growing the knowledge pack.

## Chart of accounts — *analiza planu kont*

**`optima_chart_of_accounts_overview`** · `profile`, `period`

Account count by zespół (0–8) and type (aktywa / pasywa / aktywa-pasywa / przychody / koszty / pozabilansowe); analytic depth distribution; rozrachunkowe accounts; dictionary-bound accounts; how many carry balances.

**`optima_chart_of_accounts_analyze`** · `profile`, `period`, `checks?`, `account_prefix?`

v1 rule catalogue:

| Check | Catches |
|---|---|
| Synthetic accounts posted to directly | Postings that should have gone to analytics |
| Type inconsistent with number | Zespół-4 account typed *aktywa* — drives wrong statement defaults |
| Balance on the wrong side vs type | Asset account sitting credit: misposting or mistyped account |
| Inconsistent analytic depth under one synthetic | `201-1-1` alongside `201-2` — classic cause of masks missing accounts |
| Dead accounts | Exist, never posted to in the period |
| Rozrachunkowe flag inconsistent within a group | Some `201-*` settlement, some not |
| Dictionary binding inconsistent within a group | Some analytics bound to kontrahenci, some manual |
| Naming inconsistency | Same counterparty named differently across analytics |
| Not referenced by any zestawienie | Bridge into the statements domain |

Ranked by PLN materiality, each with evidence and remediation.

**`optima_chart_of_accounts_diff`** · `profile`, `period_a`, `period_b`

Accounts added / removed / retyped / re-flagged between periods, and which of those changes aren't reflected in the statement definitions. Because the chart is per-period ([`02`](02-optima-data-model.md) §2.2), "copied the chart forward but not the report" is a structural recurring failure, not a one-off.

## Statements — *zestawienia księgowe*

**`optima_statements_list`** · `profile`, `period`

Available zestawienia (Bilans, RZiS, Cash Flow, custom) with position counts and last-modified where available.

**`optima_statement_definition`** · `profile`, `period`, `statement`, `position?`

Parsed definition tree. Each position with its raw definition, the parsed form (account functions, masks, ranges, arithmetic, position refs, embedded SQL), and the concrete accounts each mask currently expands to. The expansion alone is often enough for an accountant to spot the problem.

**`optima_statement_reconcile`** — flagship · `profile`, `period`, `statement`, `materiality_threshold?`

Expands every mask and range against the actual chart of accounts, builds the account → position coverage matrix, reports:

- **Uncovered accounts** — non-zero balance, zero positions reference it. Most common cause of a balance sheet that doesn't balance. Each with amount at stake and a suggested target position.
- **Double-counted** — >1 position, same sign, same subtree.
- **Dangling references** — masks and ranges matching nothing.
- **Function/type mismatches** — against Optima's own defaulting rule ([`02`](02-optima-data-model.md) §2.5).
- **Tie-out** — Σ Aktywa − Σ Pasywa; Σ(positions) vs Σ(accounts); residual decomposed by cause.

Ranked by PLN, each with UI-step remediation and a `SELECT` snippet to verify.

**`optima_statement_adapt`** · `profile`, `period`, `statement`, `target_period?`

*Dostosowywanie zestawień do planu kont.* Turns reconcile findings into an ordered remediation plan: for each uncovered account, the position it belongs in (inferred from number, type, name similarity, and where its siblings already sit), as either a narrower mask change or an explicit addition — with the effect on statement totals stated before the user makes the change.

Also runs in "port a definition from period A to B" mode, the common request when a new accounting year opens.

## Balances

**`optima_account_balances`** · `profile`, `period`, `account_mask?`, `date_from?`, `date_to?`, `include_buffer?`

Obroty i salda, computed from `CDN.Dekrety` rather than trusting a cached aggregate ([`02`](02-optima-data-model.md) §2.4). `include_buffer` defaults to `false` and the choice is always stated in the output — silently mixing provisional buffer entries (`DeN_Bufor`) into a reported balance gives numbers that look right and are wrong.

## Not in v1

- **Anything that writes.** ([`01`](01-integration-landscape.md))
- **A generic `run_sql` tool.** Looks attractive, is a trap: makes the model responsible for schema correctness on an undocumented drifting schema ([`02`](02-optima-data-model.md) §2.6), defeats the PII deny-list, produces confidently wrong numbers. If a raw-query escape hatch is needed later it should be `SELECT`-only, explicitly opt-in, and routed through the same statement gate. The thesis of this design is that curated domain tools beat raw SQL on a schema nobody has documented.
- Trade documents, payroll, CRM, warehouse. Later phases.
- Multi-company consolidation. Needs its own design pass.
