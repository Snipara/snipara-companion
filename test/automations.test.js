const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  AUTOMATION_MANIFEST_RELATIVE_PATH,
  AutomationInstallConflictError,
  AutomationUnsupportedHookBundleError,
  getAutomationStatus,
  installAutomationBundle,
} = require("../dist/index.js");

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-automations-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

function bundle(settingsContent = '{"hooks":{}}') {
  return {
    files: [
      {
        path: ".claude/settings.json",
        content: settingsContent,
      },
      {
        path: ".claude/hooks/context-checkpoint.sh",
        content: "#!/bin/bash\necho checkpoint\n",
      },
    ],
    instructions: ["Install generated files."],
  };
}

function instructionBundle(filePath, content) {
  return {
    files: [{ path: filePath, content }],
    instructions: ["Merge generated instructions."],
  };
}

test("installAutomationBundle writes files and manifest", async () => {
  const dir = makeWorkspace();

  const result = await installAutomationBundle({
    client: "claude-code",
    projectDir: dir,
    bundle: bundle(),
  });

  assert.equal(result.written, 2);
  assert.equal(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"), '{"hooks":{}}');
  assert.ok(fs.existsSync(path.join(dir, AUTOMATION_MANIFEST_RELATIVE_PATH)));

  const status = getAutomationStatus(dir);
  assert.equal(status.manifest.client, "claude-code");
  assert.deepEqual(
    status.files.map((file) => file.state),
    ["up-to-date", "up-to-date"]
  );
});

test("installAutomationBundle refuses unmanaged files without force", async () => {
  const dir = makeWorkspace();
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "settings.json"), "manual settings", "utf8");

  await assert.rejects(
    installAutomationBundle({
      client: "claude-code",
      projectDir: dir,
      bundle: bundle(),
    }),
    AutomationInstallConflictError
  );
});

test("installAutomationBundle refuses native hook files for incompatible clients", async () => {
  const dir = makeWorkspace();

  await assert.rejects(
    installAutomationBundle({
      client: "vscode",
      projectDir: dir,
      bundle: {
        files: [
          {
            path: ".vscode/hooks/pre-tool-use.sh",
            content: "#!/bin/bash\necho blocked\n",
          },
        ],
        instructions: [],
      },
    }),
    (error) =>
      error instanceof AutomationUnsupportedHookBundleError &&
      error.client === "vscode" &&
      error.files.includes(".vscode/hooks/pre-tool-use.sh")
  );

  assert.equal(fs.existsSync(path.join(dir, ".vscode")), false);
});

test("installAutomationBundle appends CLAUDE.md instructions instead of overwriting", async () => {
  const dir = makeWorkspace();
  const generated = "# CLAUDE.md\n\n## Snipara\nUse Snipara Hosted MCP first.\n";
  fs.writeFileSync(
    path.join(dir, "CLAUDE.md"),
    "# Existing Claude Guide\n\nKeep the project-specific instructions.\n",
    "utf8"
  );

  const result = await installAutomationBundle({
    client: "claude-code",
    projectDir: dir,
    bundle: instructionBundle("CLAUDE.md", generated),
  });

  const content = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
  assert.equal(result.written, 1);
  assert.match(content, /Keep the project-specific instructions/);
  assert.match(content, /snipara:automation CLAUDE\.md:start/);
  assert.match(content, /Use Snipara Hosted MCP first/);
  assert.notEqual(content, generated);

  const status = getAutomationStatus(dir);
  assert.equal(status.files[0].state, "up-to-date");
});

test("installAutomationBundle updates AGENTS.md Snipara section without replacing local content", async () => {
  const dir = makeWorkspace();
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Existing Agents\n\nKeep this.\n", "utf8");

  await installAutomationBundle({
    client: "codex",
    projectDir: dir,
    bundle: instructionBundle("AGENTS.md", "# AGENTS.md\n\n## Snipara\nOld workflow.\n"),
  });

  await installAutomationBundle({
    client: "codex",
    projectDir: dir,
    bundle: instructionBundle("AGENTS.md", "# AGENTS.md\n\n## Snipara\nNew workflow.\n"),
    force: true,
  });

  const content = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.match(content, /Keep this/);
  assert.match(content, /New workflow/);
  assert.doesNotMatch(content, /Old workflow/);
  assert.equal((content.match(/snipara:automation AGENTS\.md:start/g) || []).length, 1);
});

