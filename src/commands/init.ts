/**
 * `init` / `config` commands — set up companion configuration.
 *
 * Writes local companion config and, optionally, installs editor hooks and
 * local code-overlay Git hooks for the chosen client (Claude Code, Cursor,
 * Codex, …). Project binding is resolved through project-auth; most projects
 * auto-resolve per workspace, so `init` is largely optional. Interactive by
 * default, with flags for non-interactive / CI setup.
 */
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { saveConfig, loadConfig, getConfigPath, isConfigured } from "../config/store";
import { createClient, listProjectsForApiKey, type ApiKeyProjectSummary } from "../api/client";
import { automationsInstallCommand } from "./automations";
import { codeHooksInstallCommand } from "./code";
import {
  collectLocalProjectHints,
  runProjectDeviceAuthorization,
  writeProjectBinding,
} from "./project-auth";

type HookClient = "claude-code" | "cursor" | "windsurf" | "gemini" | "codex";
type InstallableHookClient = "claude-code" | "cursor" | "windsurf" | "gemini" | "codex";
type LegacyHookClient = "claude-code" | "cursor" | "windsurf";
type SetupClient = HookClient | "mistral" | "chatgpt" | "vscode" | "continue" | "custom";

const SETUP_CLIENTS = new Set<SetupClient>([
  "claude-code",
  "cursor",
  "windsurf",
  "codex",
  "gemini",
  "mistral",
  "chatgpt",
  "vscode",
  "continue",
  "custom",
]);

function maybeNormalizeClient(input?: string | null): SetupClient | undefined {
  if (!input) {
    return undefined;
  }

  return SETUP_CLIENTS.has(input as SetupClient) ? (input as SetupClient) : undefined;
}

function isHookClient(client: SetupClient): client is HookClient {
  return (
    client === "claude-code" ||
    client === "cursor" ||
    client === "windsurf" ||
    client === "gemini" ||
    client === "codex"
  );
}

function canInstallNativeHookClient(client: SetupClient): client is InstallableHookClient {
  return (
    client === "claude-code" ||
    client === "cursor" ||
    client === "windsurf" ||
    client === "gemini" ||
    client === "codex"
  );
}

function canUseLegacyHookFallback(client: SetupClient): client is LegacyHookClient {
  return client === "claude-code" || client === "cursor" || client === "windsurf";
}

function getNativeHookBlockReason(client: SetupClient): string | null {
  if (canInstallNativeHookClient(client)) {
    return null;
  }

  const reasons: Partial<Record<SetupClient, string>> = {
    vscode:
      "VS Code agent hooks are preview-gated and can be organization-disabled, so Snipara does not install them by default.",
    chatgpt:
      "ChatGPT/OpenAI-compatible clients use Hosted MCP tools; no lifecycle hooks are claimed.",
    mistral:
      "Mistral Le Chat, Vibe, and LangChain use Hosted MCP or model request hooks; Snipara does not install local agent lifecycle hooks for Mistral.",
    continue:
      "Continue support is MCP-first in this installer; no native hook files are installed.",
    custom: "MCP standardizes tools, resources, and prompts, not universal host lifecycle hooks.",
  };

  return reasons[client] ?? "This client is MCP-first; no native hook files are installed.";
}

function formatClientName(client: SetupClient): string {
  const names: Record<SetupClient, string> = {
    "claude-code": "Claude Code",
    cursor: "Cursor",
    windsurf: "Windsurf",
    codex: "OpenAI Codex",
    gemini: "Gemini",
    mistral: "Mistral Le Chat / Vibe",
    chatgpt: "ChatGPT / OpenAI MCP",
    vscode: "VS Code",
    continue: "Continue",
    custom: "Custom MCP client",
  };

  return names[client];
}

