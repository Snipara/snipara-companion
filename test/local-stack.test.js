const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const cliPath = path.join(__dirname, "..", "dist", "index.js");

function runCli(args, options = {}) {
  const env = {
    ...process.env,
    ...(options.env ?? {}),
  };
  delete env.SNIPARA_API_KEY;
  delete env.SNIPARA_PROJECT_ID;
  delete env.SNIPARA_API_URL;

  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    env,
  });
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, "utf8");
  fs.chmodSync(filePath, 0o755);
}

test("eval export writes a snipara-evals case with local workflow artifacts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-eval-export-"));
  fs.mkdirSync(path.join(dir, ".snipara", "workflow"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".snipara", "workflow", "current.json"),
    JSON.stringify({ workflowId: "demo", currentPhaseId: "verify" }),
    "utf8"
  );

  const output = path.join(dir, ".snipara", "evals", "case.json");
  const result = runCli(
    [
      "eval",
      "export",
      "--summary",
      "Implemented auth hardening and ran tests",
      "--decision",
      "Code graph remains hosted",
      "--verification",
      "pnpm test",
      "--continuity",
      "Leave a concise next-step handoff",
      "--files",
      "src/auth.ts",
      "tests/auth.test.ts",
      "--command-run",
      "pnpm test",
      "--output",
      output,
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr);
  const artifact = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(artifact.id, "implemented-auth-hardening-and-ran-tests");
  assert.equal(artifact.observed.answer, "Implemented auth hardening and ran tests");
  assert.deepEqual(artifact.observed.filesChanged, ["src/auth.ts", "tests/auth.test.ts"]);
  assert.deepEqual(artifact.observed.commandsRun, ["pnpm test"]);
  assert.equal(artifact.expected.decisions[0].statement, "Code graph remains hosted");
  assert.equal(artifact.expected.verification[0].command, "pnpm test");
  assert.equal(artifact.observed.artifacts[0].path, ".snipara/workflow/current.json");
});

test("eval run delegates to npx snipara-evals", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-eval-run-"));
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const argsFile = path.join(dir, "args.txt");
  writeExecutable(
    path.join(binDir, "npx"),
    ["#!/bin/sh", `printf '%s\\n' \"$@\" > ${JSON.stringify(argsFile)}`, "echo eval-ok", ""].join(
      "\n"
    )
  );
  fs.writeFileSync(path.join(dir, "case.json"), "{}", "utf8");

  const result = runCli(["eval", "run", "case.json", "--json", "--strict"], {
    cwd: dir,
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /eval-ok/);
  const args = fs.readFileSync(argsFile, "utf8").trim().split("\n");
  assert.deepEqual(args, [
    "--yes",
    "snipara-evals@latest",
    "run",
    "case.json",
    "--json",
    "--fail-on-threshold",
  ]);
});

test("memory local delegates to snipara-memory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-memory-local-"));
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const argsFile = path.join(dir, "memory-args.txt");
  writeExecutable(
    path.join(binDir, "snipara-memory"),
    ["#!/bin/sh", `printf '%s\\n' \"$@\" > ${JSON.stringify(argsFile)}`, "echo memory-ok", ""].join(
      "\n"
    )
  );

  const result = runCli(["memory", "local", "version"], {
    cwd: dir,
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /memory-ok/);
  assert.deepEqual(fs.readFileSync(argsFile, "utf8").trim().split("\n"), ["version"]);
});
