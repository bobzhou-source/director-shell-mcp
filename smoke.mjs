import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectDir = dirname(fileURLToPath(import.meta.url));
const serverPath = join(projectDir, "index.js");
const smokeTempDir = await fs.mkdtemp(join(tmpdir(), "director-shell-smoke-"));
let client = new Client({ name: "director-shell-smoke", version: "1.0.0" }, { capabilities: {} });
let transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], cwd: projectDir });
const failures = [];

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`PASS ${label}`);
  } else {
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
    failures.push(label);
  }
}

function payload(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP result did not contain a text payload.");
  return JSON.parse(text);
}

function waitForChild(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise(code));
  });
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const toolNames = listed.tools.map((tool) => tool.name).sort();
  check("initialize handshake", true);
  check("lists fifteen director tools", JSON.stringify(toolNames) === JSON.stringify(["edit_file", "file_lockers", "grep_files", "job_kill", "job_list", "job_start", "job_status", "job_wait", "lock_acquire", "lock_release", "process_list", "run_python", "screenshot", "shell_run", "write_file"]), toolNames.join(", "));

  const readmePath = join(projectDir, "README.md");
  const grepKnownResult = await client.callTool({
    name: "grep_files",
    arguments: { pattern: "director-shell-mcp", path: readmePath, case_sensitive: true },
  });
  const grepKnown = payload(grepKnownResult);
  check("grep_files finds README string", grepKnownResult.isError !== true && grepKnown.matches?.[0]?.file === readmePath && grepKnown.matches?.[0]?.line_number === 1);
  const grepInvalidResult = await client.callTool({
    name: "grep_files",
    arguments: { pattern: "[", path: readmePath },
  });
  const grepInvalid = payload(grepInvalidResult);
  check("grep_files invalid regex is an MCP error", grepInvalidResult.isError === true && /invalid regular expression/i.test(grepInvalid.error || ""));
  const grepLimitedResult = await client.callTool({
    name: "grep_files",
    arguments: { pattern: "the", path: readmePath, max_results: 1 },
  });
  const grepLimited = payload(grepLimitedResult);
  check("grep_files max_results truncates", grepLimitedResult.isError !== true && grepLimited.matches?.length === 1 && grepLimited.truncated === true);

  const echoResult = await client.callTool({ name: "shell_run", arguments: { command: "echo hello" } });
  const echo = payload(echoResult);
  check("shell_run exits zero", echo.exit_code === 0);
  check("shell_run captures hello", echo.stdout?.text?.toLowerCase().includes("hello"));

  const smokeFilePath = join(smokeTempDir, "nested", "known.txt");
  const knownContent = "alpha\nbeta\n";
  const writeResult = await client.callTool({
    name: "write_file",
    arguments: { path: smokeFilePath, content: knownContent },
  });
  const written = payload(writeResult);
  check("write_file creates a file", writeResult.isError !== true && written.path === smokeFilePath && written.created === true && written.appended === false);
  check("write_file writes known content", written.bytes_written === Buffer.byteLength(knownContent, "utf8") && await fs.readFile(smokeFilePath, "utf8") === knownContent);

  const editResult = await client.callTool({
    name: "edit_file",
    arguments: { path: smokeFilePath, old_text: "beta", new_text: "gamma" },
  });
  const edited = payload(editResult);
  check("edit_file replaces exact text", editResult.isError !== true && edited.replacements === 1 && await fs.readFile(smokeFilePath, "utf8") === "alpha\ngamma\n");
  const zeroMatchResult = await client.callTool({
    name: "edit_file",
    arguments: { path: smokeFilePath, old_text: "missing", new_text: "x" },
  });
  const zeroMatch = payload(zeroMatchResult);
  check("edit_file zero-match is an MCP error", zeroMatchResult.isError === true && /0 times/i.test(zeroMatch.error || ""));

  const pythonResult = await client.callTool({ name: "run_python", arguments: { code: "print(21*2)" } });
  const python = payload(pythonResult);
  check("run_python exits zero", python.exit_code === 0 && typeof python.python_executable === "string");
  check("run_python captures 42", python.stdout?.text?.includes("42"));

  const pythonArgsResult = await client.callTool({
    name: "run_python",
    arguments: { code: "import sys\nprint(sys.argv[1:])", args: ["first", "second"] },
  });
  const pythonArgs = payload(pythonArgsResult);
  check("run_python passes sys.argv", pythonArgs.exit_code === 0 && pythonArgs.stdout?.text?.includes("first") && pythonArgs.stdout?.text?.includes("second"));

  const pythonFailureResult = await client.callTool({
    name: "run_python",
    arguments: { code: "raise SystemExit(3)" },
  });
  const pythonFailure = payload(pythonFailureResult);
  check("run_python preserves failure exit code", pythonFailureResult.isError !== true && pythonFailure.exit_code === 3);

  const startResult = await client.callTool({
    name: "job_start",
    arguments: { command: "Start-Sleep -Seconds 3", name: "smoke-sleep" },
  });
  const started = payload(startResult);
  check("job_start returns an id", typeof started.job_id === "string" && started.job_id.length > 0);
  check("job_start returns a pid", Number.isInteger(started.pid) && started.pid > 0);
  check("job_start returns log paths", typeof started.log_paths?.combined === "string");

  let status;
  let sawRunning = false;
  const deadline = Date.now() + 10_000;
  do {
    const statusResult = await client.callTool({ name: "job_status", arguments: { job_id: started.job_id, tail_lines: 40 } });
    status = payload(statusResult);
    sawRunning ||= status.running === true;
    if (!status.running) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  check("job_status observes running job", sawRunning);
  check("job completes before smoke deadline", status?.running === false);
  check("job records exit code zero", status?.exit_code === 0);

  const jobsResult = await client.callTool({ name: "job_list", arguments: {} });
  const jobs = payload(jobsResult);
  check("job_list includes completed job", jobs.jobs?.some((job) => job.job_id === started.job_id && job.running === false && job.exit_code === 0));

  const waitStartResult = await client.callTool({
    name: "job_start",
    arguments: { command: "Start-Sleep -Seconds 2", name: "smoke-wait" },
  });
  const waitStarted = payload(waitStartResult);
  const waited = payload(await client.callTool({
    name: "job_wait",
    arguments: { job_id: waitStarted.job_id, timeout_ms: 10_000, tail_lines: 40 },
  }));
  check("job_wait observes completed job", waited.running === false && waited.exit_code === 0 && waited.timed_out === false);

  const shortWaitStartResult = await client.callTool({
    name: "job_start",
    arguments: { command: "Start-Sleep -Seconds 4", name: "smoke-wait-timeout" },
  });
  const shortWaitStarted = payload(shortWaitStartResult);
  const shortWait = payload(await client.callTool({
    name: "job_wait",
    arguments: { job_id: shortWaitStarted.job_id, timeout_ms: 250 },
  }));
  check("job_wait reports a normal deadline timeout", shortWait.running === true && shortWait.timed_out === true);
  const finishedShortWait = payload(await client.callTool({
    name: "job_wait",
    arguments: { job_id: shortWaitStarted.job_id, timeout_ms: 10_000 },
  }));
  check("job_wait can be called again after timeout", finishedShortWait.running === false && finishedShortWait.exit_code === 0 && finishedShortWait.timed_out === false);

  const lockName = `smoke-lock-${Date.now()}`;
  const lockFirstResult = await client.callTool({
    name: "lock_acquire",
    arguments: { name: lockName, note: "smoke holder" },
  });
  const lockFirst = payload(lockFirstResult);
  check("lock_acquire succeeds", lockFirstResult.isError !== true && lockFirst.name === lockName && typeof lockFirst.token === "string");
  const lockSecondResult = await client.callTool({ name: "lock_acquire", arguments: { name: lockName, wait_ms: 0 } });
  const lockSecond = payload(lockSecondResult);
  check("second lock_acquire names current holder", lockSecondResult.isError === true && /pid \d+.*smoke holder/i.test(lockSecond.error || ""));
  const wrongReleaseResult = await client.callTool({ name: "lock_release", arguments: { name: lockName, token: "wrong-token" } });
  const wrongRelease = payload(wrongReleaseResult);
  check("lock_release rejects a wrong token", wrongReleaseResult.isError === true && /does not match|refused/i.test(wrongRelease.error || ""));
  const releaseResult = await client.callTool({ name: "lock_release", arguments: { name: lockName, token: lockFirst.token } });
  check("lock_release accepts the owner token", releaseResult.isError !== true && payload(releaseResult).released === true);
  const lockAgainResult = await client.callTool({ name: "lock_acquire", arguments: { name: lockName } });
  const lockAgain = payload(lockAgainResult);
  check("released lock can be acquired again", lockAgainResult.isError !== true && typeof lockAgain.token === "string");
  await client.callTool({ name: "lock_release", arguments: { name: lockName, token: lockAgain.token } });

  const exitedChild = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
  const exitedPid = exitedChild.pid;
  const lockRoot = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "director-shell-mcp", "locks");
  const staleName = `smoke-stale-${Date.now()}`;
  const staleDirectory = join(lockRoot, staleName);
  await fs.mkdir(staleDirectory, { recursive: true });
  await fs.writeFile(join(staleDirectory, "owner.json"), JSON.stringify({
    token: "stale-token",
    pid: exitedPid,
    acquired_at: new Date(Date.now() - 60_000).toISOString(),
  }), "utf8");
  const staleResult = await client.callTool({ name: "lock_acquire", arguments: { name: staleName, wait_ms: 0 } });
  const stale = payload(staleResult);
  check("lock_acquire recovers a stale owner", staleResult.isError !== true && stale.name === staleName && typeof stale.token === "string");
  if (stale.token) await client.callTool({ name: "lock_release", arguments: { name: staleName, token: stale.token } });

  const screenshotResult = await client.callTool({ name: "screenshot", arguments: { target: "screen" } });
  const screenshot = payload(screenshotResult);
  if (screenshotResult.isError === true) {
    check("screenshot reports a clear unavailable-capture error", /supported|capture|screen/i.test(screenshot.error || ""));
  } else {
    const screenshotBytes = await fs.readFile(screenshot.path);
    check("screenshot writes PNG magic bytes", screenshotBytes[0] === 0x89 && screenshotBytes[1] === 0x50 && screenshotBytes[2] === 0x4e && screenshotBytes[3] === 0x47);
    check("screenshot reports nonzero dimensions", screenshot.width > 0 && screenshot.height > 0);
  }

  const processListResult = await client.callTool({ name: "process_list", arguments: { name_filter: "node" } });
  const processList = payload(processListResult);
  check("process_list finds the smoke process tree", processListResult.isError !== true && processList.processes?.some((entry) => entry.pid === globalThis.process.pid));

  const lockerFilePath = join(smokeTempDir, "locker-target.txt");
  await fs.writeFile(lockerFilePath, "locker test\n", "utf8");
  const unlockedResult = await client.callTool({ name: "file_lockers", arguments: { path: lockerFilePath } });
  const unlocked = payload(unlockedResult);
  check("file_lockers reports an unlocked file", unlockedResult.isError !== true && Array.isArray(unlocked.lockers) && unlocked.lockers.length === 0);
  const escapedLockerPath = lockerFilePath.replace(/'/g, "''");
  const lockerJobResult = await client.callTool({
    name: "job_start",
    arguments: {
      shell: "powershell",
      command: `$f=[System.IO.File]::Open('${escapedLockerPath}',[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); try { Start-Sleep -Seconds 8 } finally { $f.Dispose() }`,
      name: "smoke-file-locker",
    },
  });
  const lockerJob = payload(lockerJobResult);
  let foundLocker = false;
  const lockerDeadline = Date.now() + 6_000;
  while (Date.now() < lockerDeadline) {
    const lockerResult = await client.callTool({ name: "file_lockers", arguments: { path: lockerFilePath } });
    const lockers = payload(lockerResult);
    if (lockerResult.isError !== true && lockers.lockers?.length > 0) {
      foundLocker = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  check("file_lockers reports an active locker", foundLocker);
  const lockerFinished = payload(await client.callTool({ name: "job_wait", arguments: { job_id: lockerJob.job_id, timeout_ms: 15_000 } }));
  check("file-locking job exits cleanly", lockerFinished.running === false && lockerFinished.exit_code === 0);

  const timeoutResult = await client.callTool({
    name: "shell_run",
    arguments: { command: "Start-Sleep -Seconds 30", shell: "powershell", timeout_ms: 2_000 },
  });
  const timeout = payload(timeoutResult);
  check("shell_run timeout returns an error", timeoutResult.isError === true && timeout.timed_out === true && /timed out/i.test(timeout.error || ""));
  const restartStartResult = await client.callTool({
    name: "job_start",
    arguments: { command: "Start-Sleep -Seconds 2", name: "restart-persistence" },
  });
  const restartStarted = payload(restartStartResult);
  await client.close();
  check("first server tears down cleanly", true);

  client = new Client({ name: "director-shell-smoke-restarted", version: "1.0.0" }, { capabilities: {} });
  transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], cwd: projectDir });
  await client.connect(transport);
  let restartedStatus;
  const restartDeadline = Date.now() + 10_000;
  do {
    const restartedResult = await client.callTool({ name: "job_status", arguments: { job_id: restartStarted.job_id, tail_lines: 40 } });
    restartedStatus = payload(restartedResult);
    if (!restartedStatus.running) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < restartDeadline);
  check("job_status persists across server restart", restartedStatus?.running === false && restartedStatus?.exit_code === 0);
  const restartedJobs = payload(await client.callTool({ name: "job_list", arguments: {} }));
  check("job_list persists across server restart", restartedJobs.jobs?.some((job) => job.job_id === restartStarted.job_id && job.exit_code === 0));
} catch (error) {
  console.log(`FAIL smoke harness: ${error.message}`);
  failures.push("smoke harness");
} finally {
  await client.close().catch(() => {});
  await fs.rm(smokeTempDir, { recursive: true, force: true }).catch(() => {});
}

if (failures.length > 0) {
  console.log(`FAIL ${failures.length} assertion(s)`);
  process.exitCode = 1;
} else {
  console.log("PASS all smoke assertions");
}
