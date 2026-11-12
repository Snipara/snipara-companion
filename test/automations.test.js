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
  assert.match(content, /snipara:workflow CLAUDE\.md:start/);
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
  assert.equal((content.match(/snipara:workflow AGENTS\.md:start/g) || []).length, 1);
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

test("installAutomationBundle merges Kimi project MCP config and writes the plugin bundle", async () => {
  const dir = makeWorkspace();
  fs.mkdirSync(path.join(dir, ".kimi-code"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".kimi-code", "mcp.json"),
    JSON.stringify({ mcpServers: { other: { url: "https://example.test" } } }, null, 2),
    "utf8"
  );

  await installAutomationBundle({
    client: "kimi",
    projectDir: dir,
    bundle: {
      files: [
        {
          path: ".kimi-code/snipara-plugin/kimi.plugin.json",
          content: JSON.stringify(
            {
              name: "snipara-companion",
              hooks: [{ event: "PreToolUse", command: "node ./hooks/snipara-hook.mjs pre-tool" }],
            },
            null,
            2
          ),
        },
        {
          path: ".kimi-code/mcp.json",
          content: JSON.stringify(
            {
              mcpServers: {
                snipara: {
                  url: "https://api.snipara.com/mcp/demo",
                  bearerTokenEnvVar: "SNIPARA_API_KEY",
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

  const pluginManifest = JSON.parse(
    fs.readFileSync(path.join(dir, ".kimi-code", "snipara-plugin", "kimi.plugin.json"), "utf8")
  );
  assert.equal(pluginManifest.name, "snipara-companion");
  assert.equal(pluginManifest.hooks[0].event, "PreToolUse");

  const mcpConfig = JSON.parse(fs.readFileSync(path.join(dir, ".kimi-code", "mcp.json"), "utf8"));
  assert.equal(mcpConfig.mcpServers.other.url, "https://example.test");
  assert.equal(mcpConfig.mcpServers.snipara.bearerTokenEnvVar, "SNIPARA_API_KEY");
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
  const rule = fs.readFileSync(path.join(dir, ".cursor", "rules", "snipara.mdc"), "utf8");
  assert.ok(rule.startsWith("---\n"));
  assert.match(rule, /alwaysApply: true/);
  assert.match(rule, /snipara:workflow \.cursor\/rules\/snipara\.mdc:start/);
  assert.match(rule, /# Snipara/);
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


test("Markdown migration coalesces both complete legacy families and preserves every outside byte", async () => {
  const dir = makeWorkspace();
  const prefix = "# Équipe 🚀  \r\nKeep this exact spacing.\r\n\r\n";
  const middle = "\r\nUser text between generated regions.  \r\n";
  const suffix = "\nUser tail without a final newline";
  fs.writeFileSync(path.join(dir, "AGENTS.md"), prefix +
    "<!-- snipara:automation AGENTS.md:start -->\nOld automation manual.\n<!-- snipara:automation AGENTS.md:end -->\n" +
    middle +
    "<!-- snipara:workflow AGENTS.md:start -->\nOld workflow manual.\n<!-- snipara:workflow AGENTS.md:end -->\n" +
    suffix);
  const generated = "## Snipara\nCompact rules.\n";
  const expected = prefix +
    "<!-- snipara:workflow AGENTS.md:start -->\n## Snipara\nCompact rules.\n<!-- snipara:workflow AGENTS.md:end -->\n" +
    middle + suffix;
  await installAutomationBundle({ client: "codex", projectDir: dir, bundle: instructionBundle("AGENTS.md", generated) });
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), expected);
  const repeated = await installAutomationBundle({ client: "codex", projectDir: dir, bundle: instructionBundle("AGENTS.md", generated) });
  assert.equal(repeated.written, 0);
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), expected);
});

test("malformed instruction ownership conflicts before any write, even with force", async () => {
  const malformed = [
    "<!-- snipara:workflow AGENTS.md:start -->\nUnclosed",
    "<!-- snipara:automation AGENTS.md:end -->\nOrphan end",
    "<!-- snipara:workflow AGENTS.md:start -->\n<!-- snipara:automation AGENTS.md:start -->\nNested\n<!-- snipara:automation AGENTS.md:end -->\n<!-- snipara:workflow AGENTS.md:end -->\n",
    "<!-- snipara:workflow AGENTS.md:start -->\nCrossed\n<!-- snipara:automation AGENTS.md:end -->\n",
    "<!--snipara:workflow AGENTS.md:start -->\nMalformed spacing",
    "User prefix <!-- snipara:workflow AGENTS.md:start -->\nInline marker",
    "<!-- snipara:workflow CLAUDE.md:start -->\nWrong owner\n<!-- snipara:workflow CLAUDE.md:end -->\n",
    "<!-- snipara:workflow AGENTS.md:start -->\nBad end\n<!-- snipara:workflow AGENTS.md:end\n",
  ];
  for (const content of malformed) {
    for (const force of [false, true]) {
      const dir = makeWorkspace();
      const target = path.join(dir, "AGENTS.md");
      fs.writeFileSync(target, content);
      await assert.rejects(
        installAutomationBundle({
          client: "codex", projectDir: dir, force,
          bundle: { files: [{ path: "notes.txt", content: "must not be written" }, { path: "AGENTS.md", content: "Compact rules." }], instructions: [] },
        }),
        (error) => error instanceof AutomationInstallConflictError &&
          /manual repair/.test(error.message) && /force cannot/.test(error.message) &&
          error.conflicts.some((item) => /Invalid Snipara instruction markers/.test(item.reason))
      );
      assert.equal(fs.readFileSync(target, "utf8"), content);
      assert.equal(fs.existsSync(path.join(dir, "notes.txt")), false);
      assert.equal(fs.existsSync(path.join(dir, AUTOMATION_MANIFEST_RELATIVE_PATH)), false);
    }
  }
});

test("modern Cursor updates preserve user frontmatter and outside text byte-for-byte", async () => {
  const dir = makeWorkspace();
  const relative = ".cursor/rules/snipara.mdc";
  const target = path.join(dir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const prefix = "---\r\ndescription: My project rule\r\nalwaysApply: false\r\nglobs: src/**\r\n---\r\n\r\n# User rule  \r\n";
  const suffix = "\r\nKeep this tail without a newline";
  fs.writeFileSync(target, prefix + "<!-- snipara:workflow " + relative + ":start -->\nOld.\n<!-- snipara:workflow " + relative + ":end -->\n" + suffix);
  const generated = "---\ndescription: Generated default\nalwaysApply: true\n---\n\nRead AGENTS.md.";
  const expected = prefix + "<!-- snipara:workflow " + relative + ":start -->\nRead AGENTS.md.\n<!-- snipara:workflow " + relative + ":end -->\n" + suffix;
  await installAutomationBundle({ client: "cursor", projectDir: dir, bundle: instructionBundle(relative, generated) });
  assert.equal(fs.readFileSync(target, "utf8"), expected);
  assert.equal((expected.match(/^---\r?$/gm) || []).length, 2);
  const repeated = await installAutomationBundle({ client: "cursor", projectDir: dir, bundle: instructionBundle(relative, generated) });
  assert.equal(repeated.written, 0);
  assert.equal(fs.readFileSync(target, "utf8"), expected);
});

test("unclosed Cursor frontmatter and generated ownership markers cannot be forced", async () => {
  for (const scenario of [
    { path: ".cursor/rules/snipara.mdc", current: "---\nAlways preserve this unfinished user header", generated: "Read AGENTS.md." },
    { path: "AGENTS.md", current: "User text", generated: "<!-- snipara:automation AGENTS.md:start -->\nNested managed payload" },
  ]) {
    const dir = makeWorkspace();
    const target = path.join(dir, scenario.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, scenario.current);
    await assert.rejects(
      installAutomationBundle({ client: "cursor", projectDir: dir, force: true, bundle: instructionBundle(scenario.path, scenario.generated) }),
      AutomationInstallConflictError
    );
    assert.equal(fs.readFileSync(target, "utf8"), scenario.current);
  }
});

test("identical unmarked user text is not normalized or wrapped", async () => {
  const dir = makeWorkspace();
  const content = "## Snipara\r\nKeep this unmarked text exactly.  ";
  fs.writeFileSync(path.join(dir, "AGENTS.md"), content);
  const result = await installAutomationBundle({ client: "codex", projectDir: dir, bundle: instructionBundle("AGENTS.md", content) });
  assert.equal(result.written, 0);
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), content);
});

test("installed Claude, Cursor and Codex Companion hooks default to quiet pre-tool calls", async t => {
  for (const [client, prefix] of [["claude-code", ".claude"], ["cursor", ".cursor"], ["codex", ".codex"]]) {
    const dir = makeWorkspace();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = `${prefix}/hooks/pre-tool-use.sh`;
    const source = { files: [{ path: file, content: '#!/bin/sh\nsnipara-companion pre-tool "$INPUT" --tool Read\n' }], instructions: [] };
    await installAutomationBundle({ client, projectDir: dir, bundle: source });
    const installed = fs.readFileSync(path.join(dir, file), "utf8");
    assert.match(installed, /pre-tool --stuck-guard-only/);
    await installAutomationBundle({ client, projectDir: dir, bundle: source });
    assert.equal(fs.readFileSync(path.join(dir, file), "utf8"), installed);
    assert.equal(getAutomationStatus(dir).files[0].state, "up-to-date");
  }
});
