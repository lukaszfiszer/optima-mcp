# 05 — Roadmap, risks, and open questions

## 5.1 Phasing

### Phase 0 — Spikes (do these before committing to any design detail)

Four unknowns dominate the project's risk. Each is a small, bounded
investigation against **one real Optima database**, and each can invalidate a
design choice above. Do them first.

| # | Spike | Why it's blocking |
|---|---|---|
| **S1** | **Dump the real accounting schema.** Introspect `CDN.*` on a live DB. Settle the `CDN.Konta` column prefix (`Acc_*` vs `Kto_*` — sources conflict, [`02`](02-optima-data-model.md) §2.4), and find the **statement (zestawienie) header/position/link tables**, whose names research could not establish at all. | Nothing in the flagship tool can be built without these names. |
| **S2** | **Determine how position definitions are stored.** Readable text, or an opaque/serialised blob? | Decides whether we write a small grammar or reverse-engineer a format. Biggest single swing in effort. |
| **S3** | **Determine how accounts attach to statement positions.** Explicit link table, or resolved from masks stored on the position? | Changes the entire architecture of the coverage matrix ([`02`](02-optima-data-model.md) §2.5). |
| **S4** | **Establish the `.bac` format.** Renamed `.bak`, compressed container, or multi-DB archive? | Decides whether backup ingestion is `RESTORE` or `RESTORE` + an unwrap step. |

Also worth an hour: pin down the **mask wildcard alphabet** empirically
(`*`, `?`, ranges, the exclusion mode) — mask expansion is the core primitive
and it must be exactly right.

**Access requirement:** all four need a real Optima installation with the Księga
Handlowa module and a populated chart of accounts. Securing that — a
partner sandbox, a demo database, or a friendly accounting office — is the
practical critical path for the whole project. Worth starting on immediately,
in parallel with everything else.

### Phase 1 — Skeleton
MCP server (stdio + streamable HTTP), connection profiles, safe SQL gateway with
all five enforcement layers, schema introspection + fingerprint + SQLite cache,
`optima_describe_environment`. Ship the read-only SQL login script and the
install one-liner. **Goal: a user can point Claude/ChatGPT at their Optima DB
and get an honest capability report.**

### Phase 2 — Chart of accounts
Knowledge pack v1 for the accounting concepts, mask expansion engine,
`optima_chart_of_accounts_overview` / `_analyze` / `_diff`,
`optima_account_balances`. **Goal: real, useful *analiza planu kont*.**

### Phase 3 — Statements ⭐
Definition parser, coverage matrix, `optima_statements_list` /
`_definition` / `_reconcile` / `_adapt`. **Goal: the flagship — diagnose a
balance sheet that doesn't balance, and say exactly how to fix it.**

### Phase 4 — Ingestion workbench
Docker Compose restore pipeline, async job model, `.bac` unwrap, teardown and
cleanup guarantees.

### Phase 5 — Hardening & reach
Multi-version knowledge-pack coverage, anonymised schema-report contribution
flow, more accounting rules, then adjacent domains.

## 5.2 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **No access to a real Optima DB** | Blocks everything | Highest-priority action. Partner sandbox / demo DB / friendly accounting office. Everything else is speculative until this lands. |
| **Schema drift across Optima releases** | Silent wrong answers — the worst failure mode for accounting software | Introspect-and-resolve, never hardcode ([`02`](02-optima-data-model.md) §2.6). Refuse to run a check whose concepts didn't resolve, and say so. |
| **Statement definitions stored opaquely** | Guts the flagship tool | Spike S2 first. Fallback: reconcile from the account↔position link (S3) alone, which still catches uncovered/double-counted accounts even without parsing formulas. |
| **Confidently wrong numbers** | Reputational; an accountant files a bad statement | Deterministic computation in Python, not in the model. Always state period, buffer inclusion, and assumptions. Always emit a verification `SELECT`. Position the output as *diagnosis to review*, never as a filed figure. |
| **PII leaking into the LLM context** | RODO/GDPR exposure | Deny-list from Comarch's own personal-data structure doc, aggregate-by-default, redaction layer, explicit opt-in ([`01`](01-integration-landscape.md) §1.3). |
| **Performance impact on a live production DB** | Uninstalled during month-end close | `NOLOCK`/snapshot discipline, timeouts, row caps, concurrency limit, off-peak guidance in the docs. |
| **Support/warranty concerns from the customer's Comarch partner** | Adoption blocker | Read-only login, audit log, and clear docs stating we only `SELECT`. Make the read-only posture a *marketing* point, not a footnote. |
| **SQL Server edition licensing for the workbench** | Legal/cost | Developer edition is free for non-production; Express caps at 10 GB, which real Optima DBs exceed. Needs an explicit decision (§5.3 Q4). |
| **Comarch ships a real API and moots the project** | Strategic | Low near-term probability given their stated position, and the domain-analysis layer retains its value on any substrate. |

## 5.3 Open questions — for you

1. **Write-SQL generation.** The brief says "SQL snippet user will execute";
   I've recommended narrowing that to `SELECT`-only, with mutations expressed
   as Optima UI steps ([`03`](03-architecture.md) §3.6). Confirm, or tell me to
   design a gated write-SQL mode.
2. **Who is the user?** A single accounting office on one company DB, or a
   biuro rachunkowe with dozens of client databases? The latter makes profile
   management, multi-company tooling and cross-client benchmarking first-class
   concerns rather than afterthoughts.
3. **Deployment target.** Local desktop (stdio, alongside Claude Desktop /
   Cursor) or a hosted service the office connects to? This drives the
   security model far more than anything else — locally the DB credential never
   leaves the machine; hosted, we're a data processor.
4. **Backup workbench: ship it or document it?** Bundling Docker + SQL Server
   is a heavy install and carries the licensing question. A documented
   "restore it yourself, then point us at it" path is much lighter. My
   inclination is to document first and bundle only if users struggle.
5. **Language of the output.** I've assumed Polish domain terms embedded in
   whatever language the user is conversing in. Confirm.
6. **Optima version floor.** Supporting back to 2019 vs. only current releases
   materially changes knowledge-pack effort. What do real target customers run?
7. **Licence and openness.** Is the knowledge pack — the actual IP
   ([`02`](02-optima-data-model.md) §2.6) — open, or the commercial core?

## 5.4 What I'd do next

If the goal is to de-risk fastest: **get one real Optima database with Księga
Handlowa data, and run spikes S1–S3 against it in a single sitting.** Those
three answers convert most of this document from "proposed" to "specified", and
they're cheap once access exists. Phase 1 can be built in parallel — the
skeleton, the gateway and the introspection layer don't depend on any of the
unknowns.
