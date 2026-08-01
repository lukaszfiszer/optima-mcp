# 05 — Roadmap, risks, open questions

## 5.1 Phase 0 — spikes

Four unknowns dominate risk. Each is a bounded investigation against one real Optima DB. Each can invalidate a design choice above. Do them first.

| # | Spike | Blocks |
|---|---|---|
| **S1** | Dump the real accounting schema. Introspect `CDN.*`. Settle the `CDN.Konta` column prefix (`Acc_*` vs `Kto_*` — sources conflict) and find the **zestawienie header / position / link tables**, whose names research couldn't establish at all. | Everything in the flagship |
| **S2** | How are position definitions stored — readable text or opaque blob? | Small grammar vs reverse-engineering a format. Biggest effort swing in the project. |
| **S3** | How do accounts attach to positions — explicit link table, or resolved from masks on the position? | Entire design of the coverage matrix ([`02`](02-optima-data-model.md) §2.5) |
| **S4** | What is `.bac` — renamed `.bak`, compressed container, or multi-DB archive? | Whether ingestion is `RESTORE` or `RESTORE` + unwrap |

Also worth an hour: pin down the mask wildcard alphabet empirically (`*`, `?`, ranges, exclusion mode). Mask expansion is the core primitive and has to be exact.

**Access requirement:** all four need a real Optima install with Księga Handlowa and a populated chart of accounts. Securing that — partner sandbox, demo DB, or a friendly accounting office — is the critical path for the whole project. Start on it now, in parallel with everything else.

## 5.2 Phases

| Phase | Contents | Done when |
|---|---|---|
| **1 — Skeleton** | MCP server (stdio + streamable HTTP), connection profiles, SQL gateway with all five enforcement layers, introspection + fingerprint + SQLite cache, `optima_describe_environment`. Read-only login script, `npx` install. | A user points Claude or ChatGPT at their Optima DB and gets an honest capability report. |
| **2 — Chart of accounts** | Knowledge pack v1, mask expansion engine, `_overview` / `_analyze` / `_diff`, `optima_account_balances`. | Real *analiza planu kont*. |
| **3 — Statements** | Definition parser, coverage matrix, `_list` / `_definition` / `_reconcile` / `_adapt`. | Diagnose a balance sheet that doesn't balance and say how to fix it. |
| **4 — Ingestion workbench** | Docker Compose restore pipeline, async job model, `.bac` unwrap, teardown guarantees. | User supplies a backup file instead of a connection. |
| **5 — Hardening** | Multi-version knowledge-pack coverage, anonymised schema-report contribution flow, more rules, adjacent domains. | |

Phase 1 doesn't depend on any spike and can be built in parallel with securing DB access.

## 5.3 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| No access to a real Optima DB | Blocks everything | Top priority. Everything else is speculative until it lands. |
| Schema drift across releases | Silent wrong answers — worst failure mode for accounting software | Introspect-and-resolve, never hardcode ([`02`](02-optima-data-model.md) §2.6). Refuse checks whose concepts didn't resolve, and say so. |
| Definitions stored opaquely | Guts the flagship | Spike S2 first. Fallback: reconcile from the account↔position link (S3) alone — still catches uncovered and double-counted accounts without parsing formulas. |
| Confidently wrong numbers | An accountant files a bad statement | Deterministic computation in TS, decimal arithmetic ([`03`](03-architecture.md) §3.4), always state period / buffer inclusion / assumptions, always emit a verification `SELECT`. Position output as diagnosis to review, not a filed figure. |
| PII into the LLM context | RODO/GDPR exposure | Deny-list from Comarch's own personal-data doc, aggregate by default, redaction, explicit opt-in. |
| Performance hit on a live production DB | Uninstalled during month-end close | NOLOCK/snapshot discipline, timeouts, row caps, concurrency limit, off-peak guidance in docs. |
| Customer's Comarch partner objects on support grounds | Adoption blocker | Read-only login, audit log, clear docs that we only `SELECT`. Make the read-only posture a selling point, not a footnote. |
| SQL Server edition licensing for the workbench | Legal/cost | Developer edition free for non-production; Express caps at 10 GB, which real Optima DBs exceed. Needs a decision (Q4). |
| Comarch ships a real API | Strategic | Low near-term probability given their stated position. The domain-analysis layer keeps its value on any substrate. |

## 5.4 Open questions

1. **Write-SQL generation.** I narrowed the brief's "SQL snippet user will execute" to `SELECT`-only, with changes as Optima UI steps ([`03`](03-architecture.md) §3.7). Confirm, or tell me to design a gated write-SQL mode.
2. **Who is the user?** One accounting office on one company DB, or a biuro rachunkowe with dozens of client DBs? The latter makes profile management, multi-company tooling and cross-client benchmarking first-class.
3. **Deployment target.** Local desktop (stdio, next to Claude Desktop / Cursor) or a hosted service? Drives the security model more than anything else — locally the credential never leaves the machine; hosted, we're a data processor.
4. **Backup workbench: ship or document?** Bundling Docker + SQL Server is a heavy install and carries the licensing question. "Restore it yourself, point us at it" is much lighter. I'd document first, bundle only if users struggle.
5. **Output language.** I assumed Polish domain terms inside whatever language the user converses in. Confirm.
6. **Optima version floor.** Back to 2019, or current releases only? Materially changes knowledge-pack effort. What do target customers actually run?
7. **Licence and openness.** Is the knowledge pack ([`02`](02-optima-data-model.md) §2.6) open, or the commercial core?

## 5.5 Next

Fastest de-risking: get one real Optima DB with Księga Handlowa data and run S1–S3 in a single sitting. Those three answers convert most of this document from proposed to specified. Build Phase 1 in parallel — it depends on none of them.
