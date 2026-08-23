const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const cliPath = path.join(__dirname, "..", "dist", "index.js");
const {
  buildFeaturePlanMarkdown,
  buildFeatureSpecMarkdown,
  buildFeatureTasksMarkdown,
  normalizeFeatureSlug,
} = require("../dist/index.js");

function runCli(args, options = {}) {
  const env = {
    ...process.env,
    SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK: "1",
    ...(options.env ?? {}),
  };
  if (!options.env || !Object.prototype.hasOwnProperty.call(options.env, "SNIPARA_API_KEY")) {
    delete env.SNIPARA_API_KEY;
  }
  if (!options.env || !Object.prototype.hasOwnProperty.call(options.env, "SNIPARA_PROJECT_ID")) {
    delete env.SNIPARA_PROJECT_ID;
  }
  return spawnSync(process.execPath, [...(options.nodeArgs ?? []), cliPath, ...args], {
    cwd: options.cwd,
    env,
    encoding: "utf8",
  });
}

function writePlannerPreload(dir) {
  const preload = path.join(dir, "planner-preload.js");
  fs.writeFileSync(
    preload,
    [
      "globalThis.fetch = async (_url, init = {}) => {",
      "  const body = JSON.parse(init.body || '{}');",
      "  if (body.params?.name !== 'snipara_plan') throw new Error('Unexpected tool call');",
      "  return {",
      "    ok: true, status: 200, statusText: 'OK',",
      "    json: async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({",
      "      plan_id: 'plan_feature_test',",
      "      query: 'Make onboarding recoverable',",
      "      steps: [{ id: 'harden-flow', title: 'Harden the onboarding flow', query: 'Update the onboarding boundary', acceptance: 'Failures expose a recovery path', files: ['src/onboarding.ts'] }]",
      "    }) }] } })",
      "  };",
      "};",
      "",
    ].join("\n"),
    "utf8"
  );
  return preload;
}

function featureDir(workspace) {
  return path.join(workspace, "docs", "specs", "onboarding-recovery");
}

test("feature slug normalization is stable and safe for artifact paths", () => {
  assert.equal(normalizeFeatureSlug(" OAuth / Onboarding Recovery "), "oauth-onboarding-recovery");
  assert.throws(() => normalizeFeatureSlug("---"), /at least one letter or number/);
});

test("feature init creates a reviewable spec, plan, and task scaffold", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-feature-init-"));
  const result = runCli(
    [
      "feature",
      "init",
      "onboarding-recovery",
      "--goal",
      "Make onboarding recoverable",
      "--why",
      "Users need an actionable recovery path.",
      "--user",
      "new Snipara user",
      "--constraint",
      "Do not expose secrets",
      "--acceptance",
      "A failed setup shows a recovery action",
    ],
    { cwd: workspace }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const root = featureDir(workspace);
  for (const file of ["feature.json", "spec.md", "plan.md", "tasks.md"]) {
    assert.equal(fs.existsSync(path.join(root, file)), true, file);
  }
  assert.match(fs.readFileSync(path.join(root, "spec.md"), "utf8"), /Make onboarding recoverable/);
  assert.match(fs.readFileSync(path.join(root, "spec.md"), "utf8"), /Do not expose secrets/);

  const duplicate = runCli(
    ["feature", "init", "onboarding-recovery", "--goal", "A different goal"],
    { cwd: workspace }
  );
  assert.notEqual(duplicate.status, 0);
  assert.match(`${duplicate.stderr}${duplicate.stdout}`, /already exists/);
});

test("feature plan and tasks convert hosted phases into durable artifacts", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-feature-plan-"));
  const init = runCli(
    ["feature", "init", "onboarding-recovery", "--goal", "Make onboarding recoverable"],
    { cwd: workspace }
  );
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const preload = writePlannerPreload(workspace);

  const plan = runCli(["feature", "plan", "onboarding-recovery"], {
    cwd: workspace,
    nodeArgs: ["--require", preload],
    env: { SNIPARA_API_KEY: "test-key", SNIPARA_PROJECT_ID: "test-project" },
  });
  assert.equal(plan.status, 0, plan.stderr || plan.stdout);
  assert.match(
    fs.readFileSync(path.join(featureDir(workspace), "plan.md"), "utf8"),
    /Harden the onboarding flow/
  );
  assert.equal(fs.existsSync(path.join(featureDir(workspace), "workflow-plan.json")), true);

  const tasks = runCli(["feature", "tasks", "onboarding-recovery"], { cwd: workspace });
  assert.equal(tasks.status, 0, tasks.stderr || tasks.stdout);
  assert.match(
    fs.readFileSync(path.join(featureDir(workspace), "tasks.md"), "utf8"),
    /Failures expose a recovery path/
  );

  const status = runCli(["feature", "status", "onboarding-recovery", "--json"], { cwd: workspace });
  assert.equal(status.status, 0, status.stderr || status.stdout);
  const payload = JSON.parse(status.stdout);
  assert.equal(payload.manifest.status.plan, "ready");
  assert.equal(payload.manifest.status.tasks, "ready");
});

