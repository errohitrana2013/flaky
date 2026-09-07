// Boot every generated runner and prove the four agree.
//
// The reason this exists rather than a syntax check: `node --check` and
// `py_compile` both passed on a Python runner whose boolean filter was broken,
// because `str(True)` is "True" and `?done=true` matched nothing. A file that
// compiles is not a file that works, and the only honest test of a generated
// server is to start it and ask it for something.
//
// Node is the reference. Every other runner must return the same status, the
// same x-total-count and the same bytes for the same request — same bytes
// matters because _malformed truncates at a fraction of the body length, so any
// difference in encoding moves the cut.
//
// A runtime that is not installed is skipped and named, not failed: this runs
// on machines that have no JDK and no dotnet.

import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { nodeRunner, pythonRunner, javaRunner, csharpRunner } from "../src/handlers/runner.js";

const run = promisify(execFile);

// Deliberately awkward: a float and a whole number in one field, a boolean, a
// null, an embedded quote, a tab, a backslash and non-ASCII. Every one of these
// has broken a runner at least once.
const DATA = {
  employees: [
    { id: 1, name: "Asha", done: true, score: 9.5, manager: null, note: 'say "hi"\ttab', userId: 1 },
    { id: 2, name: "Bruno", done: false, score: 7, manager: 1, note: "café — ünicode", userId: 2 },
    { id: 3, name: "Chen", done: true, score: 7, manager: 1, note: "back\\slash", userId: 1 },
  ],
  tags: [{ id: 10, label: "alpha" }, { id: 11, label: "beta" }],
};

// _delay and _fail_rate below 1 are left out on purpose: one is a clock and the
// other is a coin, and neither can be compared byte for byte.
const REQUESTS = [
  "/",
  "/employees",
  "/employees/2",
  "/employees/99",
  "/tags",
  "/nope",
  "/employees?done=true",
  "/employees?userId=1&_select=name",
  "/employees?_sort=score&_order=desc",
  "/employees?_sort=score&_order=asc&_select=id,score",
  "/employees?_sort=manager",
  "/employees?_q=bruno",
  "/employees?_limit=1&_page=2",
  "/employees?_start=2&_limit=5",
  "/employees?_limit=2",
  "/employees?_malformed=1",
  "/employees?_status=503",
  "/employees?_status=429",
  "/employees?_fail_rate=1",
];

const has = async (cmd, args) => {
  try {
    await run(cmd, args);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(port, child, name) {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`${name} exited early (${child.exitCode})\n${child.log}`);
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`${name} never came up on ${port}\n${child.log}`);
}

// Everything that identifies a response and nothing that varies between runs.
async function probe(port) {
  const seen = {};
  for (const path of REQUESTS) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    seen[path] = {
      status: res.status,
      total: res.headers.get("x-total-count"),
      retry: res.headers.get("retry-after"),
      cors: res.headers.get("access-control-allow-origin"),
      body: await res.text(),
    };
  }
  return seen;
}

async function boot(name, cmd, args, cwd, port) {
  const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  child.log = "";
  child.stdout.on("data", (d) => (child.log += d));
  child.stderr.on("data", (d) => (child.log += d));

  try {
    await waitFor(port, child, name);
    return await probe(port);
  } finally {
    child.kill("SIGKILL");
  }
}

function compare(name, reference, actual, failures) {
  for (const path of REQUESTS) {
    const want = reference[path];
    const got = actual[path];
    for (const field of ["status", "total", "retry", "cors", "body"]) {
      if (String(want[field]) !== String(got[field])) {
        failures.push(`${name} ${path} → ${field}\n    node: ${JSON.stringify(want[field])}\n    ${name}: ${JSON.stringify(got[field])}`);
      }
    }
  }
}

const dir = await mkdtemp(join(tmpdir(), "flaky-runners-"));
const dotnet = process.env.DOTNET ?? "dotnet";
const failures = [];
const skipped = [];
let checked = 0;

try {
  await writeFile(join(dir, "mock-server.mjs"), nodeRunner(DATA));
  await writeFile(join(dir, "mock_server.py"), pythonRunner(DATA));
  await writeFile(join(dir, "MockServer.java"), javaRunner(DATA));
  await writeFile(join(dir, "MockServer.cs"), csharpRunner(DATA));

  const reference = await boot("node", process.execPath, ["mock-server.mjs", "4301"], dir, 4301);
  checked++;

  if (await has("python3", ["--version"])) {
    compare("python", reference, await boot("python", "python3", ["mock_server.py", "4302"], dir, 4302), failures);
    checked++;
  } else skipped.push("python3");

  // A single .java file runs directly from JDK 11. No javac step, no classpath.
  if (await has("java", ["-version"])) {
    compare("java", reference, await boot("java", "java", ["MockServer.java", "4303"], dir, 4303), failures);
    checked++;
  } else skipped.push("java");

  // .NET 10 runs a loose .cs file; 8 and 9 need a project, which is the fallback
  // the generated file documents — so building it that way tests both the code
  // and the instructions printed at the top of it.
  if (await has(dotnet, ["--version"])) {
    const project = join(dir, "csproj");
    await mkdir(project, { recursive: true });
    await run(dotnet, ["new", "console", "-o", project], { env: { ...process.env, DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
    await writeFile(join(project, "Program.cs"), csharpRunner(DATA));

    const built = await run(dotnet, ["build", project, "-v", "q", "--nologo"], { env: { ...process.env, DOTNET_NOLOGO: "1" } });
    // A generated file that only compiles with warnings is a file someone will
    // have to fix before it goes in their repo.
    // "0 Warning(s)" contains the word, so match the code the compiler prints.
    if (/warning [A-Z]{2}\d{4}/.test(built.stdout)) failures.push(`csharp build warnings:\n${built.stdout}`);

    compare("csharp", reference, await boot("csharp", dotnet, ["run", "--project", project, "--no-build", "--", "4304"], dir, 4304), failures);
    checked++;
  } else skipped.push("dotnet");
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (skipped.length) console.log(`skipped, not installed: ${skipped.join(", ")}`);

if (failures.length) {
  console.error(`\n${failures.length} disagreement(s) with the node runner:\n`);
  for (const failure of failures) console.error("  " + failure + "\n");
  process.exit(1);
}

console.log(`${checked} runners agree, over ${REQUESTS.length} requests each`);
