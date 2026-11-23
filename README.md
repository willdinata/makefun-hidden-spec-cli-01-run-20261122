# makefun-hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/willdinata/makefun-hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/willdinata/makefun-hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

**mend** — one patch tool for every AI edit format. `main.ts` is a Node 22 command-line
tool, standard library only, that applies a single patch to a tree of text files in any of
the four formats AI models write their edits in:

- **unified diffs**, including diffs whose header line numbers are wrong — each hunk is
  placed at the occurrence nearest the position its numbers suggest;
- **SEARCH/REPLACE blocks**, with the file path taken from the line above the block;
- **V4A patches** (`*** Begin Patch` … `*** End Patch`), with Add / Delete / Update
  sections, `*** Move to:` renames, anchors, end-of-file chunks and a forward-only cursor;
- **JSON edit objects** (one array, or JSON Lines): `create`, `str_replace` and `insert`.

Old lines are matched at three tiers — exact, ignoring trailing whitespace, then ignoring
leading and trailing whitespace — with context lines always written back as the file's own
lines and replaced lines re-indented at the loosest tier; `--strict` keeps only the exact
tier. Every path is checked for safety before anything else about its edit, parse errors
are reported before any file is looked at, a failed edit changes nothing and never stops
the edits after it, and when any edit failed nothing at all is written: the tree changes
completely or not at all. `--check` reports exactly what a run would do and writes
nothing. The report on standard output (`A` / `D` / `M` / `R` lines in byte order, then
`ok: <n> files`) and the exit codes (0, 1, 2) follow the competition's SPEC.md exactly,
as do the per-file line-break rules (a file keeps its own CRLF or LF breaks and its final
break, unless a unified hunk's `\ No newline` markers say otherwise).

`runner.ts` is the kit's trial runner, kept byte for byte; `main.ts` hands a trial to it
when the harness asks, and otherwise runs as the CLI. On the public practice set of 100
checks (exit code, stdout and every resulting file compared), this entry passes 100 of 100.

## Run

Requires Node 22. No dependencies; nothing to install.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is the patch file; with no `PATCH` (or `-`) the patch is read from standard input.
`--format` is one of `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default),
which detects the format from the patch text.

---

<sub>Entered on [make.fun](https://make.fun/?ref=63p7zf8z&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards.</sub>
