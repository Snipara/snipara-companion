const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const { buildVerificationPlan } = require("../dist/index.js");

const cliPath = path.join(__dirname, "..", "dist", "index.js");

function runCli(args, options = {}) {
  const env = {
    ...process.env,
    ...(options.env ?? {}),
  };
  if (!options.env || !Object.prototype.hasOwnProperty.call(options.env, "SNIPARA_API_KEY")) {
    delete env.SNIPARA_API_KEY;
  }
  if (!options.env || !Object.prototype.hasOwnProperty.call(options.env, "SNIPARA_PROJECT_ID")) {
    delete env.SNIPARA_PROJECT_ID;
  }
  if (!options.env || !Object.prototype.hasOwnProperty.call(options.env, "SNIPARA_API_URL")) {
    delete env.SNIPARA_API_URL;
  }
  if (!options.env || !Object.prototype.hasOwnProperty.call(options.env, "SNIPARA_SESSION_ID")) {
    delete env.SNIPARA_SESSION_ID;
  }

  return spawnSync(process.execPath, [...(options.nodeArgs ?? []), cliPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    env,
  });
}

function writePackageJson(dir, pkg) {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function writeVerifyPreload(dir) {
  const preloadPath = path.join(dir, "verify-preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "globalThis.fetch = async (_url, init = {}) => {",
      "  const body = JSON.parse(init.body || '{}');",
      "  const toolName = body.params?.name;",
      "  const args = body.params?.arguments || {};",
      "  let result;",
      "  if (toolName === 'snipara_code_impact') {",
      "    result = {",
      "      changed_files: args.changed_files || [],",
      "      matched_targets: [{ file_path: 'src/auth.ts' }],",
      "      risk: { level: 'medium', score: 42 },",
      "      recommended_tests: [{ title: 'auth route regression', command: 'pnpm test auth' }],",
      "      recommended_actions: [{ action: 'run_type_check', priority: 'high', reason: 'Changed TypeScript surface' }],",
      "      coverage_gaps: [{ code: 'missing_browser_check', severity: 'low', message: 'UI smoke not proven' }],",
      "      index_freshness: { commit_match: true },",
      "      received: args",
      "    };",
      "  } else {",
      "    result = {};",
      "  }",
      "  return {",
      "    ok: true,",
      "    status: 200,",
      "    statusText: 'OK',",
      "    json: async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } })",
      "  };",
      "};",
      "",
    ].join("\n"),
    "utf8"
  );
  return preloadPath;
}

test("buildVerificationPlan combines code impact, coverage gaps, and local scripts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-verify-plan-"));
  fs.mkdirSync(path.join(dir, "packages", "cli", "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "packages", "cli", "test"), { recursive: true });
  writePackageJson(path.join(dir, "packages", "cli"), {
    name: "snipara-companion",
    scripts: {
      test: "node --test test/*.test.js",
      "type-check": "tsc --noEmit",
      lint: "eslint src --ext .ts",
      build: "tsup src/index.ts --format cjs --dts",
    },
  });

  const plan = buildVerificationPlan({
    cwd: dir,
    task: "ship verify command",
    changedFiles: ["packages/cli/src/index.ts"],
    codeImpact: {
      changed_files: ["packages/cli/src/index.ts"],
      matched_targets: [{ file_path: "packages/cli/src/commands/verify.ts" }],
      risk: { level: "medium", score: 45 },
      recommended_tests: [{ title: "verify unit test", file: "packages/cli/test/verify.test.js" }],
      recommended_actions: [{ action: "run_type_check", reason: "CLI TypeScript surface changed" }],
      coverage_gaps: [{ code: "no_browser_check", severity: "low", message: "No UI check needed" }],
      index_freshness: {
        commit_match: false,
        warnings: [{ message: "Hosted graph does not include uncommitted edits." }],
      },
    },
  });

  assert.equal(plan.version, "snipara.verification_plan.v1");
  assert.equal(plan.risk.level, "medium");
  assert.equal(plan.risk.score, 45);
  assert.deepEqual(plan.impactedFiles, [
    "packages/cli/src/index.ts",
    "packages/cli/src/commands/verify.ts",
  ]);
  assert.ok(
    plan.recommendedChecks.some((check) => check.file === "packages/cli/test/verify.test.js")
  );
  assert.ok(
    plan.recommendedChecks.some((check) => check.command === "pnpm --filter snipara-companion test")
  );
  assert.ok(plan.missingChecks.some((gap) => gap.code === "no_browser_check"));
  assert.ok(plan.caveats.some((caveat) => caveat.includes("does not run tests")));
  assert.ok(plan.caveats.some((caveat) => caveat.includes("uncommitted edits")));
});

