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

  for (const name of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "SNIPARA_API_KEY",
    "SNIPARA_PROJECT_ID",
    "SNIPARA_API_URL",
    "SNIPARA_SESSION_ID",
    "SNIPARA_AUTOMATION_CLIENT",
  ]) {
    if (!options.env || !Object.prototype.hasOwnProperty.call(options.env, name)) {
      delete env[name];
    }
  }

  return spawnSync(process.execPath, [...(options.nodeArgs ?? []), cliPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    env,
  });
}

function makeTempWorkspace(name, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-home-`));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");

  if (options.projectSlug !== false) {
    fs.mkdirSync(path.join(dir, ".snipara"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".snipara", "project"),
      `${options.projectSlug ?? "inmosuiza"}\n`,
      "utf8"
    );
  }

  if (options.gitRemote !== false) {
    const init = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr || init.stdout);
    const remote = spawnSync(
      "git",
      [
        "remote",
        "add",
        "origin",
        options.gitRemote ?? "https://github.com/sarucca1977/inmosuiza.git",
      ],
      { cwd: dir, encoding: "utf8" }
    );
    assert.equal(remote.status, 0, remote.stderr || remote.stdout);
  }

  return { dir, home };
}

function makeNoopBrowserBin(dir) {
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  for (const command of ["open", "xdg-open", "cmd"]) {
    const commandPath = path.join(binDir, command);
    fs.writeFileSync(commandPath, "#!/usr/bin/env sh\nexit 0\n", "utf8");
    fs.chmodSync(commandPath, 0o755);
  }
  return binDir;
}

function writeAuthPreload(dir, options = {}) {
  const callsPath = path.join(dir, "fetch-calls.jsonl");
  const preloadPath = path.join(dir, "auth-preload.js");
  const projectSlug = options.projectSlug ?? "inmosuiza";
  const projectId = options.projectId ?? "proj_inmosuiza_001";
  const projectName = options.projectName ?? "InmoSuiza";
  const userCode = options.userCode ?? "TEST-CODE";

  fs.writeFileSync(
    preloadPath,
    [
      "const fs = require('fs');",
      `const callsPath = ${JSON.stringify(callsPath)};`,
      `const projectSlug = ${JSON.stringify(projectSlug)};`,
      `const projectId = ${JSON.stringify(projectId)};`,
      `const projectName = ${JSON.stringify(projectName)};`,
      `const userCode = ${JSON.stringify(userCode)};`,
      "function jsonResponse(body, status = 200) {",
      "  return {",
      "    ok: status >= 200 && status < 300,",
      "    status,",
      "    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',",
      "    json: async () => body,",
      "    text: async () => JSON.stringify(body),",
      "  };",
      "}",
      "globalThis.fetch = async (url, init = {}) => {",
      "  const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;",
      "  const call = { url: String(url), method: init.method || 'GET', body };",
      "  fs.appendFileSync(callsPath, JSON.stringify(call) + '\\n', 'utf8');",
      "  const value = String(url);",
      "  if (value.includes('/api/oauth/device/code')) {",
      "    return jsonResponse({",
      "      device_code: 'device-test',",
      "      user_code: userCode,",
      "      verification_uri: 'https://www.snipara.com/device',",
      "      verification_uri_complete: `https://www.snipara.com/device?code=${userCode}`,",
      "      expires_in: 600,",
      "      interval: 0,",
      "    });",
      "  }",
      "  if (value.includes('/api/oauth/device/token')) {",
      "    if (body && body.client_id === 'snipara-cli') {",
      "      return jsonResponse({",
      "        access_token: 'snp-user-key',",
      "        token_type: 'Bearer',",
      "        key_type: 'user',",
      "        user: { id: 'user_001', email: 'user@example.com', name: null },",
      "      });",
      "    }",
      "    return jsonResponse({",
      "      api_key: 'snp-project-key',",
      "      project_id: projectId,",
      "      project_slug: projectSlug,",
      "      project_name: projectName,",
      "      server_url: 'https://api.snipara.com',",
      "    });",
      "  }",
      "  if (value.includes('/api/cli/projects')) {",
      "    return jsonResponse({",
      "      success: true,",
      "      data: [",
      "        { id: projectId, slug: projectSlug, name: projectName, githubRepo: 'sarucca1977/inmosuiza', ownerType: 'user', automationClient: 'claude-code' },",
      "        { id: 'proj_other_001', slug: 'other-project', name: 'Other Project', githubRepo: 'sarucca1977/other', ownerType: 'user' },",
      "      ],",
      "    });",
      "  }",
      "  if (value.includes('/automation/config')) {",
      "    return jsonResponse({",
      "      success: true,",
      "      data: {",
      "        client: 'claude-code',",
      "        files: [",
      "          { path: '.claude/hooks/snipara-pre-tool.sh', content: '#!/usr/bin/env bash\\nAPI_KEY=\"snp-placeholder\"\\n' },",
      "        ],",
      "      },",
      "    });",
      "  }",
      "  return jsonResponse({",
      "    jsonrpc: '2.0',",
      "    id: 1,",
      "    result: { content: [{ type: 'text', text: '{}' }] },",
      "  });",
      "};",
      "",
    ].join("\n"),
    "utf8"
  );

  return { preloadPath, callsPath };
}