function getWorkflowInstructionMarker(relativePath: string, type: "start" | "end"): string {
  return `<!-- snipara:workflow ${relativePath}:${type} -->`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mergeWorkflowInstructionContent(
  relativePath: string,
  generatedContent: string,
  currentContent: string | undefined
): string {
  const startMarker = getWorkflowInstructionMarker(relativePath, "start");
  const endMarker = getWorkflowInstructionMarker(relativePath, "end");
  const generatedBlock = `${startMarker}\n${generatedContent.trim()}\n${endMarker}\n`;

  if (!currentContent || currentContent.trim() === "") {
    return generatedBlock;
  }

  const existingBlockPattern = new RegExp(
    `${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n?`,
    "m"
  );

  if (existingBlockPattern.test(currentContent)) {
    return currentContent.replace(existingBlockPattern, generatedBlock);
  }

  const separator = currentContent.endsWith("\n") ? "\n" : "\n\n";
  return `${currentContent}${separator}${generatedBlock}`;
}

function buildHostedMcpEndpoint(projectSlug: string): string {
  return `https://api.snipara.com/mcp/${projectSlug}`;
}

function buildClaudeWorkflowInstructionBlock(projectSlug: string): string {
  return `## Snipara Workflow

Claude Code should apply this workflow automatically for project-specific work; do not wait for the user to explicitly ask for Snipara.

- Bound Snipara project: \`${projectSlug}\`
- Hosted MCP endpoint: \`${buildHostedMcpEndpoint(projectSlug)}\`
- Keep \`SNIPARA_SESSION_ID\` equal to the active Companion session. Generated MCP configs send it as \`X-Snipara-Session-Id\`; when a client cannot send that header, pass the same value as \`correlation_context.session_id\` on retrieval tools.
- At the start of substantial work, validate the hosted MCP surface with a tool-oriented call, then use \`snipara_recall\` and a targeted \`snipara_context_query\` before falling back to local search.
- Do not treat empty MCP resources/templates as an outage. If the tool surface looks incomplete, call \`snipara_help(list_all=true)\` and compare exact tool names.
- Use \`snipara_context_query\` for docs, business context, architecture notes, runbooks, and source truth. Use \`snipara_get_chunk\` for exact cited sections when references are returned.
- For coding work, choose LITE or FULL before editing. Use FULL managed workflow for multi-file, risky, release/deploy, architectural, compaction-prone, or future-maintainer-sensitive work.
- When a visible multi-phase plan exists, keep the machine plan in JSON and run \`snipara-companion workflow start --goal "<goal>" --plan-file <plan_json_file>\`. Use \`workflow phase-start\` / \`workflow phase-commit\` per phase, and after \`workflow resume\` rerun \`workflow phase-start\` before editing again.
- Run \`snipara-companion code impact\` before risky multi-file changes, PR reviews, routes, services, jobs, auth, billing, deployment, schema, migrations, or explicit "what is missing" assessments; it auto-selects local overlay for dirty/ahead worktrees. Use hosted \`snipara_code_impact\` only when companion is unavailable or after push/reindex for canonical graph impact.
- For Project Intelligence briefs, run \`snipara-companion intelligence brief --task "<task>" --changed-files <files...>\` to combine resume context, memory health, and code impact before risky work. For roadmap-sized delivery, start with \`snipara-companion workflow scaffold --preset project-intelligence-continuity-layer\`.
- Use local file reads, \`rg\`, git commands, and tests for exact edits and current working-tree state.
- Use Snipara Sandbox only when sandboxed execution, repeatable validation, or isolated transformations materially help. For runtime-bound phases, capture compact rehydratable state with \`workflow runtime-checkpoint <phase_id> --summary "<state>" --rehydrate-file <state.json>\`. Then \`workflow resume\` restores workflow/memory continuity plus the recorded Sandbox binding and prints a reattach or rehydrate plan. It does not snapshot or exactly restore a live Snipara Sandbox / REPL process.
- If generated hooks are enabled, treat \`snipara-companion pre-tool\`, \`post-tool\`, and \`stuck-guard status\` output as high-priority runtime context.
- End substantial work with \`snipara_end_of_task_commit\` when available. For managed workflows, commit each phase with \`snipara-companion workflow phase-commit\` and close with \`snipara-companion final-commit\`.
- Store only durable decisions, learnings, preferences, and workflow context. Never store secrets, tokens, raw logs, one-off command output, or unreviewed guesses.`;
}

function buildSharedWorkflowInstructionBlock(projectSlug: string, client: SetupClient): string {
  return `## Snipara Context Workflow

This workspace is bound to Snipara project \`${projectSlug}\` for ${formatClientName(client)}. Agents should use Snipara automatically for project-specific context, decisions, and workflow state.

- Hosted MCP endpoint: \`${buildHostedMcpEndpoint(projectSlug)}\`
- Keep \`SNIPARA_SESSION_ID\` equal to the active Companion session. Generated MCP configs send it as \`X-Snipara-Session-Id\`; when a client cannot send that header, pass the same value as \`correlation_context.session_id\` on retrieval tools.
- At the start of substantial work, validate the hosted MCP surface with a tool-oriented call, then use \`snipara_recall\` and a targeted \`snipara_context_query\` before falling back to local search.
- Do not treat empty MCP resources/templates as an outage. If the tool surface looks incomplete, call \`snipara_help(list_all=true)\` and compare exact tool names.
- Use \`snipara_context_query\` for docs, business context, architecture notes, runbooks, and source truth. Use \`snipara_get_chunk\` for exact cited sections when references are returned.
- For coding work, choose LITE or FULL before editing. Use FULL managed workflow for multi-file, risky, release/deploy, architectural, compaction-prone, or future-maintainer-sensitive work.
- When a visible multi-phase plan exists, keep the machine plan in JSON and run \`snipara-companion workflow start --goal "<goal>" --plan-file <plan_json_file>\`. Use \`workflow phase-start\` / \`workflow phase-commit\` per phase, and after \`workflow resume\` rerun \`workflow phase-start\` before editing again.
- Run \`snipara-companion code impact\` before risky multi-file changes, PR reviews, routes, services, jobs, auth, billing, deployment, schema, migrations, or explicit "what is missing" assessments; it auto-selects local overlay for dirty/ahead worktrees. Use hosted \`snipara_code_impact\` only when companion is unavailable or after push/reindex for canonical graph impact.
- For Project Intelligence briefs, run \`snipara-companion intelligence brief --task "<task>" --changed-files <files...>\` to combine resume context, memory health, and code impact before risky work. For roadmap-sized delivery, start with \`snipara-companion workflow scaffold --preset project-intelligence-continuity-layer\`.
- Use local file reads, \`rg\`, git commands, and tests for exact edits and current working-tree state.
- Use Snipara Sandbox only when sandboxed execution, repeatable validation, or isolated transformations materially help. For runtime-bound phases, capture compact rehydratable state with \`workflow runtime-checkpoint <phase_id> --summary "<state>" --rehydrate-file <state.json>\`. Then \`workflow resume\` restores workflow/memory continuity plus the recorded Sandbox binding and prints a reattach or rehydrate plan. It does not snapshot or exactly restore a live Snipara Sandbox / REPL process.
- End substantial work with \`snipara_end_of_task_commit\` when available. For managed workflows, commit each phase with \`snipara-companion workflow phase-commit\` and close with \`snipara-companion final-commit\`.
- Store only durable decisions, learnings, preferences, and workflow context. Never store secrets, tokens, raw logs, one-off command output, or unreviewed guesses.`;
}

function buildClientWorkflowInstructionBlock(projectSlug: string, client: SetupClient): string {
  if (client === "claude-code") {
    return buildClaudeWorkflowInstructionBlock(projectSlug);
  }

  if (client === "cursor") {
    return `# Snipara Agent Workflow

Cursor should apply this workflow automatically for project-specific work.

${buildSharedWorkflowInstructionBlock(projectSlug, client)}`;
  }

  if (client === "gemini") {
    return `# Gemini Snipara Workflow

Gemini should apply this workflow automatically for project-specific work.

${buildSharedWorkflowInstructionBlock(projectSlug, client)}`;
  }

  if (client === "vscode") {
    return `# Snipara Copilot Workflow

VS Code and Copilot-style agents should apply this workflow automatically for project-specific work.

${buildSharedWorkflowInstructionBlock(projectSlug, client)}`;
  }

  if (client === "mistral") {
    return `# Mistral Snipara Workflow

Use this file with Mistral Vibe workspace instructions, Le Chat connector notes, or LangChain ChatMistralAI projects.

${buildSharedWorkflowInstructionBlock(projectSlug, client)}

## Mistral Integration Notes

- Le Chat: add Snipara as a Custom MCP Connector pointed at \`${buildHostedMcpEndpoint(projectSlug)}\`.
- Vibe: configure the generated streamable-http MCP server and restart Vibe after config changes.
- LangChain JavaScript: bind \`snipara_recall\`, \`snipara_context_query\`, and \`snipara_settings\` with \`ChatMistralAI.bindTools\`.
- Mistral request hooks such as \`beforeRequestHooks\`, \`requestErrorHooks\`, and \`responseHooks\` are model request hooks, not local agent lifecycle hooks.`;
  }

  return buildSharedWorkflowInstructionBlock(projectSlug, client);
}

function getClientInstructionFiles(client: SetupClient): string[] {
  if (client === "claude-code") {
    return ["CLAUDE.md"];
  }

  if (client === "cursor") {
    return [".cursor/rules/snipara.mdc"];
  }

  if (client === "gemini") {
    return ["GEMINI.md"];
  }

  if (client === "vscode") {
    return [".github/copilot-instructions.md"];
  }

  if (client === "mistral") {
    return ["MISTRAL.md"];
  }

  return [];
}

function mergeCursorRuleInstructionContent(
  relativePath: string,
  generatedContent: string,
  currentContent: string | undefined
): string {
  const body = mergeWorkflowInstructionContent(relativePath, generatedContent, currentContent);

  if (currentContent !== undefined && currentContent.trim() !== "") {
    return body;
  }

  return `---
description: Use Snipara Hosted MCP for project context and workflow state.
alwaysApply: true
---

${body}`;
}

function ensureWorkflowInstructionFile(
  projectDir: string,
  relativePath: string,
  generatedContent: string
): {
  relativePath: string;
  action: "created" | "updated" | "unchanged";
} {
  const filePath = path.join(projectDir, relativePath);
  const currentContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined;
  const nextContent =
    relativePath === ".cursor/rules/snipara.mdc"
      ? mergeCursorRuleInstructionContent(relativePath, generatedContent, currentContent)
      : mergeWorkflowInstructionContent(relativePath, generatedContent, currentContent);

  if (currentContent === nextContent) {
    return { relativePath, action: "unchanged" };
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, nextContent);
  return { relativePath, action: currentContent === undefined ? "created" : "updated" };
}

function ensureWorkflowInstructions(
  projectDir: string,
  projectSlug: string,
  client: SetupClient
): Array<{ relativePath: string; action: "created" | "updated" | "unchanged" }> {
  const instructions = [
    {
      relativePath: "AGENTS.md",
      content: buildSharedWorkflowInstructionBlock(projectSlug, client),
    },
    ...getClientInstructionFiles(client).map((relativePath) => ({
      relativePath,
      content: buildClientWorkflowInstructionBlock(projectSlug, client),
    })),
  ];

  return instructions.map((instruction) =>
    ensureWorkflowInstructionFile(projectDir, instruction.relativePath, instruction.content)
  );
}

/**
 * Prompt the user for input
 */
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function getConfigPaths(projectDir: string): { companion: string } {
  return {
    companion: getConfigPath({ cwd: projectDir, scope: "workspace" }),
  };
}

function projectMatchesIdentifier(project: ApiKeyProjectSummary, identifier: string): boolean {
  const normalized = identifier.toLowerCase();
  return project.id.toLowerCase() === normalized || project.slug.toLowerCase() === normalized;
}

function projectMatchesGitHubRepo(project: ApiKeyProjectSummary, githubRepo: string): boolean {
  return project.githubRepo?.toLowerCase() === githubRepo.toLowerCase();
}

function formatProjectChoice(project: ApiKeyProjectSummary): string {
  const details = [
    project.slug,
    project.teamName || project.teamSlug || null,
    project.githubRepo,
  ].filter((value): value is string => Boolean(value));

  return details.length > 0
    ? `${project.name} (${details.join(" • ")})`
    : `${project.name} (${project.slug})`;
}

function resolveSelectedClient(args: {
  requestedClient?: string;
  existingClient?: string;
  existingProjectId?: string;
  selectedProject: ApiKeyProjectSummary;
}): SetupClient {
  const explicitClient = maybeNormalizeClient(args.requestedClient);
  if (args.requestedClient && !explicitClient) {
    throw new Error(`Unsupported client: ${args.requestedClient}`);
  }

  if (explicitClient) {
    return explicitClient;
  }

  const existingProjectMatches =
    args.existingProjectId === args.selectedProject.id ||
    args.existingProjectId === args.selectedProject.slug;
  const existingClient = existingProjectMatches
    ? maybeNormalizeClient(args.existingClient)
    : undefined;
  if (existingClient) {
    return existingClient;
  }

  return maybeNormalizeClient(args.selectedProject.automationClient) || "claude-code";
}

async function promptForProjectSelection(
  projects: ApiKeyProjectSummary[],
  message: string
): Promise<ApiKeyProjectSummary> {
  console.log(message);
  console.log("");

  projects.forEach((project, index) => {
    console.log(`  ${index + 1}. ${formatProjectChoice(project)}`);
  });

  if (!process.stdin.isTTY) {
    console.log("\nRun one of these commands from this workspace:");
    projects.forEach((project) => {
      console.log(`  npx -y snipara-companion@latest init --project ${project.slug}`);
    });
    throw new Error("Project selection requires an interactive terminal or an explicit --project.");
  }

  while (true) {
    const answer = await prompt("\nSelect project number: ");
    const selectedIndex = Number.parseInt(answer, 10);

    if (!Number.isNaN(selectedIndex) && selectedIndex >= 1 && selectedIndex <= projects.length) {
      return projects[selectedIndex - 1];
    }

    console.log("Invalid selection. Enter one of the listed numbers.");
  }
}

/**
 * Generate Claude Code hook configuration (JSON object)
 */
function generateClaudeHookConfig(options: {
  preserveOnCompaction?: boolean;
  restoreOnSessionStart?: boolean;
}): object {
  const hooks: Record<string, unknown[]> = {};

  hooks.PreToolUse = [
    {
      matcher: "Bash|Read|Grep|Glob|Edit|MultiEdit|Write|mcp__.*",
      hooks: [
        {
          type: "command",
          command:
            "bash -lc 'cd \"${CLAUDE_PROJECT_DIR:-$PWD}\" && ./.claude/hooks/snipara-stuck-guard.sh'",
          timeout: 10,
        },
      ],
    },
  ];

  hooks.PostToolUse = [
    {
      matcher: "Bash|Read|Grep|Glob|Edit|MultiEdit|Write|mcp__.*",
      hooks: [
        {
          type: "command",
          command:
            "bash -lc 'cd \"${CLAUDE_PROJECT_DIR:-$PWD}\" && ./.claude/hooks/snipara-session.sh'",
          timeout: 10,
        },
      ],
    },
  ];

  hooks.Stop = [
    {
      matcher: ".*",
      hooks: [
        {
          type: "command",
          command:
            "bash -lc 'cd \"${CLAUDE_PROJECT_DIR:-$PWD}\" && command -v snipara-companion >/dev/null 2>&1 && snipara-companion session-end || true'",
          timeout: 30,
        },
      ],
    },
  ];

  // PreCompact hook - save context before compaction
  if (options.preserveOnCompaction) {
    hooks.PreCompact = [
      {
        matcher: "manual|auto",
        hooks: [
          {
            type: "command",
            command:
              "bash -lc 'cd \"${CLAUDE_PROJECT_DIR:-$PWD}\" && ./.claude/hooks/snipara-compact.sh'",
            timeout: 30,
          },
        ],
      },
    ];
  }

  // SessionStart hook - restore context after compaction/resume
  if (options.restoreOnSessionStart) {
    hooks.SessionStart = [
      {
        matcher: "startup|resume|compact|clear",
        hooks: [
          {
            type: "command",
            command:
              "bash -lc 'cd \"${CLAUDE_PROJECT_DIR:-$PWD}\" && ./.claude/hooks/snipara-startup.sh'",
            timeout: 30,
          },
        ],
      },
    ];
  }

  return { hooks };
}

/**
 * Generate hook configuration as JSON string
 */
function generateCodexConfigString(projectSlug: string): string {
  return `[mcp_servers.snipara]
type = "streamable_http"
url = "https://api.snipara.com/mcp/${projectSlug}"
bearer_token_env_var = "SNIPARA_API_KEY"
env_http_headers = { "X-Snipara-Session-Id" = "SNIPARA_SESSION_ID" }
`;
}

function generateGenericMcpReferenceString(client: SetupClient, projectSlug: string): string {
  if (client === "chatgpt") {
    return `${JSON.stringify(
      {
        name: "snipara",
        url: `https://api.snipara.com/mcp/${projectSlug}`,
        headers: {
          "X-API-Key": "${SNIPARA_API_KEY}",
          "X-Snipara-Session-Id": "${SNIPARA_SESSION_ID}",
        },
      },
      null,
      2
    )}
