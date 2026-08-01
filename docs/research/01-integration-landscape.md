# 01 — Integration options

Research date 2026-08. Confidence: **[confirmed]** = Comarch docs or multiple sources. **[likely]** = consistent with conventions, not documented. **[unverified]** = hypothesis, must be checked against a real install.

## Available access paths

| Path | What | Verdict |
|---|---|---|
| Public REST API | Does not exist. Comarch's stated position: a public API means public docs, versioning, backwards compat and dev support they haven't committed to. | — |
| Comarch ERP XL API | Documented, but for ERP XL, a different product. | Not applicable |
| COM / Automat Synchronizacji | Windows COM over an installed Optima client. | Needs licensed Optima + Windows host + module licences. Write-oriented, brittle across versions. Rejected. |
| Third-party REST wrappers (WebArm, ELTE-S, Kotrak) | Commercial middleware, local Windows service wrapping COM or SQL. | Paid, closed, adds a licence dependency. Mostly scoped to kontrahenci/towary/faktury, not accounting. Rejected. |
| File import/export (OPT002, OPT009) | Excel/CSV batch import. | One-way, no query. Rejected. |
| Direct SQL | Optima itself ships *Narzędzia → Wykonywanie zapytań SQL*, an admin console running arbitrary SQL against company and config DBs. | **Selected.** |

Direct read-only SQL is the only licence-free, vendor-neutral path. Optima shipping its own SQL console means this is an access path Comarch already exposes, not one we're inventing.

## Support posture

Direct `INSERT`/`UPDATE`/`DELETE` bypasses application business logic (document numbering, rozrachunki, audit trail, period locking, VAT registers). Standard way Optima databases get corrupted, and the standard reason a Comarch partner drops support for an installation. **[high confidence — universal partner practice; exact contractual wording is in the customer's own Comarch agreement]**

Consequence: the server emits no executable mutations. Changes are expressed as Optima UI steps; emitted SQL is `SELECT`-only. See [`03`](03-architecture.md) §3.6.

## Personal data

Comarch publishes a *Struktura zbioru danych osobowych* per release, listing tables holding personal data. Main ones: `CDN.PracEtaty` (employees, full payroll/HR), `CDN.Kontrahenci` (counterparties incl. sole traders), plus spread across document tables. **[confirmed]**

- Returning raw rows to a third-party LLM exfiltrates payroll data — almost certainly outside the customer's DPA.
- Our accounting use cases are aggregate (account structure, balances, statement definitions) and contain almost no personal data.
- Therefore: aggregate by default, deny-list the personal-data tables, opt-in + redaction for anything else.

## Feasibility

Feasible. Accounting-first is right:

- Aggregate, low-PII — sidesteps the section above.
- Chart of accounts and statement definitions are small and structured; fits in context after aggregation, unlike document tables at millions of rows.
- Recurring real problem: "bilans się nie bilansuje" after analytical accounts are added, currently diagnosed by hand position by position.
- Read-only by nature.

Hard parts, in order:

1. Schema is undocumented and drifts across releases ([`02`](02-optima-data-model.md) §2.6).
2. Parsing the zestawienia księgowe formula language ([`02`](02-optima-data-model.md) §2.5).
3. Restoring a customer `.bak`/`.bac` needs an engine at least as new as the one that wrote it ([`02`](02-optima-data-model.md) §2.7).

None are blockers.

## Sources

- [Dlaczego nie ma publicznego REST API do Optimy — WebArm](https://webarm.pl/blog/dlaczego-comarch-nie-ma-rest-api/)
- [WebArm ERP API — moduły Optima przez REST](https://webarm.pl/blog/100-procent-modulow-comarch-optima-przez-rest-api/)
- [Comarch API — ELTE-S](https://elte-s.com/baza-wiedzy/comarch-api/)
- [Comarch Optima API — Kotrak](https://kotrak.com/pl/blog/comarch-optima-api-rozszerzenie-mozliwosci-erp-optima-dzieki-integracji-zewnetrznych-aplikacji/)
- [Wykonywanie zapytań SQL — Comarch KB](https://pomoc.comarch.pl/optima/pl/2026/dokumentacja/wykonywanie-zapytan-sql/)
- [Struktura danych osobowych, Optima 2025.5.1 (PDF)](https://www.graf-cad.pl/images/certyfikaty/struktura_zbioru_danych_osobowych_comarch_erp_optima_2025_5.pdf)
- [OPT057 — Strojenie wydajnościowe baz MS SQL](https://pomoc.comarch.pl/optima/pl/2025/dokumentacja/opt057-strojenie-wydajnosciowe-baz-ms-sql-dla-comarch-erp-optima/)
- [Techniczny opis integracji z Optima — Futuriti WMS](https://wms.futuriti.pl/docs/techniczny-opis-integracji-z-comarch-erp-optima/)
