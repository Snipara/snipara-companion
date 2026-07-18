const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const packageRoot = path.join(__dirname, "..");
const cliPath = path.join(packageRoot, "dist", "index.js");

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Snipara Docs Smoke",
      GIT_AUTHOR_EMAIL: "docs-smoke@snipara.local",
      GIT_COMMITTER_NAME: "Snipara Docs Smoke",
      GIT_COMMITTER_EMAIL: "docs-smoke@snipara.local",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createDocsSmokeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-docs-smoke-"));
  runGit(dir, ["init", "-b", "dev"]);
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# Fixture\n", "utf8");
  fs.writeFileSync(
    path.join(dir, "docs", "architecture.md"),
    "# Architecture\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "snipara.project-context.json"),
    JSON.stringify(
      {
        schemaVersion: "snipara.project_context_manifest.v0",
        sources: [
          {
            path: "docs/architecture.md",
            authority: "canonical",
            tier: "HOT",
            required: true,
            description:
              "Architecture context that agents should treat as canonical.",
          },
        ],
        policies: [
          {
            id: "review-context-changes",
            scope: "memory.canonical",
            requirement:
              "Human review required before changing canonical context.",
            reviewRequired: true,
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  runGit(dir, [
    "add",
    "README.md",
    "docs/architecture.md",
    "snipara.project-context.json",
  ]);
  runGit(dir, ["commit", "-m", "initial docs smoke fixture"]);
  return dir;
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function rewriteCompanionCommandForLocalCli(command) {
  const localNodeCli = `${shellQuote(process.execPath)} ${shellQuote(cliPath)}`;
  return command
    .replace(/^npx\s+-y\s+snipara-companion(?:@latest)?\b/, localNodeCli)
    .replace(/^snipara-companion\b/, localNodeCli);
}

function runDocumentedCommand(command, cwd) {
  const localCommand = rewriteCompanionCommandForLocalCli(command);
  const result = spawnSync("bash", ["-lc", localCommand], {
    cwd,
    encoding: "utf8",
    env: sanitizedEnv(),
  });
  assert.equal(
    result.status,
    0,
    `Documented command failed:
${command}

Rewritten command:
${localCommand}

stdout:
${result.stdout}

stderr:
${result.stderr}`,
  );
}

function sanitizedEnv() {
  const env = { ...process.env };
  delete env.SNIPARA_API_KEY;
  delete env.SNIPARA_PROJECT_ID;
  delete env.SNIPARA_API_URL;
  delete env.SNIPARA_SESSION_ID;
  return env;
}

function extractMarkdownSection(markdown, heading) {
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, `Missing markdown section: ${heading}`);
  const rest = markdown.slice(start + heading.length);
  const nextHeading = rest.search(/\n#{1,3}\s+/);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

function extractFencedBlocks(markdown, language) {
  const blocks = [];
  const fencePattern = new RegExp(
    "```" + language + "\\n([\\s\\S]*?)\\n```",
    "g",
  );
  for (const match of markdown.matchAll(fencePattern)) {
    blocks.push(match[1]);
  }
  return blocks;
}

function splitBashCommands(block) {
  const commands = [];
  let current = "";
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      if (current) {
        commands.push(current.trim());
        current = "";
      }
      continue;
    }
    if (current) {
      if (line.endsWith("\\")) {
        current = `${current} ${line.slice(0, -1).trim()}`.trim();
        continue;
      }
      commands.push(`${current} ${line}`.trim());
      current = "";
      continue;
    }
    if (!line.includes("context-control")) {
      continue;
    }
    if (line.endsWith("\\")) {
      current = `${current} ${line.slice(0, -1).trim()}`.trim();
      continue;
    }
    commands.push(`${current} ${line}`.trim());
    current = "";
  }
  if (current) {
    commands.push(current.trim());
  }
  return commands;
}

function readmeContextControlCommands() {
  const readme = fs.readFileSync(path.join(packageRoot, "README.md"), "utf8");
  const section = extractMarkdownSection(readme, "### Context Control");
  return extractFencedBlocks(section, "bash").flatMap(splitBashCommands);
}

function fullReferenceContextControlCommands() {
  const fullReference = fs.readFileSync(
    path.join(packageRoot, "docs", "FULL_REFERENCE.md"),
    "utf8",
  );
  return fullReference
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^snipara-companion context-control\b/.test(line));
}

test("README context-control bash examples execute against the local CLI", () => {
  const commands = readmeContextControlCommands();
  assert.deepEqual(commands, [
    'npx -y snipara-companion context-control plan --summary "record reviewed context state" --output .snipara/context-control/plans/demo.json',
    "npx -y snipara-companion context-control apply --plan .snipara/context-control/plans/demo.json --approve",
    "npx -y snipara-companion context-control drift",
    "npx -y snipara-companion context-control validate --manifest snipara.project-context.json",
    "npx -y snipara-companion context-control plan --manifest snipara.project-context.json",
  ]);

  const dir = createDocsSmokeRepo();
  for (const command of commands) {
    runDocumentedCommand(command, dir);
  }
});

test("FULL_REFERENCE context-control command examples execute against the local CLI", () => {
  const commands = fullReferenceContextControlCommands();
  assert.deepEqual(commands, [
    'snipara-companion context-control plan --summary "record reviewed context state" --output .snipara/context-control/plans/demo.json',
    "snipara-companion context-control apply --plan .snipara/context-control/plans/demo.json --approve",
    "snipara-companion context-control drift",
    "snipara-companion context-control validate --manifest snipara.project-context.json",
  ]);

  const dir = createDocsSmokeRepo();
  for (const command of commands) {
    runDocumentedCommand(command, dir);
  }
});
