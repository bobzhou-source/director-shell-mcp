import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectDir = dirname(fileURLToPath(import.meta.url));
const serverPath = join(projectDir, "index.js");
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

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const toolNames = listed.tools.map((tool) => tool.name).sort();
  check("initialize handshake", true);
  check("lists five director tools", JSON.stringify(toolNames) === JSON.stringify(["job_kill", "job_list", "job_start", "job_status", "shell_run"]), toolNames.join(", "));

  const echoResult = await client.callTool({ name: "shell_run", arguments: { command: "echo hello" } });
  const echo = payload(echoResult);
  check("shell_run exits zero", echo.exit_code === 0);
  check("shell_run captures hello", echo.stdout?.text?.toLowerCase().includes("hello"));

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
}

if (failures.length > 0) {
  console.log(`FAIL ${failures.length} assertion(s)`);
  process.exitCode = 1;
} else {
  console.log("PASS all smoke assertions");
}