test("verify command returns JSON from mocked code impact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-verify-cli-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  writePackageJson(dir, {
    name: "sample-project",
    scripts: {
      test: "node --test",
      "type-check": "tsc --noEmit",
    },
  });
  const preloadPath = writeVerifyPreload(dir);

  const result = runCli(
    ["verify", "--task", "ship auth hardening", "--changed-files", "src/auth.ts", "--json"],
    {
      cwd: dir,
      env: {
        SNIPARA_API_KEY: "test-key",
        SNIPARA_PROJECT_ID: "snipara",
        SNIPARA_API_URL: "https://api.snipara.com",
      },
      nodeArgs: ["--require", preloadPath],
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.version, "snipara.verification_plan.v1");
  assert.equal(payload.task, "ship auth hardening");
  assert.equal(payload.codeImpactSourceSelection.selected, "hosted_graph");
  assert.equal(payload.codeImpactSourceSelection.reason, "hosted_configured_and_worktree_clean");
  assert.equal(payload.risk.level, "medium");
  assert.deepEqual(payload.impactedFiles, ["src/auth.ts"]);
  assert.ok(payload.recommendedChecks.some((check) => check.command === "pnpm test auth"));
  assert.ok(payload.recommendedChecks.some((check) => check.command === "pnpm test"));
  assert.ok(payload.missingChecks.some((gap) => gap.code === "missing_browser_check"));
});

test("verify command auto-selects local overlay for dirty worktrees", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-verify-dirty-local-"));
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.email", "agent@example.com"]);
  runGit(dir, ["config", "user.name", "Agent"]);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "auth.ts"), "export const auth = true;\n", "utf8");
  writePackageJson(dir, {
    name: "sample-project",
    scripts: {
      test: "node --test",
    },
  });
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-m", "initial"]);
  fs.appendFileSync(path.join(dir, "src", "auth.ts"), "export const dirty = true;\n", "utf8");

  const result = runCli(
    ["verify", "--task", "ship auth hardening", "--changed-files", "src/auth.ts", "--json"],
    {
      cwd: dir,
      env: {
        SNIPARA_API_KEY: "test-key",
        SNIPARA_PROJECT_ID: "snipara",
        SNIPARA_API_URL: "https://api.snipara.com",
      },
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.codeImpactSourceSelection.requested, "auto");
  assert.equal(payload.codeImpactSourceSelection.selected, "local_overlay");
  assert.equal(payload.codeImpactSourceSelection.reason, "working_tree_dirty");
  assert.equal(payload.codeImpactSourceSelection.dirtyFileCount, 1);
  assert.ok(payload.impactedFiles.includes("src/auth.ts"));
});

test("verify command can run in local fallback mode without hosted impact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-verify-skip-impact-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  writePackageJson(dir, {
    name: "sample-project",
    scripts: {
      lint: "eslint .",
    },
  });

  const result = runCli(["verify", "--skip-impact", "--changed-files", "src/index.ts", "--json"], {
    cwd: dir,
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.risk.level, "unknown");
  assert.ok(payload.recommendedChecks.some((check) => check.command === "pnpm lint"));
  assert.ok(payload.missingChecks.some((gap) => gap.code === "impact_skipped"));
});
