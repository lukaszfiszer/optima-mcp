# 05 — Roadmap, risks, open questions

## 5.1 Phase 0 — spikes

Four unknowns dominate risk. Each is a bounded investigation against one real Optima DB. Each can invalidate a design choice above. Do them first.

| # | Spike | Status | Blocks |
|---|---|---|---|
| **S1** | Dump the real accounting schema. Introspect `CDN.*`. Settle the `CDN.Konta` column prefix (`Acc_*` vs `Kto_*` — sources conflict) and find the **zestawienie header / position / link tables**, whose names research couldn't establish at all. | **Done** — [`07`](07-spike-0-findings.md) | Everything in the flagship |
| **S2** | How are position definitions stored — readable text or opaque blob? | **Done — readable text** ([`07`](07-spike-0-findings.md)) | Small grammar vs reverse-engineering a format. Biggest effort swing in the project. |
| **S3** | How do accounts attach to positions — explicit link table, or resolved from masks on the position? | **Done — explicit link table** (`CDN.ZestawieniaKonta`), open question on whether it's authoritative or a cache ([`07`](07-spike-0-findings.md)) | Entire design of the coverage matrix ([`02`](02-optima-data-model.md) §2.5) |
| **S4** | What is `.bac` — renamed `.bak`, compressed container, or multi-DB archive? | **Done — renamed `.bak`**, `MS_XPRESS`-compressed, no unwrap step ([`07`](07-spike-0-findings.md)) | Whether startup ingestion is `RESTORE` or `RESTORE` + unwrap ([`02`](02-optima-data-model.md) §2.7) — resolved, plain `RESTORE` |

Mask wildcard alphabet (`*`, `?`, ranges, exclusion mode) is **still open** — the sample backup run through Spike 0 uses zero masks in its zestawienia (all direct function-call references). Need a second, more complex sample DB to observe real mask usage. Mask expansion is the core primitive and has to be exact.

**Access requirement:** the mask spike still needs a second real Optima install with Księga Handlowa and a chart of accounts that actually uses masks/ranges in its zestawienia. Securing that — partner sandbox, demo DB, or a friendly accounting office — is now the critical path.

## 5.2 Phases

| Phase | Contents | Done when |
|---|---|---|
| **1 — Skeleton** | MCP server over stdio, SQL gateway with all five enforcement layers, introspection + fingerprint + cache, `optima_describe_environment`, read-only login script, `npx` install. | **Delivered.** A user points Claude at their Optima DB and gets an honest capability report. |
| **2 — MCPB extension** | Bundle with a native config UI: directory-of-backups **or** SQL server URL; managed SQL Server container; scan + fingerprint + background import of every backup that changed; multi-database tool surface; `clean`. | An accountant installs a `.mcpb`, points it at a folder of `.bac` files, and gets an honest capability report per company without opening a terminal ([`08`](08-mcpb-extension.md)). |
| **3 — Chart of accounts** | Knowledge pack v1, mask expansion engine, accounting tools — each specified individually first ([`04`](04-tool-surface.md)). | Real *analiza planu kont*. |
| **4 — Statements** | Definition parser, coverage matrix, statement tools — each specified individually first. | Diagnose a balance sheet that doesn't balance and say how to fix it. |
| **5 — Hardening** | Multi-version knowledge-pack coverage, anonymised schema-report contribution flow, more rules, adjacent domains. | |

Backup ingestion comes second because it is what turns "I have a client's `.bac` on disk" into a working install, and it is the only phase that removes the terminal from the setup path. It also unblocks the remaining mask spike — a second sample backup becomes something we can ingest by dropping it in a folder.

Phases 1 and 2 depend on no spike; both can be built in parallel with securing further DB access.

