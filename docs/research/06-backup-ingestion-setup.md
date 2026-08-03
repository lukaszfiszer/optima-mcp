# 06 — Backup ingestion: setup UX and mechanics

How the user gets a backup file into the server ([`02`](02-optima-data-model.md) §2.7 decided *that* it happens at startup; this is *how*).

## 6.1 The auth-page idea

**Proposal:** use the MCP authorization step to show a custom page where the user drops a backup file, and the server ingests it.

**Doesn't work.** Four independent reasons, any one of which kills it:

1. **MCP authorization is HTTP-only, and we're stdio.** The spec is explicit: implementations using stdio *SHOULD NOT* follow the authorization specification and should retrieve credentials from the environment. OAuth in MCP exists to protect network-exposed servers from network attackers; a local stdio process has neither problem. Using it would mean abandoning the local-first decision ([`03`](03-architecture.md) §3.2) — and that decision is what keeps us out of data-processor territory on a database full of payroll.
2. **It isn't authorization.** Hijacking the auth handshake to run a setup wizard is a misuse of the step. Client behaviour around auth pages is inconsistent enough when used as intended; it won't be reliable when used as a file-upload UI.
3. **A browser can't give us a local path.** This is the part that kills the idea even in a non-OAuth form. Drag-drop and `<input type=file>` give a `File` object with no absolute path — browsers deliberately withhold it, and the File System Access API gives a handle, not a path. So a web page can't say "ingest the file at `D:\Kopie\CDN_ABC.bac`"; it can only *stream the bytes*.
4. **Streaming the bytes is absurd here.** Real Optima backups run to tens of GB and the file is *already on the same disk as the server*. Uploading it to localhost means reading 20 GB and writing a second 20 GB copy, doubling disk use and adding minutes, to end up with a file we could have opened directly.

**The instinct is right, though.** Editing `claude_desktop_config.json` by hand to add `--backup "D:\Kopie\CDN_ABC.bac"` is a bad ask for an accountant. We want a real file picker. We just need one that returns a *path* — which means native UI, not a web page.

**Revisit when:** hosted HTTP deployment lands ([`05`](05-roadmap-and-open-questions.md) §5.4). Then OAuth is genuinely required — but even then the answer is "connect a live DB or push the backup to object storage", not a browser upload.

## 6.2 Four entry points

Layered, each degrading to the one below. Build L0 first; L1 is the one that delivers the UX the auth-page idea was reaching for.

### L0 — CLI argument (baseline, always works)

```
npx optima-mcp --backup ./CDN_ABC.bac
```

Works in every MCP client, scriptable, testable. The marginal cost is small in context: **you cannot install an MCP server into a client without touching its config anyway**, so adding one argument to a block you're already pasting is not the burden it first appears. Everything else is built on this — L1–L3 all end up invoking it.

### L1 — MCPB bundle with a native file picker (the answer)

Ship an `.mcpb` bundle (formerly `.dxt`). Claude Desktop installs it by double-click or drag into Settings, and renders a native settings UI from the manifest's `user_config`. **`user_config` supports a `file` type that opens a real OS file picker** and substitutes the chosen path into the server's `args`. **[confirmed — MCPB MANIFEST spec]**

```jsonc
{
  "user_config": {
    "backup_file": {
      "type": "file",
      "title": "Plik kopii bezpieczeństwa Optima",
      "description": "Wskaż plik .bac lub .bak z kopią bazy firmowej",
      "required": false
    },
    "sql_server": {
      "type": "string",
      "title": "Serwer SQL",
      "description": "Instancja, na której odtworzyć kopię. Zostaw puste, aby użyć serwera Optima.",
      "default": "localhost\\OPTIMA",
      "required": false
    },
    "sql_password": { "type": "string", "sensitive": true, "required": false }
  },
  "server": {
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/server/index.js",
               "--backup", "${user_config.backup_file}",
               "--sql-server", "${user_config.sql_server}"]
    }
  }
}
```

This is exactly the "drop a backup file" UX, minus every problem in §6.1: native picker, real absolute path, no upload, no byte copying, no HTTP, no OAuth, stdio intact. `sensitive: true` fields go to OS-secure storage rather than process args, which also cleans up credential handling ([`03`](03-architecture.md) §3.6).

Anthropic-specific today, and that's acceptable — it's a packaging convenience layered over L0, not a dependency.

