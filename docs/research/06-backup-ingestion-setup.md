# 06 — Backup ingestion: setup UX and mechanics

Why the setup UI is a native directory picker rather than a web page, and why the restore has to be preflighted. The end-to-end design is [`08`](08-mcpb-extension.md); this document holds the reasoning behind two of its choices.

## 6.1 The auth-page idea

**Proposal:** use the MCP authorization step to show a custom page where the user drops a backup file, and the server ingests it.

**Doesn't work.** Four independent reasons, any one of which kills it:

1. **MCP authorization is HTTP-only, and we're stdio.** The spec is explicit: implementations using stdio *SHOULD NOT* follow the authorization specification and should retrieve credentials from the environment. OAuth in MCP exists to protect network-exposed servers from network attackers; a local stdio process has neither problem. Using it would mean abandoning the local-first decision ([`03`](03-architecture.md) §3.2) — and that decision is what keeps us out of data-processor territory on a database full of payroll.
2. **It isn't authorization.** Hijacking the auth handshake to run a setup wizard is a misuse of the step. Client behaviour around auth pages is inconsistent enough when used as intended; it won't be reliable when used as a file-upload UI.
3. **A browser can't give us a local path.** This is the part that kills the idea even in a non-OAuth form. Drag-drop and `<input type=file>` give a `File` object with no absolute path — browsers deliberately withhold it, and the File System Access API gives a handle, not a path. So a web page can't say "ingest the file at `D:\Kopie\CDN_ABC.bac`"; it can only *stream the bytes*.
4. **Streaming the bytes is absurd here.** Real Optima backups run to tens of GB and the file is *already on the same disk as the server*. Uploading it to localhost means reading 20 GB and writing a second 20 GB copy, doubling disk use and adding minutes, to end up with a file we could have opened directly.

**The instinct is right, though.** Editing `claude_desktop_config.json` by hand to add a backup path is a bad ask for an accountant. A real file picker is the right answer — it just has to be a *native* one that returns a path, not a web page. MCPB's `user_config` is exactly that, in directory form ([`08`](08-mcpb-extension.md) §8.2).

**Revisit when:** hosted HTTP deployment lands ([`05`](05-roadmap-and-open-questions.md) §5.4). Then OAuth is genuinely required — but even then the answer is "connect a live DB or push the backup to object storage", not a browser upload.

## 6.2 Entry points

The **MCPB bundle** is the user-facing entry point ([`08`](08-mcpb-extension.md)). Its reach is narrow — Claude Desktop and Claude Code, plus a gated implementation in MCP for Windows; Cursor, VS Code, Windsurf, LM Studio, Goose and ChatGPT don't support it — but the target user is on Claude Desktop, and for that user the bundle is the only tolerable install.

The **CLI** stays as the developer, CI and power-user path, over identical code:

```
npx optima-mcp --backup-dir "D:\Kopie"      # repeatable
npx optima-mcp "Server=...;Database=CDN_ABC;..."
npx optima-mcp clean                        # drop imported DBs, container, volume
```

Works in every MCP client, scriptable, testable. The marginal cost of a flag is smaller than it looks for anyone editing config anyway: **you cannot install an MCP server into a client without touching its config**, so it's one argument in a block they're already pasting. What the bundle buys is that the accountant never sees that block at all.

An **Electron desktop wrapper** would be client-agnostic and can also return real local paths. Deferred and unscoped — the bundle covers the target user at a fraction of the cost.

## 6.3 Why the restore is preflighted

The per-file pipeline is [`08`](08-mcpb-extension.md) §8.5. Two properties of it are the reason it looks the way it does:

- **Preflight before the long operation.** `RESTORE HEADERONLY`, `FILELISTONLY`, a free-space check and a collation check are seconds each; the restore is minutes. Failing on collation after 8 minutes of restore is the difference between a tool that feels solid and one that feels broken.
- **`SET READ_ONLY` on every imported database.** Free, engine-enforced immutability on top of the read-only login and the statement gate ([`03`](03-architecture.md) §3.7). On the backup path there is no reason for the database ever to be writable again, so make it structurally impossible.

**Progress** is readable from `sys.dm_exec_requests.percent_complete` on a second connection, which is what makes an import reportable rather than an opaque wait ([`08`](08-mcpb-extension.md) §8.6).

## 6.4 On-disk state

```
~/.optima-mcp/
  state.json          import registry: sources → fingerprints → databases;
                      container port, volume, collation
  sa.key              generated container password, mode 0600
  audit/              query log ([`03`](03-architecture.md) §3.7)
```

Secrets are generated locally or come from env vars and the host's secret store — never from a plaintext config file. `state.json` rather than `node:sqlite` because under MCPB the host supplies the Node runtime and `node:sqlite` needs 22.5+ ([`08`](08-mcpb-extension.md) §8.5).

Imported databases are named `OPTIMAMCP_<company>_<fingerprint>` so `clean` is unambiguous and we never touch a database we didn't create. Persistence-by-default is a deliberate speed trade-off and gets a loud line in the README, because the artefact is a full copy of the customer's books ([`02`](02-optima-data-model.md) §2.7).

## 6.5 Failure messages

Failures are specific, and each says what to do. Under the extension they arrive as tool output rather than stderr, because that user never sees a terminal — the full table is [`08`](08-mcpb-extension.md) §8.10. The general rules:

| Condition | Handling |
|---|---|
| Insufficient disk, wrong collation, backup newer than the engine | Fail this source before the long restore, with the number or version that's wrong and the setting that fixes it |
| Over Express's 50 GB cap | Fail this source only; import the rest and name the alternative |
| Login over-privileged | Warn, don't fail. Serve, and say so in `optima_describe_environment` |

## 6.6 Build order

Directory scan, fingerprint registry, import worker and `clean` are part of the MCPB deliverable: [`08`](08-mcpb-extension.md) §8.11 is the build order, [`05`](05-roadmap-and-open-questions.md) §5.2 the phase list.

## Sources

- [Authorization — Model Context Protocol specification](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [Adopting the MCP Bundle format (.mcpb) for portable local servers](https://blog.modelcontextprotocol.io/posts/2025-11-20-adopting-mcpb/) — names Claude Desktop, Claude Code and MCP for Windows as the implementers
- [Register an MCP server with an MCP bundle — Microsoft Learn](https://learn.microsoft.com/en-us/windows/ai/mcp/servers/mcp-mcpb) — the Windows gating caveat
- [Which AI tools actually support MCP well right now — MCP Bundles](https://www.mcpbundles.com/blog/state-of-mcp-clients)
