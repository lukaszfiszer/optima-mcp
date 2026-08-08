# 08 — MCPB extension: configuration, container, backup import

The next deliverable after the Phase 1 skeleton ([`05`](05-roadmap-and-open-questions.md) §5.2): a **fully working MCPB extension** an accountant installs by double-clicking a file and configuring in a UI — no terminal, no JSON editing, no connection string.

This is the authoritative design for ingestion and packaging; [`06`](06-backup-ingestion-setup.md) holds the reasoning behind the setup UX, [`02`](02-optima-data-model.md) §2.7 the backup format facts.

Research date 2026-08. **[unverified]** marks claims not yet exercised against a real install.

Sections §8.4 (PATH) and §8.9 (runtime) were revised 2026-08-08 after reading the MCPB specs and the shipped Claude Desktop bundle — see §8.13 for what was established and how.

## 8.1 The requirement

Two configuration modes, exactly one active per installation:

| Mode | User configures | Server does |
|---|---|---|
| **A — live** | URL of an existing SQL Server holding the Optima database | Connects read-only, serves. This is the Phase 1 skeleton path, reached through a UI instead of an env var. |
| **B — backups** | One or more **directories** containing Optima backup files | Starts a local SQL Server **in a container**, imports every backup found, re-imports only those that changed, serves all of them |

Mode B is what makes the extension worth building. It is also what [`06`](06-backup-ingestion-setup.md) §6.1 concluded needs a *native* directory picker returning a real path — which is exactly what MCPB's `user_config` provides.

Three consequences ripple outward, and they are the substance of this document:

1. **A directory means N backups, not one** → the server serves **several company databases** at once, so the tool surface needs a database selector (§8.7).
2. **N multi-GB restores cannot finish inside a client's startup timeout**, and an extension user has no terminal in which to prewarm → the import sits **behind** the serving boundary as observable state, not a startup blocker (§8.6).
3. **A container runtime is a hard dependency of mode B** (§8.4).

## 8.2 Configuration surface

