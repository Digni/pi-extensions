# Read Guard pi Extension

User-global extension: `~/.pi/agent/extensions/read-guard/index.ts`.

It blocks stale or blind edits/writes and tells the agent to re-read the file instead of asking the user for confirmation.

## Policy

Default mode is `stale`.

- `edit` existing file in `stale` mode:
  - file must have been observed in this session
  - file must not have changed externally since the last read or successful agent edit/write
  - touched-line coverage is not required
- `edit` existing file in `range` mode:
  - same stale checks as `stale`
  - when the edited lines can be determined, they must be within ranges that were read
- `edit` existing file in `strict` mode:
  - file must have been fully read in its current version
- `write` existing file in any enabled mode:
  - file must have been fully read in its current version
- `write` new file:
  - allowed
- successful agent `edit`/`write` calls:
  - refresh the known file hash so follow-up edits are not treated as stale just because the agent changed the file
  - in `range` mode, partial read ranges are cleared after line-count-changing edits because line numbers may have shifted
- stale files:
  - blocked; re-read and retry

The guard does not treat this as a permission question. The failure message tells the agent to re-read and retry.

## Commands

```text
/readguard status  Show current mode and tracked file count
/readguard stale   Prevent blind/stale edits with low transcript noise (default)
/readguard range   Require read coverage for edits; full read for existing writes
/readguard strict  Require full current read for edits and writes
/readguard off     Disable the guard
/readguard reset   Clear tracked read state
/readguard on      Alias for stale, kept for older sessions/configs
```

## Startup flag

```bash
pi --read-guard stale
pi --read-guard range
pi --read-guard strict
pi --read-guard off
pi --read-guard on  # alias for stale
```

Because this extension is in `~/.pi/agent/extensions/`, pi auto-loads it globally. Use `/reload` in existing sessions after changing the file.
