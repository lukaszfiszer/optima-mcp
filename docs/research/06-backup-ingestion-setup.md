# 06 — Backup ingestion: setup UX and mechanics

How the user gets a backup file into the server ([`02`](02-optima-data-model.md) §2.7 decided *that* it happens at startup; this is *how*).

## 6.1 The auth-page idea

**Proposal:** use the MCP authorization step to show a custom page where the user drops a backup file, and the server ingests it.

**Doesn't work.** Four independent reasons, any one of which kills it:

1. **MCP authorization is HTTP-only, and we're stdio.** The spec is explicit: implementations using stdio *SHOULD NOT* follow the authorization specification and should retrieve credentials from the environment. OAuth in MCP exists to protect network-exposed servers from network attackers; a local stdio process has neither problem. Using it would mean abandoning the local-first decision ([`03`](03-architecture.md) §3.2) — and that decision is what keeps us out of data-processor territory on a database full of payroll.
2. **It isn't authorization.** Hijacking the auth handshake to run a setup wizard is a misuse of the step. Client behaviour around auth pages is inconsistent enough when used as intended; it won't be reliable when used as a file-upload UI.
3. **A browser can't give us a local path.** This is the part that kills the idea even in a non-OAuth form. Drag-drop and `<input type=file>` give a `File` object with no absolute path — browsers deliberately withhold it, and the File System Access API gives a handle, not a path. So a web page can't say "ingest the file at `D:\Kopie\CDN_ABC.bac`"; it can only *stream the bytes*.
4. **Streaming the bytes is absurd here.** Real Optima backups run to tens of GB and the file is *already on the same disk as the server*. Uploading it to localhost means reading 20 GB and writing a second 20 GB copy, doubling disk use and adding minutes, to end up with a file we could have opened directly.

**The instinct is right, though.** Editing `claude_desktop_config.json` by hand to add `--backup "D:\Kopie\CDN_ABC.bac"` is a bad ask for an accountant. A real file picker is the right long-term answer — it just has to be a *native* one that returns a path, not a web page. Deferred, see §6.2.

**Revisit when:** hosted HTTP deployment lands ([`05`](05-roadmap-and-open-questions.md) §5.4). Then OAuth is genuinely required — but even then the answer is "connect a live DB or push the backup to object storage", not a browser upload.

## 6.2 Entry point: CLI argument

**Decided for v1: CLI argument only.**

```
npx optima-mcp --backup ./CDN_ABC.bac
npx optima-mcp restore ./CDN_ABC.bac    # prewarm: slow first restore, in a terminal
npx optima-mcp clean                    # drop restored DBs and delete files
```

Works in every MCP client, scriptable, testable. The marginal cost is smaller than it looks: **you cannot install an MCP server into a client without touching its config anyway**, so this is one argument in a block the user is already pasting.

`restore` and `clean` are plain subcommands over the same state machine (§6.3), not a wizard. `restore` exists because the first ingest of a large backup can outlast a client's startup timeout ([`02`](02-optima-data-model.md) §2.7) — running it once in a terminal moves that wait somewhere it does no harm.

### Later, not now

Two ways to get the native file picker §6.1 concluded we'd need. Both are packaging over this CLI, neither is v1, and neither should influence any v1 decision:

- **MCPB bundle.** Native config UI with a real file picker. Reach is narrow — Claude Desktop and Claude Code, plus a gated implementation in MCP for Windows; Cursor, VS Code, Windsurf, LM Studio, Goose and ChatGPT don't support it.
- **Electron desktop wrapper.** Client-agnostic, and can return real local paths.

Defer both until the tool surface has proven itself.

## 6.3 Startup state machine