`;
  }

  return `${JSON.stringify(
    {
      mcpServers: {
        snipara: {
          type: "http",
          url: `https://api.snipara.com/mcp/${projectSlug}`,
          headers: {
            "X-API-Key": "${SNIPARA_API_KEY}",
            "X-Snipara-Session-Id": "${SNIPARA_SESSION_ID}",
          },
        },
      },
    },
    null,
    2
  )}
`;
}

function generateMistralVibeConfigString(projectSlug: string): string {
  return `[[mcp_servers]]
name = "snipara"
transport = "streamable-http"
url = "https://api.snipara.com/mcp/${projectSlug}"
api_key_env = "SNIPARA_API_KEY"
api_key_header = "X-API-Key"
api_key_format = "{token}"
`;
}

function generateMistralLeChatReferenceString(projectSlug: string): string {
  return `${JSON.stringify(
    {
      connector_name: "snipara",
      server_url: `https://api.snipara.com/mcp/${projectSlug}`,
      auth: {
        method: "HTTP Bearer Token or Basic/API key prompt",
        secret: "Use SNIPARA_API_KEY from your environment or secret store",
      },
      notes: [
        "In Le Chat, add a Custom MCP Connector with this Server URL.",
        "Do not commit API keys.",
        "Enable the connector tools deliberately in conversations that need project context.",
      ],
    },
    null,
    2
  )}
