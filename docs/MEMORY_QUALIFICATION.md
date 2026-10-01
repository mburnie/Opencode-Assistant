# Memory qualification — 1 Oct 2026

Repair and qualification of Leroy's existing memory implementation (SQLite
`memory/data.db` behind the HTTP MCP server on `127.0.0.1:4097`), done before
benchmarking it. Scope was fixing confirmed defects only — no redesign.

Fix commit: `829f4f0` — fix(memory): repair fact deduplication and SQLite backups.

## Confirmed defects fixed

1. **Whitespace-padded fact de-duplication.** `addFact()` looked duplicates up
   by trimmed content but stored the untrimmed input, so the same padded input
   added twice created two facts. It now stores the trimmed content.
   Regression tests: `tests/memory/repositories/facts.test.ts`.
2. **Memory backup missed the authoritative SQLite database.** `backupMemory()`
   (the scheduled `backup` task) copied only the legacy pre-SQLite `.md` files,
   so no fact, document or summary held in SQLite was ever backed up. It now
   adds a consistent `data.db` snapshot using the SQLite online backup API.
   Regression test: `tests/memory/manager-backup.test.ts`.

## Verified working

- Fact persistence, retrieval (`fact_search`, `fact_recent`) and deletion.
- Document persistence; `soul` and `agents` refused by `memory_write`, as are
  unknown document names.
- Audit logging of fact and document mutations, including the outcome of
  deletes (`deleted: true/false`).
- Session-context injection: the first message of a new session receives soul,
  personality, agents, skills, the 20 newest facts and the session summary,
  read fresh from SQLite; later messages get only the channel marker.
- Session-summary storage/retrieval path: `memory_write("session-summary")`
  → SQLite → next session's context and `memory_get_session_context`.
- Restart persistence (verified on a copy across separate processes, and live
  across a Leroy restart with a temporary test fact, since deleted).
- SQLite backup and restore: a snapshot restored into an empty folder matched
  the source exactly (facts, documents, skills, tasks, audit, schema) and
  passed `PRAGMA integrity_check`.
- WAL journal mode on the live database.

Test results at closure: full suite 1,159 passed / 5 todo (133 files);
memory + MCP 207 passed; lint 0 warnings; typecheck clean.

## Intended limitations (by design, not changed)

- No semantic fact de-duplication — only exact (trimmed content, category).
- No contradiction handling.
- No fact update/replacement operation (only add and delete).
- Fact search is substring-only (`LIKE`, case-insensitive, word-order
  sensitive) when no embedding provider is configured.
- Vector search is currently disabled (`EMBEDDING_BASE_URL` empty).
- The model decides when to update the session summary (triggers are in the
  soul); nothing generates it automatically.
- Only the newest 20 facts are injected automatically; older ones need
  `fact_search`.
- The Markdown memory files are not live mirrors of SQLite; SQLite is the
  source of truth and the `.md` files are a legacy import source.
- `/memory_export` is lossy: it drops fact ids, timestamps and sources, the
  audit log and scheduled tasks, and its output can only be re-imported into
  an empty database (personality is not re-imported).

## Still unresolved / future decisions (not part of this repair)

- **Automatic scheduled backups are not wired.** `CRON_BACKUP_ENABLED` /
  `CRON_BACKUP_SCHEDULE` are documented in `.env.example` but no code has ever
  read them; no weekly backup runs unless a `backup` task is created.
- **Memory write permissions need a benchmark decision.** OpenCode's config
  allows `memory_write`, `memory_read`, `fact_search`, `fact_recent` and a few
  read tools, but `fact_add`, `fact_delete` and the rest default to "ask".
  OpenCode v2 also calls MCP tools through its code-mode `execute` tool; how
  the per-tool permission rules apply on that route is unverified.
- **Model compliance with session-summary triggers needs measurement.** No
  memory write of any kind was recorded between 28 Sep 02:21 UTC and this
  qualification.
- **Audit quirks:** a de-duplicated re-add is still logged as `fact_added`;
  events sharing a millisecond come back in arbitrary order (`ORDER BY ts`
  only); one historical `fact_updated` event has no emitter in current code.
- **Telegram bot / HTTP MCP process coupling is unchanged:** the memory server
  lives inside the bot process, and Cockpit also depends on port 4097.
- The `session-summary.md` file watcher is dead legacy code (nothing writes
  that file any more); harmless, left in place.