```
resolveSource()
  --profile        → live connection
  --backup <path>  → ingest(path)
  config file      → whichever it names
  else             → fail with usage instructions

ingest(path)
  fingerprint = hash(size, mtime, first+last 1 MiB)
  state lookup:
    hit, and DB still exists on the engine  → reuse, serve now      ← fast path
    hit, but DB is gone                     → drop stale entry, continue
  resolve engine: --sql-server | discovered | Express fallback   ([`02`] §2.7.1)
  PREFLIGHT (all failures terminal, all messages actionable):
    · engine reachable, login can CREATE DATABASE
    · RESTORE HEADERONLY → backup engine version <= target version
    · instance collation is Polish_CI_AS
    · RESTORE FILELISTONLY → Σ file sizes; free disk >= that × 1.2
  unwrap .bac if it turns out to be a container            (spike S4)
  RESTORE DATABASE OPTIMAMCP_<fp> ... WITH MOVE, RECOVERY
  verify: CDN schema present; fingerprint Optima version
  ALTER DATABASE OPTIMAMCP_<fp> SET READ_ONLY
  create/grant the read-only login
  record: fingerprint → db name, source path, source mtime, restored_at
  serve
```

Two details worth keeping:

- **`SET READ_ONLY` on the restored database.** Free, engine-enforced immutability on top of the read-only login and the statement gate ([`03`](03-architecture.md) §3.7). On the backup path there is no reason for the database ever to be writable again, so make it structurally impossible.
- **Preflight before the long operation.** Every one of those checks is seconds; the restore is minutes. Failing on collation after 8 minutes of restore is the difference between a tool that feels solid and one that feels broken.

**Progress:** no MCP channel exists during startup, so write progress to stderr (clients surface it in logs). `RESTORE` percentage is readable from `sys.dm_exec_requests.percent_complete` on a second connection — use it for the `restore` progress bar.

## 6.4 On-disk state

```
~/.optima-mcp/
  config.json         profiles, engine settings   (no secrets)
  state.db            node:sqlite — fingerprint → restored DB, schema cache
  audit/              query log ([`03`] §3.7)
```

Secrets come from env vars — never `config.json`.

Restored databases are named `OPTIMAMCP_<fingerprint>` so `clean` is unambiguous and we never touch a database we didn't create. `clean` drops them and removes the data files. Persistence-by-default is a deliberate speed trade-off and gets a loud line in the README, because the artefact is a full copy of the customer's books ([`02`](02-optima-data-model.md) §2.7).

## 6.5 Failure messages

Startup failures are terminal and specific. Each says what to do:

| Condition | Message |
|---|---|
| No source configured | "No Optima database configured. Pass `--backup <plik.bac>` or `--profile <nazwa>`." |
| Backup newer than engine | "Kopia pochodzi z SQL Server <X>; serwer docelowy to <Y>. SQL Server odtwarza tylko w przód — wskaż nowszą instancję przez `--sql-server`." |
| Over Express's 50 GB cap | "Baza po odtworzeniu zajmie <N> GB, limit SQL Server Express to 50 GB. Wskaż instancję, na której działa Optima: `--sql-server`." |
| Wrong collation | "Instancja ma collation <X>, Optima wymaga Polish_CI_AS." |
| Insufficient disk | "Potrzeba <N> GB, wolne <M> GB." |
| Login over-privileged | Warn, don't fail. Serve, and say so in `optima_describe_environment`. |

## 6.6 Build order

All of v1 is one item: the CLI argument, the state machine, the fingerprint cache, and the `restore` / `clean` subcommands — phase 4 ([`05`](05-roadmap-and-open-questions.md) §5.2).

MCPB and the Electron wrapper are deferred and unscoped (§6.2).

## Sources

- [Authorization — Model Context Protocol specification](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [Adopting the MCP Bundle format (.mcpb) for portable local servers](https://blog.modelcontextprotocol.io/posts/2025-11-20-adopting-mcpb/) — names Claude Desktop, Claude Code and MCP for Windows as the implementers
- [Register an MCP server with an MCP bundle — Microsoft Learn](https://learn.microsoft.com/en-us/windows/ai/mcp/servers/mcp-mcpb) — the Windows gating caveat
- [Which AI tools actually support MCP well right now — MCP Bundles](https://www.mcpbundles.com/blog/state-of-mcp-clients)