`;
}

function generateMistralLangChainToolCallingString(projectSlug: string): string {
  return `// LangChain JavaScript reference for Mistral tool calling.
// Install: npm install @langchain/mistralai @langchain/core zod
import { ChatMistralAI } from "@langchain/mistralai";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const SNIPARA_MCP_URL = process.env.SNIPARA_MCP_URL || "https://api.snipara.com/mcp/${projectSlug}";
const SNIPARA_API_KEY = process.env.SNIPARA_API_KEY;

async function callSniparaTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (!SNIPARA_API_KEY) {
    throw new Error("Missing SNIPARA_API_KEY");
  }

  const response = await fetch(SNIPARA_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": SNIPARA_API_KEY,
      "X-Snipara-Session-Id": process.env.SNIPARA_SESSION_ID || "",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const payload = (await response.json()) as { error?: unknown; result?: unknown };
  if (!response.ok || payload.error) {
    throw new Error("Snipara MCP call failed: " + JSON.stringify(payload.error || payload));
  }
  return JSON.stringify(payload.result || {});
}

const sniparaContextQuery = tool(
  ({ query, maxTokens }) =>
    callSniparaTool("snipara_context_query", {
      query,
      max_tokens: maxTokens,
      return_references: true,
    }),
  {
    name: "snipara_context_query",
    description: "Retrieve optimized Snipara source context with references.",
    schema: z.object({
      query: z.string(),
      maxTokens: z.number().int().positive().max(12000).default(4000),
    }),
  }
);

const beforeRequestHook = (req: Request): Request => {
  const headers = new Headers(req.headers);
  headers.set("X-Snipara-Client", "mistral-langchain");
  return new Request(req, { headers });
};

export const mistralWithSniparaTools = new ChatMistralAI({
  model: process.env.MISTRAL_MODEL || "mistral-large-latest",
  temperature: 0,
  beforeRequestHooks: [beforeRequestHook],
}).bindTools([sniparaContextQuery]);
`;
}

function generateHookConfigString(client: SetupClient, projectSlug = "YOUR_PROJECT_SLUG"): string {
  if (client === "codex") {
    return generateCodexConfigString(projectSlug);
  }

  if (client === "mistral") {
    return [
      "# Mistral Vibe (.vibe/config.toml)",
      generateMistralVibeConfigString(projectSlug).trimEnd(),
      "",
      "# Mistral Le Chat Custom MCP Connector reference",
      generateMistralLeChatReferenceString(projectSlug).trimEnd(),
      "",
      "# LangChain ChatMistralAI tool calling reference",
      generateMistralLangChainToolCallingString(projectSlug).trimEnd(),
    ].join("\n");
  }

  if (client === "cursor") {
    return JSON.stringify(generateCursorHookConfig(), null, 2);
  }

  if (!canInstallNativeHookClient(client)) {
    return generateGenericMcpReferenceString(client, projectSlug);
  }

  const config =
    client === "windsurf"
      ? generateWindsurfHookConfig()
      : generateClaudeHookConfig({ preserveOnCompaction: true, restoreOnSessionStart: true });
  return JSON.stringify(config, null, 2);
}

function generateClaudeHookPreamble(description: string): string {
  return `#!/bin/bash
# Claude Code ${description}
# Generated by: snipara-companion init --with-hooks

set -euo pipefail

PROJECT_DIR="\${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$PROJECT_DIR" 2>/dev/null || true

if ! command -v snipara-companion >/dev/null 2>&1; then
  exit 0
fi

limit_context() {
  local content="$1"
  local max_bytes="\${SNIPARA_HOOK_MAX_BYTES:-6000}"
  local byte_count
  byte_count=$(printf '%s' "$content" | wc -c | tr -d ' ')

  if [ "$byte_count" -le "$max_bytes" ]; then
    printf '%s' "$content"
    return
  fi

  printf '%s' "$content" | head -c "$max_bytes"
  printf '\\n\\n[Snipara hook context truncated: %s bytes total. Set SNIPARA_HOOK_MAX_BYTES to adjust.]\\n' "$byte_count"
}
`;
}

function generateClaudeContextEmitter(eventName: string): string {
  return `
emit_context() {
  local content="$1"

  [ -z "$content" ] && exit 0
  content=$(limit_context "$content")
  jq -n --arg content "$content" '{
    hookSpecificOutput: {
      hookEventName: "${eventName}",
      additionalContext: $content
    }
  }'
}
`;
}

function generateClaudeToolInputLoader(): string {
  return `
INPUT="\${TOOL_INPUT:-}"
if [ -z "$INPUT" ]; then
  INPUT=$(cat || true)
fi

