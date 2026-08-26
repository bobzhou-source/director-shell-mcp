# director-shell-mcp

`director-shell-mcp` is a small MCP server for director-mode agents. It uses the MCP stdio transport to provide a controlled escape hatch for running shell commands and supervising detached background jobs. Commands are started only when an agent explicitly calls a tool; the server does not run a shell on its own.

## Install

Node.js 18 or newer is required. From this directory:

```powershell
npm install
```

Run the server directly with:

```powershell
node C:/Users/RZHOU/Desktop/director-shell-mcp/index.js
```

## OMP registration (primary)

The primary client is the Oh My Pi (OMP) harness. Add this exact configuration to the user-level `~/.omp/agent/mcp.json` (or to the project-level `.omp/mcp.json`):

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "director-shell": {
      "command": "node",
      "args": ["C:/Users/RZHOU/Desktop/director-shell-mcp/index.js"]
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
      "args": ["C:/Users/RZHOU/Desktop/director-shell-mcp/index.js"]
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

## Verification

Run the lightweight end-to-end smoke test (it uses only `echo` and PowerShell sleep):

```powershell
npm run smoke
```

The smoke test starts a fresh MCP server over stdio, performs initialization, lists all five tools, exercises command completion and output capture, verifies a detached job while it is running and after it exits, checks persistence through `job_list`, and verifies a two-second timeout against a thirty-second sleep.
