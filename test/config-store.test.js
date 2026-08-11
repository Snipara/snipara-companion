const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { getConfigPath, loadConfig, saveConfig } = require("../dist/index.js");

function withTempHome(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-config-"));
  const homeDir = path.join(tmpDir, "home");
  fs.mkdirSync(homeDir, { recursive: true });

  const previousHome = process.env.HOME;
  const previousApiKey = process.env.SNIPARA_API_KEY;
  const previousProjectId = process.env.SNIPARA_PROJECT_ID;
  const previousApiUrl = process.env.SNIPARA_API_URL;
  const previousSessionId = process.env.SNIPARA_SESSION_ID;
  const previousAutomationClient = process.env.SNIPARA_AUTOMATION_CLIENT;
  const previousWorkspaceDir = process.env.SNIPARA_WORKSPACE_DIR;
  process.env.HOME = homeDir;
  delete process.env.SNIPARA_API_KEY;
  delete process.env.SNIPARA_PROJECT_ID;
  delete process.env.SNIPARA_API_URL;
  delete process.env.SNIPARA_SESSION_ID;
  delete process.env.SNIPARA_AUTOMATION_CLIENT;
  delete process.env.SNIPARA_WORKSPACE_DIR;

  try {
    fn({ tmpDir, homeDir });
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousApiKey === undefined) {
      delete process.env.SNIPARA_API_KEY;
    } else {
      process.env.SNIPARA_API_KEY = previousApiKey;
    }
    if (previousProjectId === undefined) {
      delete process.env.SNIPARA_PROJECT_ID;
    } else {
      process.env.SNIPARA_PROJECT_ID = previousProjectId;
    }
    if (previousApiUrl === undefined) {
      delete process.env.SNIPARA_API_URL;
    } else {
      process.env.SNIPARA_API_URL = previousApiUrl;
    }
    if (previousSessionId === undefined) {
      delete process.env.SNIPARA_SESSION_ID;
    } else {
      process.env.SNIPARA_SESSION_ID = previousSessionId;
    }
    if (previousAutomationClient === undefined) {
      delete process.env.SNIPARA_AUTOMATION_CLIENT;
    } else {
      process.env.SNIPARA_AUTOMATION_CLIENT = previousAutomationClient;
    }
    if (previousWorkspaceDir === undefined) {
      delete process.env.SNIPARA_WORKSPACE_DIR;
    } else {
      process.env.SNIPARA_WORKSPACE_DIR = previousWorkspaceDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("workspace companion config stores auth and project in one file", () => {
  withTempHome(({ tmpDir }) => {
    const repoDir = path.join(tmpDir, "repo");
    const nestedDir = path.join(repoDir, "src");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, ".snipara", "companion"), { recursive: true });
    fs.mkdirSync(nestedDir, { recursive: true });

    const workspaceConfigPath = path.join(repoDir, ".snipara", "companion", "config.json");

    fs.writeFileSync(
      workspaceConfigPath,
      JSON.stringify({ apiKey: "workspace-key", projectId: "workspace-project", client: "codex" }),
      "utf8"
    );

    const previousCwd = process.cwd();
    process.chdir(nestedDir);

    try {
      const config = loadConfig();
      assert.equal(config.apiKey, "workspace-key");
      assert.equal(config.projectId, "workspace-project");
      assert.equal(config.client, "codex");
      assert.equal(fs.realpathSync(getConfigPath()), fs.realpathSync(workspaceConfigPath));
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test("environment variables override file-based config resolution", () => {
  withTempHome(({ homeDir }) => {
    fs.mkdirSync(path.join(homeDir, ".snipara", "companion"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".snipara", "companion", "config.json"),
      JSON.stringify({ apiKey: "global-key", projectId: "global-project" }),
      "utf8"
    );

    const previousProjectId = process.env.SNIPARA_PROJECT_ID;
    process.env.SNIPARA_PROJECT_ID = "env-project";

    try {
      const config = loadConfig();
      assert.equal(config.projectId, "env-project");
      assert.equal(config.apiKey, "global-key");
    } finally {
      if (previousProjectId === undefined) {
        delete process.env.SNIPARA_PROJECT_ID;
      } else {
        process.env.SNIPARA_PROJECT_ID = previousProjectId;
      }
    }
  });
});

test("workspace companion config wins over stale env auth", () => {
  withTempHome(({ tmpDir }) => {
    const repoDir = path.join(tmpDir, "repo");
    const nestedDir = path.join(repoDir, "src");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, ".snipara", "companion"), { recursive: true });
    fs.mkdirSync(nestedDir, { recursive: true });

    fs.writeFileSync(
      path.join(repoDir, ".snipara", "companion", "config.json"),
      JSON.stringify({
        apiKey: "workspace-project-key",
        projectId: "workspace-project",
        apiUrl: "https://api.snipara.com",
      }),
      "utf8"
    );

    const previousCwd = process.cwd();
    process.env.SNIPARA_API_KEY = "stale-env-key";
    process.env.SNIPARA_PROJECT_ID = "stale-env-project";
    process.chdir(nestedDir);

    try {
      const config = loadConfig();
      assert.equal(config.apiKey, "workspace-project-key");
      assert.equal(config.projectId, "workspace-project");
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test("empty SNIPARA_API_URL does not override the default API URL", () => {
  withTempHome(({ homeDir }) => {
    fs.mkdirSync(path.join(homeDir, ".snipara", "companion"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".snipara", "companion", "config.json"),
      JSON.stringify({ apiKey: "global-key" }),
      "utf8"
    );

    const previousApiUrl = process.env.SNIPARA_API_URL;
    process.env.SNIPARA_API_URL = "";

    try {
      const config = loadConfig();
      assert.equal(config.apiUrl, "https://api.snipara.com");
    } finally {
      if (previousApiUrl === undefined) {
        delete process.env.SNIPARA_API_URL;
      } else {
        process.env.SNIPARA_API_URL = previousApiUrl;
      }
    }
  });
});

test(".snipara/project provides a project fallback for companion config", () => {
  withTempHome(({ tmpDir }) => {
    const repoDir = path.join(tmpDir, "repo");
    const nestedDir = path.join(repoDir, "src");
    fs.mkdirSync(path.join(repoDir, ".snipara", "companion"), { recursive: true });
    fs.mkdirSync(nestedDir, { recursive: true });

    fs.writeFileSync(
      path.join(repoDir, ".snipara", "companion", "config.json"),
      JSON.stringify({ apiKey: "global-key" }),
      "utf8"
    );
    fs.writeFileSync(path.join(repoDir, ".snipara", "project"), "project-slug\n", "utf8");

    const previousCwd = process.cwd();
    process.chdir(nestedDir);

    try {
      const config = loadConfig();
      assert.equal(config.apiKey, "global-key");
      assert.equal(config.projectId, "project-slug");
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test(".snipara/project overrides stale global project binding", () => {
  withTempHome(({ tmpDir, homeDir }) => {
    const repoDir = path.join(tmpDir, "repo");
    const nestedDir = path.join(repoDir, "src");
    fs.mkdirSync(path.join(homeDir, ".snipara", "companion"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, ".snipara", "companion"), { recursive: true });
    fs.mkdirSync(nestedDir, { recursive: true });

    fs.writeFileSync(
      path.join(homeDir, ".snipara", "companion", "config.json"),
      JSON.stringify({ apiKey: "global-key", projectId: "global-project" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(repoDir, ".snipara", "companion", "config.json"),
      JSON.stringify({ apiKey: "workspace-key" }),
      "utf8"
    );
    fs.writeFileSync(path.join(repoDir, ".snipara", "project"), "workspace-project\n", "utf8");

    const previousCwd = process.cwd();
    process.chdir(nestedDir);

    try {
      const config = loadConfig();
      assert.equal(config.apiKey, "workspace-key");
      assert.equal(config.projectId, "workspace-project");
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test("SNIPARA_WORKSPACE_DIR anchors config when commands run from a package subdir", () => {
  withTempHome(({ tmpDir }) => {
    const repoDir = path.join(tmpDir, "repo");
    const packageDir = path.join(repoDir, "packages", "cli");
    fs.mkdirSync(path.join(repoDir, ".snipara", "companion"), { recursive: true });
    fs.mkdirSync(packageDir, { recursive: true });

    fs.writeFileSync(
      path.join(repoDir, ".snipara", "companion", "config.json"),
      JSON.stringify({ apiKey: "global-key" }),
      "utf8"
    );
    fs.writeFileSync(path.join(repoDir, ".snipara", "project"), "root-project\n", "utf8");

    const previousCwd = process.cwd();
    process.env.SNIPARA_WORKSPACE_DIR = repoDir;
    process.chdir(packageDir);

    try {
      const config = loadConfig();
      assert.equal(config.apiKey, "global-key");
      assert.equal(config.projectId, "root-project");
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test("workspace saves keep auth and project in one companion config", () => {
  withTempHome(({ tmpDir }) => {
    const repoDir = path.join(tmpDir, "repo");
    const workspaceConfigPath = path.join(repoDir, ".snipara", "companion", "config.json");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.mkdirSync(path.dirname(workspaceConfigPath), { recursive: true });

    fs.writeFileSync(
      workspaceConfigPath,
      JSON.stringify(
        {
          apiKey: "legacy-local-key",
          apiUrl: "https://api.snipara.com",
          projectId: "legacy-project",
          sessionId: "sess_existing",
          client: "codex",
        },
        null,
        2
      ),
      "utf8"
    );

    saveConfig({ projectId: "proj_snipara_001" }, { cwd: repoDir, scope: "workspace" });

    const workspaceConfig = JSON.parse(fs.readFileSync(workspaceConfigPath, "utf8"));
    assert.deepEqual(workspaceConfig, {
      apiKey: "legacy-local-key",
      apiUrl: "https://api.snipara.com",
      client: "codex",
      projectId: "proj_snipara_001",
      sessionId: "sess_existing",
    });
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.dirname(workspaceConfigPath)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(workspaceConfigPath).mode & 0o777, 0o600);
    }
  });
});

test("loading an existing companion config repairs permissive secret permissions", () => {
  if (process.platform === "win32") {
    return;
  }

  withTempHome(({ tmpDir }) => {
    const repoDir = path.join(tmpDir, "repo");
    const workspaceConfigPath = path.join(repoDir, ".snipara", "companion", "config.json");
    fs.mkdirSync(path.dirname(workspaceConfigPath), { recursive: true, mode: 0o755 });
    fs.writeFileSync(
      workspaceConfigPath,
      JSON.stringify({ apiKey: "workspace-key", projectId: "workspace-project" }),
      { encoding: "utf8", mode: 0o644 }
    );
    fs.chmodSync(path.dirname(workspaceConfigPath), 0o755);
    fs.chmodSync(workspaceConfigPath, 0o644);

    loadConfig({ cwd: repoDir, scope: "workspace" });

    assert.equal(fs.statSync(path.dirname(workspaceConfigPath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(workspaceConfigPath).mode & 0o777, 0o600);
  });
});
