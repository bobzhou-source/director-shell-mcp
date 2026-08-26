import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, createWriteStream, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const SERVER_VERSION = "1.0.0";
const OUTPUT_LIMIT = 50 * 1024;
const MAX_TIMEOUT_MS = 600_000;
const MAX_TAIL_LINES = 1_000;
const MAX_GREP_RESULTS = 1_000;
const MAX_GREP_CONTEXT = 5;
const MAX_PROCESS_RESULTS = 1_000;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCK_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const IS_WINDOWS = process.platform === "win32";
const DEFAULT_SHELL = IS_WINDOWS ? "powershell" : "bash";
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const JOBS_DIR = join(LOCAL_APP_DATA, "director-shell-mcp", "jobs");
const LOCKS_DIR = join(LOCAL_APP_DATA, "director-shell-mcp", "locks");
const TEMP_OUTPUT_DIR = join(tmpdir(), "director-shell-mcp");
const SERVER_FILE = fileURLToPath(import.meta.url);
const SKIPPED_SEARCH_DIRECTORIES = new Set(["node_modules", ".git", "bin", "obj", "dist", "target"]);
const MAX_SEARCH_FILE_BYTES = 5 * 1024 * 1024;
let cachedPythonProbe;

const TOOL_DEFINITIONS = [
  {
    name: "shell_run",
    description: "Run a shell command to completion, with bounded output and a timeout.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command text to execute." },
        cwd: { type: "string", description: "Working directory for the command." },
        timeout_ms: { type: "integer", default: 60000, minimum: 1, maximum: MAX_TIMEOUT_MS },
        shell: { type: "string", enum: ["powershell", "cmd", "bash"], default: DEFAULT_SHELL },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Write UTF-8 text to an absolute file path, optionally appending and creating parent directories.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path to write." },
        content: { type: "string", description: "UTF-8 text to write." },
        append: { type: "boolean", default: false, description: "Append instead of replacing the file." },
        create_dirs: { type: "boolean", default: true, description: "Create missing parent directories before writing." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description: "Replace an exact text occurrence in a UTF-8 file at an absolute path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path to edit." },
        old_text: { type: "string", description: "Non-empty text that must occur exactly once unless replace_all is true." },
        new_text: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", default: false, description: "Replace every occurrence instead of requiring exactly one." },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
  },
  {
    name: "run_python",
    description: "Run Python code with optional arguments, bounded output, and a timeout.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Python source code to execute." },
        cwd: { type: "string", description: "Working directory for the Python process." },
        timeout_ms: { type: "integer", default: 60000, minimum: 1, maximum: MAX_TIMEOUT_MS },
        args: { type: "array", items: { type: "string" }, description: "Arguments passed to Python as sys.argv[1:]." },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "job_start",
    description: "Start a detached long-running command and persist its logs and metadata.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command text to execute." },
        cwd: { type: "string", description: "Working directory for the command." },
        shell: { type: "string", enum: ["powershell", "cmd", "bash"], default: DEFAULT_SHELL },
        name: { type: "string", description: "Optional human-readable job name." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "job_status",
    description: "Read a persisted job's state, exit code, runtime, and recent combined output.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Job id returned by job_start." },
        tail_lines: { type: "integer", default: 40, minimum: 0, maximum: MAX_TAIL_LINES },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "job_kill",
    description: "Terminate a job previously started by this server.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string", description: "Job id returned by job_start." } },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "job_list",
    description: "List all persisted jobs known to this server.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "grep_files",
    description: "Recursively search text files with a JavaScript regular expression.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression source." },
        path: { type: "string", description: "Absolute file or directory path to search." },
        glob: { type: "string", description: "Optional simple filename filter using * and ? wildcards." },
        case_sensitive: { type: "boolean", default: false },
        max_results: { type: "integer", default: 200, minimum: 1, maximum: MAX_GREP_RESULTS },
        context_lines: { type: "integer", default: 0, minimum: 0, maximum: MAX_GREP_CONTEXT },
      },
      required: ["pattern", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "job_wait",
    description: "Wait for a persisted job to exit, or return when the wait deadline expires.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Job id returned by job_start." },
        timeout_ms: { type: "integer", default: 60000, minimum: 1, maximum: MAX_TIMEOUT_MS },
        tail_lines: { type: "integer", default: 40, minimum: 0, maximum: MAX_TAIL_LINES },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "lock_acquire",
    description: "Acquire a persisted cross-agent named mutex.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Mutex name using letters, digits, underscore, dot, or hyphen." },
        wait_ms: { type: "integer", default: 0, minimum: 0, maximum: MAX_TIMEOUT_MS },
        note: { type: "string", description: "Optional note describing the lock holder." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "lock_release",
    description: "Release a persisted mutex using the token returned by lock_acquire.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Mutex name." },
        token: { type: "string", description: "Token returned by lock_acquire." },
      },
      required: ["name", "token"],
      additionalProperties: false,
    },
  },
  {
    name: "screenshot",
    description: "Capture the full screen or a visible window to a PNG file on Windows.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["screen", "window"], default: "screen" },
        window_title: { type: "string", description: "Case-insensitive title substring required for window capture." },
        output_path: { type: "string", description: "Optional absolute .png output path." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "process_list",
    description: "List visible system processes and available executable details on Windows.",
    inputSchema: {
      type: "object",
      properties: {
        name_filter: { type: "string", description: "Optional case-insensitive substring of process name or executable path." },
        max_results: { type: "integer", default: 100, minimum: 1, maximum: MAX_PROCESS_RESULTS },
      },
      additionalProperties: false,
    },
  },
  {
    name: "file_lockers",
    description: "List processes holding an existing file open on Windows.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path to an existing file." } },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