test("installAutomationBundle merges Claude hooks and project MCP separately", async () => {
  const dir = makeWorkspace();
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".claude", "settings.json"),
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo existing", timeout: 1 }],
            },
          ],
        },
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, ".mcp.json"),
    JSON.stringify(
      { mcpServers: { existing: { type: "http", url: "https://example.test" } } },
      null,
      2
    ),
    "utf8"
  );

  await installAutomationBundle({
    client: "claude-code",
    projectDir: dir,
    bundle: {
      files: [
        {
          path: ".claude/settings.json",
          content: JSON.stringify(
            {
              hooks: {
                PreToolUse: [
                  {
                    matcher: "Bash",
                    hooks: [
                      { type: "command", command: "snipara-companion pre-tool", timeout: 10 },
                    ],
                  },
                ],
              },
            },
            null,
            2
          ),
        },
        {
          path: ".mcp.json",
          content: JSON.stringify(
            {
              mcpServers: {
                snipara: { type: "http", url: "https://api.snipara.com/mcp/demo" },
              },
            },
            null,
            2
          ),
        },
      ],
      instructions: [],
    },
    force: true,
  });

  const settings = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.mcpServers, undefined);
  assert.deepEqual(
    settings.hooks.PreToolUse[0].hooks.map((hook) => hook.command),
    ["echo existing", "snipara-companion pre-tool"]
  );
  const mcpConfig = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
  assert.equal(mcpConfig.mcpServers.existing.url, "https://example.test");
  assert.equal(mcpConfig.mcpServers.snipara.url, "https://api.snipara.com/mcp/demo");
});

test("installAutomationBundle merges Windsurf JSON config instead of overwriting", async () => {
  const dir = makeWorkspace();
  fs.mkdirSync(path.join(dir, ".windsurf"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".windsurf", "cascade-hooks.json"),
    JSON.stringify({ hooks: { existing_hook: { command: "echo existing", timeout: 1 } } }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, ".windsurf", "mcp.json"),
    JSON.stringify({ mcpServers: { other: { serverUrl: "https://example.test" } } }, null, 2),
    "utf8"
  );

  await installAutomationBundle({
    client: "windsurf",
    projectDir: dir,
    bundle: {
      files: [
        {
          path: ".windsurf/cascade-hooks.json",
          content: JSON.stringify(
            { hooks: { pre_read_code: { command: ".windsurf/hooks/pre-read.sh", timeout: 10 } } },
            null,
            2
          ),
        },
        {
          path: ".windsurf/mcp.json",
          content: JSON.stringify(
            {
              mcpServers: {
                snipara: {
                  serverUrl: "https://api.snipara.com/mcp/demo",
                  transport: "streamable-http",
                },
              },
            },
            null,
            2
          ),
        },
      ],
      instructions: [],
    },
    force: true,
  });

  const cascadeHooks = JSON.parse(
    fs.readFileSync(path.join(dir, ".windsurf", "cascade-hooks.json"), "utf8")
  );
  assert.equal(cascadeHooks.hooks.existing_hook.command, "echo existing");
  assert.equal(cascadeHooks.hooks.pre_read_code.command, ".windsurf/hooks/pre-read.sh");

  const mcpConfig = JSON.parse(fs.readFileSync(path.join(dir, ".windsurf", "mcp.json"), "utf8"));
  assert.equal(mcpConfig.mcpServers.other.serverUrl, "https://example.test");
  assert.equal(mcpConfig.mcpServers.snipara.transport, "streamable-http");
});

test("installAutomationBundle allows MCP and rule files for Cursor", async () => {
  const dir = makeWorkspace();

  const result = await installAutomationBundle({
    client: "cursor",
    projectDir: dir,
    bundle: {
      files: [
        {
          path: ".cursor/mcp.json",
          content: '{"mcpServers":{"snipara":{"type":"http"}}}',
        },
        {
          path: ".cursor/rules/snipara.mdc",
          content: "# Snipara\n",
        },
      ],
      instructions: [],
    },
  });

  assert.equal(result.written, 2);
  assert.equal(fs.existsSync(path.join(dir, ".cursor", "hooks.json")), false);
  assert.equal(fs.existsSync(path.join(dir, ".cursor", "hooks")), false);
  assert.equal(
    fs.readFileSync(path.join(dir, ".cursor", "rules", "snipara.mdc"), "utf8"),
    "# Snipara\n"
  );
});

test("installAutomationBundle allows native hook files for Cursor", async () => {
  const dir = makeWorkspace();

  const result = await installAutomationBundle({
    client: "cursor",
    projectDir: dir,
    bundle: {
      files: [
        {
          path: ".cursor/hooks.json",
          content:
            '{"version":1,"hooks":{"preToolUse":[{"command":".cursor/hooks/preToolUse.sh"}]}}',
        },
        {
          path: ".cursor/hooks/preToolUse.sh",
          content: "#!/bin/bash\njq -n '{ continue: true, permission: \"allow\" }'\n",
        },
      ],
      instructions: [],
    },
  });

  assert.equal(result.written, 2);
  assert.equal(
    fs.readFileSync(path.join(dir, ".cursor", "hooks", "preToolUse.sh"), "utf8"),
    "#!/bin/bash\njq -n '{ continue: true, permission: \"allow\" }'\n"
  );
  assert.ok(fs.statSync(path.join(dir, ".cursor", "hooks", "preToolUse.sh")).mode & 0o111);
});

