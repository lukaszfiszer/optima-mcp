# 01 — Integration landscape & feasibility

*Research date: 2026-08. Sources at the bottom. Findings are labelled with a
confidence level; anything marked **[unverified]** must be re-checked against a
real installation before it is baked into code.*

## 1.1 The premise holds: Optima has no usable programmatic surface

Comarch ERP Optima is one of the most widely deployed ERP/accounting systems in
Poland, and it deliberately ships **no public REST API**. Comarch's own
positioning is that a public API implies public docs, versioning, backwards
compatibility and developer support — commitments they have not made for a
product whose users are accountants and warehouse staff, not programmers.

What actually exists, and why each option is a dead end for our goal:

| Surface | What it is | Why it doesn't work for us |
|---|---|---|
| **Comarch ERP XL API** | The documented API — but for *ERP XL*, a different product | Not Optima |
| **COM / Automat Synchronizacji** | Windows COM automation over the installed Optima client | Requires a licensed Optima install + Windows host + module licences; write-oriented; brittle across versions; not something an end user can point an agent at |
| **Third-party REST wrappers** (WebArm, ELTE-S, Kotrak, various partner "Web API do Optimy") | Commercial middleware, typically a local Windows service either wrapping COM or querying SQL directly | Paid, closed, per-vendor; adds a licence dependency; mostly scoped to trade documents (kontrahenci, towary, faktury), not accounting |
| **File import/export** (OPT002, OPT009 bulletins) | Excel/CSV import paths | One-way, batch, no query capability |
| **Built-in SQL query tool** | Optima itself ships *Narzędzia → Wykonywanie zapytań SQL* (admin-only), executing arbitrary SQL against the company and configuration databases | This is the tell: **Comarch expects power users to read the database directly.** |

**Conclusion:** the only vendor-neutral, licence-free, agent-friendly substrate
is **direct read-only access to the MS SQL Server database.** That matches the
project brief exactly, and the existence of Optima's own SQL console means we
are not inventing an unsanctioned access path — we are automating one Comarch
already exposes.

## 1.2 Legal / support posture — read this before writing code

This is the single most important non-technical constraint, and it shapes the
architecture:

- **Reading is normal. Writing is not.** Direct `INSERT`/`UPDATE`/`DELETE`
  against Optima tables bypasses all application-layer business logic
  (document numbering, rozrachunki, audit trail, period locking, VAT
  registers). It is the classic way to corrupt an Optima database, and it is
  the standard reason a Comarch partner will decline to support an
  installation. **[high confidence — universal practice in the Optima partner
  ecosystem; the exact contractual wording lives in the customer's own
  Comarch agreement and should be confirmed per-deployment]**
- The brief's "all operations read only" rule is therefore not just a safety
  rail — it is what makes the product deployable at all in a real accounting
  office.
- **Design consequence:** the server should never emit an executable mutation.
  Where a change *is* the answer, the output should be **UI steps inside
  Optima** ("Księgowość → Zestawienia księgowe → …"), and any SQL it emits
  should be `SELECT`-only verification/diagnostic queries. See
  [`03-architecture.md` §3.6](03-architecture.md) for the full output contract
  and the rationale for narrowing "SQL snippet the user executes" to read-only
  SQL.

## 1.3 Data protection (RODO/GDPR) — also architecture-shaping

An Optima company database is dense with personal data. Comarch publishes a
"Struktura zbioru danych osobowych" document per release that enumerates the
tables holding it; the headline ones are `CDN.PracEtaty` (employees, full
payroll/HR) and `CDN.Kontrahenci` (counterparties, incl. sole traders), with
secondary spread across every document table. **[high confidence]**

Implications:

1. A naive "let the agent SELECT whatever it wants and paste rows into the
   prompt" design **exfiltrates payroll data to a third-party LLM.** That is a
   processing activity the user's DPA almost certainly does not cover.
2. Our accounting use cases are almost entirely **aggregate** — account
   structure, balances, statement definitions. Very little of that is personal
   data. This is a happy accident we should exploit deliberately.
3. Therefore: **aggregate-by-default, never return raw personal-data rows
   without an explicit opt-in, and keep a redaction layer between the SQL
   results and the tool output.** Ship a default deny-list covering the
   personal-data tables from Comarch's own structure document.

## 1.4 Feasibility verdict

**Feasible, and the accounting-first scoping is the right wedge.**

Why accounting specifically is the best v1, beyond the brief saying so:

- Accounting data is **aggregate and low-PII** — it sidesteps §1.3.
- The chart of accounts and statement definitions are **small, structured, and
  self-describing** — they fit in a context window after aggregation, unlike
  document tables which run to millions of rows.
- The pain is **real and recurring**: "bilans się nie bilansuje" after someone
  adds analytical accounts is a perennial Optima support ticket, and today it
  is diagnosed by hand, position by position. This is a task where an LLM plus
  a good coverage analysis genuinely beats a human with a spreadsheet.
- It is **read-only by nature** — nobody expects an analysis tool to post
  journal entries.

The hard parts, in order of difficulty:

1. **The schema is undocumented and drifts across releases.** (§2 —
   this is the core engineering problem, and the answer is runtime
   introspection plus a curated, versioned knowledge pack.)
2. **Parsing the zestawienia księgowe formula language**, which mixes account
   masks, account functions, arithmetic, references to other positions, and
   raw SQL.
3. **Backup ingestion** — restoring a customer `.bak`/`.bac` requires a SQL
   Server engine at least as new as the one that produced it.

None of these are blockers. All three are addressed in the following documents.

---

## Sources

- [Czy Comarch Optima posiada API? Dlaczego nie ma publicznego REST API do Optimy — WebArm](https://webarm.pl/blog/dlaczego-comarch-nie-ma-rest-api/)
- [WebArm ERP API: moduły Comarch ERP Optima przez REST API](https://webarm.pl/blog/100-procent-modulow-comarch-optima-przez-rest-api/)
- [Comarch API: integracja ERP Optima i XL z aplikacjami — ELTE-S](https://elte-s.com/baza-wiedzy/comarch-api/)
- [Comarch Optima API — Kotrak](https://kotrak.com/pl/blog/comarch-optima-api-rozszerzenie-mozliwosci-erp-optima-dzieki-integracji-zewnetrznych-aplikacji/)
- [Wykonywanie zapytań SQL — Baza Wiedzy Comarch ERP Optima](https://pomoc.comarch.pl/optima/pl/2026/dokumentacja/wykonywanie-zapytan-sql/)
- [Struktura danych osobowych w systemie Comarch ERP Optima 2025.5.1 (PDF)](https://www.graf-cad.pl/images/certyfikaty/struktura_zbioru_danych_osobowych_comarch_erp_optima_2025_5.pdf)
- [OPT057 — Strojenie wydajnościowe baz MS SQL dla Comarch ERP Optima](https://pomoc.comarch.pl/optima/pl/2025/dokumentacja/opt057-strojenie-wydajnosciowe-baz-ms-sql-dla-comarch-erp-optima/)
- [Techniczny opis integracji z Comarch ERP Optima — Futuriti WMS](https://wms.futuriti.pl/docs/techniczny-opis-integracji-z-comarch-erp-optima/)