function defaultShell() {
  return DEFAULT_SHELL;
}
async function validateCwd(cwd) {
  if (!cwd) return;
  try {
    const stats = await fs.stat(cwd);
    if (!stats.isDirectory()) throw new Error(`The cwd path is not a directory: ${cwd}.`);
  } catch (error) {
    if (error.message.startsWith("The cwd path is")) throw error;
    if (error.code === "ENOENT") throw new Error(`The cwd directory does not exist: ${cwd}.`);
    throw new Error(`The cwd directory cannot be accessed: ${error.message}.`);
  }
}


function validateShell(value) {
  const shell = value === undefined ? defaultShell() : value;
  if (!["powershell", "cmd", "bash"].includes(shell)) {
    throw new Error(`Shell must be one of powershell, cmd, or bash; received ${JSON.stringify(shell)}.`);
  }
  return shell;
}

function shellInvocation(shell, command) {
  if (shell === "powershell") {
    return IS_WINDOWS
      ? { executable: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] }
      : { executable: "pwsh", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] };
  }
  if (shell === "cmd") {
    if (!IS_WINDOWS) throw new Error("The cmd shell is only available on Windows.");
    return { executable: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { executable: "bash", args: ["-lc", command] };
}

function shellProbe(shell) {
  const invocation = shellInvocation(shell, "exit 0");
  const probe = spawnSync(invocation.executable, invocation.args, {
    stdio: "ignore",
    windowsHide: true,
    timeout: 10_000,
  });
  if (probe.error?.code === "ENOENT") {
    throw new Error(`The ${shell} shell executable is not available on this system.`);
  }
  if (probe.error) {
    throw new Error(`The ${shell} shell could not be started: ${probe.error.message}.`);
  }
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

function jsonResult(value, isError = false) {
  return {
    isError,
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(message) {
  return jsonResult({ error: message }, true);
}

function parseObjectArguments(request) {
  const args = request.params?.arguments;
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be a JSON object.");
  return args;
}

function requireCommand(args) {
  if (typeof args.command !== "string" || args.command.trim() === "") {
    throw new Error("The command parameter is required and must be a non-empty string.");
  }
  return args.command;
}

function optionalCwd(args) {
  if (args.cwd !== undefined && (typeof args.cwd !== "string" || args.cwd.trim() === "")) {
    throw new Error("The cwd parameter must be a non-empty string when provided.");
  }
  return args.cwd;
}
function requireAbsolutePath(args) {
  if (typeof args.path !== "string" || args.path.trim() === "") {
    throw new Error("The path parameter is required and must be a non-empty absolute path.");
  }
  if (!isAbsolute(args.path)) {
    throw new Error(`The path parameter must be an absolute path; received ${JSON.stringify(args.path)}.`);
  }
  return args.path;
}

function booleanValue(args, name, defaultValue) {
  const value = args[name] === undefined ? defaultValue : args[name];
  if (typeof value !== "boolean") throw new Error(`The ${name} parameter must be a boolean when provided.`);
  return value;
}

function pythonExecutable() {
  if (cachedPythonProbe) {
    if (cachedPythonProbe.error) throw new Error(cachedPythonProbe.error);
    return cachedPythonProbe.executable;
  }
  const candidates = IS_WINDOWS ? ["py", "python"] : ["python3", "python"];
  for (const executable of candidates) {
    let probe;
    try {
      probe = spawnSync(executable, ["--version"], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
    } catch {
      continue;
    }
    if (!probe.error && probe.status === 0) {
      cachedPythonProbe = { executable };
      return executable;
    }
  }
  const attempted = candidates.join(" and ");
  const error = `No usable Python executable is available; tried ${attempted}.`;
  cachedPythonProbe = { error };
  throw new Error(error);
}

function timeoutValue(args) {
  const timeout = args.timeout_ms === undefined ? 60_000 : args.timeout_ms;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw new Error(`timeout_ms must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
  }
  return timeout;
}

function tailValue(args) {
  const tail = args.tail_lines === undefined ? 40 : args.tail_lines;
  if (!Number.isInteger(tail) || tail < 0 || tail > MAX_TAIL_LINES) {
    throw new Error(`tail_lines must be an integer between 0 and ${MAX_TAIL_LINES}.`);
  }
  return tail;
}

function boundedInteger(args, name, defaultValue, minimum, maximum) {
  const value = args[name] === undefined ? defaultValue : args[name];
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function filenameGlobRegex(glob) {
  if (glob === undefined) return null;
  if (typeof glob !== "string" || glob.length === 0) {
    throw new Error("The glob parameter must be a non-empty string when provided.");
  }
  let source = "^";
  for (const character of glob) {
    if (character === "*") source += ".*";
    else if (character === "?") source += ".";
    else source += character.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
  }
  return new RegExp(`${source}$`, "i");
}

async function searchFiles(rootPath, pattern, filenameFilter, caseSensitive, maxResults, contextLines) {
  const matches = [];
  let filesScanned = 0;
  let truncated = false;
  const visitedDirectories = new Set();

  async function scanFile(filePath) {
    if (filenameFilter && !filenameFilter.test(basename(filePath))) return;
    let stats;
    try {
      stats = await fs.stat(filePath);
    } catch {
      return;
    }
    if (!stats.isFile()) return;
    filesScanned += 1;
    if (stats.size > MAX_SEARCH_FILE_BYTES) return;
    let buffer;
    try {
      buffer = await fs.readFile(filePath);
    } catch {
      return;
    }
    if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) return;
    const lines = buffer.toString("utf8").split(/\r?\n/);
    const expression = new RegExp(pattern, caseSensitive ? "" : "i");
    for (let index = 0; index < lines.length; index += 1) {
      if (!expression.test(lines[index])) continue;
      matches.push({
        file: filePath,
        line_number: index + 1,
        line: lines[index],
        before: lines.slice(Math.max(0, index - contextLines), index),
        after: lines.slice(index + 1, Math.min(lines.length, index + contextLines + 1)),
      });
      if (matches.length >= maxResults) {
        truncated = true;
        return;
      }
    }
  }

  async function scanDirectory(directoryPath) {
    let realDirectory;
    try {
      realDirectory = await fs.realpath(directoryPath);
    } catch {
      return;
    }
    if (visitedDirectories.has(realDirectory)) return;
    visitedDirectories.add(realDirectory);
    let entries;
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (matches.length >= maxResults) return;
      const childPath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_SEARCH_DIRECTORIES.has(entry.name)) await scanDirectory(childPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        await scanFile(childPath);
      }
    }
  }

  let rootStats;
  try {
    rootStats = await fs.stat(rootPath);
  } catch (error) {
    throw new Error(`Unable to access search path ${rootPath}: ${error.message}.`);
  }
  if (rootStats.isDirectory()) await scanDirectory(rootPath);
  else if (rootStats.isFile()) await scanFile(rootPath);
  else throw new Error(`The search path is not a file or directory: ${rootPath}.`);
  return { matches, files_scanned: filesScanned, truncated };
}
class OutputCapture {
  constructor(label) {
    this.label = label;
    this.previewChunks = [];
    this.previewLength = 0;
    this.fullPath = null;
    this.stream = null;
  }

  append(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.stream === null && this.previewLength + buffer.length <= OUTPUT_LIMIT) {
      this.previewChunks.push(buffer);
      this.previewLength += buffer.length;
      return;
    }
    if (this.stream === null) {
      ensureDirectory(TEMP_OUTPUT_DIR);
      this.fullPath = join(TEMP_OUTPUT_DIR, `${Date.now()}-${randomUUID()}-${this.label}.log`);
      this.stream = createWriteStream(this.fullPath, { flags: "wx" });
      for (const prior of this.previewChunks) this.stream.write(prior);
      this.previewChunks = [];
      this.stream.write(buffer);
    } else {
      this.stream.write(buffer);
    }
  }

  async finish() {
    if (this.stream === null) return;
    await new Promise((resolvePromise, rejectPromise) => {
      this.stream.once("error", rejectPromise);
      this.stream.once("finish", resolvePromise);
      this.stream.end();
    });
  }

  result() {
    const value = Buffer.concat(this.previewChunks).toString("utf8");
    return this.fullPath === null ? { text: value } : { text: value, truncated: true, full_output_path: this.fullPath };
  }
}

async function terminateProcess(child) {
  if (!child.pid) return;
  if (IS_WINDOWS) {
    await new Promise((resolvePromise) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => resolvePromise());
      killer.once("close", () => resolvePromise());
    });
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The process may have exited between the timeout and kill attempt.
  }
}

async function runProcess(invocation, cwd, timeoutMs) {
  const stdout = new OutputCapture("stdout");
  const stderr = new OutputCapture("stderr");
  const started = Date.now();
  let child;
  try {
    child = spawn(invocation.executable, invocation.args, {
      cwd: cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`Unable to start the command: ${error.message}.`);
  }

  return new Promise((resolvePromise, rejectPromise) => {
    let timedOut = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcess(child);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.append(chunk));
    child.stderr.on("data", (chunk) => stderr.append(chunk));
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", async (exitCode, signal) => {
      clearTimeout(timer);
      try {
        await Promise.all([stdout.finish(), stderr.finish()]);
      } catch (error) {
        rejectPromise(new Error(`Unable to save command output: ${error.message}.`));
        return;
      }
      const result = {
        exit_code: typeof exitCode === "number" ? exitCode : null,
        duration_ms: Date.now() - started,
        stdout: stdout.result(),
        stderr: stderr.result(),
      };
      if (spawnError) {
        rejectPromise(new Error(`Unable to start the command: ${spawnError.message}.`));
      } else if (timedOut) {
        resolvePromise({ ...result, timed_out: true, signal });
      } else {
        resolvePromise(result);
      }
    });
  });
}

async function runCommand(command, cwd, shell, timeoutMs) {
  return runProcess(shellInvocation(shell, command), cwd, timeoutMs);
}
function powerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function runPowerShellJson(script, timeoutMs = 60_000) {
  if (!IS_WINDOWS) throw new Error("This tool is only supported on Windows.");
  ensureDirectory(TEMP_OUTPUT_DIR);
  const scriptPath = join(TEMP_OUTPUT_DIR, `${Date.now()}-${randomUUID()}-helper.ps1`);
  try {
    await fs.writeFile(scriptPath, script, "utf8");
    const result = await runProcess({
      executable: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    }, undefined, timeoutMs);
    if (result.timed_out) throw new Error(`PowerShell helper timed out after ${timeoutMs} ms.`);
    let stdout = result.stdout?.text || "";
    if (result.stdout?.full_output_path) stdout = await fs.readFile(result.stdout.full_output_path, "utf8");
    if (result.exit_code !== 0) {
      const stderr = (result.stderr?.text || "").trim().replace(/\s+/g, " ");
      throw new Error(`PowerShell helper failed${stderr ? `: ${stderr}` : ` with exit code ${result.exit_code}`}.`);
    }
    try {
      return JSON.parse(stdout.trim());
    } catch (error) {
      throw new Error(`PowerShell helper returned invalid JSON: ${error.message}.`);
    }
  } finally {
    await fs.rm(scriptPath, { force: true }).catch(() => {});
  }
}

function screenshotScript(target, outputPath, windowTitle) {
  const output = powerShellLiteral(outputPath);
  const title = powerShellLiteral(windowTitle || "");
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$target = ${powerShellLiteral(target)}
$outputPath = ${output}
$windowTitle = ${title}
$left = 0
$top = 0
$width = 0
$height = 0
$actualTitle = $null
if ($target -eq 'screen') {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $left = $bounds.Left
  $top = $bounds.Top
  $width = $bounds.Width
  $height = $bounds.Height
} else {
  Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DirectorWindowNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT rect, int size);
}
"@
  $matched = $null
  [DirectorWindowNative]::EnumWindows({
    param($hWnd, $lParam)
    if (-not [DirectorWindowNative]::IsWindowVisible($hWnd)) { return $true }
    $text = New-Object System.Text.StringBuilder 1024
    [void][DirectorWindowNative]::GetWindowText($hWnd, $text, $text.Capacity)
    $candidate = $text.ToString()
    if ($candidate.Length -gt 0 -and $candidate.IndexOf($windowTitle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $matched = [pscustomobject]@{ Handle = $hWnd; Title = $candidate }
      return $false
    }
    return $true
  }, [IntPtr]::Zero)
  if ($null -eq $matched) { throw "No visible window matched the title substring '$windowTitle'." }
  $actualTitle = $matched.Title
  $rect = New-Object DirectorWindowNative+RECT
  $size = [Runtime.InteropServices.Marshal]::SizeOf($rect)
  $dwmResult = [DirectorWindowNative]::DwmGetWindowAttribute($matched.Handle, 9, [ref]$rect, $size)
  if ($dwmResult -ne 0) {
    if (-not [DirectorWindowNative]::GetWindowRect($matched.Handle, [ref]$rect)) { throw "Unable to obtain the matched window bounds." }
  }
  $left = $rect.Left
  $top = $rect.Top
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) { throw "The matched window has an empty capture rectangle." }
}
if ($width -le 0 -or $height -le 0) { throw "The screen has an empty capture rectangle." }
$bitmap = $null
$graphics = $null
try {
  $bitmap = [System.Drawing.Bitmap]::new($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($left, $top, 0, 0, [System.Drawing.Size]::new($width, $height))
  $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  if ($null -ne $graphics) { $graphics.Dispose() }
  if ($null -ne $bitmap) { $bitmap.Dispose() }
}
[pscustomobject]@{ path = $outputPath; width = $width; height = $height; target = $target; window_title = $actualTitle } | ConvertTo-Json -Compress
`;
}

function processListScript(nameFilter, maxRows) {
  return `
$ErrorActionPreference = 'Stop'
$nameFilter = ${powerShellLiteral(nameFilter || "")}
$maxRows = ${maxRows}
$items = @(Get-Process | ForEach-Object {
  $name = $_.ProcessName
  $path = $null
  $started = $null
  try { $path = $_.Path } catch {}
  try { $started = $_.StartTime.ToUniversalTime().ToString('o') } catch {}
  $candidate = "$name $path"
  if ($nameFilter.Length -eq 0 -or $candidate.IndexOf($nameFilter, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    [pscustomobject]@{
      pid = [int]$_.Id
      name = $name
      path = $path
      started_at = $started
      working_set_bytes = [int64]$_.WorkingSet64
    }
  }
} | Select-Object -First $maxRows)
@($items) | ConvertTo-Json -Compress
`;
}

function fileLockersScript(filePath) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DirectorRestartManager {
  [StructLayout(LayoutKind.Sequential)]
  public struct RM_UNIQUE_PROCESS {
    public int dwProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
  }
  public enum RM_APP_TYPE { RmUnknownApp = 0, RmMainWindow = 1, RmOtherWindow = 2, RmService = 3, RmExplorer = 4, RmConsole = 5, RmCritical = 1000 }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public RM_APP_TYPE ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmStartSession(out uint sessionHandle, int flags, string sessionKey);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmRegisterResources(uint sessionHandle, uint nFiles, string[] files, uint nApplications, RM_UNIQUE_PROCESS[] applications, uint nServices, string[] services);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmGetList(uint sessionHandle, out uint needed, ref uint count, IntPtr processInfo, out uint rebootReasons);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmGetList(uint sessionHandle, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] processInfo, out uint rebootReasons);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmEndSession(uint sessionHandle);
}
"@
$session = [uint32]0
$started = $false
try {
  $result = [DirectorRestartManager]::RmStartSession([ref]$session, 0, [guid]::NewGuid().ToString())
  if ($result -ne 0) { throw "RmStartSession failed with code $result." }
  $started = $true
  $files = [string[]]@(${powerShellLiteral(filePath)})
  $result = [DirectorRestartManager]::RmRegisterResources($session, 1, $files, 0, $null, 0, $null)
  if ($result -ne 0) { throw "RmRegisterResources failed with code $result." }
  $needed = [uint32]0
  $count = [uint32]0
  $reasons = [uint32]0
  $result = [DirectorRestartManager]::RmGetList($session, [ref]$needed, [ref]$count, [IntPtr]::Zero, [ref]$reasons)
  if ($result -ne 0 -and $result -ne 234) { throw "RmGetList failed with code $result." }
  $lockers = @()
  if ($needed -gt 0) {
    $infos = New-Object 'DirectorRestartManager+RM_PROCESS_INFO[]' $needed
    $count = $needed
    $result = [DirectorRestartManager]::RmGetList($session, [ref]$needed, [ref]$count, $infos, [ref]$reasons)
    if ($result -ne 0) { throw "RmGetList failed with code $result." }
    for ($index = 0; $index -lt $count; $index++) {
      $lockers += [pscustomobject]@{
        pid = [int]$infos[$index].Process.dwProcessId
        app_name = $infos[$index].strAppName
        app_type = $infos[$index].ApplicationType.ToString()
      }
    }
  }
  [pscustomobject]@{ path = ${powerShellLiteral(filePath)}; lockers = @($lockers) } | ConvertTo-Json -Compress
} finally {
  if ($started) { [void][DirectorRestartManager]::RmEndSession($session) }
}
`;
}

function jobPaths(jobId) {
  const directory = join(JOBS_DIR, jobId);
  return {
    directory,
    metadata: join(directory, "metadata.json"),
    stdout: join(directory, "stdout.log"),
    stderr: join(directory, "stderr.log"),
    combined: join(directory, "combined.log"),
    exit: join(directory, "exit_code.txt"),
  };
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(temporary, filePath);
}

async function readExitCode(path) {
  try {
    const value = (await fs.readFile(path, "utf8")).trim();
    if (!/^-?\d+$/.test(value)) return null;
    return Number.parseInt(value, 10);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readTailLines(filePath, requestedLines) {
  if (requestedLines === 0) return "";
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
  if (stat.size === 0) return "";
  const handle = await fs.open(filePath, "r");
  const chunks = [];
  let position = stat.size;
  let newlineCount = 0;
  try {
    while (position > 0 && newlineCount <= requestedLines) {
      const length = Math.min(64 * 1024, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const read = await handle.read(buffer, 0, length, position);
      const chunk = buffer.subarray(0, read.bytesRead);
      chunks.unshift(chunk);
      for (const byte of chunk) if (byte === 10) newlineCount += 1;
    }
  } finally {
    await handle.close();
  }
  let text = Buffer.concat(chunks).toString("utf8");
  let lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines = lines.slice(0, -1);
  return lines.slice(-requestedLines).join("\n");
}

async function loadJob(jobId) {
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) {
    throw new Error("job_id must be a valid job id returned by job_start.");
  }
  const paths = jobPaths(jobId);
  let metadata;
  try {
    metadata = JSON.parse(await fs.readFile(paths.metadata, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`No job exists with id ${jobId}.`);
    throw new Error(`Job ${jobId} has invalid persisted metadata.`);
  }
  if (metadata.job_id !== jobId || metadata.log_paths?.combined !== paths.combined) {
    throw new Error(`Job ${jobId} has invalid persisted metadata.`);
  }
  return { ...metadata, paths };
}

async function jobState(job) {
  const exitCode = await readExitCode(job.paths.exit);
  const running = exitCode === null;
  const runtimeMs = Math.max(0, (running ? Date.now() : (await fs.stat(job.paths.exit)).mtimeMs) - job.started_at_ms);
  return { running, exitCode, runtimeMs };
}

async function runJobWrapper(config) {
  const paths = config.paths;
  let child;
  let exitCode = 1;
  let stdoutStream;
  let stderrStream;
  let combinedStream;
  try {
    ensureDirectory(paths.directory);
    stdoutStream = createWriteStream(paths.stdout, { flags: "a" });
    stderrStream = createWriteStream(paths.stderr, { flags: "a" });
    combinedStream = createWriteStream(paths.combined, { flags: "a" });
    const invocation = shellInvocation(config.shell, config.command);
    child = spawn(invocation.executable, invocation.args, {
      cwd: config.cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => {
      stdoutStream.write(chunk);
      combinedStream.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrStream.write(chunk);
      combinedStream.write(chunk);
    });
    exitCode = await new Promise((resolvePromise) => {
      child.once("error", (error) => {
        const message = `Unable to start the job command: ${error.message}.\n`;
        stderrStream.write(message);
        combinedStream.write(message);
        resolvePromise(1);
      });
      child.once("close", (code) => resolvePromise(typeof code === "number" ? code : 1));
    });
  } catch (error) {
    const message = `Unable to run the job: ${error.message}.\n`;
    if (stderrStream) stderrStream.write(message);
    if (combinedStream) combinedStream.write(message);
    exitCode = 1;
  } finally {
    for (const stream of [stdoutStream, stderrStream, combinedStream]) {
      if (stream) stream.end();
    }
    await Promise.all([stdoutStream, stderrStream, combinedStream].filter(Boolean).map((stream) => new Promise((resolvePromise) => stream.once("close", resolvePromise))));
    await fs.writeFile(paths.exit, `${exitCode}\n`, "utf8");
  }
}

async function handleShellRun(args) {
  const command = requireCommand(args);
  const cwd = optionalCwd(args);
  await validateCwd(cwd);
  const shell = validateShell(args.shell);
  const timeoutMs = timeoutValue(args);
  const result = await runCommand(command, cwd, shell, timeoutMs);
  if (result.timed_out) {
    return jsonResult({
      error: `Command timed out after ${timeoutMs} ms.`,
      timeout_ms: timeoutMs,
      ...result,
    }, true);
  }
  return jsonResult({ shell, ...result });
}
async function handleWriteFile(args) {
  const filePath = requireAbsolutePath(args);
  if (typeof args.content !== "string") {
    throw new Error("The content parameter is required and must be a string.");
  }
  const append = booleanValue(args, "append", false);
  const createDirs = booleanValue(args, "create_dirs", true);
  const created = !existsSync(filePath);
  try {
    if (createDirs) await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, args.content, { encoding: "utf8", flag: append ? "a" : "w" });
  } catch (error) {
    throw new Error(`Unable to write file ${filePath}: ${error.message}.`);
  }
  return jsonResult({
    path: filePath,
    bytes_written: Buffer.byteLength(args.content, "utf8"),
    created,
    appended: append,
  });
}

async function handleEditFile(args) {
  const filePath = requireAbsolutePath(args);
  if (typeof args.old_text !== "string" || args.old_text.length === 0) {
    throw new Error("The old_text parameter is required and must be a non-empty string.");
  }
  if (typeof args.new_text !== "string") {
    throw new Error("The new_text parameter is required and must be a string.");
  }
  const replaceAll = booleanValue(args, "replace_all", false);
  let original;
  try {
    original = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read file ${filePath}: ${error.message}.`);
  }

  let replacements = 0;
  let offset = 0;
  while ((offset = original.indexOf(args.old_text, offset)) !== -1) {
    replacements += 1;
    offset += args.old_text.length;
  }
  if (replacements === 0 || (!replaceAll && replacements !== 1)) {
    throw new Error(`The old_text value occurs ${replacements} times in ${filePath}; expected exactly once unless replace_all is true.`);
  }

  const edited = replaceAll
    ? original.split(args.old_text).join(args.new_text)
    : original.replace(args.old_text, () => args.new_text);
  try {
    await fs.writeFile(filePath, edited, "utf8");
  } catch (error) {
    throw new Error(`Unable to write edited file ${filePath}: ${error.message}.`);
  }
  return jsonResult({ path: filePath, replacements });
}

async function handleRunPython(args) {
  if (typeof args.code !== "string") {
    throw new Error("The code parameter is required and must be a string.");
  }
  const cwd = optionalCwd(args);
  await validateCwd(cwd);
  const timeoutMs = timeoutValue(args);
  if (args.args !== undefined && (!Array.isArray(args.args) || args.args.some((value) => typeof value !== "string"))) {
    throw new Error("The args parameter must be an array of strings when provided.");
  }
  const python = pythonExecutable();
  ensureDirectory(TEMP_OUTPUT_DIR);
  const scriptPath = join(TEMP_OUTPUT_DIR, `${Date.now()}-${randomUUID()}-run-python.py`);
  try {
    try {
      await fs.writeFile(scriptPath, args.code, "utf8");
    } catch (error) {
      throw new Error(`Unable to write the temporary Python script: ${error.message}.`);
    }
    const result = await runProcess({
      executable: python,
      args: [scriptPath, ...(args.args || [])],
    }, cwd, timeoutMs);
    if (result.timed_out) {
      return jsonResult({
        error: `Python command timed out after ${timeoutMs} ms.`,
        timeout_ms: timeoutMs,
        python_executable: python,
        ...result,
      }, true);
    }
    return jsonResult({ python_executable: python, ...result });
  } finally {
    await fs.rm(scriptPath, { force: true }).catch(() => {});
  }
}


async function handleJobStart(args) {
  const command = requireCommand(args);
  const cwd = optionalCwd(args);
  await validateCwd(cwd);
  const shell = validateShell(args.shell);
  if (args.name !== undefined && (typeof args.name !== "string" || args.name.length > 200)) {
    throw new Error("The name parameter must be a string of at most 200 characters when provided.");
  }
  shellProbe(shell);
  ensureDirectory(JOBS_DIR);
  const jobId = randomUUID();
  const paths = jobPaths(jobId);
  ensureDirectory(paths.directory);
  const startedAtMs = Date.now();
  const metadata = {
    job_id: jobId,
    name: args.name || null,
    command,
    cwd: cwd || process.cwd(),
    shell,
    pid: null,
    started_at: new Date(startedAtMs).toISOString(),
    started_at_ms: startedAtMs,
    log_paths: { stdout: paths.stdout, stderr: paths.stderr, combined: paths.combined },
    exit_marker: paths.exit,
  };
  let wrapper;
  try {
    wrapper = spawn(process.execPath, [SERVER_FILE, "--job-wrapper", JSON.stringify({
      command,
      cwd: metadata.cwd,
      shell,
      paths,
    })], {
      cwd: metadata.cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`Unable to start detached job: ${error.message}.`);
  }
  if (!wrapper.pid) throw new Error("Unable to start detached job because no process id was returned.");
  metadata.pid = wrapper.pid;
  await writeJsonAtomic(paths.metadata, metadata);
  wrapper.unref();
  return jsonResult({
    job_id: jobId,
    pid: wrapper.pid,
    name: metadata.name,
    log_paths: metadata.log_paths,
    exit_marker: metadata.exit_marker,
  });
}

async function handleJobStatus(args) {
  if (args.job_id === undefined) throw new Error("The job_id parameter is required.");
  const tailLines = tailValue(args);
  const job = await loadJob(args.job_id);
  const state = await jobState(job);
  return jsonResult({
    job_id: job.job_id,
    name: job.name,
    pid: job.pid,
    running: state.running,
    exit_code: state.exitCode,
    runtime_ms: state.runtimeMs,
    started_at: job.started_at,
    output_tail: await readTailLines(job.paths.combined, tailLines),
  });
}

async function handleJobKill(args) {
  if (args.job_id === undefined) throw new Error("The job_id parameter is required.");
  const job = await loadJob(args.job_id);
  const state = await jobState(job);
  if (!state.running) {
    return jsonResult({ job_id: job.job_id, killed: false, running: false, exit_code: state.exitCode });
  }
  if (!job.pid) throw new Error(`Job ${job.job_id} has no persisted process id and cannot be killed.`);
  if (IS_WINDOWS) {
    await new Promise((resolvePromise, rejectPromise) => {
      const killer = spawn("taskkill.exe", ["/PID", String(job.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("error", (error) => rejectPromise(new Error(`Unable to kill job ${job.job_id}: ${error.message}.`)));
      killer.once("close", (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`Unable to kill job ${job.job_id}; taskkill exited with code ${code}.`)));
    });
  } else {
    try {
      process.kill(job.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw new Error(`Unable to kill job ${job.job_id}: ${error.message}.`);
    }
  }
  if ((await readExitCode(job.paths.exit)) === null) await fs.writeFile(job.paths.exit, "-1\n", "utf8");
  return jsonResult({ job_id: job.job_id, killed: true, running: false, exit_code: -1 });
}

async function handleJobList() {
  ensureDirectory(JOBS_DIR);
  const entries = await fs.readdir(JOBS_DIR, { withFileTypes: true });
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !JOB_ID_PATTERN.test(entry.name)) continue;
    try {
      const job = await loadJob(entry.name);
      const state = await jobState(job);
      jobs.push({
        job_id: job.job_id,
        name: job.name,
        pid: job.pid,
        running: state.running,
        exit_code: state.exitCode,
        started_at: job.started_at,
      });
    } catch {
      // Ignore unrelated or incomplete directories in the jobs root.
    }
  }
  jobs.sort((a, b) => b.started_at.localeCompare(a.started_at));
  return jsonResult({ jobs });
}

async function handleGrepFiles(args) {
  if (typeof args.pattern !== "string") throw new Error("The pattern parameter is required and must be a string.");
  const rootPath = requireAbsolutePath(args);
  const caseSensitive = booleanValue(args, "case_sensitive", false);
  const maxResults = boundedInteger(args, "max_results", 200, 1, MAX_GREP_RESULTS);
  const contextLines = boundedInteger(args, "context_lines", 0, 0, MAX_GREP_CONTEXT);
  let expression;
  try {
    expression = new RegExp(args.pattern, caseSensitive ? "" : "i");
  } catch (error) {
    throw new Error(`Invalid regular expression pattern: ${error.message}.`);
  }
  return jsonResult(await searchFiles(rootPath, expression.source, filenameGlobRegex(args.glob), caseSensitive, maxResults, contextLines));
}

async function jobStatusPayload(job, tailLines) {
  const state = await jobState(job);
  return {
    job_id: job.job_id,
    name: job.name,
    pid: job.pid,
    running: state.running,
    exit_code: state.exitCode,
    runtime_ms: state.runtimeMs,
    started_at: job.started_at,
    output_tail: await readTailLines(job.paths.combined, tailLines),
  };
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function handleJobWait(args) {
  if (args.job_id === undefined) throw new Error("The job_id parameter is required.");
  const timeoutMs = timeoutValue(args);
  const tailLines = tailValue(args);
  const job = await loadJob(args.job_id);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const state = await jobState(job);
    if (!state.running) return jsonResult({ ...(await jobStatusPayload(job, tailLines)), timed_out: false });
    const remaining = deadline - Date.now();
    if (remaining <= 0) return jsonResult({ ...(await jobStatusPayload(job, tailLines)), timed_out: true });
    await sleep(Math.min(500, remaining));
  }
}

function requireLockName(args) {
  if (typeof args.name !== "string" || !LOCK_NAME_PATTERN.test(args.name)) {
    throw new Error("The name parameter is required and must match ^[A-Za-z0-9_.-]{1,64}$.");
  }
  return args.name;
}

async function readLockOwner(lockDirectory) {
  try {
    return JSON.parse(await fs.readFile(join(lockDirectory, "owner.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Unable to read lock owner metadata: ${error.message}.`);
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code !== "ESRCH" && error.code !== "EINVAL";
  }
  if (!IS_WINDOWS) return true;
  const probe = spawnSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  if (probe.error || probe.status !== 0) return true;
  return new RegExp(`"[^"]+","${pid}"`).test(probe.stdout || "");
}

function lockHolderDescription(name, owner) {
  if (!owner || !Number.isInteger(owner.pid)) return `Lock "${name}" is held by an unknown process.`;
  const acquiredAtMs = Number.isFinite(owner.acquired_at_ms)
    ? owner.acquired_at_ms
    : Date.parse(owner.acquired_at || "") || Date.now();
  const duration = Math.max(0, Date.now() - acquiredAtMs);
  const note = typeof owner.note === "string" && owner.note.length > 0 ? `, note "${owner.note}"` : "";
  return `Lock "${name}" is held by pid ${owner.pid}${note} for ${duration} ms.`;
}

async function handleLockAcquire(args) {
  const name = requireLockName(args);
  const waitMs = boundedInteger(args, "wait_ms", 0, 0, MAX_TIMEOUT_MS);
  if (args.note !== undefined && typeof args.note !== "string") throw new Error("The note parameter must be a string when provided.");
  const lockDirectory = join(LOCKS_DIR, name);
  ensureDirectory(LOCKS_DIR);
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      await fs.mkdir(lockDirectory);
      const token = randomUUID();
      const acquiredAtMs = Date.now();
      const owner = {
        token,
        pid: process.pid,
        acquired_at: new Date(acquiredAtMs).toISOString(),
        acquired_at_ms: acquiredAtMs,
      };
      if (args.note !== undefined) owner.note = args.note;
      try {
        await writeJsonAtomic(join(lockDirectory, "owner.json"), owner);
      } catch (error) {
        await fs.rm(lockDirectory, { recursive: true, force: true }).catch(() => {});
        throw new Error(`Unable to write lock owner metadata: ${error.message}.`);
      }
      return jsonResult({ name, token, acquired_at: owner.acquired_at });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const owner = await readLockOwner(lockDirectory);
    if (owner && !processAlive(owner.pid)) {
      await fs.rm(lockDirectory, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    const remaining = deadline - Date.now();
    if (waitMs === 0 || remaining <= 0) throw new Error(lockHolderDescription(name, owner));
    await sleep(Math.min(250, remaining));
  }
}

async function handleLockRelease(args) {
  const name = requireLockName(args);
  if (typeof args.token !== "string" || args.token.length === 0) {
    throw new Error("The token parameter is required and must be a non-empty string.");
  }
  const lockDirectory = join(LOCKS_DIR, name);
  try {
    const stats = await fs.stat(lockDirectory);
    if (!stats.isDirectory()) throw new Error(`Lock "${name}" is not held.`);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Lock "${name}" is not held.`);
    throw error;
  }
  const owner = await readLockOwner(lockDirectory);
  if (!owner) throw new Error(`Lock "${name}" has no owner metadata; release was refused.`);
  if (owner.token !== args.token) throw new Error(`Lock "${name}" token does not match the current holder; release was refused.`);
  await fs.rm(lockDirectory, { recursive: true, force: true });
  return jsonResult({ name, released: true });
}

async function handleScreenshot(args) {
  const target = args.target === undefined ? "screen" : args.target;
  if (target !== "screen" && target !== "window") throw new Error("The target parameter must be screen or window.");
  let windowTitle;
  if (target === "window") {
    if (typeof args.window_title !== "string" || args.window_title.trim() === "") {
      throw new Error("The window_title parameter is required when target is window.");
    }
    windowTitle = args.window_title;
  }
  const outputPath = args.output_path === undefined
    ? join(TEMP_OUTPUT_DIR, `${Date.now()}-${randomUUID()}-screenshot.png`)
    : args.output_path;
  if (typeof outputPath !== "string" || !isAbsolute(outputPath)) {
    throw new Error("The output_path parameter must be an absolute path when provided.");
  }
  if (!/\.png$/i.test(outputPath)) throw new Error("The output_path parameter must end with .png.");
  if (!IS_WINDOWS) throw new Error("The screenshot tool is only supported on Windows.");
  ensureDirectory(dirname(outputPath));
  const result = await runPowerShellJson(screenshotScript(target, outputPath, windowTitle));
  if (!result || result.path !== outputPath || !Number.isInteger(result.width) || !Number.isInteger(result.height)) {
    throw new Error("The screenshot capture returned invalid dimensions.");
  }
  const value = { path: outputPath, width: result.width, height: result.height, target };
  if (target === "window") value.window_title = result.window_title;
  return jsonResult(value);
}

async function handleProcessList(args) {
  if (args.name_filter !== undefined && typeof args.name_filter !== "string") {
    throw new Error("The name_filter parameter must be a string when provided.");
  }
  const maxResults = boundedInteger(args, "max_results", 100, 1, MAX_PROCESS_RESULTS);
  if (!IS_WINDOWS) throw new Error("The process_list tool is only supported on Windows.");
  const raw = await runPowerShellJson(processListScript(args.name_filter, maxResults + 1));
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const truncated = rows.length > maxResults;
  const processes = rows.slice(0, maxResults).map((row) => {
    const value = { pid: row.pid, name: row.name };
    if (typeof row.path === "string" && row.path.length > 0) value.path = row.path;
    if (typeof row.started_at === "string" && row.started_at.length > 0) value.started_at = row.started_at;
    if (Number.isFinite(row.working_set_bytes)) value.working_set_bytes = row.working_set_bytes;
    return value;
  });
  return jsonResult({ processes, truncated });
}

async function handleFileLockers(args) {
  const filePath = requireAbsolutePath(args);
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`The file does not exist: ${filePath}.`);
    throw new Error(`Unable to access file ${filePath}: ${error.message}.`);
  }
  if (!stats.isFile()) throw new Error(`The path is not an existing file: ${filePath}.`);
  if (!IS_WINDOWS) throw new Error("The file_lockers tool is only supported on Windows.");
  const result = await runPowerShellJson(fileLockersScript(filePath));
  const lockers = Array.isArray(result?.lockers) ? result.lockers : result?.lockers ? [result.lockers] : [];
  return jsonResult({
    path: filePath,
    lockers: lockers.map((locker) => ({ pid: locker.pid, app_name: locker.app_name, app_type: locker.app_type })),
  });
}
async function handleTool(name, args) {
  switch (name) {
    case "shell_run": return handleShellRun(args);
    case "write_file": return handleWriteFile(args);
    case "edit_file": return handleEditFile(args);
    case "run_python": return handleRunPython(args);
    case "job_start": return handleJobStart(args);
    case "job_status": return handleJobStatus(args);
    case "job_wait": return handleJobWait(args);
    case "job_kill": return handleJobKill(args);
    case "job_list": return handleJobList();
    case "grep_files": return handleGrepFiles(args);
    case "lock_acquire": return handleLockAcquire(args);
    case "lock_release": return handleLockRelease(args);
    case "screenshot": return handleScreenshot(args);
    case "process_list": return handleProcessList(args);
    case "file_lockers": return handleFileLockers(args);
    default: throw new Error(`Unknown tool ${JSON.stringify(name)}.`);
  }
}

async function startServer() {
  const server = new Server(
    { name: "director-shell-mcp", version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await handleTool(request.params.name, parseObjectArguments(request));
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[2] === "--job-wrapper") {
  let config;
  try {
    config = JSON.parse(process.argv[3]);
    await runJobWrapper(config);
    process.exitCode = 0;
  } catch (error) {
    process.exitCode = 1;
  }
} else {
  await startServer();
}
