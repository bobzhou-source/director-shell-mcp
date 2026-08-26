import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, createWriteStream, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const SERVER_VERSION = "1.0.0";
const OUTPUT_LIMIT = 50 * 1024;
const MAX_TIMEOUT_MS = 600_000;
const MAX_TAIL_LINES = 1_000;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IS_WINDOWS = process.platform === "win32";
const DEFAULT_SHELL = IS_WINDOWS ? "powershell" : "bash";
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const JOBS_DIR = join(LOCAL_APP_DATA, "director-shell-mcp", "jobs");
const TEMP_OUTPUT_DIR = join(tmpdir(), "director-shell-mcp");
const SERVER_FILE = fileURLToPath(import.meta.url);

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

async function runCommand(command, cwd, shell, timeoutMs) {
  const invocation = shellInvocation(shell, command);
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
    let timer = setTimeout(() => {
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

async function handleTool(name, args) {
  switch (name) {
    case "shell_run": return handleShellRun(args);
    case "job_start": return handleJobStart(args);
    case "job_status": return handleJobStatus(args);
    case "job_kill": return handleJobKill(args);
    case "job_list": return handleJobList();
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
