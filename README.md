# director-shell-mcp

`director-shell-mcp` is a small MCP server for director-mode agents. It uses the MCP stdio transport to provide a controlled escape hatch for writing files, running Python data-exploration code, running shell commands, and supervising detached background jobs. Commands are started only when an agent explicitly calls a tool; the server does not run a shell on its own.

## Install

Node.js 18 or newer is required. From this directory:

```powershell
npm install
```

Run the server directly with:

```powershell
node C:/path/to/director-shell-mcp/index.js
```

## OMP registration (primary)

The primary client is the Oh My Pi (OMP) harness. Add this exact configuration to the user-level `~/.omp/agent/mcp.json` (or to the project-level `.omp/mcp.json`):

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "director-shell": {
      "command": "node",
      "args": ["C:/path/to/director-shell-mcp/index.js"]
    }
  }
}
```

For stdio servers, `type` may be omitted. After editing the config, run `/mcp reload` and then `/mcp test director-shell` in OMP.

## Generic MCP client registration

Other MCP clients generally accept an equivalent stdio registration:

```json
{
  "mcpServers": {
    "director-shell": {
      "command": "node",
      "args": ["C:/path/to/director-shell-mcp/index.js"]
    }
  }
}
```

## Tool reference

All tools return a JSON object in the MCP text content. Errors are returned as MCP tool errors with a sentence-form `error` field.

### `shell_run`

Runs a command to completion. Parameters:

- `command` (string, required): command text.
- `cwd` (string, optional): working directory.
- `timeout_ms` (integer, optional): defaults to 60,000; maximum 600,000.
- `shell` (`powershell`, `cmd`, or `bash`, optional): defaults to PowerShell on Windows and Bash elsewhere.

The result contains `exit_code`, `duration_ms`, and `stdout`/`stderr` objects. Each stream includes up to approximately 50 KiB of preview text. If a stream exceeds that cap, its object also includes `truncated: true` and `full_output_path` pointing to a temporary file containing the complete stream. A timeout returns an MCP tool error with a clear message and the partial result.

### `write_file`

Writes UTF-8 text to an absolute file path. Parameters:

- `path` (string, required): absolute file path.
- `content` (string, required): text to write.
- `append` (boolean, optional): append instead of replacing; defaults to `false`.
- `create_dirs` (boolean, optional): create missing parent directories; defaults to `true`.

The result contains `path`, `bytes_written`, `created` (whether the file did not exist before the call), and `appended`.

### `edit_file`

Replaces text in a UTF-8 file at an absolute path. Parameters:

- `path` (string, required): absolute file path.
- `old_text` (string, required): non-empty text to find.
- `new_text` (string, required): replacement text.
- `replace_all` (boolean, optional): replace every occurrence; defaults to `false`.

Without `replace_all`, `old_text` must occur exactly once. Zero matches or multiple matches return an MCP tool error and leave the file unchanged. The result contains `path` and `replacements`.

### `run_python`

Runs Python source code to completion with bounded output and a timeout. On Windows, the server probes the `py` launcher first and then `python`; on other systems it probes `python3` first and then `python`, caching the first usable executable. Parameters:

- `code` (string, required): Python source code.
- `cwd` (string, optional): working directory for the Python process.
- `timeout_ms` (integer, optional): defaults to 60,000; maximum 600,000.
- `args` (array of strings, optional): values passed as `sys.argv[1:]`.

The result contains `exit_code`, `duration_ms`, `stdout`/`stderr` objects, and `python_executable`. Output streams are capped and spilled to temporary files using the same behavior as `shell_run`. A timeout returns an MCP tool error with a clear message and the partial result.

### `job_start`

Starts a detached command that continues after the tool call returns. Parameters:

- `command` (string, required)
- `cwd` (string, optional)
- `shell` (`powershell`, `cmd`, or `bash`, optional)
- `name` (string, optional, human-readable label)

The result contains `job_id`, `pid`, `log_paths` (`stdout`, `stderr`, and `combined`), and the `exit_marker` path. Metadata is persisted as JSON beneath `%LOCALAPPDATA%/director-shell-mcp/jobs/<jobId>/`, so jobs remain discoverable after a server restart.

### `job_status`

Reads persisted state for a job. Parameters:

- `job_id` (string, required): an id returned by `job_start`.
- `tail_lines` (integer, optional): defaults to 40; maximum 1,000.

The result contains `running`, `exit_code` (when available), `runtime_ms`, `started_at`, and `output_tail` from the combined log. The detached wrapper writes `exit_code.txt` when the command exits, preserving the exit code across server restarts.

### `job_kill`

Terminates a job started by this server. It accepts `job_id`. On Windows it uses `taskkill /T /F` to terminate the wrapper's process tree. Jobs that were already completed are left unchanged.

### `job_list`

Lists all valid persisted jobs with their `job_id`, optional `name`, `pid`, `running` state, exit code, and start time.

### `grep_files`

Searches an absolute file or directory recursively using a JavaScript regular expression without requiring ripgrep. The search skips `node_modules`, `.git`, `bin`, `obj`, `dist`, and `target`, ignores files larger than 5 MiB and binary files, and stops at the result limit. Parameters:

- `pattern` (string, required): JavaScript regular expression source.
- `path` (string, required): absolute file or directory path.
- `glob` (string, optional): simple filename filter using `*` and `?`.
- `case_sensitive` (boolean, optional): defaults to `false`.
- `max_results` (integer, optional): defaults to 200; maximum 1,000.
- `context_lines` (integer, optional): lines before and after each match; defaults to 0; maximum 5.

The result contains `matches` with `file`, `line_number`, `line`, `before`, and `after`, plus `files_scanned` and `truncated`. Invalid regular expressions return an MCP tool error.

### `job_wait`

Waits for an existing detached job to exit, polling its persisted exit marker every 500 ms. Parameters:

- `job_id` (string, required): id returned by `job_start`.
- `timeout_ms` (integer, optional): defaults to 60,000; maximum 600,000.
- `tail_lines` (integer, optional): defaults to 40; maximum 1,000.

The result has the same fields as `job_status` and adds `timed_out`. A deadline while the job is still running is a normal result with `timed_out: true`, not an MCP error.

### `lock_acquire` and `lock_release`

Provide a cross-agent named mutex persisted beneath `%LOCALAPPDATA%/director-shell-mcp/locks/`. Names contain only letters, digits, `_`, `.`, and `-` and are at most 64 characters. `lock_acquire` accepts `name` (required), `wait_ms` (optional, defaults to 0, maximum 600,000), and an optional `note`; it returns `name`, a UUID `token`, and `acquired_at`. Acquisition uses an atomic directory create and recovers locks whose recorded owner process is no longer alive. A held lock error identifies its pid, note when present, and duration. `lock_release` accepts `name` and the owner `token`; wrong tokens and free locks are errors and do not change the lock.

### `screenshot`

Captures the full virtual screen, or a visible top-level window, to a PNG on Windows using System.Drawing and the Windows APIs. Parameters:

- `target` (`screen` or `window`, optional): defaults to `screen`.
- `window_title` (string, required for `window`): case-insensitive visible-window title substring.
- `output_path` (absolute `.png`, optional): defaults to a timestamped file in the temporary output directory.

The result contains `path`, `width`, `height`, `target`, and the matched `window_title` for window captures. It returns a clear not-supported error on non-Windows systems and a clear no-match error when a requested window cannot be found.

### `process_list`

Returns a read-only process listing on Windows. Parameters:

- `name_filter` (string, optional): case-insensitive substring of a process name or executable path.
- `max_results` (integer, optional): defaults to 100; maximum 1,000.

Each process contains `pid` and `name`, and includes `path`, `started_at`, and `working_set_bytes` when available. The result also contains `truncated`.

### `file_lockers`

Reports processes holding an existing file open on Windows via the Restart Manager API. It accepts `path` (required), which must be an absolute path to an existing file, and returns `{ path, lockers }`. Each locker contains `pid`, `app_name`, and `app_type`; an unlocked file is a successful result with an empty `lockers` array. Non-Windows systems return a clear not-supported error.

## Verification

Run the lightweight end-to-end smoke test (it uses only `echo` and PowerShell sleep):

```powershell
npm run smoke
```

The smoke test starts a fresh MCP server over stdio, performs initialization, lists all fifteen tools, exercises file writing, exact text editing, Python execution and argument passing, command completion and output capture, verifies detached jobs while they are running and after they exit, exercises grep, wait, locks, screenshots, process listing, and Restart Manager file-locker detection, checks persistence through `job_list`, and verifies command timeout handling.

## License

MIT