### L2 — `npx optima-mcp setup` (client-agnostic wizard)

Interactive terminal setup for everyone not on Claude Desktop:

- discover local SQL Server instances and Optima databases (`CDN_*`, `CDN_KNF_*`)
- offer a live connection or ask for a backup path (with tab completion — a terminal *can* take a path)
- create the read-only login, run the preflight (§6.3), do the restore with a progress bar
- write the profile to `~/.optima-mcp/config.json` and print the exact client-config block to paste

After setup the client config is just `npx optima-mcp` with no arguments. This doubles as the **prewarm** step ([`02`](02-optima-data-model.md) §2.7): the slow first restore happens here, in a terminal where minutes are fine, not inside a client with a startup timeout.

### L3 — watched folder (zero config)

If no source is configured, look in `~/.optima-mcp/backups/`. Exactly one backup → use it. Several → fail listing them. Docs reduce to "drop your `.bac` in this folder."

Cheap to build, useful for the least technical users. Optional; skip if L1 and L2 land well.

### Progressive enhancement — elicitation

If no source is configured *and* the client advertises `elicitation`, ask for a path mid-session instead of failing. Strictly a bonus: support is uneven and it must never be the only route ([`03`](03-architecture.md) §3.3).

## 6.3 Startup state machine

```
resolveSource()
  --profile        → live connection
  --backup <path>  → ingest(path)
  config file      → whichever it names
  watched folder   → exactly one file? ingest it
  else             → fail with setup instructions (or elicit)

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

**Progress:** no MCP channel exists during startup, so write progress to stderr (clients surface it in logs). `RESTORE` percentage is readable from `sys.dm_exec_requests.percent_complete` on a second connection — use it for the `setup`/`restore` progress bar.

## 6.4 On-disk state

```
~/.optima-mcp/
  config.json         profiles, engine settings   (no secrets)
  state.db            node:sqlite — fingerprint → restored DB, schema cache
  backups/            L3 watched folder
  audit/              query log ([`03`] §3.7)
```

Secrets go to the OS keychain via MCPB `sensitive` fields, or env vars for L0/L2 — never `config.json`.

Restored databases are named `OPTIMAMCP_<fingerprint>` so `clean` is unambiguous and we never touch a database we didn't create. `clean` drops them and removes the data files. Persistence-by-default is a deliberate speed trade-off and gets a loud line in the README, because the artefact is a full copy of the customer's books ([`02`](02-optima-data-model.md) §2.7).

## 6.5 Failure messages

Startup failures are terminal and specific. Each says what to do:

| Condition | Message |
|---|---|
| No source configured | "No Optima database configured. Run `npx optima-mcp setup`, or pass `--backup <plik.bac>` / `--profile <nazwa>`." |
| Backup newer than engine | "Kopia pochodzi z SQL Server <X>; serwer docelowy to <Y>. SQL Server odtwarza tylko w przód — wskaż nowszą instancję przez `--sql-server`." |
| Over Express's 50 GB cap | "Baza po odtworzeniu zajmie <N> GB, limit SQL Server Express to 50 GB. Wskaż instancję, na której działa Optima: `--sql-server`." |
| Wrong collation | "Instancja ma collation <X>, Optima wymaga Polish_CI_AS." |
| Insufficient disk | "Potrzeba <N> GB, wolne <M> GB." |
| Login over-privileged | Warn, don't fail. Serve, and say so in `optima_describe_environment`. |

## 6.6 Build order

| | What | Phase |
|---|---|---|
| 1 | L0 CLI arg + state machine + fingerprint cache + `restore` / `clean` | 4 |
| 2 | L2 `setup` wizard (also the prewarm path) | 4 |
| 3 | L1 MCPB bundle | 4, once L0 is stable — it's a manifest over L0 |
| 4 | L3 watched folder, elicitation | opportunistic |

## Sources

- [Authorization — Model Context Protocol specification](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [MCPB `MANIFEST.md` — `user_config` field types](https://raw.githubusercontent.com/anthropics/mcpb/main/MANIFEST.md)
- [Adopting the MCP Bundle format (.mcpb) for portable local servers](https://blog.modelcontextprotocol.io/posts/2025-11-20-adopting-mcpb/)
- [Desktop Extensions — Anthropic Engineering](https://www.anthropic.com/engineering/desktop-extensions)