[ -z "$INPUT" ] && exit 0

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // .tool // .name // "unknown"' 2>/dev/null || echo "unknown")
TOOL_INPUT_JSON=$(printf '%s' "$INPUT" | jq -c '.tool_input // .input // .arguments // .args // .' 2>/dev/null || printf '%s' "$INPUT")
`;
}

function generateClaudeStuckGuardScript(): string {
  return `${generateClaudeHookPreamble("PreToolUse hook for Snipara context and stuck-guard checks.")}
${generateClaudeContextEmitter("PreToolUse")}
${generateClaudeToolInputLoader()}
CONTEXT=$(snipara-companion pre-tool "$TOOL_INPUT_JSON" --tool "$TOOL_NAME" --max-tokens "\${SNIPARA_HOOK_MAX_TOKENS:-1200}" 2>/dev/stderr || true)
emit_context "$CONTEXT"
`;
}

function generateClaudeStartupScript(): string {
  return `${generateClaudeHookPreamble("SessionStart hook for Snipara memory and workflow restoration.")}
${generateClaudeContextEmitter("SessionStart")}
CONTEXT=""
if [ -f ".snipara/workflow/current.json" ]; then
  WORKFLOW_STATUS=$(jq -r '.status // empty' ".snipara/workflow/current.json" 2>/dev/null || true)
  if [ "$WORKFLOW_STATUS" != "completed" ]; then
    CONTEXT=$(snipara-companion workflow resume --include-session-context 2>/dev/stderr || true)
  fi
fi

if [ -z "$CONTEXT" ]; then
  CONTEXT=$(snipara-companion session-bootstrap --include-session-context --max-context-tokens "\${SNIPARA_HOOK_MAX_TOKENS:-1200}" 2>/dev/stderr || true)
fi

emit_context "$CONTEXT"
`;
}

function generateClaudeSessionScript(): string {
  return `${generateClaudeHookPreamble("PostToolUse hook for Snipara file tracking and failure guidance.")}
${generateClaudeContextEmitter("PostToolUse")}
${generateClaudeToolInputLoader()}
TOOL_OUTPUT_JSON=$(printf '%s' "$INPUT" | jq -c '.tool_response // .tool_output // .result // .response // {}' 2>/dev/null || echo "{}")
STATUS=$(printf '%s' "$INPUT" | jq -r '.status // .tool_status // empty' 2>/dev/null || true)

ARGS=(post-tool "$TOOL_INPUT_JSON" --tool "$TOOL_NAME" --result "$TOOL_OUTPUT_JSON")
if [ -n "$STATUS" ]; then
  ARGS+=(--status "$STATUS")
fi

CONTEXT=$(snipara-companion "\${ARGS[@]}" 2>/dev/stderr || true)
emit_context "$CONTEXT"
`;
}

function generateClaudeCompactScript(): string {
  return `${generateClaudeHookPreamble("PreCompact hook for Snipara workflow checkpointing.")}
${generateClaudeContextEmitter("PreCompact")}
if [ -f ".snipara/workflow/current.json" ]; then
  SUMMARY="Claude Code compacted while a managed workflow state existed. Resume with snipara-companion workflow resume --include-session-context and continue from .snipara/workflow/current.json."
  CONTEXT=$(snipara-companion task-commit --summary "$SUMMARY" --category workflow-compaction --outcome partial 2>/dev/stderr || true)
else
  CONTEXT=$(snipara-companion task-commit --summary "Claude Code compacted local session context" --category session-compaction --outcome partial 2>/dev/stderr || true)
fi

emit_context "$CONTEXT"
`;
}

function generateCursorHookConfig(): object {
  return {
    version: 1,
    hooks: {
      preCompact: [{ command: ".cursor/hooks/preCompact.sh", timeout: 30 }],
      sessionStart: [{ command: ".cursor/hooks/sessionStart.sh", timeout: 10 }],
      beforeReadFile: [{ command: ".cursor/hooks/beforeReadFile.sh", timeout: 10 }],
      afterFileEdit: [{ command: ".cursor/hooks/afterFileEdit.sh", timeout: 5 }],
    },
  };
}

function generateCursorBeforeReadScript(): string {
  return `#!/bin/bash
# Cursor beforeReadFile Hook for Snipara Context Injection
# Emits Cursor-compatible JSON only on stdout.

set -e

INPUT=$(cat)
if [ -z "$INPUT" ]; then
  jq -n '{ continue: true, permission: "allow" }'
  exit 0
fi

CONTEXT=$(snipara-companion pre-tool "$INPUT" --tool beforeReadFile 2>/dev/stderr || true)
if [ -n "$CONTEXT" ]; then
  jq -n --arg content "$CONTEXT" '{
    continue: true,
    permission: "allow",
    agent_message: $content
  }'
else
  jq -n '{ continue: true, permission: "allow" }'
fi
`;
}

function generateCursorAfterFileEditScript(): string {
  return `#!/bin/bash
# Cursor afterFileEdit Hook for Snipara File Tracking
# Emits Cursor-compatible JSON only on stdout.

set -e

INPUT=$(cat)
if [ -z "$INPUT" ]; then
  jq -n '{ continue: true }'
  exit 0
fi

CONTEXT=$(snipara-companion post-tool "$INPUT" --tool afterFileEdit 2>/dev/stderr || true)
if [ -n "$CONTEXT" ]; then
  jq -n --arg content "$CONTEXT" '{
    continue: true,
    additional_context: $content
  }'
else
  jq -n '{ continue: true }'
fi
`;
}

function generateCursorPreCompactScript(projectId: string): string {
  return `#!/bin/bash
# Cursor preCompact Hook for Context Preservation
# Generated by: snipara-companion init --with-hooks
# Project: ${projectId}
#
# This hook saves the session context (passed via stdin) before compaction.
# Cursor hooks must emit JSON only on stdout.

set -e

PROJECT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/../.." && pwd)"
CHECKPOINT_FILE="$PROJECT_DIR/.cursor/.session-context"

CONTEXT=$(cat)

if [ -n "$CONTEXT" ]; then
  mkdir -p "$(dirname "$CHECKPOINT_FILE")"
  printf '%s' "$CONTEXT" > "$CHECKPOINT_FILE"
  echo "preCompact: Context checkpoint saved" >&2
  jq -n '{ continue: true, agent_message: "Snipara saved the Cursor session checkpoint before compaction." }'
else
  echo "preCompact: No context provided" >&2
  jq -n '{ continue: true }'
fi
`;
}

function generateCursorSessionStartScript(projectId: string): string {
  return `#!/bin/bash
# Cursor sessionStart Hook for Context Restoration
# Generated by: snipara-companion init --with-hooks
# Project: ${projectId}
#
# This hook restores the session context after compaction or resume.
# Cursor hooks must emit JSON only on stdout.

set -e

PROJECT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/../.." && pwd)"
CHECKPOINT_FILE="$PROJECT_DIR/.cursor/.session-context"
CONTEXT=""