function readFetchCalls(callsPath) {
  if (!fs.existsSync(callsPath)) {
    return [];
  }

  return fs
    .readFileSync(callsPath, "utf8")
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const projectAuthCommandCases = [
  {
    name: "init",
    args: ["init", "--client", "claude-code", "--force"],
    expectedClientId: "claude-code",
  },
  {
    name: "init --with-hooks",
    args: ["init", "--client", "claude-code", "--with-hooks", "--force"],
    expectedClientId: "claude-code",
    expectAutomationBundle: true,
  },
  {
    name: "login",
    args: ["login", "--client", "claude-code"],
    expectedClientId: "claude-code",
  },
  {
    name: "login --project",
    args: ["login", "--client", "claude-code", "--project", "explicit-project"],
    expectedClientId: "claude-code",
    expectedProjectHint: "explicit-project",
    projectSlug: "explicit-project",
    projectId: "proj_explicit_001",
    projectName: "Explicit Project",
  },
  {
    name: "login --client mistral",
    args: ["login", "--client", "mistral"],
    expectedClientId: "mistral",
  },
];

for (const commandCase of projectAuthCommandCases) {
  test(`${commandCase.name} opens project picker auth with local repo context`, () => {
    const { dir, home } = makeTempWorkspace(
      `snipara-auth-${commandCase.name.replace(/\W+/g, "-")}`
    );
    const binDir = makeNoopBrowserBin(dir);
    const { preloadPath, callsPath } = writeAuthPreload(dir, {
      projectSlug: commandCase.projectSlug,
      projectId: commandCase.projectId,
      projectName: commandCase.projectName,
    });

    const result = runCli(commandCase.args, {
      cwd: dir,
      env: { HOME: home, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
      nodeArgs: ["-r", preloadPath],
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Opening browser to authorize this workspace/);
    assert.match(result.stdout, /Select the project\/repo this workspace should use/);
    assert.match(
      result.stdout,
      new RegExp(`project_hint=${commandCase.expectedProjectHint ?? "inmosuiza"}`)
    );
    if (!commandCase.expectedProjectHint) {
      assert.match(result.stdout, /repo_hint=sarucca1977%2Finmosuiza/);
    }

    const calls = readFetchCalls(callsPath);
    const deviceCodeCalls = calls.filter((call) => call.url.includes("/api/oauth/device/code"));
    assert.equal(deviceCodeCalls.length, 1);
    assert.equal(deviceCodeCalls[0].body.client_id, commandCase.expectedClientId);
    assert.equal(deviceCodeCalls[0].body.scope, "mcp:read mcp:write");
    assert.equal(deviceCodeCalls[0].body.auto_provision, true);

    if (commandCase.expectAutomationBundle) {
      assert.ok(calls.some((call) => call.url.includes("/automation/config")));
      assert.ok(fs.existsSync(path.join(dir, ".claude", "hooks", "snipara-pre-tool.sh")));
      const postCommitHook = fs.readFileSync(
        path.join(dir, ".git", "hooks", "post-commit"),
        "utf8"
      );
      const prePushHook = fs.readFileSync(path.join(dir, ".git", "hooks", "pre-push"), "utf8");
      assert.match(postCommitHook, /snipara-companion code sync --commit HEAD/);
      assert.match(prePushHook, /snipara-companion code promote --from-hook pre-push/);
    }

    const workspaceConfig = JSON.parse(
      fs.readFileSync(path.join(dir, ".snipara", "companion", "config.json"), "utf8")
    );
    assert.equal(workspaceConfig.apiKey, "snp-project-key");
    assert.equal(workspaceConfig.projectId, commandCase.projectId ?? "proj_inmosuiza_001");
    assert.equal(
      fs.readFileSync(path.join(dir, ".snipara", "project"), "utf8"),
      `${commandCase.projectSlug ?? "inmosuiza"}\n`
    );

    if (commandCase.name.startsWith("init")) {
      const agentsMd = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
      assert.match(agentsMd, /snipara:workflow AGENTS\.md:start/);
      assert.match(agentsMd, /Snipara Context Workflow/);
      assert.match(agentsMd, /snipara-companion workflow start/);
      assert.match(agentsMd, /plan_json_file/);
      assert.match(agentsMd, /workflow resume[\s\S]*workflow phase-start/);

      const claudeMd = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
      assert.match(claudeMd, /snipara:workflow CLAUDE\.md:start/);
      assert.match(claudeMd, /Snipara Workflow/);
      assert.match(claudeMd, /do not wait for the user to explicitly ask for Snipara/);
      assert.match(claudeMd, /snipara-companion workflow start/);
      assert.match(claudeMd, /plan in JSON/);
      assert.match(claudeMd, /does not snapshot or exactly restore a live Snipara Sandbox/);
      assert.match(claudeMd, new RegExp(`mcp/${commandCase.projectSlug ?? "inmosuiza"}`));
    }
  });
}

test("init merges Claude workflow instructions without replacing existing CLAUDE.md", () => {
  const { dir, home } = makeTempWorkspace("snipara-auth-existing-claude-md");
  const existingClaudeGuide = "# Existing Claude Guide\n\nKeep local project rules.\n";
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), existingClaudeGuide, "utf8");
  const { preloadPath } = writeAuthPreload(dir);
  const args = [
    "init",
    "--client",
    "claude-code",
    "--api-key",
    "snp-project-key",
    "--project",
    "inmosuiza",
    "--force",
  ];

  const firstResult = runCli(args, {
    cwd: dir,
    env: { HOME: home },
    nodeArgs: ["-r", preloadPath],
  });

  assert.equal(firstResult.status, 0, firstResult.stderr || firstResult.stdout);

  const firstContent = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
  assert.ok(firstContent.startsWith(existingClaudeGuide));
  assert.match(firstContent, /snipara:workflow CLAUDE\.md:start/);
  assert.match(firstContent, /Bound Snipara project: `inmosuiza`/);
  assert.match(firstContent, /snipara-companion workflow phase-commit/);
  assert.equal((firstContent.match(/snipara:workflow CLAUDE\.md:start/g) || []).length, 1);

  const secondResult = runCli(args, {
    cwd: dir,
    env: { HOME: home },
    nodeArgs: ["-r", preloadPath],
  });

  assert.equal(secondResult.status, 0, secondResult.stderr || secondResult.stdout);

  const secondContent = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
  assert.equal(secondContent, firstContent);
  assert.equal((secondContent.match(/snipara:workflow CLAUDE\.md:start/g) || []).length, 1);
});

test("init installs workflow instructions for each agent client surface", () => {
  const cases = [
    { client: "codex", files: ["AGENTS.md"] },
    { client: "cursor", files: ["AGENTS.md", ".cursor/rules/snipara.mdc"] },
    { client: "gemini", files: ["AGENTS.md", "GEMINI.md"] },
    { client: "mistral", files: ["AGENTS.md", "MISTRAL.md"] },
    { client: "vscode", files: ["AGENTS.md", ".github/copilot-instructions.md"] },
    { client: "continue", files: ["AGENTS.md"] },
    { client: "chatgpt", files: ["AGENTS.md"] },
    { client: "custom", files: ["AGENTS.md"] },
  ];

  for (const commandCase of cases) {
    const { dir, home } = makeTempWorkspace(`snipara-auth-${commandCase.client}-workflow`);
    const { preloadPath } = writeAuthPreload(dir);

    const result = runCli(
      [
        "init",
        "--client",
        commandCase.client,
        "--api-key",
        "snp-project-key",
        "--project",
        "inmosuiza",
        "--force",
      ],
      {
        cwd: dir,
        env: { HOME: home },
        nodeArgs: ["-r", preloadPath],
      }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);

    for (const relativePath of commandCase.files) {
      const content = fs.readFileSync(path.join(dir, relativePath), "utf8");
      assert.match(
        content,
        new RegExp(`snipara:workflow ${relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:start`)
      );
      assert.match(content, /snipara_recall/);
      assert.match(content, /snipara-companion workflow start/);
      assert.match(content, /plan_json_file/);
      assert.match(content, /mcp\/inmosuiza/);
    }

    if (commandCase.client === "cursor") {
      const cursorRule = fs.readFileSync(path.join(dir, ".cursor", "rules", "snipara.mdc"), "utf8");
      assert.ok(cursorRule.startsWith("---\n"));
      assert.match(cursorRule, /alwaysApply: true/);
    }

    if (commandCase.client === "mistral") {
      const mistralGuide = fs.readFileSync(path.join(dir, "MISTRAL.md"), "utf8");
      assert.match(mistralGuide, /Le Chat/);
      assert.match(mistralGuide, /ChatMistralAI\.bindTools/);
      assert.match(mistralGuide, /beforeRequestHooks/);
    }
  }
});

test("init --with-hooks keeps Mistral on MCP-first setup without native hooks", () => {
  const { dir, home } = makeTempWorkspace("snipara-auth-mistral-no-hooks");
  const { preloadPath } = writeAuthPreload(dir);

  const result = runCli(
    [
      "init",
      "--client",
      "mistral",
      "--api-key",
      "snp-project-key",
      "--project",
      "inmosuiza",
      "--with-hooks",
      "--force",
    ],
    {
      cwd: dir,
      env: { HOME: home },
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Native hook install is disabled for Mistral Le Chat \/ Vibe/);
  assert.match(result.stdout, /model request hooks/);
  assert.equal(fs.existsSync(path.join(dir, ".claude", "hooks")), false);
  assert.equal(fs.existsSync(path.join(dir, ".cursor", "hooks")), false);
  assert.ok(fs.existsSync(path.join(dir, "MISTRAL.md")));
});

test("login --user-key opens legacy API-key auth without project selection", () => {
  const { dir, home } = makeTempWorkspace("snipara-auth-user-key", {
    projectSlug: false,
    gitRemote: false,
  });
  const binDir = makeNoopBrowserBin(dir);
  const { preloadPath, callsPath } = writeAuthPreload(dir);

  const result = runCli(["login", "--user-key"], {
    cwd: dir,
    env: { HOME: home, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
    nodeArgs: ["-r", preloadPath],
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Snipara user-key login/);
  assert.match(result.stdout, /Opening browser to authorize this device/);
  assert.match(result.stdout, /legacy user key is not project-bound/);
  assert.doesNotMatch(result.stdout, /Select the project\/repo this workspace should use/);

  const calls = readFetchCalls(callsPath);
  const deviceCodeCalls = calls.filter((call) => call.url.includes("/api/oauth/device/code"));
  assert.equal(deviceCodeCalls.length, 1);
  assert.equal(deviceCodeCalls[0].body.client_id, "snipara-cli");
  assert.equal(deviceCodeCalls[0].body.auto_provision, true);

  const workspaceConfig = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "companion", "config.json"), "utf8")
  );
  assert.equal(workspaceConfig.apiKey, "snp-user-key");
  assert.equal(workspaceConfig.projectId, undefined);
  assert.equal(fs.existsSync(path.join(dir, ".snipara", "project")), false);
});

test("init with an API key and multiple projects requires an explicit project choice", () => {
  const { dir, home } = makeTempWorkspace("snipara-auth-api-key-choice", {
    projectSlug: false,
    gitRemote: false,
  });
  const { preloadPath, callsPath } = writeAuthPreload(dir);

  const result = runCli(
    ["init", "--api-key", "snp-test-key", "--client", "claude-code", "--force"],
    {
      cwd: dir,
      env: { HOME: home },
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Select the project this workspace should use/);
  assert.match(result.stdout, /1\. InmoSuiza \(inmosuiza .* sarucca1977\/inmosuiza\)/);
  assert.match(result.stdout, /2\. Other Project \(other-project .* sarucca1977\/other\)/);
  assert.match(result.stdout, /npx -y snipara-companion@latest init --project inmosuiza/);
  assert.match(result.stdout, /npx -y snipara-companion@latest init --project other-project/);
  assert.match(result.stderr, /Project selection requires an interactive terminal/);

  const calls = readFetchCalls(callsPath);
  assert.ok(calls.some((call) => call.url.includes("/api/cli/projects")));
  assert.equal(
    calls.some((call) => call.url.includes("/api/oauth/device/code")),
    false
  );
});

test("configured-only commands do not start hidden browser auth when auth is missing", () => {
  const commandCases = [
    ["query", "--query", "auth middleware", "--max-tokens", "100"],
    ["shared-context", "--categories", "MANDATORY"],
    ["automations", "install", "--client", "claude-code"],
    ["automations", "diff", "--client", "claude-code"],
    ["workflow", "run", "--mode", "standard", "--query", "auth middleware"],
    ["recall", "--query", "auth decisions"],
  ];

  for (const args of commandCases) {
    const { dir, home } = makeTempWorkspace(`snipara-auth-no-hidden-${args[0]}`, {
      projectSlug: false,
      gitRemote: false,
    });
    const binDir = makeNoopBrowserBin(dir);
    const { preloadPath, callsPath } = writeAuthPreload(dir);

    const result = runCli(args, {
      cwd: dir,
      env: { HOME: home, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
      nodeArgs: ["-r", preloadPath],
    });
    const output = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.status, 1, `${args.join(" ")} unexpectedly succeeded:\n${output}`);
    assert.doesNotMatch(output, /Opening browser to authorize/);
    assert.doesNotMatch(output, /Verification URL/);
    assert.match(output, /npx -y snipara-companion@latest init/);

    const calls = readFetchCalls(callsPath);
    assert.equal(
      calls.some((call) => call.url.includes("/api/oauth/device/code")),
      false,
      `${args.join(" ")} unexpectedly started browser auth`
    );
  }
});