test("feature tasks can chunk a locally authored plan.md", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-feature-local-plan-"));
  const init = runCli(["feature", "init", "local-plan", "--goal", "Use a local plan"], {
    cwd: workspace,
  });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const root = path.join(workspace, "docs", "specs", "local-plan");
  fs.writeFileSync(
    path.join(root, "plan.md"),
    [
      "# Technical Plan: local-plan",
      "",
      "## Phases",
      "",
      "1. Prepare the local implementation",
      "  - Write the first implementation slice.",
      "",
      "2. Verify the local implementation",
      "",
      "  - Run the focused regression tests.",
      "",
    ].join("\n"),
    "utf8"
  );

  const tasks = runCli(["feature", "tasks", "local-plan"], { cwd: workspace });
  assert.equal(tasks.status, 0, tasks.stderr || tasks.stdout);
  const workflowPlan = JSON.parse(fs.readFileSync(path.join(root, "workflow-plan.json"), "utf8"));
  assert.equal(workflowPlan.source, "local_plan");
  assert.equal(workflowPlan.steps.length, 2);
  assert.match(
    fs.readFileSync(path.join(root, "tasks.md"), "utf8"),
    /Verify the local implementation/
  );

  const start = runCli(["feature", "start", "local-plan", "--workflow-id", "local-plan-workflow"], {
    cwd: workspace,
  });
  assert.equal(start.status, 0, start.stderr || start.stdout);
  const workflowState = JSON.parse(
    fs.readFileSync(path.join(workspace, ".snipara", "workflow", "current.json"), "utf8")
  );
  assert.equal(workflowState.workflowId, "local-plan-workflow");
  assert.equal(workflowState.phases.length, 2);
  assert.equal(workflowState.phases[0].id, workflowPlan.steps[0].id);
});

test("feature markdown builders preserve the workflow boundary", () => {
  const manifest = {
    schemaVersion: "snipara.feature_work_item.v1",
    source: "snipara-companion",
    slug: "demo",
    goal: "Ship the demo",
    users: [],
    constraints: [],
    nonGoals: [],
    acceptanceCriteria: ["The demo is usable"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    artifacts: {
      spec: "spec.md",
      plan: "plan.md",
      tasks: "tasks.md",
      workflowPlan: "workflow-plan.json",
    },
    status: { spec: "ready", plan: "ready", tasks: "ready" },
  };
  const plan = {
    mode: "full",
    goal: manifest.goal,
    source: "snipara_plan",
    plan_id: "plan_demo",
    generatedAt: "2026-01-01T00:00:00.000Z",
    steps: [
      { id: "phase-one", title: "Build it", query: "Build the demo", acceptance: "It works" },
    ],
  };

  assert.match(buildFeatureSpecMarkdown(manifest), /Feature Specification: demo/);
  assert.match(buildFeaturePlanMarkdown(manifest, plan), /Build it/);
  assert.match(buildFeatureTasksMarkdown(manifest, plan), /phase-one/);
});

test("feature tasks preserve explicit DAG and parallel metadata", () => {
  const manifest = {
    schemaVersion: "snipara.feature_work_item.v1",
    source: "snipara-companion",
    slug: "dag-demo",
    goal: "Ship the DAG demo",
    users: [],
    constraints: [],
    nonGoals: [],
    acceptanceCriteria: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    artifacts: {
      spec: "spec.md",
      plan: "plan.md",
      tasks: "tasks.md",
      workflowPlan: "workflow-plan.json",
    },
    status: { spec: "ready", plan: "ready", tasks: "ready" },
  };
  const plan = {
    mode: "full",
    goal: manifest.goal,
    source: "snipara_plan",
    generatedAt: "2026-01-01T00:00:00.000Z",
    steps: [
      {
        id: "parallel-ui",
        title: "Parallel UI work",
        query: "Update independent UI surfaces",
        tasks: [
          { id: "header", title: "Update header", query: "Update header", parallel_group: "ui" },
          {
            id: "footer",
            title: "Update footer",
            query: "Update footer",
            parallel_group: "ui",
            depends_on: ["data-contract"],
          },
        ],
      },
    ],
  };

  const markdown = buildFeatureTasksMarkdown(manifest, plan);
  assert.match(markdown, /Parallel group: ui/);
  assert.match(markdown, /Depends on: data-contract/);
  assert.doesNotMatch(markdown, /Depends on: header/);
});