if [ -s "$CHECKPOINT_FILE" ]; then
  CHECKPOINT_CONTEXT=$(cat "$CHECKPOINT_FILE")
  CONTEXT="## Snipara Session Checkpoint

$CHECKPOINT_CONTEXT"
fi

if [ -n "$CONTEXT" ]; then
  jq -n --arg content "$CONTEXT" '{
    continue: true,
    agent_message: "Snipara restored Cursor session context.",
    additional_context: $content
  }'
else
  jq -n '{ continue: true }'
fi
`;
}

function generateWindsurfHookConfig(): object {
  return {
    hooks: {
      pre_read_code: { command: ".windsurf/hooks/pre-read.sh", timeout: 10 },
      post_read_code: { command: ".windsurf/hooks/post-read.sh", timeout: 5 },
      post_write_code: { command: ".windsurf/hooks/post-write.sh", timeout: 5 },
    },
  };
}

function generateWindsurfPreReadScript(): string {
  return `#!/bin/bash
# Windsurf pre_read_code Hook for Snipara Context Injection

INPUT=$(cat)
if [ -z "$INPUT" ]; then
  exit 0
fi

snipara-companion pre-tool "$INPUT" || true
`;
}

function generateWindsurfPostReadScript(): string {
  return `#!/bin/bash
# Windsurf post_read_code Hook for Snipara File Tracking

INPUT=$(cat)
if [ -z "$INPUT" ]; then
  exit 0
fi

snipara-companion post-tool "$INPUT" || true
`;
}

function generateWindsurfPostWriteScript(): string {
  return `#!/bin/bash
# Windsurf post_write_code Hook for Snipara File Tracking

INPUT=$(cat)
if [ -z "$INPUT" ]; then
  exit 0
fi