test("installAutomationBundle merges Cursor config and appends .cursorrules", async () => {
  const dir = makeWorkspace();
  fs.mkdirSync(path.join(dir, ".cursor"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".cursor", "hooks.json"),
    JSON.stringify({ hooks: { existingHook: { command: "echo existing", timeout: 1 } } }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { other: { url: "https://example.test" } } }, null, 2),
    "utf8"
  );
  fs.writeFileSync(path.join(dir, ".cursorrules"), "Keep existing Cursor rules.\n", "utf8");

  await installAutomationBundle({
    client: "cursor",
    projectDir: dir,
    bundle: {
      files: [
        {
          path: ".cursor/hooks.json",
          content: JSON.stringify(
            {
              hooks: {
                beforeReadFile: { command: ".cursor/hooks/beforeReadFile.sh", timeout: 10 },
              },
            },
            null,
            2
          ),
        },
        {
          path: ".cursor/mcp.json",
          content: JSON.stringify(
            { mcpServers: { snipara: { url: "https://api.snipara.com/mcp/demo" } } },
            null,
            2
          ),
        },
        {
          path: ".cursorrules",
          content: "# Snipara Cursor Rules\n\nUse Snipara first.\n",
        },
      ],
      instructions: [],
    },
    force: true,
  });

  const hooks = JSON.parse(fs.readFileSync(path.join(dir, ".cursor", "hooks.json"), "utf8"));
  assert.equal(hooks.hooks.existingHook.command, "echo existing");
  assert.equal(hooks.hooks.beforeReadFile.command, ".cursor/hooks/beforeReadFile.sh");

  const mcp = JSON.parse(fs.readFileSync(path.join(dir, ".cursor", "mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.other.url, "https://example.test");
  assert.equal(mcp.mcpServers.snipara.url, "https://api.snipara.com/mcp/demo");

  const rules = fs.readFileSync(path.join(dir, ".cursorrules"), "utf8");
  assert.match(rules, /Keep existing Cursor rules/);
  assert.match(rules, /Use Snipara first/);
});

test("installAutomationBundle allows native hook files for Gemini", async () => {
  const dir = makeWorkspace();

  const result = await installAutomationBundle({
    client: "gemini",
    projectDir: dir,
    bundle: {
      files: [
        {
          path: ".gemini/settings.json",
          content:
            '{"hooks":{"BeforeTool":[{"hooks":[{"command":".gemini/hooks/before-tool.sh"}]}]}}',
        },
        {
          path: ".gemini/hooks/before-tool.sh",
          content: "#!/bin/bash\njq -n '{ decision: \"allow\", suppressOutput: true }'\n",
        },
      ],
      instructions: [],
    },
  });

  assert.equal(result.written, 2);
  assert.equal(
    fs.readFileSync(path.join(dir, ".gemini", "hooks", "before-tool.sh"), "utf8"),
    "#!/bin/bash\njq -n '{ decision: \"allow\", suppressOutput: true }'\n"
  );
  assert.ok(fs.statSync(path.join(dir, ".gemini", "hooks", "before-tool.sh")).mode & 0o111);
});

test("installAutomationBundle allows native hook files for Codex", async () => {
  const dir = makeWorkspace();

  const result = await installAutomationBundle({
    client: "codex",
    projectDir: dir,
    bundle: {
      files: [
        {
          path: ".codex/hooks.json",
          content:
            '{"hooks":{"PreToolUse":[{"hooks":[{"command":"bash \\"$(git rev-parse --show-toplevel)/.codex/hooks/pre-tool-use.sh\\""}]}]}}',
        },
        {
          path: ".codex/hooks/pre-tool-use.sh",
          content:
            "#!/bin/bash\njq -n '{ hookSpecificOutput: { hookEventName: \"PreToolUse\" } }'\n",
        },
      ],
      instructions: [],
    },
  });

  assert.equal(result.written, 2);
  assert.equal(
    fs.readFileSync(path.join(dir, ".codex", "hooks", "pre-tool-use.sh"), "utf8"),
    "#!/bin/bash\njq -n '{ hookSpecificOutput: { hookEventName: \"PreToolUse\" } }'\n"
  );
  assert.ok(fs.statSync(path.join(dir, ".codex", "hooks", "pre-tool-use.sh")).mode & 0o111);
});

test("installAutomationBundle merges Continue config arrays by name", async () => {
  const dir = makeWorkspace();
  fs.mkdirSync(path.join(dir, ".continue"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".continue", "config.json"),
    JSON.stringify(
      {
        models: [{ title: "Existing model", provider: "openai" }],
        mcpServers: [{ name: "existing", transport: { type: "sse", url: "https://example.test" } }],
      },
      null,
      2
    ),
    "utf8"
  );

  await installAutomationBundle({
    client: "continue",
    projectDir: dir,
    bundle: {
      files: [
        {
          path: ".continue/config.json",
          content: JSON.stringify(
            {
              models: [],
              mcpServers: [
                {
                  name: "snipara",
                  transport: { type: "sse", url: "https://api.snipara.com/mcp/demo/sse" },
                },
              ],
            },
            null,
            2
          ),
        },
      ],
      instructions: [],
    },
    force: true,
  });

  const config = JSON.parse(fs.readFileSync(path.join(dir, ".continue", "config.json"), "utf8"));
  assert.equal(config.models[0].title, "Existing model");
  assert.equal(
    config.mcpServers.find((server) => server.name === "existing").transport.url,
    "https://example.test"
  );
  assert.equal(
    config.mcpServers.find((server) => server.name === "snipara").transport.url,
    "https://api.snipara.com/mcp/demo/sse"
  );
});

test("installAutomationBundle rewrites generated API key placeholders to local config lookup", async () => {
  const dir = makeWorkspace();
  const generatedBundle = {
    files: [
      {
        path: ".claude/hooks/context-checkpoint.sh",
        content: '#!/bin/bash\nPROJECT_DIR="$(pwd)"\nAPI_KEY="snp-preview"\necho "$API_KEY"\n',
      },
    ],
    instructions: [],
  };

  await installAutomationBundle({
    client: "claude-code",
    projectDir: dir,
    bundle: generatedBundle,
  });

  const script = fs.readFileSync(
    path.join(dir, ".claude", "hooks", "context-checkpoint.sh"),
    "utf8"
  );
  assert.doesNotMatch(script, /snp-preview/);
  assert.match(script, /SNIPARA_API_KEY/);
  assert.ok(
    script.indexOf('path.join(root, ".snipara", "companion", "config.json")') <
      script.indexOf('API_KEY="${SNIPARA_API_KEY:-}"')
  );
  assert.doesNotMatch(script, new RegExp(["RLM", "API", "KEY"].join("_")));
  assert.match(script, /.snipara/);
  assert.doesNotMatch(script, /.rlmsaas/);

  const result = await installAutomationBundle({
    client: "claude-code",
    projectDir: dir,
    bundle: generatedBundle,
    dryRun: true,
  });

  assert.equal(result.written, 0);
  assert.equal(result.unchanged, 1);
});

test("installAutomationBundle updates managed files when unchanged locally", async () => {
  const dir = makeWorkspace();

  await installAutomationBundle({
    client: "claude-code",
    projectDir: dir,
    bundle: bundle('{"version":1}'),
  });

  const result = await installAutomationBundle({
    client: "claude-code",
    projectDir: dir,
    bundle: bundle('{"version":2}'),
  });

  assert.equal(result.written, 1);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.version, 2);
});

test("installAutomationBundle refuses managed generated scripts modified locally", async () => {
  const dir = makeWorkspace();

  await installAutomationBundle({
    client: "claude-code",
    projectDir: dir,
    bundle: bundle('{"version":1}'),
  });
  fs.writeFileSync(
    path.join(dir, ".claude", "hooks", "context-checkpoint.sh"),
    "#!/bin/bash\necho local edit\n",
    "utf8"
  );

  await assert.rejects(
    installAutomationBundle({
      client: "claude-code",
      projectDir: dir,
      bundle: bundle('{"version":2}'),
    }),
    (error) =>
      error instanceof AutomationInstallConflictError &&
      error.conflicts.some((conflict) => conflict.reason === "managed file was modified locally")
  );
});

test("getAutomationStatus reports modified and missing files", async () => {
  const dir = makeWorkspace();

  await installAutomationBundle({
    client: "claude-code",
    projectDir: dir,
    bundle: bundle(),
  });
  fs.writeFileSync(path.join(dir, ".claude", "settings.json"), '{"changed":true}', "utf8");
  fs.rmSync(path.join(dir, ".claude", "hooks", "context-checkpoint.sh"));

  const status = getAutomationStatus(dir);
  assert.deepEqual(
    status.files.map((file) => file.state),
    ["modified", "missing"]
  );
});