`user_config` supports `directory` with `multiple: true`, and `string` with `sensitive: true` (masked in the UI, stored by the host's secret store, passed via env). That is precisely the shape needed.

```json
{
  "user_config": {
    "backup_dirs": {
      "type": "directory",
      "title": "Folder z kopiami bazy Optima",
      "description": "Folder z plikami .bac / .bak. Można wskazać kilka folderów. Zostaw puste, jeśli łączysz się z serwerem SQL.",
      "multiple": true,
      "required": false
    },
    "live_server_url": {
      "type": "string",
      "title": "Adres serwera SQL z bazą Optima",
      "description": "Np. Server=localhost\\OPTIMA;Database=CDN_ABC;User Id=optima_ro;Password=…  Zostaw puste, jeśli wskazujesz folder z kopiami.",
      "sensitive": true,
      "required": false
    }
  }
}
```

**Two fields, no more.** The visible configuration is exactly the two modes. In particular there is no "restore into my own SQL Server instead" field, even though that path exists for databases over Express's 50 GB cap (§8.4): a second URL box next to the first one destroys the "exactly one of these" clarity §8.3 rests on, and a user who can tell a restore *target* from a data *source* can set `OPTIMA_RESTORE_TARGET` in the env. Revisit only if the over-cap case turns out to be common rather than rare.

Wiring — `backup_dirs` expands to one argument per selected directory; the URL goes through env so no credential lands in an argv visible to `ps`:

```json
"server": {
  "type": "node",
  "entry_point": "server/index.js",
  "mcp_config": {
    "command": "node",
    "args": ["${__dirname}/server/index.js", "--backup-dir", "${user_config.backup_dirs}"],
    "env": {
      "OPTIMA_CONNECTION_STRING": "${user_config.live_server_url}"
    }
  }
}
```

Deliberately **not** configurable in the UI: SQL Server image and edition, `sa` password, container name, host port, memory cap, collation, restore target. Every one of them is a decision the user cannot make well and we can (§8.4). Each is overridable by an env var for our own debugging and for the rare power user, undocumented in the UI.

**No `sa` password field.** We generate one per installation (32 chars, CSPRNG), store it `0600` in the state directory (§8.5), and never show it. Asking an accountant to invent a password that satisfies SQL Server's policy is a support ticket, and a user-chosen one would be reused from somewhere else.

## 8.3 Mode resolution

```
backup_dirs set, no live_server_url   → mode B (§8.4, §8.5)
live_server_url set, no backup_dirs   → mode A (Phase 1 path, unchanged)
both set                              → configuration error, terminal
neither set                           → configuration error, terminal
```

Both-set is an error rather than a precedence rule: silently ignoring one half of a configuration a user deliberately filled in is how someone ends up analysing a six-month-old backup while believing they are looking at live data — the failure [`05`](05-roadmap-and-open-questions.md) §5.3 ranks as "wrong conclusions, confidently stated". `OPTIMA_RESTORE_TARGET` is a modifier on mode B, not a third mode.

Configuration errors surface differently than in a CLI: an MCPB user sees a dead server in the extension list. So a configuration error must **not** exit the process. Instead the server starts, serves, and answers every tool call with the actionable message (§8.10) — a broken configuration the user can read is worth more than a clean exit code they never see.

## 8.4 The container

**Decided: mode B runs SQL Server in a container we manage.** Asking a config UI for an instance name costs the user a lookup they may not know how to do, plus a login with `CREATE DATABASE`, plus a real chance of restoring a client's backup into the production instance that runs their live Optima. A managed container has none of those failure modes and one of its own — Docker must exist. That trade is worth it, and the user's own instance remains reachable through `OPTIMA_RESTORE_TARGET` for the over-50 GB case.

### Runtime discovery

Any Docker-API-compatible CLI: Docker Desktop, Colima (used in [`07`](07-spike-0-findings.md)), Rancher Desktop, Podman via `podman` with the Docker CLI shim.

**The PATH problem is smaller than it looked, but the probe stays.** GUI-launched applications on macOS inherit a minimal `PATH` — typically no `/usr/local/bin`, no `/opt/homebrew/bin` — which would leave a bundled server unable to resolve `docker` at all. Reading the shipped Claude Desktop bundle (§8.12) shows the host already mitigates this in two layers:

1. **Login-shell environment extraction.** A separate utility process (`shellPathWorker.js`) runs the user's login shell and reports its environment back; the main process merges the result into its own `process.env`, so children inherit a terminal-parity `PATH` rather than the launchd stub. It has a 5-second timeout and a retry budget, and **falls back to the bare process environment on failure** — the failure path is real, just uncommon.
2. **A `PATH` floor** appended on top when entries are missing: `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`, `~/.nvm/versions/node/*/bin`, `~/.orbstack/bin`, `~/.rd/bin`, `~/.local/bin`, `~/.volta/bin`, mise/asdf/pyenv shims, Nix profiles, `/usr/bin`. That OrbStack and Rancher Desktop appear by name is direct evidence container CLIs are expected to resolve here.

So `docker` very likely resolves without help, and Colima (the `07` setup) lands in `/usr/local/bin` or `/opt/homebrew/bin` — in the floor either way. **The explicit ladder below is still required**: it costs almost nothing, and it covers the extraction-failure fallback, Docker Desktop's own install path, and Windows, none of which the floor addresses. What changes is sequencing — this is no longer a mode-killing unknown, so §8.11 item 2 no longer blocks item 3. Probe in order:

```
$OPTIMA_DOCKER (escape hatch)
`which docker` on the inherited PATH
/usr/local/bin/docker, /opt/homebrew/bin/docker, ~/.docker/bin/docker,
  /Applications/Docker.app/Contents/Resources/bin/docker
/usr/local/bin/podman, /opt/homebrew/bin/podman
Windows: %ProgramFiles%\Docker\Docker\resources\bin\docker.exe
```

Then verify the daemon actually answers (`docker info`) — an installed-but-not-running Docker Desktop is the common case, and it gets its own message (§8.10). Never auto-install a container runtime.

### Instance

```
docker run -d --name optima-mcp-mssql
  -e ACCEPT_EULA=Y
  -e MSSQL_PID=Express
  -e MSSQL_COLLATION=Polish_CI_AS
  -e MSSQL_SA_PASSWORD=<generated>
  -e MSSQL_MEMORY_LIMIT_MB=<min(4096, 40% host RAM)>
  -p 127.0.0.1:11433:1433
  -v optima-mcp-mssql-data:/var/opt/mssql
  -v <backup_dir_1>:/backups/1:ro  [... one per configured directory]
  mcr.microsoft.com/mssql/server:2025-latest
```

Every line is load-bearing:

- **`MSSQL_PID=Express`** — free for production use, so no licensing grey area for a user analysing their own books. Note that on the 2025 (`ver17`) images `Developer` **is not a valid `MSSQL_PID`** (the values are `Express`, `Standard`, `StandardDeveloper`, `Enterprise`, `EnterpriseCore`, `EnterpriseDeveloper`, `Evaluation`) — and the developer editions are EULA-barred from production anyway ([`02`](02-optima-data-model.md) §2.7.1). Express's 50 GB cap is what `OPTIMA_RESTORE_TARGET` exists for.
- **`MSSQL_COLLATION=Polish_CI_AS`** — Optima's required collation, set correctly at creation rather than discovered in preflight and reported as a failure ([`06`](06-backup-ingestion-setup.md) §6.3). **This only takes effect at first initialisation of the data volume**, so a volume created with the wrong collation must be recreated, not reconfigured. Record the collation alongside the volume in state and refuse to reuse a mismatched one.
- **`-p 127.0.0.1:11433`** — loopback only. Binding `0.0.0.0` would expose a database of someone else's books to the local network. Scan upward from 11433 if taken and persist the chosen port.
- **Named volume for data, bind mount for backups, `:ro`.** The restored data files live in the volume (Docker-managed, on the VM disk on macOS/Windows — its free space is what matters for preflight, not the host disk holding the backups). The backup directories are mounted read-only: we never need to write there, and the mount makes the file readable at a path inside the container, which is what `RESTORE FROM DISK` requires. The container process runs as a non-root user, so a backup directory that is not world-readable will fail on open rather than on SQL syntax — worth its own diagnostic **[unverified: exact behaviour under Docker Desktop's file sharing on macOS vs. Windows]**.
- **`--platform linux/amd64` on Apple Silicon.** The images are amd64-only; [`07`](07-spike-0-findings.md) ran them under Rosetta via Colima. Restores are slower under emulation. Detect arm64 and say so in the environment report rather than letting the user conclude the tool is slow.

**Lifecycle:** reuse a running container that matches our name, image and collation; `docker start` it if stopped; create it only if absent. On graceful shutdown, **stop but do not remove** — restarting is seconds, whereas losing the volume means re-restoring every backup. `optima-mcp clean` (and a documented Docker command, since an MCPB user has no CLI) removes container and volume.

## 8.5 Import pipeline

```
scan()   for each configured directory, non-recursive, *.bac + *.bak
         (recursive is a trap: Optima backup folders accumulate
          per-day subfolders and a scan could enqueue 90 restores)

for each file, serially:
  fp = fingerprint(size, mtime, hash(first + last 1 MiB))
  registry lookup by (source path):
    same fp, DB present on engine   → up to date, nothing to do   ← the common case
    same fp, DB missing             → drop entry, import
    different fp                    → source changed: import, then drop the old DB
    no entry                        → import
  preflight (seconds, before the minutes):
    RESTORE HEADERONLY   → engine version >= backup version; capture DatabaseName
    RESTORE FILELISTONLY → Σ file sizes; volume free space >= that × 1.2
                           over 50 GB on Express → skip this file, report it
  RESTORE DATABASE OPTIMAMCP_<company>_<fp8> FROM DISK='/backups/<n>/<file>'
    WITH MOVE ..., RECOVERY
  verify CDN schema present; fingerprint Optima version
  ALTER DATABASE ... SET READ_ONLY
  grant the read-only login
  register: source path, fp, mtime, db name, company, imported_at
  publish: this database is now queryable
```

Notes that matter:

- **Serial, not parallel.** Concurrent restores on an Express instance with 4 cores and a capped buffer pool are slower in aggregate and make progress unreportable. Order by file mtime descending — newest backup first, because that is the one the user is asking about.
- **Change detection is the fingerprint, as designed** ([`06`](06-backup-ingestion-setup.md) §6.3) — now per file rather than per process. The requirement's "if the backup has changes" is exactly this: `mtime` alone is too weak (copying a folder rewrites it), a full-content hash of 20 GB is too slow, size + mtime + 2 MiB of content is the working compromise.
- **A vanished source file does not drop its database.** The user may have moved backups off to make room; the imported copy is still valid data. Report it as `source file no longer present` and keep serving. Only a *superseded* fingerprint drops the old database.
- **One database per file, several files per company.** Two dated backups of the same company are two sources, both queryable, distinguished by backup date — which is the point of allowing a directory. Deduplicate only on identical fingerprints.
- **Over-50 GB is a per-file failure, not a mode failure.** Import everything that fits and report what didn't, naming the remedy.

### State

```
~/.optima-mcp/
  state.json      registry: sources → fingerprints → databases; container port, volume, collation
  sa.key          generated sa password, mode 0600
  audit/          query log ([`03`](03-architecture.md) §3.7)
```

`state.json` rather than a `node:sqlite` store, for one specific reason: `node:sqlite` needs Node 22.5+, and under MCPB the **host** supplies the Node runtime, whose version we don't control. A registry of a handful of entries doesn't need SQL, and the alternative (`better-sqlite3`) is a native build, which is the one thing [`03`](03-architecture.md) §3.4 spent its dependency budget avoiding. The schema cache keeps using `node:sqlite` when the runtime offers it and degrades to in-memory when it doesn't.

## 8.6 Serving before the import finishes

**Decided: import is a background process observable through the tool surface, not a startup gate.**

A folder of five 20 GB backups is an hour of restoring, and an extension user has no terminal in which to do that ahead of time. Restoring before serving would mean the client kills the server on first run and the extension looks broken — the risk in [`05`](05-roadmap-and-open-questions.md) §5.3. So:

```
t0   server starts, container starts, MCP serves immediately
t0+  import worker runs (§8.5), publishing each database as it completes
```

Each source carries state: `queued → preflight → importing (percent) → ready | failed(reason) | skipped(reason)`.

- **`optima_describe_environment` is the progress UI.** It always reports every configured source with its state, percent, and ETA. No new tool: an agent asked "what can you see?" calls it already, and a *second* status tool would get called instead of it half the time.
- **Progress comes from `sys.dm_exec_requests.percent_complete`** on a second connection ([`06`](06-backup-ingestion-setup.md) §6.3), plus MCP logging notifications for clients that surface them, plus stderr.
- **A tool call against a not-yet-ready database is refused with progress**, not queued and not silently answered from a different database: "Baza CDN_ABC jest w trakcie importu (43%, ok. 6 min). Gotowe: CDN_XYZ." An LLM handles an honest "not yet, try in 6 minutes" well; it handles a 40-minute hang badly.
- **No restore tool and no connect tool** ([`04`](04-tool-surface.md)). What the model gets is *visibility* into an import it cannot trigger, retarget, or cancel. The data source is fixed by configuration; what varies is only when each one becomes ready.

## 8.7 Several databases, one server

Mode B routinely yields more than one company database, which the tool surface has never had to model.

- Every tool takes an optional **`database`** argument naming a source. Omitted with exactly one ready source → that one. Omitted with several → refuse and list them with company name and backup date. Guessing "probably the newest" here would be a confidently-wrong-numbers bug of the worst kind: right shape, wrong company.
- `optima_describe_environment` takes no `database` and reports all of them ([`04`](04-tool-surface.md)).
- Identifiers exposed to the model are stable, readable labels (`CDN_ABC (kopia 2026-07-31)`), never internal `OPTIMAMCP_*` names and never file paths — a path is a filesystem detail, and paths in tool arguments invite path-shaped requests.
- **Cross-company consolidation stays excluded** ([`04`](04-tool-surface.md)). Selecting among databases is not aggregating across them; comparing two dated backups of one company is a later, separately specified tool.

This answers [`05`](05-roadmap-and-open-questions.md) §5.4 Q2 by construction: multi-database is first-class, so the biuro-rachunkowe shape is supported whether or not it was the target.

## 8.8 Security posture in container mode

Mode B changes the read-only story of [`03`](03-architecture.md) §3.7 in one respect — we hold `sa` on the container, because `RESTORE DATABASE` requires it — so the compensating controls have to be explicit:

1. `sa` is used **only** by the import worker. The MCP query path connects as a `db_datareader`-only login, created by us, and the statement gate still applies to everything it sends.
2. Every imported database is `SET READ_ONLY` ([`06`](06-backup-ingestion-setup.md) §6.3). Engine-enforced, free, and there is no path in mode B that needs it writable again.
3. Loopback-only port binding, generated password, `0600` key file, `:ro` backup mounts (§8.4).
4. The imported databases are full copies of the books including payroll, potentially several of them, on a Docker volume the user cannot see in Finder. The confidentiality warning in [`02`](02-optima-data-model.md) §2.7 has to be louder here: the extension's UI text must say what it copies and where, and the environment report must state total disk used and how to remove it.
5. Mode A keeps its posture unchanged and unchanged in kind: we get a read-only login and never anything more.

## 8.9 Packaging

- `manifest.json`, `server/` with the bundled entry point, `node_modules` installed `--production`, icon, `mcpb pack` → one `.mcpb` file. `mcpb validate` in CI on every commit; a manifest that fails validation is a broken release the CI can catch for free.
- **`manifest_version`: `0.3`** — the version the spec declares current (last updated 2025-12-02). Note the spec's own `uv` example uses `0.4`, and Claude Desktop sends `x-mcpb-manifest-version: 0.4` when querying the extension registry, so `0.4` exists in practice ahead of the written spec. Stay on `0.3`: we use no field that requires more, and `mcpb validate` is the arbiter.
- `compatibility.platforms`: `darwin`, `win32`, `linux`.

### `compatibility.runtimes.node`: declare it, and keep the floor genuinely low

**Decided: declare `runtimes.node` as the spec requires, set to the true minimum the bundled code needs — and keep that minimum low enough that the host's built-in Node clears it.**

[`MANIFEST.md`](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md#compatibility) is explicit — *"Only specify the runtime(s) your extension actually uses… For Node.js extensions: specify `node` version"* — and the field is a portability declaration for **any** MCPB host, not a Claude Desktop hint. A host with no embedded runtime has nothing else to go on. Omitting it is not an option.

What the host findings change is the *value*, not the decision to declare. There is no `node` binary inside Claude.app: "Node.js ships with Claude" means Electron's *embedded* Node, and a `type: "node"` server whose `command` is `node` with a script in `args[0]` runs in an Electron **`utilityProcess`** on that build's `process.versions.node`. The resolution ladder (§8.13):

| Declared | Built-in satisfies it | Result |
|---|---|---|
| a range | yes | **built-in node** — the target |
| a range | no | searches the machine for a system Node, takes the first install matching the range, **else the highest found** — which may not satisfy the range at all |
| nothing | — | built-in node *when the host's `isUsingBuiltInNodeForMcp` flag is on*; with it off, the highest system Node found, matched against nothing |

Two consequences, and neither is "declare nothing":

1. **A floor above the built-in is the thing to avoid.** It is the one input that moves us off the host's runtime onto whatever Node the user happens to have, picked by the host, with no signal in the UI. So the floor is a real engineering constraint on the code, not a number chosen after the fact: no `node:sqlite`, no APIs newer than the floor, target output the built-in can run. Our stated Node 22+ development stack ([`03`](03-architecture.md) §3.4) is about the dev and `npx` path — the bundle's declared floor must be the lower figure we actually need.
2. **The declaration is not enforced end-to-end**, since the last-resort branch takes the highest system Node regardless of the range. So it never removes the need to check `process.versions.node` in our own startup path, report it in the environment report and the log banner (§8.12), and fail with the message in §8.10 if the runtime is genuinely too old. The declaration is what well-behaved hosts match against; the startup check is what catches the ones that don't.

**[unverified: the built-in version.]** Read it from the log banner on the first real install (§8.11 item 1), then set the floor at or below it. Until then the safe provisional value is the lowest version the code actually requires — do not raise it to match the dev environment.

Consequences to carry:

- **`process.execPath` is Claude, not `node`.** Nothing may re-spawn the server by `execPath`. Spawning `docker` is unaffected.
- **§8.5's `state.json` decision is reinforced.** `node:sqlite` availability tracks Electron's Node, which is not a version we choose — the schema cache's degrade-to-in-memory path is the only safe posture.
- Bundle a single esbuild output plus a minimal `node_modules` ([`03`](03-architecture.md) §3.4 already targets a bundled ESM CLI), so the `.mcpb` stays small and the dependency surface auditable.

Remaining packaging notes:

- Signing: `mcpb sign` / `verify` exist; unsigned bundles install with a warning. Sign before any distribution outside the repo **[unverified: exact host UX for unsigned bundles]**.
- `npx optima-mcp` stays supported as the developer and CI entry point ([`06`](06-backup-ingestion-setup.md) §6.2). The bundle is packaging over the same server, not a second implementation.

## 8.10 Failure messages

Extending [`06`](06-backup-ingestion-setup.md) §6.5. In mode B these arrive as tool output rather than stderr (§8.3), so each must be readable by someone who has never seen a terminal.

| Condition | Message |
|---|---|
| Neither directory nor server configured | "Nie wskazano źródła danych. W ustawieniach rozszerzenia wybierz folder z kopiami bazy Optima **albo** podaj adres serwera SQL." |
| Both configured | "Wskazano jednocześnie folder z kopiami i adres serwera SQL. Wybierz jedno źródło — inaczej nie da się stwierdzić, które dane analizujesz." |
| No container runtime found | "Nie znaleziono Dockera. Aby analizować kopie bazy, zainstaluj Docker Desktop (docker.com), albo podaj adres istniejącego serwera SQL." |
| Runtime installed, daemon down | "Docker jest zainstalowany, ale nie działa. Uruchom Docker Desktop i odśwież rozszerzenie." |
| Directory contains no backups | "W folderze <X> nie ma plików .bac ani .bak." |
| Backup newer than engine | "Kopia pochodzi z SQL Server <X>; serwer docelowy to <Y>. SQL Server odtwarza tylko w przód." |
| Over Express's 50 GB cap | "Baza <X> po odtworzeniu zajmie <N> GB, limit darmowego SQL Server Express to 50 GB. Wskaż własny serwer SQL w ustawieniach zaawansowanych." |
| Insufficient volume space | "Potrzeba <N> GB na dysku Dockera, wolne <M> GB. Zwiększ limit dysku w Docker Desktop albo usuń nieużywane kopie (`optima-mcp clean`)." |
| Backup unreadable in container | "Nie można odczytać pliku <X> — sprawdź uprawnienia do folderu i to, że jest udostępniony Dockerowi (Docker Desktop → Settings → Resources → File sharing)." |
| Volume collation mismatch | "Istniejący kontener ma collation <X>, Optima wymaga Polish_CI_AS. Usuń go: `optima-mcp clean`." |
| Query against importing DB | "Baza <X> jest w trakcie importu (<N>%, ok. <M> min). Gotowe bazy: <lista>." |
| Emulated architecture | Warn, don't fail: "SQL Server działa w emulacji x86 na procesorze ARM — import będzie wolniejszy." |
| Node runtime too old | "Rozszerzenie wymaga Node <X>; klient udostępnia <Y>." |

## 8.11 Build order

Mode A first — it is the Phase 1 skeleton reached through a config UI, so it validates the whole bundle path (packaging, `user_config` substitution, host Node version, sensitive-value handling) with no container in the way. Then mode B on top.

| # | Item | Done when |
|---|---|---|
| 0 | Log file, levels, rotation, startup banner (§8.12) | Every later item is debuggable from a file the user can send. **First, because it is how items 1–2 get answered on a real machine** |
| 1 | Manifest, `user_config`, packaging, `mcpb validate` in CI | Installing the `.mcpb`, pasting a server URL into the UI, and getting an environment report — no JSON edited. The banner confirms §8.9's runtime branch against a real install |
| 2 | Docker discovery + probe (§8.4) | The banner names a `docker` path and a live daemon on macOS and Windows. No longer gates item 3 — §8.4 establishes the host supplies a usable `PATH` — but the ladder still ships |
| 3 | Container lifecycle: create/reuse/start/stop, volume, port, collation guard | A container comes up with the right collation and survives a restart |
| 4 | Scan + fingerprint + registry (§8.5), no restore yet | Correct import/skip decisions reported for a folder of backups |
| 5 | Import worker: preflight, restore, verify, `SET READ_ONLY`, read-only login | A folder of backups becomes N read-only databases |
| 6 | Async serving: source states, progress, refusal-with-progress (§8.6) | Cold start on a 20 GB backup is a visible import, not a dead extension |
| 7 | `database` argument and multi-source reporting (§8.7) | Two companies in one folder are both reachable, unambiguously |
| 8 | Disclosure, disk reporting, `clean` (§8.8) | The user can see what was copied where, and remove it |
| 9 | Log path in the environment report, redaction pass (§8.12) | Asked "why isn't this working", the agent names the file to send — and it contains no credentials |

Independent of Phase 2/3 accounting work ([`05`](05-roadmap-and-open-questions.md) §5.2) and of the still-open mask spike — this is ingestion and packaging, not schema.

## 8.12 Diagnostics and logging

**Requirement: the extension must be debuggable from inside Claude Desktop, by someone with no terminal, on a machine we do not have.** Everything Phase 1 could diagnose by reading stderr in a terminal has to be recoverable from a file the user can find and send us.

This is not a nicety. Under MCPB, three of the things most likely to go wrong are invisible by construction: which Node the host chose (§8.9 — four possible branches), what `PATH` the process actually received (§8.4 — extraction, floor, or fallback), and what happened during an import that takes 40 minutes behind the serving boundary (§8.6). A user reporting "it doesn't work" cannot answer any of those, and neither can we.

### Our own log file, not the host's

Write to `~/.optima-mcp/logs/optima-mcp-<date>.log`, alongside the audit log ([`03`](03-architecture.md) §3.7) — **in addition to** stderr, never instead of it.

Claude Desktop captures server stderr to `~/Library/Logs/Claude/mcp-server-<name>.log` (`%APPDATA%\Claude\logs\` on Windows), and that stays the first thing to ask for. But it is the host's mechanism, not ours: it is undocumented, it has changed before, and a `utilityProcess`-hosted server (§8.9) is not a spawned child, so **whether its stderr lands in that file at all is [unverified — confirm on the first real install]**. A log path we own is the one artifact we can be sure exists and can name in a support reply.

- Rotate by day, keep 7 files, cap each at 10 MB. An import worker logging progress is chatty, and this must never fill a disk.
- `OPTIMA_LOG_LEVEL` (`error|warn|info|debug`, default `info`) — `debug` is what we ask a tester to set. Undocumented in the UI, like the other env escape hatches (§8.2).
- One line per event, timestamped, levelled, with a stable event name. Plain text over JSON: the reader is a human pasting it into an issue.

### The startup banner

The single most valuable thing in the file. One block, every launch, at `info`, before anything can fail:

```
optima-mcp <version>  build <git sha>
runtime   node <process.versions.node>  electron=<yes|no>  execPath=<path>
platform  darwin arm64  (emulation: n/a)
mode      B — backups         config source: user_config
dirs      /Users/x/Kopie  (2 files: *.bac)
docker    /opt/homebrew/bin/docker  (found via: PATH)  daemon: ok  27.3.1
state     ~/.optima-mcp/state.json   log: ~/.optima-mcp/logs/optima-mcp-2026-08-08.log
```

`electron=yes` (inferred from `process.versions.electron` / `execPath` not being a `node` binary) is what tells us instantly which §8.9 branch fired. **Log the resolved `PATH` at `debug`** — it is the whole of §8.4's uncertainty in one line — but not at `info`, since it is long and can carry directory names from the user's machine.

### What must be logged

| Event | Level | Why |
|---|---|---|
| Startup banner | info | Answers §8.9 and §8.4 without a round trip |
| Docker probe: every candidate path tried, which hit, `docker info` outcome | debug / info on failure | The failure mode we cannot reproduce remotely |
| Every `docker` invocation: argv, exit code, duration, stderr tail | debug | Container lifecycle bugs are argv bugs |
| Container decision: reuse / start / create, and why (name, image, collation match) | info | §8.4's guard is invisible otherwise |
| Per source: fingerprint, registry decision (up-to-date / changed / new / missing DB) | info | §8.5's whole contract in one line per file |
| Preflight results: `HEADERONLY` version, `FILELISTONLY` sizes, free space | info | Turns a skip into an explained skip |
| Restore progress ticks | debug | Chatty by nature; `info` gets start and finish only |
| State transition per source (`queued → … → ready\|failed\|skipped`) | info | Reconstructs a 40-minute import after the fact |
| Every tool call: name, `database` argument, duration, row count, outcome | info | Pairs with the audit log; shows refusals-with-progress actually firing |
| Configuration errors (§8.3) | error | These do not exit the process, so the log is the only record |

### Redaction, and the environment report

Never logged, at any level: the connection string, the generated `sa` password, any query result row. The `PATH` and the configured directory paths are `debug`-only. This is the same rule as [`03`](03-architecture.md) §3.7 — credentials never enter the model context, and they must not enter a file a user pastes into a public issue either.

**`optima_describe_environment` reports the log file's path**, so an agent asked "why isn't this working" can tell the user exactly which file to send. Same reasoning as §8.6 making it the progress UI: one tool the model already calls, rather than a diagnostics tool that competes with it.

## 8.13 How the host behaviour in §8.4 and §8.9 was established

Recorded because the conclusions are load-bearing and the sources are not documentation.

The MCPB specs answer neither question. `README.md` says only *"Node.js ships with Claude for macOS and Windows"* — no version, no mechanism — and [modelcontextprotocol/mcpb#89](https://github.com/modelcontextprotocol/mcpb/issues/89) is an open request that Anthropic document exactly this. `MANIFEST.md` describes `compatibility.runtimes.node` as a requirement without saying what a host does when it is not met. Neither document mentions the child process's environment or `PATH` at all.

So both were read out of the shipped application: Claude Desktop **1.26832.0** on macOS, `Contents/Resources/app.asar` unpacked with `@electron/asar` and the main-process bundle read directly. That yielded the `utilityProcess` runtime-selection ladder in §8.9, the login-shell extractor and `PATH` floor in §8.4, and the `x-mcpb-manifest-version: 0.4` header in §8.9.

Two caveats on that evidence:

1. **It is one build on one platform.** Minified internals are not an API and can change without notice. Everything here should be re-confirmed against the log banner (§8.12) on the first real install, and nothing in the design may *depend* on the internals — §8.4's probe ladder and §8.9's "declare nothing" both hold regardless of what the host does.
2. **The `PATH` floor was confirmed on the Claude-Code-in-Desktop spawn path**; that the extension spawn path shares it was not traced to the end. Treated as likely, not certain — which is why the probe ladder stays.

Also noted: the repository has moved from `anthropics/mcpb` to `modelcontextprotocol/mcpb`.

## Sources

- [MCPB manifest specification](https://github.com/anthropics/mcpb/blob/main/MANIFEST.md) — `user_config` types, `directory` + `multiple`, `sensitive`, `${user_config.*}` substitution, `compatibility.runtimes`
- [MCPB README](https://github.com/anthropics/mcpb/blob/main/README.md) — bundle layout, "Node.js ships with Claude for macOS and Windows", `node_modules --production`
- [MCPB CLI](https://github.com/anthropics/mcpb/blob/main/CLI.md) — `init`/`validate`/`pack`/`sign`/`verify`/`info`/`unsign`, `.mcpbignore`, PKCS#7 signature format
- [MCPB examples](https://github.com/anthropics/mcpb/tree/main/examples) — `hello-world-node` (all `user_config` types), `file-system-node` (`directory` + `multiple: true` expanding into args)
- [mcpb#89 — runtime policy is undocumented](https://github.com/modelcontextprotocol/mcpb/issues/89) — open request for the Node version and delivery mechanism; why §8.9 was settled empirically
- Claude Desktop 1.26832.0 (macOS), `Contents/Resources/app.asar` — the `utilityProcess` runtime ladder (§8.9) and the login-shell `PATH` extraction and floor (§8.4). Not documentation; see §8.13
- [Adopting the MCP Bundle format (.mcpb)](https://blog.modelcontextprotocol.io/posts/2025-11-20-adopting-mcpb/) — which clients implement it
- [Configure environment variables for SQL Server on Linux — Microsoft Learn](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-configure-environment-variables?view=sql-server-ver17) — `MSSQL_COLLATION`, `MSSQL_PID` values for the 2025 images (no `Developer`), `MSSQL_MEMORY_LIMIT_MB`
- [Docker: run containers for SQL Server on Linux — Microsoft Learn](https://learn.microsoft.com/en-us/sql/linux/quickstart-install-connect-docker?view=sql-server-ver17)
- [Editions and supported features of SQL Server 2025 — Microsoft Learn](https://learn.microsoft.com/en-us/sql/sql-server/editions-and-components-of-sql-server-2025?view=sql-server-ver17) — Express 50 GB cap
- [`07`](07-spike-0-findings.md) — the Colima + amd64-emulation setup that restored a real `.bac`