snipara-companion post-tool "$INPUT" || true
`;
}

/**
 * Install hooks to the project directory
 */
function installHooks(
  projectDir: string,
  projectId: string,
  _apiKey: string,
  client: HookClient
): { success: boolean; error?: string } {
  try {
    if (client === "cursor") {
      const cursorDir = path.join(projectDir, ".cursor");
      const hooksDir = path.join(cursorDir, "hooks");
      const hooksPath = path.join(cursorDir, "hooks.json");

      if (!fs.existsSync(cursorDir)) {
        fs.mkdirSync(cursorDir, { recursive: true });
      }
      if (!fs.existsSync(hooksDir)) {
        fs.mkdirSync(hooksDir, { recursive: true });
      }

      const preCompactPath = path.join(hooksDir, "preCompact.sh");
      fs.writeFileSync(preCompactPath, generateCursorPreCompactScript(projectId));
      fs.chmodSync(preCompactPath, "755");

      const sessionStartPath = path.join(hooksDir, "sessionStart.sh");
      fs.writeFileSync(sessionStartPath, generateCursorSessionStartScript(projectId));
      fs.chmodSync(sessionStartPath, "755");

      const beforeReadPath = path.join(hooksDir, "beforeReadFile.sh");
      fs.writeFileSync(beforeReadPath, generateCursorBeforeReadScript());
      fs.chmodSync(beforeReadPath, "755");

      const afterEditPath = path.join(hooksDir, "afterFileEdit.sh");
      fs.writeFileSync(afterEditPath, generateCursorAfterFileEditScript());
      fs.chmodSync(afterEditPath, "755");

      fs.writeFileSync(hooksPath, JSON.stringify(generateCursorHookConfig(), null, 2));

      return { success: true };
    }

    if (client === "windsurf") {
      const windsurfDir = path.join(projectDir, ".windsurf");
      const hooksDir = path.join(windsurfDir, "hooks");
      const hooksPath = path.join(windsurfDir, "cascade-hooks.json");

      if (!fs.existsSync(windsurfDir)) {
        fs.mkdirSync(windsurfDir, { recursive: true });
      }
      if (!fs.existsSync(hooksDir)) {
        fs.mkdirSync(hooksDir, { recursive: true });
      }

      const preReadPath = path.join(hooksDir, "pre-read.sh");
      fs.writeFileSync(preReadPath, generateWindsurfPreReadScript());
      fs.chmodSync(preReadPath, "755");

      const postReadPath = path.join(hooksDir, "post-read.sh");
      fs.writeFileSync(postReadPath, generateWindsurfPostReadScript());
      fs.chmodSync(postReadPath, "755");

      const postWritePath = path.join(hooksDir, "post-write.sh");
      fs.writeFileSync(postWritePath, generateWindsurfPostWriteScript());
      fs.chmodSync(postWritePath, "755");

      fs.writeFileSync(hooksPath, JSON.stringify(generateWindsurfHookConfig(), null, 2));

      return { success: true };
    }

    const claudeDir = path.join(projectDir, ".claude");
    const hooksDir = path.join(claudeDir, "hooks");
    const settingsPath = path.join(claudeDir, "settings.json");

    // Create directories
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }

    const hookScripts = [
      ["snipara-stuck-guard.sh", generateClaudeStuckGuardScript()],
      ["snipara-startup.sh", generateClaudeStartupScript()],
      ["snipara-session.sh", generateClaudeSessionScript()],
      ["snipara-compact.sh", generateClaudeCompactScript()],
    ] as const;

    for (const [fileName, content] of hookScripts) {
      const hookPath = path.join(hooksDir, fileName);
      fs.writeFileSync(hookPath, content);
      fs.chmodSync(hookPath, "755");
    }

    // Read existing settings or create new
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      } catch {
        // Invalid JSON, start fresh
      }
    }

    // Merge hook config
    const hookConfig = generateClaudeHookConfig({
      preserveOnCompaction: true,
      restoreOnSessionStart: true,
    });
    settings = { ...settings, ...hookConfig };

    // Write settings
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Initialize the Snipara companion CLI configuration
 */
export async function initCommand(options: {
  apiKey?: string;
  project?: string;
  projectId?: string;
  client?: string;
  force?: boolean;
  withHooks?: boolean;
  dir?: string;
}): Promise<void> {
  console.log("\n🚀 Snipara Companion CLI Setup\n");
  const projectDir = options.dir || process.cwd();
  const configPaths = getConfigPaths(projectDir);

  // Check if already configured
  if (isConfigured({ cwd: projectDir }) && !options.force) {
    console.log("✓ Already configured!");
    console.log(`  Companion config: ${configPaths.companion}\n`);

    const overwrite = await prompt("Overwrite existing configuration? (y/N): ");
    if (overwrite.toLowerCase() !== "y") {
      console.log("\nSetup cancelled.");
      return;
    }
  }

  const existingConfig = loadConfig({ cwd: projectDir });
  const localProjectHints = collectLocalProjectHints(projectDir);

  // Get API key
  let apiKey = options.apiKey;
  let authorizedProject:
    | {
        projectId: string;
        projectSlug: string;
        projectName?: string;
      }
    | undefined;

  if (!apiKey) {
    console.log("No API key provided. Starting browser project authorization...\n");
    const authorization = await runProjectDeviceAuthorization({
      apiUrl: existingConfig.apiUrl,
      client: options.client,
      localProjectHints,
    });
    apiKey = authorization.apiKey;
    authorizedProject = {
      projectId: authorization.projectId,
      projectSlug: authorization.projectSlug,
      projectName: authorization.projectName,
    };
  }

  if (!apiKey) {
    console.error("\n❌ Authorization completed but no API key was returned.");
    process.exit(1);
  }

  console.log("\n⏳ Discovering accessible projects...");
  const accessibleProjects = await listProjectsForApiKey(apiKey, existingConfig.apiUrl, 10000);

  if (accessibleProjects.length === 0) {
    console.error("\n❌ No accessible context projects were found for this API key.");
    process.exit(1);
  }

  let selectedProject: ApiKeyProjectSummary | undefined;
  const requestedProject = options.project ?? options.projectId;

  if (requestedProject) {
    selectedProject = accessibleProjects.find(
      (project) => project.id === requestedProject || project.slug === requestedProject
    );

    if (!selectedProject) {
      console.error("\n❌ The provided project slug or ID is not accessible with this API key.");
      process.exit(1);
    }
  }

  if (!selectedProject && authorizedProject) {
    selectedProject = accessibleProjects.find(
      (project) =>
        project.id === authorizedProject.projectId || project.slug === authorizedProject.projectSlug
    );

    if (selectedProject) {
      console.log(`✓ Selected browser-authorized project: ${selectedProject.name}`);
    } else {
      console.error("\n❌ The browser-authorized project is not accessible with this API key.");
      process.exit(1);
    }
  }

  for (const signal of localProjectHints.identifiers) {
    if (selectedProject) {
      break;
    }

    const matches = accessibleProjects.filter((project) =>
      projectMatchesIdentifier(project, signal.value)
    );

    if (matches.length === 1) {
      selectedProject = matches[0];
      console.log(
        `✓ Matched local ${signal.source} (${signal.value}) to project ${selectedProject.name}`
      );
    } else if (matches.length > 1) {
      selectedProject = await promptForProjectSelection(
        matches,
        `Multiple accessible projects match local ${signal.source} (${signal.value}).`
      );
    }
  }

  if (!selectedProject && localProjectHints.githubRepo) {
    const repoMatches = accessibleProjects.filter((project) =>
      projectMatchesGitHubRepo(project, localProjectHints.githubRepo!)
    );

    if (repoMatches.length === 1) {
      selectedProject = repoMatches[0];
      console.log(
        `✓ Matched GitHub remote ${localProjectHints.githubRepo} to project ${selectedProject.name}`
      );
    } else if (repoMatches.length > 1) {
      selectedProject = await promptForProjectSelection(
        repoMatches,
        `Multiple projects match GitHub remote ${localProjectHints.githubRepo}.`
      );
    }
  }

  const hasLocalProjectContext =
    localProjectHints.identifiers.length > 0 || Boolean(localProjectHints.githubRepo);

  if (!selectedProject && hasLocalProjectContext) {
    const localSummary = [
      ...localProjectHints.identifiers.map((signal) => `${signal.source}: ${signal.value}`),
      localProjectHints.githubRepo ? `git remote: ${localProjectHints.githubRepo}` : null,
    ]
      .filter((value): value is string => Boolean(value))
      .join("; ");

    selectedProject = await promptForProjectSelection(
      accessibleProjects,
      `Local workspace points at ${localSummary}, but no accessible project matched it exactly. Select the project/repo this workspace should use.`
    );
  }

  if (!selectedProject && accessibleProjects.length === 1) {
    selectedProject = accessibleProjects[0];
    console.log(`✓ Selected only accessible project: ${selectedProject.name}`);
  }

  if (!selectedProject) {
    selectedProject = await promptForProjectSelection(
      accessibleProjects,
      "Select the project this workspace should use."
    );
  }

  const projectIdentifier = selectedProject.id;
  const selectedClient = resolveSelectedClient({
    requestedClient: options.client,
    existingClient: existingConfig.client,
    existingProjectId: existingConfig.projectId,
    selectedProject,
  });

  // Save one workspace-local companion config: auth, project selection, and session state.
  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  saveConfig(
    {
      apiKey,
      apiUrl: existingConfig.apiUrl,
      projectId: projectIdentifier,
      sessionId,
      client: selectedClient,
    },
    { cwd: projectDir, scope: "workspace" }
  );
  writeProjectBinding(projectDir, selectedProject.slug);

  const workflowInstructionResults = ensureWorkflowInstructions(
    projectDir,
    selectedProject.slug,
    selectedClient
  );
  for (const workflowInstructions of workflowInstructionResults) {
    const workflowAction =
      workflowInstructions.action === "created"
        ? "Created"
        : workflowInstructions.action === "updated"
          ? "Updated"
          : "Verified";
    console.log(
      `✓ ${workflowAction} Snipara workflow instructions: ${workflowInstructions.relativePath}`
    );
  }

  // Test connection
  console.log("\n⏳ Testing connection...");
  const client = createClient(10000, { cwd: projectDir });
  const connected = await client.testConnection();

  if (connected) {
    console.log("✓ Connection successful!\n");
  } else {
    console.log(
      "⚠️  Could not verify connection. Please check your API key and project slug or ID.\n"
    );
  }

  // Install hooks if requested
  const hookClient = selectedClient;

  if (options.withHooks) {
    console.log("━".repeat(60));
    console.log("\n📦 Installing Automation Files\n");
    let installedAutomationFiles = false;

    try {
      await automationsInstallCommand({
        client: hookClient,
        dir: projectDir,
        force: options.force,
      });
      installedAutomationFiles = true;
    } catch (error) {
      if (!canInstallNativeHookClient(hookClient)) {
        const reason = getNativeHookBlockReason(hookClient);
        console.log(
          `Native hook install is disabled for ${formatClientName(hookClient)}. ${reason}`
        );
        console.log(
          `Use AGENTS.md plus the ${formatClientName(hookClient)} MCP reference from \`npx -y snipara-companion@latest init --client ${hookClient}\`.`
        );
      } else if (
        process.env.SNIPARA_COMPANION_LEGACY_HOOKS_FALLBACK !== "1" ||
        !canUseLegacyHookFallback(hookClient)
      ) {
        throw error;
      } else {
        console.log("Hosted automation bundle unavailable; using legacy local hook templates.");
        const result = installHooks(projectDir, selectedProject.slug, apiKey, hookClient);
        if (!result.success) {
          throw new Error(`Failed to install legacy hooks: ${result.error}`);
        }
        installedAutomationFiles = true;
        console.log("✓ Legacy hooks installed successfully.");
      }
    }
    if (!installedAutomationFiles) {
      console.log("No local automation files were installed for this client.");
    }

    console.log("━".repeat(60));
    console.log("\n🔁 Installing Local Code Overlay Git Hooks\n");
    try {
      await codeHooksInstallCommand({
        dir: projectDir,
        maxFiles: 2000,
        requestReindex: true,
      });
    } catch (error) {
      console.log(
        `Could not install local code overlay Git hooks: ${error instanceof Error ? error.message : String(error)}`
      );
      console.log("Run `snipara-companion code hooks install` from a Git workspace to retry.");
    }
  } else {
    // Show hook configuration for manual setup
    console.log("━".repeat(60));
    if (hookClient === "cursor") {
      console.log("\n📝 Cursor Hook Configuration\n");
      console.log(
        "Add this to .cursor/hooks.json, or rerun with --with-hooks to install the full bundle:\n"
      );
    } else if (hookClient === "windsurf") {
      console.log("\n📝 Windsurf Hook Configuration\n");
      console.log("Add this to your .windsurf/cascade-hooks.json:\n");
    } else if (hookClient === "codex") {
      console.log("\n📝 OpenAI Codex MCP Configuration\n");
      console.log("Merge this into ~/.codex/config.toml or project .codex/config.toml:\n");
    } else if (hookClient === "gemini") {
      console.log("\n📝 Gemini MCP Reference\n");
      console.log("Use this hosted MCP reference in your Gemini MCP settings:\n");
    } else if (hookClient === "mistral") {
      console.log("\n📝 Mistral MCP, Vibe, and LangChain Reference\n");
      console.log(
        "Use these references for Le Chat Custom MCP Connectors, Mistral Vibe, or ChatMistralAI tool calling:\n"
      );
    } else if (hookClient === "vscode") {
      console.log("\n📝 VS Code MCP Reference\n");
      console.log("Use this hosted MCP reference in your VS Code MCP settings:\n");
    } else if (hookClient === "continue") {
      console.log("\n📝 Continue MCP Reference\n");
      console.log("Use this hosted MCP reference in your Continue MCP settings:\n");
    } else if (hookClient === "chatgpt") {
      console.log("\n📝 ChatGPT / OpenAI MCP Reference\n");
      console.log("Use this hosted MCP reference in your OpenAI-compatible MCP settings:\n");
    } else if (hookClient === "custom") {
      console.log("\n📝 Custom MCP Reference\n");
      console.log("Use this hosted MCP reference in any streamable HTTP MCP client:\n");
    } else {
      console.log("\n📝 Claude Code Hook Configuration\n");
      console.log("Add this hook block to your project .claude/settings.json:\n");
    }
    console.log("━".repeat(60));
    console.log(generateHookConfigString(hookClient, selectedProject.slug));
    console.log("━".repeat(60));
  }

  console.log("\n✅ Setup complete!\n");
  console.log(`Companion config: ${configPaths.companion}`);
  console.log(`Selected project: ${formatProjectChoice(selectedProject)}`);
  console.log(`Selected client:  ${formatClientName(selectedClient)}`);
  console.log(`Correlation session: ${sessionId}`);
  console.log(
    "Export SNIPARA_SESSION_ID with this value before starting the MCP client so served context and execution outcomes share one bounded session."
  );

  if (options.withHooks) {
    console.log("\nNext steps:");
    if (hookClient === "cursor") {
      console.log("  1. Restart Cursor to load the new MCP, rules, and hooks");
      console.log("  2. Verify with: cursor mcp list");
    } else if (hookClient === "windsurf") {
      console.log("  1. Restart Windsurf to load the new hooks");
      console.log("  2. Verify your cascade hooks are enabled");
    } else if (hookClient === "codex") {
      console.log("  1. Restart Codex to load the MCP config and hooks");
      console.log("  2. Verify the snipara MCP tools and /hooks are available in Codex");
    } else if (hookClient === "gemini") {
      console.log("  1. Restart Gemini CLI to load the hooks");
      console.log("  2. Review hook status with: /hooks panel");
      console.log("  3. Verify the Snipara MCP server is available");
    } else if (hookClient === "mistral") {
      console.log("  1. Add Snipara as a Le Chat Custom MCP Connector or Vibe MCP server");
      console.log("  2. Restart the Mistral client and verify the snipara MCP tools are available");
      console.log("  3. Use LangChain request hooks only around ChatMistralAI requests");
    } else if (!isHookClient(hookClient)) {
      console.log(`  1. Add the Snipara MCP reference to ${formatClientName(hookClient)}`);
      console.log("  2. Restart the client and verify the snipara MCP tools are available");
    } else {
      console.log("  1. Restart Claude Code to load the new hooks");
      console.log("  2. Verify with: claude mcp list");
    }
    console.log("\nAutomation setup is ready for the selected client.\n");
  } else {
    console.log("\nNext steps:");
    console.log("  1. Apply the configuration above");
    if (hookClient === "cursor") {
      console.log("  2. Add it to .cursor/hooks.json in your project");
      console.log("  3. Restart Cursor");
    } else if (hookClient === "windsurf") {
      console.log("  2. Add it to .windsurf/cascade-hooks.json in your project");
      console.log("  3. Restart Windsurf");
    } else if (hookClient === "codex") {
      console.log("  2. Add it to ~/.codex/config.toml or project .codex/config.toml");
      console.log("  3. Restart Codex");
    } else if (hookClient === "mistral") {
      console.log("  2. Add the Vibe block to .vibe/config.toml or add the Le Chat connector");
      console.log("  3. Restart the Mistral client");
    } else if (!isHookClient(hookClient)) {
      console.log(`  2. Add it to ${formatClientName(hookClient)} MCP settings`);
      console.log(`  3. Restart ${formatClientName(hookClient)}`);
    } else {
      console.log("  2. Add the hook block to .claude/settings.json in your project");
      console.log("  3. Restart Claude Code");
    }
    if (canInstallNativeHookClient(hookClient)) {
      console.log("\nOr run: npx -y snipara-companion@latest init --with-hooks");
      console.log("to automatically install hooks in the current directory.\n");
    } else {
      console.log("\nNative hooks stay disabled for this client until a verified bundle ships.\n");
    }
  }
}

/**
 * Show current configuration
 */
export function showConfig(): void {
  const config = loadConfig();
  const companionConfigPath = getConfigPath();

  console.log("\n📋 Snipara Configuration\n");
  console.log(`Companion config: ${companionConfigPath}\n`);
  console.log(`API URL:     ${config.apiUrl}`);
  console.log(`API Key:     ${config.apiKey ? config.apiKey.slice(0, 8) + "..." : "not set"}`);
  console.log(`Project:     ${config.projectId || "not set"}`);
  console.log(`Client:      ${config.client || "not set"}`);
  console.log(`Session ID:  ${config.sessionId || "not set"}`);
  console.log();
}