## 5.3 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| No access to a real Optima DB | Blocks everything | Top priority. Everything else is speculative until it lands. |
| Schema drift across releases | Silent wrong answers — worst failure mode for accounting software | Introspect-and-resolve, never hardcode ([`02`](02-optima-data-model.md) §2.6). Refuse checks whose concepts didn't resolve, and say so. |
| Definitions stored opaquely | Guts the flagship | Spike S2 first. Fallback: reconcile from the account↔position link (S3) alone — still catches uncovered and double-counted accounts without parsing formulas. |
| Confidently wrong numbers | An accountant files a bad statement | Deterministic computation in TS, decimal arithmetic ([`03`](03-architecture.md) §3.5), always state period / buffer inclusion / assumptions, always emit a verification `SELECT`. Position output as diagnosis to review, not a filed figure. |
| PII into the LLM context | RODO/GDPR exposure | Deny-list from Comarch's own personal-data doc, aggregate by default, redaction, explicit opt-in. |
| Performance hit on a live production DB | Uninstalled during month-end close | NOLOCK/snapshot discipline, timeouts, row caps, concurrency limit, off-peak guidance in docs. |
| Customer's Comarch partner objects on support grounds | Adoption blocker | Read-only login, audit log, clear docs that we only `SELECT`. Make the read-only posture a selling point, not a footnote. |
| Backup restore needs a licensed SQL Server | Legal/cost | Resolved ([`02`](02-optima-data-model.md) §2.7.1). No open-source engine can restore `.bak` — Babelfish is protocol-compatible, not storage-compatible; OrcaMDF is abandoned and experimental. Default is a **managed Express container** ([`08`](08-mcpb-extension.md) §8.4) — free for production use; the user's own instance is the escape hatch. Developer editions are excluded — production use breaches their EULA, and `Developer` isn't even a valid `MSSQL_PID` on the 2025 images. |
| Optima DB over 50 GB (Express cap) | Small user segment blocked | Per-file, not per-install: import everything that fits, report what didn't, point at the "own SQL Server" setting ([`08`](08-mcpb-extension.md) §8.5). |
| **Docker missing or not running on the user's machine** | Backup mode dead — and this is now the *primary* mode | Detect early and specifically, distinguishing not-installed from not-running ([`08`](08-mcpb-extension.md) §8.10). Never auto-install. The live-server mode needs no container. **Open sub-risk:** a GUI-launched client gives the server a minimal `PATH`, so `docker` may not resolve at all — probe explicit paths, and test this before building the mode ([`08`](08-mcpb-extension.md) §8.4, §8.11 item 2). |
| Cold-start restore exceeds the MCP client's startup timeout | Server appears broken on first run | Structural: the server serves immediately and the import runs behind it, reported as progress ([`08`](08-mcpb-extension.md) §8.6). Fingerprint-and-skip makes every later launch instant. |
| Several databases served at once, and the agent picks the wrong one | Right shape, wrong company — indistinguishable from a correct answer | Never infer a default when more than one source is ready; refuse and list ([`08`](08-mcpb-extension.md) §8.7). Every result names its company and backup date. |
| Import worker holds `sa` on the container | Privilege beyond what the design claims | `sa` is import-only; the MCP query path uses a `db_datareader` login, every imported DB is `SET READ_ONLY`, port is loopback-only ([`08`](08-mcpb-extension.md) §8.8). |
| Imported backups persist on local disk | Full copies of the books, incl. payroll, left lying around — potentially several, on a Docker volume the user can't see in Finder | Persistence is deliberate (it's what makes startup fast) but must be documented loudly, in the extension UI and in the environment report, with total disk used. `optima-mcp clean` removes container and volume; restored DBs are name-tagged so cleanup never touches someone else's database ([`08`](08-mcpb-extension.md) §8.8). |
| Stale backup mistaken for live data | Wrong conclusions, confidently stated | `optima_describe_environment` always reports the source and the backup's date ([`04`](04-tool-surface.md)). |
| Comarch ships a real API | Strategic | Low near-term probability given their stated position. The domain-analysis layer keeps its value on any substrate. |

## 5.4 Open questions

1. **Write-SQL generation.** I narrowed the brief's "SQL snippet user will execute" to `SELECT`-only, with changes as Optima UI steps ([`03`](03-architecture.md) §3.8). Confirm, or tell me to design a gated write-SQL mode.
2. **Who is the user?** Answered by construction: a directory of backups yields several company databases, so multi-database is first-class from phase 2 ([`08`](08-mcpb-extension.md) §8.7). Cross-client *consolidation* remains excluded.
3. **Output language.** I assumed Polish domain terms inside whatever language the user converses in. Confirm. (Extension config UI text is written in Polish — [`08`](08-mcpb-extension.md) §8.2, §8.10.)
4. **Optima version floor.** Back to 2019, or current releases only? Materially changes knowledge-pack effort. What do target customers actually run? Also sets the container image version: restores go forward only, so the image must be at least as new as the newest backup anyone brings.
5. **Licence and openness.** Is the knowledge pack ([`02`](02-optima-data-model.md) §2.6) open, or the commercial core?
6. **Which Node version does Claude Desktop provide to a bundled server?** Decides the `compatibility.runtimes.node` floor and whether `node:sqlite` is usable ([`08`](08-mcpb-extension.md) §8.5, §8.9). Empirical, cheap, and blocks packaging choices.

### Decided

- **Deployment: local desktop, stdio.** ([`03`](03-architecture.md) §3.2) Credential never leaves the machine, and we never become a data processor for a database full of payroll. Streamable HTTP stays implemented but unsupported until hosted is on the table.
- **Distribution: MCPB bundle is the user-facing install**, `npx` remains the developer and CI path. ([`08`](08-mcpb-extension.md)) A config UI with a native directory picker is the only setup an accountant can complete unaided.
- **Two configuration modes, mutually exclusive:** a directory (or several) of backup files, or a live SQL Server URL. ([`08`](08-mcpb-extension.md) §8.3) Both set is an error, not a precedence rule — the failure mode is analysing a stale backup while believing it's live.
- **Restore target: a managed SQL Server Express container by default**, the user's own instance as an env-var escape hatch for over-50 GB databases. ([`08`](08-mcpb-extension.md) §8.4) A config UI can't reasonably ask for an instance name and a `CREATE DATABASE` login, and pointing the default at the instance that runs live Optima is a bad default.
- **Backup import: background, observable, not a tool.** ([`08`](08-mcpb-extension.md) §8.6) N multi-GB restores can't fit inside a client's startup timeout, and an extension user has no terminal to prewarm in. The model gets *visibility* into an import it cannot trigger or retarget; there is no connect tool and no restore tool.

## 5.5 Next

~~Fastest de-risking: get one real Optima DB with Księga Handlowa data and run S1–S3 in a single sitting.~~ Done — see [`07`](07-spike-0-findings.md). Remaining de-risking: a **second** sample backup to observe actual mask/range usage in zestawienia (the one sampled so far uses none), and to check whether the S1 corrections (`DekretyKonta` not `Dekrety`, missing `Zrodla`) generalise or were specific to that install. Build Phase 1 in parallel — it depends on none of them.

Phase 1 is delivered; **Phase 2 is the MCPB extension** ([`08`](08-mcpb-extension.md) §8.11). Its first two items are cheap empirical checks that can reshape the rest — what Node the host provides, and whether a bundled server can reach Docker at all from a GUI-launched client. Do those before writing container code. Note that phase 2 also makes the second mask-spike sample trivially ingestible: drop a `.bac` in the folder.
