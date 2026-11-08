---
name: director-shell-mcp
description: Use when an AI agent needs a controlled MCP escape hatch to run shell commands, write or exactly edit files, run Python data exploration, supervise detached background jobs, take cross-agent locks, grep files, list processes, or capture screenshots, for example in multi-agent Roblox Studio or director-mode orchestration workflows.
---

# director-shell-mcp

MCP stdio server (Node.js 18+, MIT) that gives director-mode AI agents shell, file, Python, job, lock and screenshot tools. Source: https://github.com/bobzhou-source/director-shell-mcp

## Install and register

```sh
git clone https://github.com/bobzhou-source/director-shell-mcp.git
cd director-shell-mcp && npm install
```

Register it as a stdio server in any MCP client (Oh My Pi `~/.omp/agent/mcp.json`, Claude Code, Codex):

```json
{ "mcpServers": { "director-shell": { "command": "node", "args": ["/abs/path/to/director-shell-mcp/index.js"] } } }
```

In OMP run `/mcp reload` then `/mcp test director-shell`.

## Agent instructions

1. Prefer the client's native read/edit tools; reach for director-shell when the host agent lacks shell, Python or job control.
2. Use `shell_run` for commands that finish within `timeout_ms` (default 60 s, max 600 s). Pick `shell` explicitly (`bash`, `powershell`, `cmd`) when the platform matters.
3. Anything longer (builds, training, servers, playtests): `job_start`, then `job_wait` or `job_status` with `tail_lines`; stop it with `job_kill`. Never loop `shell_run` to poll.
4. Edit with `edit_file`: `old_text` must match exactly once unless `replace_all` is true. Zero or multiple matches are errors and leave the file untouched; re-read and retry with more context.
5. When several agents share files or a Studio session, wrap the critical section in `lock_acquire` / `lock_release`.
6. If a result stream is `truncated: true`, read the complete output from `full_output_path` instead of rerunning the command.
7. Use `screenshot` (`screen` or `window` by title) for visual audits, and `process_list` / `file_lockers` to diagnose stuck processes or locked files.

## Tool reference

| Tool | Purpose |
|---|---|
| `shell_run` | Run a command to completion; returns `exit_code`, `duration_ms`, `stdout`, `stderr` (about 50 KiB preview each) |
| `write_file` | Write or append UTF-8 text to an absolute path, creating parent dirs |
| `edit_file` | Exact-match text replacement in a file |
| `run_python` | Run Python source with optional `cwd`, `args`, `timeout_ms` |
| `job_start` / `job_status` / `job_wait` / `job_kill` / `job_list` | Detached background job lifecycle with log tails |
| `grep_files` | Regex search across a file or directory with glob filter and context lines |
| `lock_acquire` / `lock_release` | Named cross-agent locks |
| `screenshot` | PNG of the screen or a titled window |
| `process_list` | Running processes filtered by name or path |
| `file_lockers` | Which processes hold a file open |

## Related

- Roblox AI game pipeline that uses this server: https://robertzhou.dev/work/roblox-ai-pipeline/
- Portfolio: https://robertzhou.dev

Author: Robert Zhou (https://robertzhou.dev) · ORCID 0009-0009-2155-7215 · Colby College
