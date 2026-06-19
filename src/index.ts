#!/usr/bin/env node

/**
 * snipara-companion CLI entry point.
 *
 * Builds the Commander program, registers every subcommand, and parses argv.
 * Command behavior lives in the `./commands/*` modules; this file only maps the
 * CLI surface (names, flags, argument parsing) onto those handlers.
 *
 * Command families registered below:
 *   - Setup / auth:      login, init, config, doctor
 *   - Continuity:        status, timeline, handoff, verify, brief, workflow, intelligence
 *   - Team coordination: collaboration, swarm, htask (+ handoff/resume via team-sync)
 *   - Editor hooks:      pre-tool, post-tool, session-end (invoked by Claude Code / IDE hooks)
 *   - Guards:            stuck-guard, memory-guard
 *   - Hosted context:    query, shared-context, plan, multi-query, orchestrate, chunk, reindex
 *   - Docs / knowledge:  upload, references, business-collections, client-projects,
 *                        onboard-folder, sync-documents
 *   - Code graph:        code (local impact/callers/imports + hosted overlay)
 *   - Automation:        automations, events, memory
 *
 * The `export { ... }` block below re-exports pure helpers (buildX, parsers,
 * path resolvers) so they can be used programmatically and unit-tested without
 * spawning the CLI.
 */

import fs from "fs";
import path from "path";
import { Command } from "commander";
import { initCommand, showConfig } from "./commands/init";
import { loginCommand } from "./commands/login";
import { preToolCommand, clearCache } from "./commands/pre-tool";
import { postToolCommand } from "./commands/post-tool";
import { sessionEndCommand, sessionStatusCommand, sessionResetCommand } from "./commands/session";
import { emitEventCommand, recentEventsCommand } from "./commands/events";
import {
  stuckGuardCheckCommand,
  stuckGuardSimulateCommand,
  stuckGuardStatusCommand,
} from "./commands/stuck-guard";
import {
  memoryAuditCommand,
  memoryCleanCandidatesCommand,
  memoryCompactCommand,
  memoryHealthCommand,
  memoryInvalidateCommand,
  memorySupersedeCommand,
} from "./commands/memory";
import { evalExportCommand, evalRunCommand, memoryLocalCommand } from "./commands/local-stack";
import {
  contextPackCleanCommand,
  contextPackPackCommand,
  contextPackRetrieveCommand,
  contextPackStatsCommand,
} from "./commands/context-pack";
import { memoryGuardCheckCommand, rememberGuardMemoryCommand } from "./commands/memory-guard";
import { doctorCommand } from "./commands/doctor";
import {
  codeGraphAutoSourceCommand,
  codeHooksInstallCommand,
  codeLocalImpactCommand,
  codeLocalCallersCommand,
  codeLocalImportsCommand,
  codeLocalNeighborsCommand,
  codeLocalShortestPathCommand,
  codeMcpCommand,
  codePromoteCommand,
  codeServeCommand,
  codeStatusCommand,
  codeSyncCommand,
  codeUploadCommand,
} from "./commands/code";
import {
  automationsDiffCommand,
  automationsInstallCommand,
  automationsStatusCommand,
  automationsUpdateCommand,
} from "./commands/automations";
import { projectIntelligenceBriefCommand } from "./commands/intelligence";
import { referencesIngestCommand, referencesScanCommand } from "./commands/references";
import { verifyCommand } from "./commands/verify";
import { projectIntelligenceRunCommand } from "./commands/run";
import {
  agenticHandoffCommand,
  teamSyncCompleteWorkCommand,
  teamSyncHandoffCommand,
  teamSyncResumeCommand,
  teamSyncStartWorkCommand,
  teamSyncSweepCommand,
  teamSyncWhatChangedCommand,
} from "./commands/team-sync";
import {
  collaborationClaimCommand,
  collaborationGuardCommand,
  collaborationHooksInstallCommand,
  collaborationIdeStatusCommand,
  collaborationReleaseCommand,
  collaborationStartCommand,
  collaborationStatusCommand,
  collaborationWatchCommand,
} from "./commands/collaboration";
import {
  agenticStatusCommand,
  businessHealthCommand,
  businessCollectionEnsureCommand,
  businessCollectionUploadCommand,
  businessCollectionsListCommand,
  chunkGetCommand,
  clientProjectCreateCommand,
  clientProjectsListCommand,
  codeSymbolCardCommand,
  finalCommitCommand,
  loadDocumentCommand,
  multiQueryCommand,
  onboardFolderCommand,
  orchestrateCommand,
  planCommand,
  queryCommand,
  recallCommand,
  reindexCommand,
  sessionBootstrapCommand,
  sharedContextCommand,
  syncDocumentsCommand,
  taskCommitCommand,
  uploadCommand,
  workflowImpactGateCommand,
  workflowPhaseCommitCommand,
  workflowPhaseStartCommand,
  workflowRuntimeCheckpointCommand,
  workflowResumeCommand,
  workflowScaffoldCommand,
  workflowRunCommand,
  workflowStartCommand,
  workflowStatusCommand,
  workflowTimelineCommand,
  WORKFLOW_PLAN_PRESET_IDS,
} from "./commands/workflows";
import {
  htaskCompleteCommand,
  htaskCreateCommand,
  htaskCreateFeatureCommand,
  htaskNextCommand,
  htaskTreeCommand,
} from "./commands/htask";
import { swarmCreateCommand, swarmJoinCommand } from "./commands/swarm";
import { loadConfig } from "./config/store";

// Programmatic API: pure helpers re-exported for embedding and unit tests.
// These have no CLI side effects and are safe to import without running argv.
export { resolveQueryFromToolInput } from "./commands/pre-tool";
export { extractFilesFromToolInput } from "./commands/post-tool";
export {
  attachLocalContextPackReceipts,
  buildCanonicalEvent,
  buildLocalContextPackReceipt,
  buildLocalContextPackReceipts,
} from "./commands/events";
export { createClient, listProjectsForApiKey } from "./api/client";
export {
  buildToolCallPayload,
  buildToolResultPayload,
  classifyToolResult,
  extractCommandFromToolInput,
  formatStuckGuardDecision,
  getStuckGuardInjection,
} from "./commands/stuck-guard";
export {
  categoryFromGuardTag,
  detectReleaseSurfacesFromFiles,
  getStagedFiles,
  normalizeGuardTag,
  runMemoryGuardCheck,
} from "./commands/memory-guard";
export {
  buildProjectIntelligenceBrief,
  projectIntelligenceBriefCommand,
} from "./commands/intelligence";
export {
  buildMemoryAudit,
  memoryAuditCommand,
  memoryCleanCandidatesCommand,
  memoryCompactCommand,
  memoryHealthCommand,
} from "./commands/memory";
export {
  buildEvalCaseArtifact,
  evalExportCommand,
  evalRunCommand,
  memoryLocalCommand,
} from "./commands/local-stack";
export {
  buildContextPackStats,
  cleanContextPacks,
  contextPackCleanCommand,
  contextPackPackCommand,
  contextPackRetrieveCommand,
  contextPackStatsCommand,
  getContextPackStoragePaths,
  packContext,
  resolveContextPackRecord,
  retrieveContextPack,
} from "./commands/context-pack";
export { buildVerificationPlan, verifyCommand } from "./commands/verify";
export { buildProjectJudgmentCard, formatProjectJudgmentCard } from "./commands/judgment-card";
export { buildProjectIntelligenceRun, projectIntelligenceRunCommand } from "./commands/run";
export {
  buildCodeHooksInstallPlan,
  buildCodePromotionResult,
  buildCodeStatusResult,
  buildCodeSyncResult,
  buildHostedCodeOverlayUploadPayload,
  buildLocalCallersResult,
  buildLocalCodeOverlay,
  buildLocalImpactResult,
  buildLocalImportsResult,
  buildLocalNeighborsResult,
  buildLocalShortestPathResult,
  getLocalCodeOverlayCachePath,
  getLocalCodePromotionStatePath,
  readLocalCodeOverlayCache,
  readLocalCodePromotionState,
  summarizeLocalCodeOverlay,
  writeLocalCodeOverlayCache,
  writeLocalCodePromotionState,
} from "./commands/code";
export { getPlanStepDisplayTitle } from "./commands/workflows";
export {
  ingestReferences,
  referencesIngestCommand,
  referencesScanCommand,
  scanReferences,
} from "./commands/references";
export {
  buildAgenticTimeline,
  buildAgenticWorkStatus,
  buildGeneratedWorkflowPlanDocument,
  buildWorkflowImpactGate,
  buildWorkflowPhaseCommitSummary,
  buildWorkflowPlanScaffold,
  buildSessionBootstrapQuality,
  buildOnboardFolderManifest,
  buildSyncDocumentsDryRun,
  collectSyncDocuments,
  collectSyncDocumentsInput,
  normalizeWorkflowPlanInput,
  resolveFullWorkflowTokenBudget,
  validatePlanResult,
  WORKFLOW_PLANS_RELATIVE_DIR,
  WORKFLOW_STATE_RELATIVE_PATH,
} from "./commands/workflows";
export { createLocalQueryCache } from "./cache/query-cache";
export { getConfigPath, loadConfig, saveConfig } from "./config/store";
export {
  AUTOMATION_MANIFEST_RELATIVE_PATH,
  AutomationInstallConflictError,
  AutomationUnsupportedHookBundleError,
  buildAutomationInstallPlan,
  getAutomationManifestPath,
  getAutomationStatus,
  installAutomationBundle,
  loadAutomationManifest,
} from "./commands/automations";
export {
  buildAgenticHandoffMarkdown,
  archiveInactiveTeamSyncWork,
  autoArchiveTeamSyncState,
  buildTeamSyncHandoffRecord,
  buildTeamSyncStartWorkRecord,
  buildTeamSyncSummary,
  completeTeamSyncStateFromEvidence,
  completeTeamSyncWorkFromEvidence,
  createEmptyTeamSyncState,
  getTeamSyncStatePath,
  loadTeamSyncState,
  saveTeamSyncState,
  teamSyncSweepCommand,
  TEAM_SYNC_STATE_RELATIVE_PATH,
} from "./commands/team-sync";
export {
  buildCollaborationActor,
  buildCollaborationGuardActionCards,
  buildHostedGuardPayload,
  buildCollaborationHooksInstallPlan,
  COLLABORATION_STATE_RELATIVE_PATH,
  compactHostedGuardResources,
  createEmptyCollaborationState,
  deriveLocalCollaborationResourcesFromFiles,
  getCollaborationStatePath,
  loadCollaborationState,
  normalizeCollaborationFiles,
  parseCollaborationResources,
  saveCollaborationState,
  collaborationIdeStatusCommand,
} from "./commands/collaboration";
export { buildJournalCheckpointEntry } from "./commands/journal";
export {
  detectRuntimeEnvironment,
  formatOrchestratorRecommendationReason,
  getOrchestratorRecommendation,
  shouldSuggestOrchestratorForWorkflow,
  shouldSuggestRuntimeForWorkflow,
} from "./runtime/detection";
export {
  buildAdaptiveWorkRoutingRecommendation,
  buildOrchestratorHandoff,
  ORCHESTRATOR_HANDOFF_RELATIVE_PATH,
  writeOrchestratorHandoff,
} from "./runtime/orchestrator-handoff";

const CLI_VERSION_FALLBACK = "1.1.23";

async function readOptionalStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    return undefined;
  }

  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  return input.trim() === "" ? undefined : input;
}

function readCliVersion(): string {
  const packageJsonPath = path.resolve(__dirname, "../package.json");

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      version?: unknown;
    };
    return typeof packageJson.version === "string" ? packageJson.version : CLI_VERSION_FALLBACK;
  } catch {
    return CLI_VERSION_FALLBACK;
  }
}

// CLI command registration. Each `program.command(...)` block below maps a
// command's flags and arguments to a handler in ./commands/*; argv is parsed at
// the bottom of the file. Behavior belongs in the handlers, not here.
const program = new Command();

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

program
  .name("snipara-companion")
  .description("Snipara companion CLI for local hooks and automation workflows")
  .version(readCliVersion());

// Login command (device-code OAuth flow)
program
  .command("login")
  .description("Authenticate this workspace through the Snipara project picker")
  .option("--api-url <url>", "Override the API URL (default: https://api.snipara.com)")
  .option("-c, --client <client>", "Client type for the project API key label")
  .option("-p, --project <project>", "Project slug or ID to preselect in the browser")
  .option("--project-id <id>", "Project slug or ID (deprecated alias)")
  .option("-d, --dir <directory>", "Project directory (default: current)")
  .option("--user-key", "Use the legacy project-agnostic user-key login flow")
  .action(async (options) => {
    try {
      await loginCommand({
        ...options,
        project: options.project ?? options.projectId,
      });
    } catch (err) {
      console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

// Init command (optional — project is auto-resolved per workspace)
program
  .command("init")
  .description("Initialize Snipara companion configuration")
  .option("-k, --api-key <key>", "API key")
  .option("-p, --project <project>", "Project slug or ID")
  .option("--project-id <id>", "Project slug or ID (deprecated alias)")
  .option(
    "-c, --client <client>",
    "Client type (claude-code|cursor|windsurf|codex|gemini|mistral|chatgpt|vscode|continue|custom)"
  )
  .option("-f, --force", "Force overwrite existing configuration")
  .option("-w, --with-hooks", "Install hooks automatically")
  .option("-d, --dir <directory>", "Project directory for hooks (default: current)")
  .action(async (options) => {
    await initCommand({
      ...options,
      project: options.project ?? options.projectId,
    });
  });

// Config command
program
  .command("config")
  .description("Show current configuration")
  .action(() => {
    showConfig();
  });

program
  .command("doctor")
  .description(
    "Diagnose Snipara companion, Snipara Sandbox, optional Orchestrator, provider keys, and Docker"
  )
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await doctorCommand({ json: options.json });
  });

program
  .command("status")
  .description("Show the current agentic work status across workflow, git, and Team Sync")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await agenticStatusCommand({ json: Boolean(options.json) });
  });

program
  .command("timeline")
  .description("Show recent workflow phase commits, checkpoints, and Team Sync handoffs")
  .option("-l, --limit <number>", "Maximum number of events", "20")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await workflowTimelineCommand({
      limit: parseInt(options.limit, 10),
      json: Boolean(options.json),
    });
  });

program
  .command("handoff")
  .description("Create an agent-ready handoff artifact and persist Team Sync continuity")
  .option("--summary <summary>", "What changed in this session")
  .option("--next <next>", "Recommended next action")
  .option("--files <files...>", "Relevant files")
  .option("--attention <attention>", "Attention level (note|watch|review|proof)")
  .option("--risk <risk>", "Compatibility alias for --attention")
  .option("--actor <actor>", "Actor or agent name")
  .option("-d, --dir <directory>", "Project directory (default: current)")
  .option("-o, --output <file>", "Write the handoff artifact to Markdown or JSON")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await agenticHandoffCommand({
      summary: options.summary,
      next: options.next,
      files: options.files,
      attention: options.attention,
      risk: options.risk,
      actor: options.actor,
      dir: options.dir,
      output: options.output,
      json: Boolean(options.json),
    });
  });

program
  .command("verify")
  .description("Build a transparent verification plan from code impact and local package scripts")
  .option("--task <task>", "Current task or change summary")
  .option("--qualified-name <name>", "Qualified symbol name")
  .option("--symbol-key <key>", "Stable graph symbol key")
  .option("--file-path <file>", "Single source file to analyze")
  .option("--changed-files <files...>", "Changed files to analyze")
  .option("--diff-summary <summary>", "Natural-language summary for code impact")
  .option("-l, --limit <number>", "Maximum impact entries", "50")
  .option("--skip-impact", "Skip code impact and infer local package checks only")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await verifyCommand({
      task: options.task,
      qualifiedName: options.qualifiedName,
      symbolKey: options.symbolKey,
      filePath: options.filePath,
      changedFiles: options.changedFiles,
      diffSummary: options.diffSummary,
      limit: options.limit ? parseInt(options.limit, 10) : undefined,
      skipImpact: Boolean(options.skipImpact),
      json: Boolean(options.json),
    });
  });

program
  .command("run")
  .description("Run the production Project Intelligence judgment flow for a task or release")
  .option("--task <task>", "Current task or change summary")
  .option("--branch <branch>", "Branch to scope continuity signals")
  .option("--changed-files <changedFiles...>", "Changed files to analyze")
  .option("--recent-files <recentFiles...>", "Recently touched files for continuity lookup")
  .option("--diff-summary <diffSummary>", "Natural-language summary for code impact")
  .option("--max-tokens <number>", "Resume context token budget", "4000")
  .option("--release", "Run release-oriented guard and package surface review")
  .option("--skip-impact", "Do not run companion code impact")
  .option("--skip-memory-health", "Do not call snipara_memory_health")
  .option("--skip-guard", "Skip collaboration guard during release runs")
  .option("--skip-package-review", "Skip npm package surface review")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await projectIntelligenceRunCommand({
      task: options.task,
      branch: options.branch,
      changedFiles: options.changedFiles,
      recentFiles: options.recentFiles,
      diffSummary: options.diffSummary,
      maxTokens: parseInt(options.maxTokens, 10),
      release: Boolean(options.release),
      skipImpact: Boolean(options.skipImpact),
      skipMemoryHealth: Boolean(options.skipMemoryHealth),
      skipGuard: Boolean(options.skipGuard),
      skipPackageReview: Boolean(options.skipPackageReview),
      json: Boolean(options.json),
    });
  });

program
  .command("swarm")
  .description(
    "Legacy direct hosted swarm passthrough (prefer snipara-orchestrator for shared multi-agent task routing)"
  )
  .addCommand(
    new Command("create")
      .description("Create a hosted swarm for multi-agent coordination")
      .requiredOption("--name <name>", "Swarm name")
      .option("--description <description>", "Swarm description")
      .option("--max-agents <n>", "Maximum agents", (value) => Number.parseInt(value, 10))
      .option("--task-timeout <seconds>", "Task timeout in seconds", (value) =>
        Number.parseInt(value, 10)
      )
      .option("--claim-timeout <seconds>", "Claim timeout in seconds", (value) =>
        Number.parseInt(value, 10)
      )
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await swarmCreateCommand({
          name: options.name,
          description: options.description,
          maxAgents: options.maxAgents,
          taskTimeout: options.taskTimeout,
          claimTimeout: options.claimTimeout,
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("join")
      .description("Join an existing hosted swarm as an agent")
      .requiredOption("--swarm-id <id>", "Swarm ID")
      .requiredOption("--agent-id <id>", "Agent ID")
      .option("--name <name>", "Human-readable agent name")
      .option("--role <role>", "Role (coordinator|worker|observer)")
      .option("--capability <capability...>", "Agent capabilities")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await swarmJoinCommand({
          swarmId: options.swarmId,
          agentId: options.agentId,
          name: options.name,
          role: options.role,
          capabilities: options.capability,
          json: options.json,
        });
      })
  );

program
  .command("htask")
  .description(
    "Legacy direct hosted htask passthrough (prefer snipara-orchestrator for shared multi-agent queues)"
  )
  .addCommand(
    new Command("create")
      .description("Create a hosted hierarchical task at N0, N1, N2, or N3")
      .requiredOption("--swarm-id <id>", "Swarm ID")
      .requiredOption("--title <title>", "Task title")
      .requiredOption("--description <description>", "Task description")
      .requiredOption("--owner <owner>", "Task owner")
      .option("--level <level>", "Task level (N0_INITIATIVE|N1_FEATURE|N2_WORKSTREAM|N3_TASK)")
      .option("--parent-id <id>", "Parent task ID")
      .option("--priority <priority>", "Priority (P0|P1|P2)")
      .option("--eta-target <iso>", "Target completion date (ISO)")
      .option("--execution-target <target>", "Execution target (LOCAL|CLOUD|HYBRID|EXTERNAL)")
      .option("--workstream-type <type>", "Workstream type for N2 tasks")
      .option("--acceptance-criteria-json <json>", "Acceptance criteria JSON array")
      .option("--context-ref <ref...>", "Context reference paths or URLs")
      .option("--context-query <query>", "Context query for hosted retrieval")
      .option("--evidence-required-json <json>", "Evidence required JSON array")
      .option("--is-blocking", "Mark the task blocking for parent closure")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await htaskCreateCommand({
          swarmId: options.swarmId,
          level: options.level,
          title: options.title,
          description: options.description,
          owner: options.owner,
          parentId: options.parentId,
          priority: options.priority,
          etaTarget: options.etaTarget,
          executionTarget: options.executionTarget,
          workstreamType: options.workstreamType,
          acceptanceCriteriaJson: options.acceptanceCriteriaJson,
          contextRefs: options.contextRef,
          contextQuery: options.contextQuery,
          evidenceRequiredJson: options.evidenceRequiredJson,
          isBlocking: options.isBlocking,
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("create-feature")
      .description("Create a hosted N1 feature with optional N2 workstreams")
      .requiredOption("--swarm-id <id>", "Swarm ID")
      .requiredOption("--title <title>", "Feature title")
      .requiredOption("--description <description>", "Feature description")
      .requiredOption("--owner <owner>", "Feature owner")
      .option("--parent-id <id>", "Optional N0 parent ID")
      .option("--workstream <type...>", "Workstream types to create")
      .option("--workstream-owner <TYPE=owner...>", "Per-workstream owner mapping")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await htaskCreateFeatureCommand({
          swarmId: options.swarmId,
          title: options.title,
          description: options.description,
          owner: options.owner,
          parentId: options.parentId,
          workstreams: options.workstream,
          workstreamOwners: options.workstreamOwner,
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("next")
      .description("Get the next recommended hosted N3 htask batch")
      .requiredOption("--swarm-id <id>", "Swarm ID")
      .option("--feature-id <id>", "Optional feature ID")
      .option("--workstream-type <type>", "Optional workstream type filter")
      .option("--limit <n>", "Batch size", (value) => Number.parseInt(value, 10))
      .option("--owner <owner>", "Owner filter")
      .option("--include-blocked", "Include blocked tasks in the recommendation payload")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await htaskNextCommand({
          swarmId: options.swarmId,
          featureId: options.featureId,
          workstreamType: options.workstreamType,
          limit: options.limit,
          owner: options.owner,
          includeBlocked: options.includeBlocked,
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("tree")
      .description("Print the hosted htask tree from a task or all roots")
      .requiredOption("--swarm-id <id>", "Swarm ID")
      .option("--task-id <id>", "Optional root task ID")
      .option("--max-depth <n>", "Maximum depth", (value) => Number.parseInt(value, 10))
      .option("--include-archived", "Include archived tasks")
      .option("--include-completed", "Include completed tasks")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await htaskTreeCommand({
          swarmId: options.swarmId,
          taskId: options.taskId,
          maxDepth: options.maxDepth,
          includeArchived: options.includeArchived,
          includeCompleted: options.includeCompleted,
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("complete")
      .description("Complete a hosted N3 htask with result and evidence")
      .requiredOption("--swarm-id <id>", "Swarm ID")
      .requiredOption("--task-id <id>", "Task ID")
      .option("--evidence-json <json>", "Evidence payload JSON")
      .option("--result-json <json>", "Result payload JSON")
      .option("--learnings-json <json>", "Learnings JSON array")
      .option("--decision-impact-json <json>", "Decision impact JSON payload")
      .option("--create-memory", "Request memory creation from the completion payload")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await htaskCompleteCommand({
          swarmId: options.swarmId,
          taskId: options.taskId,
          evidenceJson: options.evidenceJson,
          resultJson: options.resultJson,
          learningsJson: options.learningsJson,
          decisionImpactJson: options.decisionImpactJson,
          createMemory: options.createMemory,
          json: options.json,
        });
      })
  );

program
  .command("automations")
  .description("Install and inspect dashboard-generated automation hook bundles")
  .addCommand(
    new Command("install")
      .description("Fetch and install the project automation bundle")
      .option(
        "-c, --client <client>",
        "Client type (claude-code|cursor|windsurf|codex|gemini|mistral|chatgpt|vscode|continue|custom)"
      )
      .option("-d, --dir <directory>", "Project directory (default: current)")
      .option("-f, --force", "Overwrite local files even when they differ")
      .option("--dry-run", "Preview writes without changing files")
      .action(async (options) => {
        await automationsInstallCommand({
          client: options.client,
          dir: options.dir,
          force: options.force,
          dryRun: options.dryRun,
        });
      })
  )
  .addCommand(
    new Command("update")
      .description("Refresh installed automation files from the hosted project settings")
      .option("-c, --client <client>", "Override the manifest client")
      .option("-d, --dir <directory>", "Project directory (default: current)")
      .option("-f, --force", "Overwrite local files even when they differ")
      .option("--dry-run", "Preview writes without changing files")
      .action(async (options) => {
        await automationsUpdateCommand({
          client: options.client,
          dir: options.dir,
          force: options.force,
          dryRun: options.dryRun,
        });
      })
  )
  .addCommand(
    new Command("diff")
      .description("Preview generated automation file changes")
      .option("-c, --client <client>", "Override the manifest client")
      .option("-d, --dir <directory>", "Project directory (default: current)")
      .action(async (options) => {
        await automationsDiffCommand({
          client: options.client,
          dir: options.dir,
        });
      })
  )
  .addCommand(
    new Command("status")
      .description("Show local automation manifest drift")
      .option("-d, --dir <directory>", "Project directory (default: current)")
      .action((options) => {
        automationsStatusCommand({ dir: options.dir });
      })
  );

// Pre-tool command (called by Claude Code hooks)
program
  .command("pre-tool")
  .description("Query Snipara for relevant context (PreToolUse hook)")
  .argument("[toolInput]", "Raw tool input (JSON) from hooks")
  .option("-q, --query <query>", "Search query")
  .option("-t, --tool <tool>", "Tool name (Read, Glob, Grep, Edit)")
  .option("-m, --max-tokens <number>", "Maximum tokens", "1200")
  .option("--no-cache", "Bypass cache")
  .option("--stuck-guard-only", "Run guard checks without automatic context retrieval")
  .action(async (toolInput, options) => {
    const resolvedToolInput = toolInput ?? (await readOptionalStdin());
    await preToolCommand({
      query: options.query,
      toolInput: resolvedToolInput,
      tool: options.tool,
      maxTokens: parseInt(options.maxTokens, 10),
      noCache: options.cache === false,
      stuckGuardOnly: Boolean(options.stuckGuardOnly),
    });
  });

// Post-tool command (called by Claude Code hooks)
program
  .command("post-tool")
  .description("Track file access (PostToolUse hook)")
  .argument("[toolInput]", "Raw tool input (JSON) from hooks")
  .option("-f, --file <file>", "File that was accessed")
  .option("--files <files...>", "Multiple files that were accessed")
  .option("-r, --result <result>", "Tool result (optional)")
  .option("-t, --tool <tool>", "Tool name (Read, Grep, Bash, Edit)")
  .option("--exit-code <number>", "Tool process exit code")
  .option("--status <status>", "Tool result status (success|failure|timeout)")
  .option("--pack-result", "Pack exact tool result locally and attach a metadata-only receipt")
  .action(async (toolInput, options) => {
    const resolvedToolInput = toolInput ?? (await readOptionalStdin());
    await postToolCommand({
      ...options,
      toolInput: resolvedToolInput,
      exitCode: typeof options.exitCode === "string" ? parseInt(options.exitCode, 10) : undefined,
      packResult: Boolean(options.packResult),
    });
  });

// Session end command (called on Stop hook)
program
  .command("session-end")
  .description("Persist session context (Stop hook)")
  .action(async () => {
    await sessionEndCommand();
  });

// Session status command
program
  .command("session")
  .description("Session management")
  .addCommand(
    new Command("status").description("Show session status").action(async () => {
      await sessionStatusCommand();
    })
  )
  .addCommand(
    new Command("reset").description("Reset session (start fresh)").action(() => {
      sessionResetCommand();
    })
  );

program
  .command("emit-event")
  .description("Emit a canonical automation event to the Snipara automation API")
  .requiredOption("-e, --event-type <type>", "Canonical event type")
  .option("-c, --client <client>", "Client name", "snipara-companion")
  .option("-w, --workspace <workspace>", "Workspace path")
  .option("-s, --session-id <sessionId>", "Session ID")
  .option("-a, --agent-id <agentId>", "Agent ID", "local-agent")
  .option(
    "-p, --privacy-level <level>",
    "Privacy level (standard|sensitive|restricted)",
    "standard"
  )
  .option("--payload <json>", "JSON payload for the event")
  .option("-d, --dir <directory>", "Workspace directory for local context-pack references")
  .option(
    "--context-pack <id>",
    "Attach a local context-pack receipt; repeatable",
    collectOption,
    []
  )
  .option("--context-pack-operation <operation>", "pack|retrieve|reference", "reference")
  .action(async (options) => {
    await emitEventCommand({
      eventType: options.eventType,
      client: options.client,
      workspace: options.workspace,
      sessionId: options.sessionId,
      agentId: options.agentId,
      privacyLevel: options.privacyLevel,
      payload: options.payload,
      contextPackIds: options.contextPack,
      contextPackOperation: options.contextPackOperation,
      cwd: options.dir,
    });
  });

program
  .command("events")
  .description("Automation event operations")
  .addCommand(
    new Command("recent")
      .description("Fetch recent automation events ingested by the local edge runtime")
      .option("-s, --session-id <sessionId>", "Filter by session id")
      .option("-l, --limit <number>", "Maximum number of events", "20")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await recentEventsCommand({
          sessionId: options.sessionId,
          limit: parseInt(options.limit, 10),
          json: options.json,
        });
      })
  );

program
  .command("stuck-guard")
  .description("Evaluate and inspect Stuck Guard Rescue Pack decisions")
  .addCommand(
    new Command("status")
      .description("Show the current Stuck Guard decision for recent events")
      .option("-s, --session-id <sessionId>", "Filter by session id")
      .option("-l, --limit <number>", "Maximum number of recent events", "50")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await stuckGuardStatusCommand({
          sessionId: options.sessionId,
          limit: parseInt(options.limit, 10),
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("check")
      .description("Evaluate a current tool call/result against Stuck Guard")
      .argument("[toolInput]", "Raw tool input JSON or command text")
      .option("-t, --tool <tool>", "Tool name")
      .option("-q, --query <query>", "Explicit query/task text")
      .option("-r, --result <result>", "Tool result text")
      .option("--exit-code <number>", "Tool process exit code")
      .option("--status <status>", "Tool result status (success|failure|timeout)")
      .option("-s, --session-id <sessionId>", "Session id")
      .option("-l, --limit <number>", "Maximum number of recent events", "50")
      .option("--no-recent", "Evaluate only the supplied event")
      .option("--json", "Print raw JSON")
      .action(async (toolInput, options) => {
        await stuckGuardCheckCommand(toolInput, {
          tool: options.tool,
          query: options.query,
          result: options.result,
          exitCode:
            typeof options.exitCode === "string" ? parseInt(options.exitCode, 10) : undefined,
          status: options.status,
          sessionId: options.sessionId,
          includeRecent: options.recent,
          limit: parseInt(options.limit, 10),
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("simulate")
      .description("Evaluate a fixture file with canonical events")
      .requiredOption("-f, --fixture <file>", "Fixture JSON file")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await stuckGuardSimulateCommand({
          fixture: options.fixture,
          json: options.json,
        });
      })
  );

program
  .command("memory-guard")
  .description(
    "Recall tagged memory and source context before failed retries, commits, and finalization"
  )
  .addCommand(
    new Command("check")
      .description("Check whether memory/context guidance is required before continuing")
      .option("--trigger <trigger>", "failure|pre-commit|commit|pre-final|manual", "manual")
      .option("--file <file>", "Touched file")
      .option("--files <files...>", "Touched files")
      .option("--staged", "Use git staged files")
      .option("--command <command>", "Command or action that failed")
      .option("--intent <intent>", "Proposed user intent or action to check before mutating")
      .option("--result <result>", "Command result preview")
      .option("--exit-code <code>", "Command exit code")
      .option("--status <status>", "Command status")
      .option("--destructive", "Treat the proposed action as destructive or irreversible")
      .option("--require-confirmation", "Require explicit user confirmation before continuing")
      .option(
        "--confirmed-by-user <confirmation>",
        "Explicit user confirmation text that permits a strict destructive/contradictory override"
      )
      .option("--strict", "Exit non-zero if guidance is required but unavailable")
      .option("--category <categories...>", "Additional memory categories to recall")
      .option("--no-context", "Skip source context query")
      .option("--no-recent-failures", "Skip recent Companion event failure inspection")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await memoryGuardCheckCommand({
          trigger: options.trigger,
          files: [
            ...(options.file ? [options.file] : []),
            ...(Array.isArray(options.files) ? options.files : []),
          ],
          staged: Boolean(options.staged),
          command: options.command,
          intent: options.intent,
          result: options.result,
          exitCode:
            options.exitCode !== undefined ? Number.parseInt(options.exitCode, 10) : undefined,
          status: options.status,
          destructive: Boolean(options.destructive),
          requireConfirmation: Boolean(options.requireConfirmation),
          confirmedByUser: options.confirmedByUser,
          strict: Boolean(options.strict),
          categories: options.category,
          includeContext: options.context,
          recentFailures: options.recentFailures,
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("remember")
      .description("Store a project/team memory tagged for a guard phase such as pre-commit")
      .requiredOption("-t, --text <text>", "Memory text")
      .option("--guard-tag <tag>", "Guard tag/category such as pre-commit, commit, failure")
      .option("-c, --category <category>", "Explicit memory category")
      .option("--type <type>", "Memory type", "learning")
      .option("--scope <scope>", "Memory scope", "project")
      .option("--ttl-days <days>", "Optional expiration in days")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await rememberGuardMemoryCommand({
          text: options.text,
          guardTag: options.guardTag,
          category: options.category,
          type: options.type,
          scope: options.scope,
          ttlDays: options.ttlDays !== undefined ? Number.parseInt(options.ttlDays, 10) : undefined,
          json: options.json,
        });
      })
  );

program
  .command("query")
  .description(
    "Search project documents, parsed files, and current truth through hosted Snipara context"
  )
  .requiredOption("-q, --query <query>", "Search query")
  .option("-m, --max-tokens <number>", "Maximum tokens", "8000")
  .option(
    "--follow-recommendation",
    "Automatically execute the recommended structural tool when Snipara returns one"
  )
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await queryCommand({
      query: options.query,
      maxTokens: parseInt(options.maxTokens, 10),
      followRecommendation: Boolean(options.followRecommendation),
      json: options.json,
    });
  });

program
  .command("shared-context")
  .description("Load project-linked shared standards, business playbooks, and reusable guidance")
  .option("-m, --max-tokens <number>", "Maximum tokens", "2000")
  .option(
    "-c, --categories <categories...>",
    "Filter categories (MANDATORY|BEST_PRACTICES|GUIDELINES|REFERENCE)"
  )
  .option("--no-content", "Return document metadata only")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await sharedContextCommand({
      maxTokens: parseInt(options.maxTokens, 10),
      categories: options.categories,
      includeContent: options.content !== false,
      json: options.json,
    });
  });

program
  .command("plan")
  .description("Generate a hosted execution plan through the local companion")
  .requiredOption("-q, --query <query>", "Plan query")
  .option("-m, --max-tokens <number>", "Maximum tokens")
  .option("--write-plan-file <file>", "Write a managed workflow-compatible plan JSON file")
  .option("--start-workflow", "Start a local managed workflow from the generated plan")
  .option("--workflow-id <id>", "Stable managed workflow id when using --start-workflow")
  .option("--force", "Replace an existing active workflow state when starting a workflow")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await planCommand({
      query: options.query,
      maxTokens: options.maxTokens ? parseInt(options.maxTokens, 10) : undefined,
      writePlanFile: options.writePlanFile,
      startWorkflow: Boolean(options.startWorkflow),
      workflowId: options.workflowId,
      force: Boolean(options.force),
      json: options.json,
    });
  });

program
  .command("upload")
  .description("Upload a document to Snipara through the local companion")
  .requiredOption("-p, --path <path>", "Destination path in Snipara")
  .option("-f, --file <file>", "Read content from a local file")
  .option("-c, --content <content>", "Inline content")
  .option("--kind <kind>", "Document kind (DOC|BINARY), inferred from path when omitted")
  .option("--format <format>", "Document format, inferred from extension when omitted")
  .option("--language <language>", "Optional language hint")
  .option("--metadata <json>", "Inline JSON metadata object")
  .option("--metadata-file <file>", "JSON file containing metadata")
  .option("--asset-class <class>", "Convenience metadata.assetClass value")
  .option("--usage-mode <mode>", "Convenience metadata.usageMode value")
  .option("--source-kind <kind>", "Convenience metadata.sourceKind value")
  .option("--client-id <id>", "Convenience metadata.clientId value")
  .option("--source-modified-at <iso>", "Convenience metadata.sourceModifiedAt value")
  .option("--source-snapshot-at <iso>", "Convenience metadata.sourceSnapshotAt value")
  .option("--reindex", "Trigger an incremental document reindex after upload")
  .option("--reindex-kind <kind>", "Reindex kind (doc|code)", "doc")
  .option("--reindex-mode <mode>", "Reindex mode (incremental|full)", "incremental")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await uploadCommand({
      path: options.path,
      file: options.file,
      content: options.content,
      kind: options.kind,
      format: options.format,
      language: options.language,
      metadata: options.metadata,
      metadataFile: options.metadataFile,
      assetClass: options.assetClass,
      usageMode: options.usageMode,
      sourceKind: options.sourceKind,
      clientId: options.clientId,
      sourceModifiedAt: options.sourceModifiedAt,
      sourceSnapshotAt: options.sourceSnapshotAt,
      reindex: Boolean(options.reindex),
      reindexKind: options.reindexKind,
      reindexMode: options.reindexMode,
      json: options.json,
    });
  });

const references = program
  .command("references")
  .description("Scan and ingest external documentation references with provenance");

references
  .command("scan")
  .description("Scan local docs for external URLs and write a Snipara reference manifest")
  .option("-r, --root <dir>", "Project root to scan", process.cwd())
  .option("-o, --output <file>", "Manifest output path", ".snipara/references/manifest.json")
  .option(
    "--allow-domain <domain>",
    "Allow a domain or parent domain for ingestion",
    collectOption,
    []
  )
  .option("--deny-domain <domain>", "Deny a domain or parent domain", collectOption, [])
  .option("--extension <ext>", "File extension to scan; repeatable", collectOption, [])
  .option("--max-files <number>", "Maximum files to scan", (value) => Number.parseInt(value, 10))
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await referencesScanCommand({
      root: options.root,
      output: options.output,
      allowDomain: options.allowDomain,
      denyDomain: options.denyDomain,
      extensions: options.extension,
      maxFiles: options.maxFiles,
      json: options.json,
    });
  });

references
  .command("ingest")
  .description("Fetch allowed external references into source-backed Markdown snapshots")
  .option("-m, --manifest <file>", "Reference manifest path", ".snipara/references/manifest.json")
  .option("-o, --output-dir <dir>", "Local snapshot output directory")
  .option("--allow-domain <domain>", "Allow a domain at ingest time", collectOption, [])
  .option("--id <id>", "Manifest item ID to ingest; repeatable", collectOption, [])
  .option("--max <number>", "Maximum references to ingest", (value) => Number.parseInt(value, 10))
  .option("--timeout-ms <number>", "Fetch timeout per URL", (value) => Number.parseInt(value, 10))
  .option("--max-bytes <number>", "Maximum response body bytes", (value) =>
    Number.parseInt(value, 10)
  )
  .option("--destination-prefix <path>", "Destination prefix when uploading", "external-references")
  .option("--upload", "Upload snapshots to Snipara through hosted MCP")
  .option("--reindex", "Trigger an incremental document reindex after upload")
  .option(
    "--dry-run",
    "Show selected references without fetching, writing, uploading, or updating manifest"
  )
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await referencesIngestCommand({
      manifest: options.manifest,
      outputDir: options.outputDir,
      allowDomain: options.allowDomain,
      ids: options.id,
      max: options.max,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      destinationPrefix: options.destinationPrefix,
      upload: Boolean(options.upload),
      reindex: Boolean(options.reindex),
      dryRun: Boolean(options.dryRun),
      json: options.json,
    });
  });

const businessCollections = program
  .command("business-collections")
  .description("Manage Team Business Context collections through hosted MCP");

businessCollections
  .command("list")
  .description("List Team Business Context collections")
  .option("--include-custom", "Include custom business-looking collections")
  .option("--no-missing-presets", "Do not print missing preset definitions")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await businessCollectionsListCommand({
      includeCustom: Boolean(options.includeCustom),
      noMissingPresets: options.missingPresets === false,
      json: options.json,
    });
  });

businessCollections
  .command("ensure")
  .description("Create or return a Team Business Context collection")
  .option(
    "--preset <preset>",
    "Preset: business_response_playbook|business_library|offer_templates|company_presentations|reference_diagrams"
  )
  .option("--name <name>", "Custom collection name")
  .option("--slug <slug>", "Custom collection slug")
  .option("--description <description>", "Collection description")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await businessCollectionEnsureCommand({
      preset: options.preset,
      name: options.name,
      slug: options.slug,
      description: options.description,
      json: options.json,
    });
  });

businessCollections
  .command("upload")
  .description("Upload a reusable document to Team Business Context")
  .requiredOption("--title <title>", "Document title")
  .option("--collection-id <id>", "Business collection ID")
  .option(
    "--preset <preset>",
    "Preset: business_response_playbook|business_library|offer_templates|company_presentations|reference_diagrams"
  )
  .option("--collection-slug <slug>", "Business collection slug")
  .option("-f, --file <file>", "Read content from a local markdown/text file")
  .option("-c, --content <content>", "Inline content")
  .option(
    "--category <category>",
    "Shared context category (MANDATORY|BEST_PRACTICES|GUIDELINES|REFERENCE)"
  )
  .option("--tags <tags>", "Comma-separated tags")
  .option("--priority <number>", "Priority within category")
  .option("--allow-custom-collection", "Allow upload to non-preset custom business collection")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await businessCollectionUploadCommand({
      collectionId: options.collectionId,
      preset: options.preset,
      collectionSlug: options.collectionSlug,
      title: options.title,
      file: options.file,
      content: options.content,
      category: options.category,
      tags: options.tags,
      priority: options.priority ? parseInt(options.priority, 10) : undefined,
      allowCustomCollection: Boolean(options.allowCustomCollection),
      json: options.json,
    });
  });

const clientProjects = program
  .command("client-projects")
  .description("Manage client/project business-context workspaces through hosted MCP");

clientProjects
  .command("list")
  .description("List client/project business-context workspaces")
  .option("--include-internal", "Include internal, research, and code projects")
  .option("--limit <number>", "Maximum projects to return")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await clientProjectsListCommand({
      includeInternal: Boolean(options.includeInternal),
      limit: options.limit ? parseInt(options.limit, 10) : undefined,
      json: options.json,
    });
  });

clientProjects
  .command("create")
  .description("Create a client/project business-context workspace")
  .requiredOption("--name <name>", "Client/project display name")
  .option("--slug <slug>", "Stable project slug")
  .option("--description <description>", "Project description")
  .option("--external-client-id <id>", "External client identifier for integrator workflows")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await clientProjectCreateCommand({
      name: options.name,
      slug: options.slug,
      description: options.description,
      externalClientId: options.externalClientId,
      json: options.json,
    });
  });

program
  .command("onboard-folder")
  .description(
    "Business-first onboarding for a local or LLM-materialized folder with preview/apply sync"
  )
  .argument("[dir]", "Folder to onboard", ".")
  .option("-p, --prefix <prefix>", "Destination path prefix in Snipara")
  .option(
    "-m, --mode <mode>",
    "Override detection: auto|business_context|code_project|mixed",
    "auto"
  )
  .option("--usage-mode <mode>", "Business usage mode", "current_truth")
  .option("--source-kind <kind>", "metadata.sourceKind", "local_agent")
  .option(
    "--source-provider <provider>",
    "metadata.sourceProvider, e.g. local_folder, chatgpt_drive, claude_notion",
    "local_folder"
  )
  .option("--source-uri <uri>", "Optional source URI/provenance, never inferred automatically")
  .option("--client-id <id>", "Optional metadata.clientId")
  .option("--snapshot-at <iso>", "Override metadata.sourceSnapshotAt")
  .option("--no-recursive", "Only scan top-level files")
  .option("--delete-missing", "Delete remote documents missing from this sync set when applying")
  .option("--apply", "Upload the generated manifest through hosted MCP")
  .option("--no-reindex", "Do not trigger document reindex after apply")
  .option("--reindex-kind <kind>", "Reindex kind (doc|code)", "doc")
  .option("--reindex-mode <mode>", "Reindex mode (incremental|full)", "incremental")
  .option("--write-manifest <file>", "Write a sync-documents compatible JSON manifest")
  .option("--json", "Print raw JSON")
  .action(async (dir, options) => {
    await onboardFolderCommand({
      dir,
      prefix: options.prefix,
      mode: options.mode,
      usageMode: options.usageMode,
      sourceKind: options.sourceKind,
      sourceProvider: options.sourceProvider,
      sourceUri: options.sourceUri,
      clientId: options.clientId,
      snapshotAt: options.snapshotAt,
      recursive: options.recursive !== false,
      deleteMissing: options.deleteMissing === true,
      apply: Boolean(options.apply),
      reindex: options.reindex !== false,
      reindexKind: options.reindexKind,
      reindexMode: options.reindexMode,
      writeManifest: options.writeManifest,
      json: options.json,
    });
  });

program
  .command("sync-documents")
  .description("Bulk sync text and supported binary parser documents to Snipara through hosted MCP")
  .option("-f, --file <file>", "JSON file containing [{ path, content }] or { documents }")
  .option(
    "-d, --dir <dir>",
    "Directory containing .md, .markdown, .mdx, .txt, .rst, .adoc, .pdf, .docx, .pptx, .svg, or .vsdx files"
  )
  .option("-r, --recursive", "Recursively scan --dir")
  .option("-p, --prefix <prefix>", "Destination path prefix when syncing a directory")
  .option("--delete-missing", "Delete remote documents missing from this sync set")
  .option("--dry-run", "Validate the sync payload locally without uploading")
  .option("--reindex", "Trigger an incremental document reindex after sync")
  .option("--reindex-kind <kind>", "Reindex kind (doc|code)")
  .option("--reindex-mode <mode>", "Reindex mode (incremental|full)")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await syncDocumentsCommand({
      file: options.file,
      dir: options.dir,
      recursive: Boolean(options.recursive),
      prefix: options.prefix,
      deleteMissing: options.deleteMissing === true ? true : undefined,
      dryRun: options.dryRun === true ? true : undefined,
      reindex: options.reindex === true ? true : undefined,
      reindexKind: options.reindexKind,
      reindexMode: options.reindexMode,
      json: options.json,
    });
  });

program
  .command("reindex")
  .description("Trigger or poll a Snipara background reindex job")
  .option("-k, --kind <kind>", "Index kind (doc|code)", "doc")
  .option("-m, --mode <mode>", "Index mode (incremental|full)", "incremental")
  .option("-j, --job-id <jobId>", "Poll an existing reindex job instead of creating one")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await reindexCommand({
      kind: options.kind,
      mode: options.mode,
      jobId: options.jobId,
      json: options.json,
    });
  });

program
  .command("business-health")
  .description("Inspect business-context index health and freshness signals")
  .option("--stale-threshold-days <number>", "Days after which content is considered stale")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await businessHealthCommand({
      staleThresholdDays:
        options.staleThresholdDays !== undefined
          ? parseInt(options.staleThresholdDays, 10)
          : undefined,
      json: options.json,
    });
  });

program
  .command("chunk")
  .description("Chunk operations")
  .addCommand(
    new Command("get")
      .description("Fetch a chunk by id")
      .requiredOption("-i, --chunk-id <chunkId>", "Chunk id")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await chunkGetCommand({
          chunkId: options.chunkId,
          json: options.json,
        });
      })
  );

program
  .command("multi-query")
  .description("Run multiple hosted queries through the local companion")
  .requiredOption("-q, --queries <queries...>", "Queries to run")
  .option("-m, --max-tokens <number>", "Shared token budget")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await multiQueryCommand({
      queries: options.queries,
      maxTokens: options.maxTokens ? parseInt(options.maxTokens, 10) : undefined,
      json: options.json,
    });
  });

program
  .command("orchestrate")
  .description("Run a multi-step hosted exploration through the local companion")
  .requiredOption("-q, --query <query>", "Exploration query")
  .option("-m, --max-tokens <number>", "Maximum tokens")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await orchestrateCommand({
      query: options.query,
      maxTokens: options.maxTokens ? parseInt(options.maxTokens, 10) : undefined,
      json: options.json,
    });
  });

program
  .command("brief")
  .description("Build a Project Intelligence continuity brief for the current task")
  .option("--task <task>", "Current task or change summary")
  .option("--branch <branch>", "Branch to scope continuity signals")
  .option("--changed-files <changedFiles...>", "Changed files to analyze")
  .option("--recent-files <recentFiles...>", "Recently touched files for continuity lookup")
  .option("--diff-summary <diffSummary>", "Natural-language summary for code impact")
  .option("--max-tokens <number>", "Resume context token budget", "4000")
  .option("--skip-impact", "Do not run companion code impact")
  .option("--skip-memory-health", "Do not call snipara_memory_health")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await projectIntelligenceBriefCommand({
      task: options.task,
      branch: options.branch,
      changedFiles: options.changedFiles,
      recentFiles: options.recentFiles,
      diffSummary: options.diffSummary,
      maxTokens: parseInt(options.maxTokens, 10),
      skipImpact: Boolean(options.skipImpact),
      skipMemoryHealth: Boolean(options.skipMemoryHealth),
      json: Boolean(options.json),
    });
  });

const intelligence = program
  .command("intelligence")
  .description(
    "Compose Project Intelligence briefs from continuity, memory health, and code impact"
  );

intelligence
  .command("brief")
  .description("Build a Project Intelligence continuity brief for the current task")
  .option("--task <task>", "Current task or change summary")
  .option("--branch <branch>", "Branch to scope continuity signals")
  .option("--changed-files <changedFiles...>", "Changed files to analyze")
  .option("--recent-files <recentFiles...>", "Recently touched files for continuity lookup")
  .option("--diff-summary <diffSummary>", "Natural-language summary for code impact")
  .option("--max-tokens <number>", "Resume context token budget", "4000")
  .option("--skip-impact", "Do not run companion code impact")
  .option("--skip-memory-health", "Do not call snipara_memory_health")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await projectIntelligenceBriefCommand({
      task: options.task,
      branch: options.branch,
      changedFiles: options.changedFiles,
      recentFiles: options.recentFiles,
      diffSummary: options.diffSummary,
      maxTokens: parseInt(options.maxTokens, 10),
      skipImpact: Boolean(options.skipImpact),
      skipMemoryHealth: Boolean(options.skipMemoryHealth),
      json: Boolean(options.json),
    });
  });

const workflow = program
  .command("workflow")
  .description("Workflow presets and compaction-safe phase tracking");

workflow
  .command("scaffold")
  .description("Generate a reusable managed workflow plan file from a built-in preset")
  .requiredOption("--preset <preset>", `Preset id (${WORKFLOW_PLAN_PRESET_IDS.join("|")})`)
  .option("-g, --goal <goal>", "Override the scaffolded workflow goal")
  .option("-o, --output <file>", "Write the scaffolded plan to this file")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await workflowScaffoldCommand({
      preset: options.preset,
      goal: options.goal,
      output: options.output,
      json: options.json,
    });
  });

workflow
  .command("start")
  .description(
    "Create a local Snipara workflow state from a visible LLM plan (prefer JSON for stable phase ids)"
  )
  .option("-g, --goal <goal>", "Workflow goal")
  .option(
    "--plan-file <file>",
    "LLM plan file; prefer JSON for stable phase ids, Markdown/Text also accepted"
  )
  .option("--id <id>", "Stable workflow id")
  .option("--force", "Replace an existing active workflow state")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await workflowStartCommand({
      goal: options.goal,
      planFile: options.planFile,
      id: options.id,
      force: Boolean(options.force),
      json: options.json,
    });
  });

workflow
  .command("status")
  .description("Show the current local Snipara workflow state")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await workflowStatusCommand({ json: options.json });
  });

workflow
  .command("impact-gate")
  .description("Audit committed local workflow phases that have not been pushed yet")
  .option("--base <ref>", "Base ref to compare against (default: upstream branch)")
  .option("--max-files <number>", "Maximum supported code files to inspect", "2000")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await workflowImpactGateCommand({
      base: options.base,
      maxFiles: parseInt(options.maxFiles, 10),
      json: options.json,
    });
  });

workflow
  .command("resume")
  .description(
    "Restore managed workflow state plus hosted memory after compaction or resume, including guided Sandbox reattach or rehydrate steps when a runtime checkpoint exists"
  )
  .option("--max-critical-tokens <number>", "Durable memory token budget")
  .option("--max-context-tokens <number>", "Short-lived session context token budget")
  .option("--include-session-context", "Include short-lived session carryover")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await workflowResumeCommand({
      maxCriticalTokens:
        options.maxCriticalTokens !== undefined
          ? parseInt(options.maxCriticalTokens, 10)
          : undefined,
      maxContextTokens:
        options.maxContextTokens !== undefined ? parseInt(options.maxContextTokens, 10) : undefined,
      includeSessionContext: Boolean(options.includeSessionContext),
      json: options.json,
    });
  });

workflow
  .command("phase-start")
  .description("Mark a workflow phase active and print the required Snipara context gate")
  .argument("<phaseId>", "Workflow phase id")
  .option("--json", "Print raw JSON")
  .action(async (phaseId, options) => {
    await workflowPhaseStartCommand({ phaseId, json: options.json });
  });

workflow
  .command("runtime-checkpoint")
  .description(
    "Capture a Snipara Sandbox resume checkpoint for the active workflow phase using local state plus an automation event when configured"
  )
  .argument("<phaseId>", "Workflow phase id")
  .requiredOption("-s, --summary <summary>", "Runtime checkpoint summary")
  .option("--environment <environment>", "Sandbox environment label, for example local or docker")
  .option("--profile <profile>", "Sandbox profile label, for example default or analysis")
  .option("-f, --files <files...>", "Files tracked by this runtime checkpoint")
  .option(
    "--commands <commands...>",
    "Commands or deterministic checks represented by this checkpoint"
  )
  .option("--artifacts <files...>", "Artifacts needed for resume or verification")
  .option(
    "--context-pack <id>",
    "Attach a local context-pack receipt; repeatable",
    collectOption,
    []
  )
  .option("--bootstrap-query <query>", "Query to reuse with snipara_repl_context during rehydrate")
  .option("--sandbox-session-id <sessionId>", "Override the bound Snipara Sandbox session id")
  .option("--rehydrate-json <json>", "Compact JSON-serializable state to restore during rehydrate")
  .option("--rehydrate-file <file>", "JSON file containing compact rehydratable state")
  .option("--json", "Print raw JSON")
  .action(async (phaseId, options) => {
    await workflowRuntimeCheckpointCommand({
      phaseId,
      summary: options.summary,
      environment: options.environment,
      profile: options.profile,
      files: options.files,
      commands: options.commands,
      artifacts: options.artifacts,
      contextPackIds: options.contextPack,
      bootstrapQuery: options.bootstrapQuery,
      sandboxSessionId: options.sandboxSessionId,
      rehydrateJson: options.rehydrateJson,
      rehydrateFile: options.rehydrateFile,
      json: options.json,
    });
  });

workflow
  .command("phase-commit")
  .description(
    "Persist a phase outcome through snipara_end_of_task_commit and advance the workflow"
  )
  .argument("<phaseId>", "Workflow phase id")
  .requiredOption("-s, --summary <summary>", "Phase outcome summary")
  .option("-c, --category <category>", "Memory category", "workflow-phase")
  .option("-o, --outcome <outcome>", "completed|partial|blocked|abandoned", "completed")
  .option("-f, --files <files...>", "Files touched")
  .option("--json", "Print raw JSON")
  .action(async (phaseId, options) => {
    await workflowPhaseCommitCommand({
      phaseId,
      summary: options.summary,
      category: options.category,
      outcome: options.outcome,
      files: options.files,
      json: options.json,
    });
  });

workflow
  .command("final-commit")
  .description("Persist the final workflow outcome and close the local workflow state")
  .requiredOption("-s, --summary <summary>", "Final outcome summary")
  .option("-c, --category <category>", "Memory category", "final-commit")
  .option("-o, --outcome <outcome>", "completed|partial|blocked|abandoned", "completed")
  .option("-f, --files <files...>", "Files touched")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await finalCommitCommand({
      summary: options.summary,
      category: options.category,
      outcome: options.outcome,
      files: options.files,
      json: options.json,
    });
  });

workflow
  .command("run")
  .description("Run a LITE/STANDARD/FULL/orchestrate workflow preset")
  .requiredOption("-q, --query <query>", "Workflow query")
  .option("-M, --mode <mode>", "lite|standard|auto|full|orchestrate", "standard")
  .option(
    "-m, --max-tokens <number>",
    "Maximum tokens; FULL mode splits this across workflow surfaces",
    "8000"
  )
  .option("--include-session-context", "Include short-lived session carryover for FULL workflow")
  .option("--max-critical-tokens <number>", "Durable memory token budget for FULL workflow")
  .option("--max-context-tokens <number>", "Short-lived session context token budget")
  .option("--no-runtime-hint", "Hide Snipara Sandbox and Orchestrator suggestions")
  .option(
    "--emit-orchestrator-handoff",
    "Write .snipara/orchestrator/handoff.json when orchestrator routing is recommended"
  )
  .option(
    "--auto-route-orchestrator",
    "Mark this workflow for orchestrator handling by policy and emit the handoff automatically"
  )
  .option(
    "--orchestrator-policy-source <source>",
    "Label the workspace or tenant policy that triggered orchestrator routing"
  )
  .option(
    "--adaptive-routing-dry-run",
    "Attach Adaptive Work Routing recommendation metadata without launching workers"
  )
  .option(
    "--route-local-workers",
    "Prefer local worker endpoints and keep deep reasoning on the planner"
  )
  .option("--routing-worker-role <role>", "Suggested worker role for Adaptive Work Routing")
  .option(
    "--routing-preferred-endpoint <type>",
    "Preferred worker endpoint type for runtime catalog resolution; repeatable",
    collectOption,
    []
  )
  .option(
    "--routing-allowed-endpoint <type>",
    "Allowed worker endpoint type for runtime catalog resolution; repeatable",
    collectOption,
    []
  )
  .option(
    "--planner-retains-reasoning",
    "Mark the main planner as retaining deep reasoning while the worker executes scoped work"
  )
  .option("--write-plan-file <file>", "Write the generated FULL-mode plan as workflow JSON")
  .option(
    "--start-workflow-from-plan",
    "Start a local managed workflow from the generated FULL-mode plan"
  )
  .option("--workflow-id <id>", "Stable managed workflow id when using --start-workflow-from-plan")
  .option("--force", "Replace an existing active workflow state when starting from generated plan")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await workflowRunCommand({
      query: options.query,
      mode: options.mode,
      maxTokens: parseInt(options.maxTokens, 10),
      includeSessionContext: Boolean(options.includeSessionContext),
      maxCriticalTokens:
        options.maxCriticalTokens !== undefined
          ? parseInt(options.maxCriticalTokens, 10)
          : undefined,
      maxContextTokens:
        options.maxContextTokens !== undefined ? parseInt(options.maxContextTokens, 10) : undefined,
      runtimeHint: options.runtimeHint !== false,
      emitOrchestratorHandoff: Boolean(options.emitOrchestratorHandoff),
      autoRouteOrchestrator: Boolean(options.autoRouteOrchestrator),
      orchestratorPolicySource: options.orchestratorPolicySource,
      adaptiveRoutingDryRun: Boolean(options.adaptiveRoutingDryRun),
      routeLocalWorkers: Boolean(options.routeLocalWorkers),
      routingWorkerRole: options.routingWorkerRole,
      routingPreferredEndpoints: options.routingPreferredEndpoint,
      routingAllowedEndpoints: options.routingAllowedEndpoint,
      plannerRetainsReasoning: options.plannerRetainsReasoning ? true : undefined,
      writePlanFile: options.writePlanFile,
      startWorkflowFromPlan: Boolean(options.startWorkflowFromPlan),
      workflowId: options.workflowId,
      force: Boolean(options.force),
      json: options.json,
    });
  });

const teamSync = program
  .command("team-sync")
  .description(
    "Record local repo state and fetch hosted Team Sync continuity context when configured"
  );

teamSync
  .command("start-work")
  .description(
    "Record the work you are starting and fetch the hosted Start Work Brief when available"
  )
  .requiredOption("-s, --summary <summary>", "Short work intent")
  .option("-f, --files <files...>", "Files expected to change")
  .option("-b, --branch <branch>", "Current branch name")
  .option("-a, --actor <actor>", "Developer or agent name")
  .option("-d, --dir <directory>", "Repository directory (default: current)")
  .option(
    "--emit-orchestrator-handoff",
    "Write .snipara/orchestrator/handoff.json for the current Team Sync state"
  )
  .option(
    "--auto-route-orchestrator",
    "Mark this Team Sync command for orchestrator handling by policy and emit the handoff automatically"
  )
  .option(
    "--orchestrator-policy-source <source>",
    "Label the workspace or tenant policy that triggered orchestrator routing"
  )
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await teamSyncStartWorkCommand({
      summary: options.summary,
      files: options.files,
      branch: options.branch,
      actor: options.actor,
      dir: options.dir,
      emitOrchestratorHandoff: Boolean(options.emitOrchestratorHandoff),
      autoRouteOrchestrator: Boolean(options.autoRouteOrchestrator),
      orchestratorPolicySource: options.orchestratorPolicySource,
      json: options.json,
    });
  });

teamSync
  .command("handoff")
  .description("Record a local handoff and publish the hosted handoff capsule when available")
  .requiredOption("-s, --summary <summary>", "What changed or what matters")
  .option("-n, --next <next>", "Recommended next action")
  .option("-f, --files <files...>", "Relevant files")
  .option("--attention <level>", "note|watch|review|proof")
  .option("-r, --risk <risk>", "Legacy alias for --attention")
  .option("-a, --actor <actor>", "Developer or agent name")
  .option("-d, --dir <directory>", "Repository directory (default: current)")
  .option(
    "--emit-orchestrator-handoff",
    "Write .snipara/orchestrator/handoff.json for the current Team Sync state"
  )
  .option(
    "--auto-route-orchestrator",
    "Mark this Team Sync command for orchestrator handling by policy and emit the handoff automatically"
  )
  .option(
    "--orchestrator-policy-source <source>",
    "Label the workspace or tenant policy that triggered orchestrator routing"
  )
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await teamSyncHandoffCommand({
      summary: options.summary,
      next: options.next,
      files: options.files,
      attention: options.attention,
      risk: options.risk,
      actor: options.actor,
      dir: options.dir,
      emitOrchestratorHandoff: Boolean(options.emitOrchestratorHandoff),
      autoRouteOrchestrator: Boolean(options.autoRouteOrchestrator),
      orchestratorPolicySource: options.orchestratorPolicySource,
      json: options.json,
    });
  });

teamSync
  .command("complete-work")
  .description("Close a local Team Sync work item once it is no longer active")
  .option("--id <id>", "Specific work item id to complete (default: latest active or stale item)")
  .option("-n, --next <next>", "Optional completion note or follow-up")
  .option("-d, --dir <directory>", "Repository directory (default: current)")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await teamSyncCompleteWorkCommand({
      id: options.id,
      next: options.next,
      dir: options.dir,
      json: options.json,
    });
  });

teamSync
  .command("sweep")
  .description("Archive stale local Team Sync work items after an inactivity threshold")
  .option("--days <days>", "Archive active work with no update after this many days", "14")
  .option("--dry-run", "Preview which work items would be archived")
  .option("-d, --dir <directory>", "Repository directory (default: current)")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await teamSyncSweepCommand({
      days: options.days,
      dryRun: Boolean(options.dryRun),
      dir: options.dir,
      json: options.json,
    });
  });

teamSync
  .command("what-changed")
  .description(
    "Summarize local Team Sync state and fetch hosted What Changed For Me when available"
  )
  .option("--since <date>", "Only include records created after this ISO date")
  .option("-d, --dir <directory>", "Repository directory (default: current)")
  .option(
    "--include-session-context",
    "Compatibility alias; hosted Team Sync still uses workflow resume for short-lived session carryover"
  )
  .option(
    "--emit-orchestrator-handoff",
    "Write .snipara/orchestrator/handoff.json for the current Team Sync state"
  )
  .option(
    "--auto-route-orchestrator",
    "Mark this Team Sync command for orchestrator handling by policy and emit the handoff automatically"
  )
  .option(
    "--orchestrator-policy-source <source>",
    "Label the workspace or tenant policy that triggered orchestrator routing"
  )
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await teamSyncWhatChangedCommand({
      since: options.since,
      dir: options.dir,
      includeSessionContext: Boolean(options.includeSessionContext),
      emitOrchestratorHandoff: Boolean(options.emitOrchestratorHandoff),
      autoRouteOrchestrator: Boolean(options.autoRouteOrchestrator),
      orchestratorPolicySource: options.orchestratorPolicySource,
      json: options.json,
    });
  });

teamSync
  .command("resume")
  .description("Show local carryover plus hosted Team Sync resume context when available")
  .option("-d, --dir <directory>", "Repository directory (default: current)")
  .option(
    "--include-session-context",
    "Compatibility alias; hosted Team Sync still uses workflow resume for short-lived session carryover"
  )
  .option(
    "--emit-orchestrator-handoff",
    "Write .snipara/orchestrator/handoff.json for the current Team Sync state"
  )
  .option(
    "--auto-route-orchestrator",
    "Mark this Team Sync command for orchestrator handling by policy and emit the handoff automatically"
  )
  .option(
    "--orchestrator-policy-source <source>",
    "Label the workspace or tenant policy that triggered orchestrator routing"
  )
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await teamSyncResumeCommand({
      dir: options.dir,
      includeSessionContext: Boolean(options.includeSessionContext),
      emitOrchestratorHandoff: Boolean(options.emitOrchestratorHandoff),
      autoRouteOrchestrator: Boolean(options.autoRouteOrchestrator),
      orchestratorPolicySource: options.orchestratorPolicySource,
      json: options.json,
    });
  });

const collaboration = program
  .command("collaboration")
  .alias("collab")
  .description("Publish safe parallel-coding presence, claims, locks, and guard checks");

collaboration
  .command("start")
  .description("Start or heartbeat a collaboration work session for this repo")
  .option("-s, --summary <summary>", "Short work intent")
  .option("-f, --files <files...>", "Files expected to change (defaults to dirty git files)")
  .option("-r, --resource <resources...>", "Explicit resources in KIND:id format")
  .option("--actor <actor>", "Developer or agent display name")
  .option("--actor-id <actorId>", "Stable developer or agent id")
  .option("--actor-type <actorType>", "HUMAN|AGENT|SYSTEM", "AGENT")
  .option("--session-id <sessionId>", "Automation/session id")
  .option("--work-session-id <workSessionId>", "Existing hosted work session id")
  .option("--swarm-id <swarmId>", "Optional swarm id")
  .option("--client <client>", "Client label", "snipara-companion")
  .option("--repository <repository>", "Repository id")
  .option("-b, --branch <branch>", "Current branch name")
  .option("--worktree <worktree>", "Worktree path")
  .option("--heartbeat-ttl-seconds <seconds>", "Heartbeat TTL in seconds")
  .option("-d, --dir <directory>", "Repository directory (default: current)")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await collaborationStartCommand({
      summary: options.summary,
      files: options.files,
      resources: options.resource,
      actor: options.actor,
      actorId: options.actorId,
      actorType: options.actorType,
      sessionId: options.sessionId,
      workSessionId: options.workSessionId,
      swarmId: options.swarmId,
      client: options.client,
      repository: options.repository,
      branch: options.branch,
      worktree: options.worktree,
      heartbeatTtlSeconds: options.heartbeatTtlSeconds,
      dir: options.dir,
      json: options.json,
    });
  });

collaboration
  .command("watch")
  .description("Continuously publish presence, heartbeat active leases, and auto-claim dirty files")
  .option("-s, --summary <summary>", "Short work intent")
  .option("-f, --files <files...>", "Files expected to change (defaults to dirty git files)")
  .option("-r, --resource <resources...>", "Explicit resources in KIND:id format")
  .option("-m, --mode <mode>", "WATCH|ADVISORY|REQUIRES_ACK|EXCLUSIVE|HARD_BLOCK", "WATCH")
  .option("--reason <reason>", "Claim reason")
  .option("--ttl-seconds <seconds>", "Lease TTL in seconds")
  .option("--heartbeat-ttl-seconds <seconds>", "Session heartbeat TTL in seconds")
  .option("--interval-seconds <seconds>", "Polling interval", "15")
  .option("--max-files <number>", "Maximum files for local code resource expansion", "2000")
  .option("--once", "Run one watch tick and exit")
  .option("--no-auto-claim", "Publish presence without creating or heartbeating leases")
  .option("--no-release-stale", "Keep local active leases even when files are no longer dirty")
  .option("--actor <actor>", "Developer or agent display name")
  .option("--actor-id <actorId>", "Stable developer or agent id")
  .option("--actor-type <actorType>", "HUMAN|AGENT|SYSTEM", "AGENT")
  .option("--session-id <sessionId>", "Automation/session id")
  .option("--work-session-id <workSessionId>", "Existing hosted work session id")
  .option("--swarm-id <swarmId>", "Optional swarm id")
  .option("--client <client>", "Client label", "snipara-companion")
  .option("--repository <repository>", "Repository id")
  .option("-b, --branch <branch>", "Current branch name")
  .option("--worktree <worktree>", "Worktree path")
  .option("-d, --dir <directory>", "Repository directory (default: current)")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await collaborationWatchCommand({
      summary: options.summary,
      files: options.files,
      resources: options.resource,
      mode: options.mode,
      reason: options.reason,
      ttlSeconds: options.ttlSeconds,
      heartbeatTtlSeconds: options.heartbeatTtlSeconds,
      intervalSeconds: options.intervalSeconds,
      maxFiles: options.maxFiles,
      once: Boolean(options.once),
      autoClaim: options.autoClaim !== false,
      releaseStale: options.releaseStale !== false,
      actor: options.actor,
      actorId: options.actorId,
      actorType: options.actorType,
      sessionId: options.sessionId,
      workSessionId: options.workSessionId,
      swarmId: options.swarmId,
      client: options.client,
      repository: options.repository,
      branch: options.branch,
      worktree: options.worktree,
      dir: options.dir,
      json: options.json,
    });
  });

collaboration
  .command("claim")
  .description("Claim or lock resources so other humans and agents can see overlap")
  .option("-f, --files <files...>", "Files to claim")
  .option("-r, --resource <resources...>", "Explicit resources in KIND:id format")
  .option("-m, --mode <mode>", "WATCH|ADVISORY|REQUIRES_ACK|EXCLUSIVE|HARD_BLOCK", "ADVISORY")
  .option("--reason <reason>", "Why the resource is claimed")
  .option("--ttl-seconds <seconds>", "Lease TTL in seconds")
  .option("--actor <actor>", "Developer or agent display name")
  .option("--actor-id <actorId>", "Stable developer or agent id")
  .option("--actor-type <actorType>", "HUMAN|AGENT|SYSTEM", "AGENT")
  .option("--session-id <sessionId>", "Automation/session id")
  .option("--work-session-id <workSessionId>", "Existing hosted work session id")
  .option("--swarm-id <swarmId>", "Optional swarm id")
  .option("--client <client>", "Client label", "snipara-companion")
  .option("--repository <repository>", "Repository id")
  .option("-b, --branch <branch>", "Current branch name")
  .option("--worktree <worktree>", "Worktree path")
  .option("-d, --dir <directory>", "Repository directory (default: current)")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await collaborationClaimCommand({
      files: options.files,
      resources: options.resource,
      mode: options.mode,
      reason: options.reason,
      ttlSeconds: options.ttlSeconds,
      actor: options.actor,
      actorId: options.actorId,
      actorType: options.actorType,
      sessionId: options.sessionId,
      workSessionId: options.workSessionId,
      swarmId: options.swarmId,
      client: options.client,
      repository: options.repository,
      branch: options.branch,
      worktree: options.worktree,
      dir: options.dir,
      json: options.json,
    });
  });

collaboration
  .command("guard")
  .description("Check files or resources against active collaboration sessions and locks")
  .option("-f, --files <files...>", "Files to guard (defaults to dirty git files)")
  .option("-r, --resource <resources...>", "Explicit resources in KIND:id format")
  .option(
    "--profile <profile>",
    "edit|pre-commit|pre-push|pre-deploy|migration|schema|release-package",
    "edit"
  )
  .option("-a, --action <action>", "Guarded action label", "edit")
  .option("--actor <actor>", "Developer or agent display name")
  .option("--actor-id <actorId>", "Stable developer or agent id")
  .option("--actor-type <actorType>", "HUMAN|AGENT|SYSTEM", "AGENT")
  .option("--session-id <sessionId>", "Automation/session id")
  .option("--work-session-id <workSessionId>", "Existing hosted work session id")
  .option("--client <client>", "Client label", "snipara-companion")
  .option("--repository <repository>", "Repository id")
  .option("-b, --branch <branch>", "Current branch name")
  .option("--worktree <worktree>", "Worktree path")
  .option("--max-files <number>", "Maximum files for local code resource expansion", "2000")
  .option("--no-persist", "Evaluate without storing a guard event")
  .option("--enforce", "Exit non-zero for REVIEW_REQUIRED or REQUIRES_ACK, not only BLOCKED")
  .option(
    "--ack-review-only",
    "Under --enforce, acknowledge review-only stale-state and decision-consistency warnings"
  )
  .option("-d, --dir <directory>", "Repository directory (default: current)")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await collaborationGuardCommand({
      files: options.files,
      resources: options.resource,
      profile: options.profile,
      action: options.action,
      actor: options.actor,
      actorId: options.actorId,
      actorType: options.actorType,
      sessionId: options.sessionId,
      workSessionId: options.workSessionId,
      client: options.client,
      repository: options.repository,
      branch: options.branch,
      worktree: options.worktree,
      maxFiles: options.maxFiles,
      persist: options.persist,
      enforce: Boolean(options.enforce),
      ackReviewOnly: Boolean(options.ackReviewOnly),
      dir: options.dir,
      json: options.json,
    });
  });

collaboration
  .command("hooks")
  .description("Install blocking Git hooks that run the hosted collaboration guard")
  .addCommand(
    new Command("install")
      .description("Install managed pre-commit and pre-push collaboration guard hooks")
      .option("-d, --dir <directory>", "Repository directory (default: current)")
      .option("--dry-run", "Preview hook writes without changing files")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await collaborationHooksInstallCommand({
          dir: options.dir,
          dryRun: Boolean(options.dryRun),
          json: Boolean(options.json),
        });
      })
  );

collaboration
  .command("release")
  .description("Release a collaboration lease")
  .option("--lease-id <leaseId>", "Lease id to release (defaults to latest active local lease)")
  .option("--all", "Release all active local leases")
  .option("--reason <reason>", "Release reason")
  .option("--actor <actor>", "Developer or agent display name")
  .option("--actor-id <actorId>", "Stable developer or agent id")
  .option("--actor-type <actorType>", "HUMAN|AGENT|SYSTEM", "AGENT")
  .option("--session-id <sessionId>", "Automation/session id")
  .option("--client <client>", "Client label", "snipara-companion")
  .option("-d, --dir <directory>", "Repository directory (default: current)")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await collaborationReleaseCommand({
      leaseId: options.leaseId,
      all: Boolean(options.all),
      reason: options.reason,
      actor: options.actor,
      actorId: options.actorId,
      actorType: options.actorType,
      sessionId: options.sessionId,
      client: options.client,
      dir: options.dir,
      json: options.json,
    });
  });

collaboration
  .command("status")
  .description("Show local collaboration state and hosted active sessions/leases")
  .option("--actor <actor>", "Developer or agent display name")
  .option("--actor-id <actorId>", "Stable developer or agent id")
  .option("--actor-type <actorType>", "HUMAN|AGENT|SYSTEM", "AGENT")
  .option("--session-id <sessionId>", "Automation/session id")
  .option("--client <client>", "Client label", "snipara-companion")
  .option("-d, --dir <directory>", "Repository directory (default: current)")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await collaborationStatusCommand({
      actor: options.actor,
      actorId: options.actorId,
      actorType: options.actorType,
      sessionId: options.sessionId,
      client: options.client,
      dir: options.dir,
      json: options.json,
    });
  });

collaboration
  .command("ide-status")
  .description("Print compact JSON status for IDE extensions and editor integrations")
  .option("--actor <actor>", "Developer or agent display name")
  .option("--actor-id <actorId>", "Stable developer or agent id")
  .option("--actor-type <actorType>", "HUMAN|AGENT|SYSTEM", "AGENT")
  .option("--session-id <sessionId>", "Automation/session id")
  .option("--client <client>", "Client label", "snipara-companion")
  .option("-d, --dir <directory>", "Repository directory (default: current)")
  .option("--no-json", "Print a compact text summary instead of JSON")
  .action(async (options) => {
    await collaborationIdeStatusCommand({
      actor: options.actor,
      actorId: options.actorId,
      actorType: options.actorType,
      sessionId: options.sessionId,
      client: options.client,
      dir: options.dir,
      json: options.json,
    });
  });

const code = program
  .command("code")
  .description("Direct hosted code graph queries and local overlay helpers");

code
  .addCommand(
    new Command("status")
      .description("Inspect the non-canonical local code overlay for this working tree")
      .option("-d, --dir <directory>", "Repository directory (default: current)")
      .option("--max-files <number>", "Maximum supported code files to inspect", "2000")
      .option("--include-graph", "Include full files, symbols, and imports in JSON output")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await codeStatusCommand({
          dir: options.dir,
          maxFiles: parseInt(options.maxFiles, 10),
          includeGraph: Boolean(options.includeGraph),
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("sync")
      .description("Build and cache a non-canonical local code overlay")
      .option("-d, --dir <directory>", "Repository directory (default: current)")
      .option("--working-tree", "Index the current working tree")
      .option("--commit <commit>", "Index a local commit instead of the working tree")
      .option("--only-if-head <sha>", "Skip cache writes if repository HEAD moved")
      .option("--max-files <number>", "Maximum supported code files to inspect", "2000")
      .option("--include-graph", "Include full files, symbols, and imports in JSON output")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await codeSyncCommand({
          dir: options.dir,
          workingTree: Boolean(options.workingTree),
          commit: options.commit,
          onlyIfHead: options.onlyIfHead,
          maxFiles: parseInt(options.maxFiles, 10),
          includeGraph: Boolean(options.includeGraph),
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("upload")
      .description("Upload the non-canonical local code overlay through Hosted MCP")
      .option("-d, --dir <directory>", "Repository directory (default: current)")
      .option("--cached", "Upload the cached overlay instead of rebuilding from the working tree")
      .option("--ttl-hours <number>", "Hosted overlay TTL in hours", "48")
      .option("--source-client <name>", "Source client label", "snipara-companion")
      .option("--session-id <id>", "Optional agent/session identifier")
      .option("--no-retire-previous", "Keep older active overlays for the same repository/branch")
      .option("--max-files <number>", "Maximum supported code files to inspect", "2000")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await codeUploadCommand({
          dir: options.dir,
          cached: Boolean(options.cached),
          ttlHours: parseInt(options.ttlHours, 10),
          sourceClient: options.sourceClient,
          sessionId: options.sessionId,
          retirePrevious: options.retirePrevious !== false,
          maxFiles: parseInt(options.maxFiles, 10),
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("hooks")
      .description(
        "Install Git hooks that keep local code overlays fresh before hosted push/index catches up"
      )
      .addCommand(
        new Command("install")
          .description("Install managed post-commit and pre-push hooks for local code overlays")
          .option("-d, --dir <directory>", "Repository directory (default: current)")
          .option("--max-files <number>", "Maximum supported code files to inspect", "2000")
          .option("--synchronous", "Run hook work in the foreground instead of background")
          .option(
            "--reindex-delay-seconds <number>",
            "Background pre-push delay before requesting hosted reindex",
            "5"
          )
          .option(
            "--no-request-reindex",
            "Do not request hosted code reindex from the pre-push hook"
          )
          .option("--dry-run", "Preview hook writes without changing files")
          .option("--json", "Print raw JSON")
          .action(async (options) => {
            await codeHooksInstallCommand({
              dir: options.dir,
              maxFiles: parseInt(options.maxFiles, 10),
              synchronous: Boolean(options.synchronous),
              reindexDelaySeconds: parseInt(options.reindexDelaySeconds, 10),
              requestReindex: options.requestReindex !== false,
              dryRun: Boolean(options.dryRun),
              json: Boolean(options.json),
            });
          })
      )
  )
  .addCommand(
    new Command("promote")
      .description(
        "Record local overlay promotion state after push and optionally request hosted code reindex"
      )
      .option("-d, --dir <directory>", "Repository directory (default: current)")
      .option("--pushed-sha <sha>", "Pushed local commit SHA or ref (default: HEAD)")
      .option("--indexed-sha <sha>", "Hosted indexed commit SHA to reconcile against")
      .option("--request-reindex", "Request hosted code reindex for this project")
      .option("--from-hook <hook>", "Read hook stdin; currently supports pre-push")
      .option("--strict", "Fail when hosted reindex fails instead of recording a warning")
      .option("--max-files <number>", "Maximum supported code files to inspect", "2000")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await codePromoteCommand({
          dir: options.dir,
          pushedSha: options.pushedSha,
          indexedSha: options.indexedSha,
          requestReindex: Boolean(options.requestReindex),
          fromHook: options.fromHook,
          strict: Boolean(options.strict),
          maxFiles: parseInt(options.maxFiles, 10),
          json: Boolean(options.json),
        });
      })
  )
  .addCommand(
    new Command("serve")
      .description("Serve the non-canonical local code overlay through HTTP or MCP stdio")
      .option("-d, --dir <directory>", "Repository directory (default: current)")
      .option("--transport <transport>", "Transport: http|mcp-stdio", "http")
      .option("--host <host>", "HTTP host", "127.0.0.1")
      .option("--port <number>", "HTTP port", "4747")
      .option("--cached", "Use the cached overlay for query tools instead of rebuilding")
      .option("--max-files <number>", "Maximum supported code files to inspect", "2000")
      .option("--include-graph", "Include full files, symbols, and imports in status/sync output")
      .option(
        "--ready-file <file>",
        "Write HTTP server address metadata to a JSON file after listen"
      )
      .option("--allow-origin <origin>", "Optional CORS Access-Control-Allow-Origin value")
      .option("--json", "Print startup metadata as JSON")
      .action(async (options) => {
        await codeServeCommand({
          dir: options.dir,
          transport: options.transport,
          host: options.host,
          port: parseInt(options.port, 10),
          cached: Boolean(options.cached),
          maxFiles: parseInt(options.maxFiles, 10),
          includeGraph: Boolean(options.includeGraph),
          readyFile: options.readyFile,
          allowOrigin: options.allowOrigin,
          json: Boolean(options.json),
        });
      })
  )
  .addCommand(
    new Command("mcp")
      .description("Run a local MCP stdio server exposing snipara_local_code_* tools")
      .option("-d, --dir <directory>", "Repository directory (default: current)")
      .option("--cached", "Use the cached overlay for query tools instead of rebuilding")
      .option("--max-files <number>", "Maximum supported code files to inspect", "2000")
      .option("--include-graph", "Include full files, symbols, and imports in status/sync output")
      .action(async (options) => {
        await codeMcpCommand({
          dir: options.dir,
          cached: Boolean(options.cached),
          maxFiles: parseInt(options.maxFiles, 10),
          includeGraph: Boolean(options.includeGraph),
          json: true,
        });
      })
  )
  .addCommand(
    new Command("local")
      .description("Query the non-canonical local code overlay with CLI JSON")
      .addCommand(
        new Command("callers")
          .description("List local file-level importers for a symbol or file")
          .option("-q, --qualified-name <qualifiedName>", "Local symbol name or file::symbol")
          .option("--symbol-key <symbolKey>", "Local overlay symbol key")
          .option("-f, --file-path <filePath>", "File path to inspect")
          .option("--cached", "Use the cached overlay instead of rebuilding from the working tree")
          .option("--max-files <number>", "Maximum supported code files to inspect", "2000")
          .option("--json", "Print raw JSON")
          .action(async (options) => {
            await codeLocalCallersCommand({
              qualifiedName: options.qualifiedName,
              symbolKey: options.symbolKey,
              filePath: options.filePath,
              cached: Boolean(options.cached),
              maxFiles: parseInt(options.maxFiles, 10),
              json: options.json,
            });
          })
      )
      .addCommand(
        new Command("imports")
          .description("List local imports for a symbol or file")
          .option("-q, --qualified-name <qualifiedName>", "Local symbol name or file::symbol")
          .option("--symbol-key <symbolKey>", "Local overlay symbol key")
          .option("-f, --file-path <filePath>", "File path to inspect")
          .option("--cached", "Use the cached overlay instead of rebuilding from the working tree")
          .option("--max-files <number>", "Maximum supported code files to inspect", "2000")
          .option("--json", "Print raw JSON")
          .action(async (options) => {
            await codeLocalImportsCommand({
              qualifiedName: options.qualifiedName,
              symbolKey: options.symbolKey,
              filePath: options.filePath,
              cached: Boolean(options.cached),
              maxFiles: parseInt(options.maxFiles, 10),
              json: options.json,
            });
          })
      )
      .addCommand(
        new Command("neighbors")
          .description("List local incoming and outgoing file-level import neighbors")
          .option("-q, --qualified-name <qualifiedName>", "Local symbol name or file::symbol")
          .option("--symbol-key <symbolKey>", "Local overlay symbol key")
          .option("-f, --file-path <filePath>", "File path to inspect")
          .option("--cached", "Use the cached overlay instead of rebuilding from the working tree")
          .option("--max-files <number>", "Maximum supported code files to inspect", "2000")
          .option("--json", "Print raw JSON")
          .action(async (options) => {
            await codeLocalNeighborsCommand({
              qualifiedName: options.qualifiedName,
              symbolKey: options.symbolKey,
              filePath: options.filePath,
              cached: Boolean(options.cached),
              maxFiles: parseInt(options.maxFiles, 10),
              json: options.json,
            });
          })
      )
      .addCommand(
        new Command("impact")
          .description(
            "Summarize local file-level import impact for changed files or a selected symbol"
          )
          .option("--changed-files <changedFiles...>", "Changed files to inspect")
          .option("-q, --qualified-name <qualifiedName>", "Local symbol name or file::symbol")
          .option("--symbol-key <symbolKey>", "Local overlay symbol key")
          .option("-f, --file-path <filePath>", "File path to inspect")
          .option("--cached", "Use the cached overlay instead of rebuilding from the working tree")
          .option("--max-files <number>", "Maximum supported code files to inspect", "2000")
          .option("--json", "Print raw JSON")
          .action(async (options) => {
            await codeLocalImpactCommand({
              changedFiles: options.changedFiles,
              qualifiedName: options.qualifiedName,
              symbolKey: options.symbolKey,
              filePath: options.filePath,
              cached: Boolean(options.cached),
              maxFiles: parseInt(options.maxFiles, 10),
              json: options.json,
            });
          })
      )
      .addCommand(
        new Command("shortest-path")
          .description("Find a local file-level import path between symbols or files")
          .requiredOption("--from <from>", "Source symbol name or file path")
          .requiredOption("--to <to>", "Target symbol name or file path")
          .option("--max-hops <number>", "Maximum file hops", "6")
          .option("--cached", "Use the cached overlay instead of rebuilding from the working tree")
          .option("--max-files <number>", "Maximum supported code files to inspect", "2000")
          .option("--json", "Print raw JSON")
          .action(async (options) => {
            await codeLocalShortestPathCommand({
              from: options.from,
              to: options.to,
              maxHops: parseInt(options.maxHops, 10),
              cached: Boolean(options.cached),
              maxFiles: parseInt(options.maxFiles, 10),
              json: options.json,
            });
          })
      )
  )
  .addCommand(
    new Command("callers")
      .description("Find who calls a symbol; auto-select hosted graph or local overlay")
      .option("-q, --qualified-name <qualifiedName>", "Qualified symbol name")
      .option("--symbol-key <symbolKey>", "Stable graph or local overlay symbol key")
      .option("-d, --depth <number>", "Traversal depth", "1")
      .option("-l, --limit <number>", "Maximum callers", "50")
      .option("--source <source>", "auto|hosted|local", "auto")
      .option("--cached", "When local is selected, use the cached overlay if present")
      .option("--max-files <number>", "Maximum supported code files for local overlay", "2000")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await codeGraphAutoSourceCommand("callers", {
          qualifiedName: options.qualifiedName,
          symbolKey: options.symbolKey,
          depth: parseInt(options.depth, 10),
          limit: parseInt(options.limit, 10),
          source: options.source,
          cached: Boolean(options.cached),
          maxFiles: parseInt(options.maxFiles, 10),
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("imports")
      .description(
        "Find imports/importers for a symbol or file; auto-select hosted graph or local overlay"
      )
      .option("-q, --qualified-name <qualifiedName>", "Qualified symbol name")
      .option("--symbol-key <symbolKey>", "Stable graph or local overlay symbol key")
      .option("-f, --file-path <filePath>", "File path to inspect")
      .option("-d, --direction <direction>", "in|out", "out")
      .option("--include-file-nodes", "Include all matched file nodes")
      .option("-l, --limit <number>", "Maximum imports", "50")
      .option("--source <source>", "auto|hosted|local", "auto")
      .option("--cached", "When local is selected, use the cached overlay if present")
      .option("--max-files <number>", "Maximum supported code files for local overlay", "2000")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await codeGraphAutoSourceCommand("imports", {
          qualifiedName: options.qualifiedName,
          symbolKey: options.symbolKey,
          filePath: options.filePath,
          direction: options.direction,
          includeFileNodes: Boolean(options.includeFileNodes),
          limit: parseInt(options.limit, 10),
          source: options.source,
          cached: Boolean(options.cached),
          maxFiles: parseInt(options.maxFiles, 10),
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("neighbors")
      .description("Get a symbol neighborhood; auto-select hosted graph or local overlay")
      .option("-q, --qualified-name <qualifiedName>", "Qualified symbol name")
      .option("--symbol-key <symbolKey>", "Stable graph or local overlay symbol key")
      .option("-d, --depth <number>", "Traversal depth", "2")
      .option("-e, --edge-kinds <edgeKinds...>", "Edge kinds to include")
      .option("-l, --limit <number>", "Maximum nodes", "200")
      .option("--source <source>", "auto|hosted|local", "auto")
      .option("--cached", "When local is selected, use the cached overlay if present")
      .option("--max-files <number>", "Maximum supported code files for local overlay", "2000")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await codeGraphAutoSourceCommand("neighbors", {
          qualifiedName: options.qualifiedName,
          symbolKey: options.symbolKey,
          depth: parseInt(options.depth, 10),
          edgeKinds: options.edgeKinds,
          limit: parseInt(options.limit, 10),
          source: options.source,
          cached: Boolean(options.cached),
          maxFiles: parseInt(options.maxFiles, 10),
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("shortest-path")
      .description("Find how two symbols connect; auto-select hosted graph or local overlay")
      .requiredOption("--from <from>", "Source qualified symbol name")
      .requiredOption("--to <to>", "Target qualified symbol name")
      .option("-e, --edge-kinds <edgeKinds...>", "Edge kinds to include")
      .option("--max-hops <number>", "Maximum hops", "6")
      .option("--source <source>", "auto|hosted|local", "auto")
      .option("--cached", "When local is selected, use the cached overlay if present")
      .option("--max-files <number>", "Maximum supported code files for local overlay", "2000")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await codeGraphAutoSourceCommand("shortest-path", {
          from: options.from,
          to: options.to,
          edgeKinds: options.edgeKinds,
          maxHops: parseInt(options.maxHops, 10),
          source: options.source,
          cached: Boolean(options.cached),
          maxFiles: parseInt(options.maxFiles, 10),
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("symbol-card")
      .description("Load an agent-ready symbol card before editing an important code symbol")
      .option("-q, --qualified-name <qualifiedName>", "Qualified symbol name")
      .option("--symbol-key <symbolKey>", "Stable graph symbol key")
      .option("-l, --limit <number>", "Maximum relations", "20")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await codeSymbolCardCommand({
          qualifiedName: options.qualifiedName,
          symbolKey: options.symbolKey,
          limit: parseInt(options.limit, 10),
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("impact")
      .description(
        "Run the primary agent-ready code impact gate for routes/services/jobs; auto-select local overlay for dirty/ahead worktrees and hosted graph for clean indexed code"
      )
      .option("-q, --qualified-name <qualifiedName>", "Qualified symbol name")
      .option("--symbol-key <symbolKey>", "Stable graph symbol key")
      .option("-f, --file-path <filePath>", "Source file to analyze")
      .option("--changed-files <changedFiles...>", "Changed files to analyze")
      .option("--diff-summary <diffSummary>", "Natural-language summary of the change")
      .option("-l, --limit <number>", "Maximum impact entries", "50")
      .option("--source <source>", "auto|hosted|local", "auto")
      .option("--cached", "When local is selected, use the cached overlay if present")
      .option("--max-files <number>", "Maximum supported code files for local overlay", "2000")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await codeGraphAutoSourceCommand("impact", {
          qualifiedName: options.qualifiedName,
          symbolKey: options.symbolKey,
          filePath: options.filePath,
          changedFiles: options.changedFiles,
          diffSummary: options.diffSummary,
          limit: parseInt(options.limit, 10),
          source: options.source,
          cached: Boolean(options.cached),
          maxFiles: parseInt(options.maxFiles, 10),
          json: options.json,
        });
      })
  );

program
  .command("context-pack")
  .description("Pack and retrieve local-only tool outputs without a Snipara account")
  .addCommand(
    new Command("pack")
      .description("Store text, file content, or piped tool output in .snipara/context-pack")
      .argument("[content]", "Inline content to pack")
      .option("-d, --dir <directory>", "Workspace directory (default: current)")
      .option("--text <text>", "Inline text to pack")
      .option("--file <file>", "Read content from a local text file")
      .option("--label <label>", "Human label for this pack")
      .option("--source <source>", "Source command, file, or tool name")
      .option("--kind <kind>", "tool_output|log|diff|file|text|note", "tool_output")
      .option("--tag <tag>", "Tag to attach; repeatable", collectOption, [])
      .option("--ttl-days <number>", "Optional expiration TTL in days")
      .option("--max-bytes <number>", "Maximum input bytes", "2097152")
      .option("--allow-sensitive", "Allow secret-like content to be packed locally")
      .option("--json", "Print raw JSON")
      .action(async (content, options) => {
        const pipedInput =
          content === undefined && options.text === undefined && options.file === undefined
            ? await readOptionalStdin()
            : undefined;
        await contextPackPackCommand({
          cwd: options.dir,
          input: content ?? pipedInput,
          text: options.text,
          file: options.file,
          label: options.label,
          source: options.source,
          kind: options.kind,
          tags: options.tag,
          ttlDays: options.ttlDays !== undefined ? Number.parseInt(options.ttlDays, 10) : undefined,
          maxBytes:
            options.maxBytes !== undefined ? Number.parseInt(options.maxBytes, 10) : undefined,
          allowSensitive: Boolean(options.allowSensitive),
          json: Boolean(options.json),
        });
      })
  )
  .addCommand(
    new Command("retrieve")
      .description("Retrieve exact local content by pack id, hash prefix, or latest")
      .argument("<id>", "Context pack id, hash prefix, or latest")
      .option("-d, --dir <directory>", "Workspace directory (default: current)")
      .option("-o, --output <file>", "Write content to a file instead of stdout")
      .option("--metadata-only", "With --json, omit exact recovered content from stdout")
      .option("--json", "Print metadata and content as JSON")
      .action(async (id, options) => {
        await contextPackRetrieveCommand(id, {
          cwd: options.dir,
          output: options.output,
          metadataOnly: Boolean(options.metadataOnly),
          json: Boolean(options.json),
        });
      })
  )
  .addCommand(
    new Command("stats")
      .description("Summarize local context-pack storage")
      .option("-d, --dir <directory>", "Workspace directory (default: current)")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await contextPackStatsCommand({
          cwd: options.dir,
          json: Boolean(options.json),
        });
      })
  )
  .addCommand(
    new Command("clean")
      .description("Delete expired, old, or all local context packs")
      .option("-d, --dir <directory>", "Workspace directory (default: current)")
      .option("--all", "Delete every local context pack")
      .option("--no-expired", "Do not include expired packs by default")
      .option("--older-than-days <number>", "Delete packs older than this many days")
      .option("--dry-run", "Preview deletions without removing files")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await contextPackCleanCommand({
          cwd: options.dir,
          all: Boolean(options.all),
          expired: options.expired !== false,
          olderThanDays:
            options.olderThanDays !== undefined
              ? Number.parseInt(options.olderThanDays, 10)
              : undefined,
          dryRun: Boolean(options.dryRun),
          json: Boolean(options.json),
        });
      })
  );

program
  .command("load-document")
  .description("Load one exact source document by path through the local companion")
  .requiredOption("-p, --path <path>", "Document path")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await loadDocumentCommand({
      path: options.path,
      json: options.json,
    });
  });

program
  .command("memory")
  .description("Inspect memory health, cleanup candidates, and dry-run compaction")
  .addCommand(
    new Command("local")
      .description("Delegate to the local snipara-memory OSS engine")
      .allowUnknownOption(true)
      .option("--binary <command>", "snipara-memory binary to execute")
      .argument("[args...]", "Arguments passed to snipara-memory")
      .action(async (args, options) => {
        await memoryLocalCommand({
          binary: options.binary,
          args,
        });
      })
  )
  .addCommand(
    new Command("audit")
      .description("Run memory health, cleanup candidates, and compaction dry-run together")
      .option("-s, --scope <scope>", "Memory scope (agent|project|team|user)")
      .option("--include-inactive", "Include invalidated and superseded memories in scans")
      .option("--sample-limit <number>", "Maximum anomaly samples for memory health", "5")
      .option("--limit-per-bucket <number>", "Maximum cleanup candidates per bucket", "10")
      .option("--no-deduplicate", "Disable duplicate analysis in the compact dry-run")
      .option("--promote-threshold <number>", "Promotion threshold for the compact dry-run")
      .option("--archive-older-than-days <number>", "Archive-age threshold for the compact dry-run")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await memoryAuditCommand({
          scope: options.scope,
          includeInactive: Boolean(options.includeInactive),
          sampleLimit: parseInt(options.sampleLimit, 10),
          limitPerBucket: parseInt(options.limitPerBucket, 10),
          deduplicate: options.deduplicate,
          promoteThreshold:
            options.promoteThreshold !== undefined
              ? parseFloat(options.promoteThreshold)
              : undefined,
          archiveOlderThanDays:
            options.archiveOlderThanDays !== undefined
              ? parseInt(options.archiveOlderThanDays, 10)
              : undefined,
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("health")
      .description("Read-only memory hygiene diagnostics")
      .option("-s, --scope <scope>", "Memory scope (agent|project|team|user)")
      .option("--include-inactive", "Include invalidated and superseded memories in scans")
      .option("--sample-limit <number>", "Maximum anomaly samples", "5")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await memoryHealthCommand({
          scope: options.scope,
          includeInactive: Boolean(options.includeInactive),
          sampleLimit: parseInt(options.sampleLimit, 10),
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("clean-candidates")
      .description("Read-only grouped memory cleanup candidates")
      .option("-s, --scope <scope>", "Memory scope (agent|project|team|user)")
      .option("--include-inactive", "Include invalidated and superseded memories in scans")
      .option("--limit-per-bucket <number>", "Maximum candidates per bucket", "10")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await memoryCleanCandidatesCommand({
          scope: options.scope,
          includeInactive: Boolean(options.includeInactive),
          limitPerBucket: parseInt(options.limitPerBucket, 10),
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("compact")
      .description("Preview hosted memory compaction without mutating memory")
      .option("-s, --scope <scope>", "Memory scope (agent|project|team|user)")
      .option("--no-deduplicate", "Disable duplicate analysis in the dry-run")
      .option("--promote-threshold <number>", "Promotion threshold for the dry-run")
      .option("--archive-older-than-days <number>", "Archive-age threshold for the dry-run")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await memoryCompactCommand({
          scope: options.scope,
          deduplicate: options.deduplicate,
          promoteThreshold:
            options.promoteThreshold !== undefined
              ? parseFloat(options.promoteThreshold)
              : undefined,
          archiveOlderThanDays:
            options.archiveOlderThanDays !== undefined
              ? parseInt(options.archiveOlderThanDays, 10)
              : undefined,
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("invalidate")
      .description("Invalidate one hosted Memory V2 or mapped legacy memory without deleting it")
      .argument("<memory-id>", "Memory ID to invalidate")
      .option("--reason <reason>", "Human-readable invalidation reason")
      .option("--invalidated-at <isoTimestamp>", "ISO timestamp; defaults to server time")
      .option("--json", "Print raw JSON")
      .action(async (memoryId, options) => {
        await memoryInvalidateCommand(memoryId, {
          reason: options.reason,
          invalidatedAt: options.invalidatedAt,
          json: options.json,
        });
      })
  )
  .addCommand(
    new Command("supersede")
      .description("Mark one hosted Memory V2 or mapped legacy memory as superseded by another")
      .argument("<old-memory-id>", "Memory ID being replaced")
      .argument("<new-memory-id>", "Replacement memory ID")
      .option("--reason <reason>", "Human-readable supersession reason")
      .option("--json", "Print raw JSON")
      .action(async (oldMemoryId, newMemoryId, options) => {
        await memorySupersedeCommand(oldMemoryId, newMemoryId, {
          reason: options.reason,
          json: options.json,
        });
      })
  );

program
  .command("eval")
  .description("Export and run Mini Snipara Project Intelligence eval cases")
  .addCommand(
    new Command("export")
      .description("Write a local snipara-evals case from companion workflow evidence")
      .option("--id <id>", "Stable eval case id")
      .option("--name <name>", "Human-readable case name")
      .option("--description <description>", "Case description")
      .option("--summary <summary>", "Observed answer or task summary")
      .option("--context <text>", "Expected context fact; repeatable", collectOption, [])
      .option("--decision <statement>", "Expected decision; repeatable", collectOption, [])
      .option("--impact <target>", "Expected impact surface; repeatable", collectOption, [])
      .option(
        "--verification <check>",
        "Expected verification check or command; repeatable",
        collectOption,
        []
      )
      .option(
        "--continuity <handoff>",
        "Expected continuity or handoff signal; repeatable",
        collectOption,
        []
      )
      .option("--files <files...>", "Observed changed files")
      .option("--command-run <command>", "Observed command that ran; repeatable", collectOption, [])
      .option("-o, --output <file>", "Output case file", ".snipara/evals/case.json")
      .option("-d, --dir <directory>", "Project directory (default: current)")
      .option("--json", "Print raw JSON")
      .action(async (options) => {
        await evalExportCommand({
          id: options.id,
          name: options.name,
          description: options.description,
          summary: options.summary,
          context: options.context,
          decision: options.decision,
          impact: options.impact,
          verification: options.verification,
          continuity: options.continuity,
          files: options.files,
          commandRun: options.commandRun,
          output: options.output,
          dir: options.dir,
          json: Boolean(options.json),
        });
      })
  )
  .addCommand(
    new Command("run")
      .description("Run snipara-evals on one or more local case files")
      .argument("<cases...>", "snipara-evals case JSON files")
      .option("--runner <command>", "Runner command (default: npx or SNIPARA_EVALS_RUNNER)")
      .option("--package <spec>", "npm package spec", "snipara-evals@latest")
      .option("--json", "Print raw JSON from snipara-evals")
      .option("--strict", "Exit non-zero when thresholds fail")
      .action(async (cases, options) => {
        await evalRunCommand({
          cases,
          runner: options.runner,
          packageSpec: options.package,
          json: Boolean(options.json),
          strict: Boolean(options.strict),
        });
      })
  );

program
  .command("recall")
  .description(
    "Recall durable decisions, learnings, preferences, and session carryover from memory"
  )
  .requiredOption("-q, --query <query>", "Memory question")
  .option("-t, --type <type>", "Memory type (fact|decision|learning|preference|todo|context)")
  .option("-s, --scope <scope>", "Memory scope (agent|project|team|user)")
  .option("-c, --category <category>", "Memory category filter")
  .option("-l, --limit <number>", "Maximum memories to return", "5")
  .option("--min-relevance <number>", "Minimum relevance threshold", "0.5")
  .option("--include-inactive", "Include invalidated or superseded memories in the main result set")
  .option("--warning-threshold <number>", "Threshold for lifecycle warnings", "0.72")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await recallCommand({
      query: options.query,
      type: options.type,
      scope: options.scope,
      category: options.category,
      limit: parseInt(options.limit, 10),
      minRelevance: parseFloat(options.minRelevance),
      includeInactive: Boolean(options.includeInactive),
      warningThreshold: parseFloat(options.warningThreshold),
      json: options.json,
    });
  });

program
  .command("session-bootstrap")
  .description(
    "Fetch durable memory for session start, with optional short-lived session carryover"
  )
  .option("--max-critical-tokens <number>", "Durable memory token budget")
  .option(
    "--include-session-context",
    "Include short-lived session carryover in addition to durable memory"
  )
  .option("--max-context-tokens <number>", "Short-lived session context token budget")
  .option("--max-daily-tokens <number>", "Deprecated alias for --max-context-tokens")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    const maxCriticalTokens =
      options.maxCriticalTokens !== undefined ? parseInt(options.maxCriticalTokens, 10) : undefined;
    const maxContextTokens =
      options.maxContextTokens !== undefined
        ? parseInt(options.maxContextTokens, 10)
        : options.maxDailyTokens !== undefined
          ? parseInt(options.maxDailyTokens, 10)
          : undefined;
    await sessionBootstrapCommand({
      maxCriticalTokens,
      maxContextTokens,
      includeSessionContext: Boolean(
        options.includeSessionContext || options.maxContextTokens || options.maxDailyTokens
      ),
      json: options.json,
    });
  });

program
  .command("task-commit")
  .description("Persist durable outcomes after meaningful task work, not every git commit")
  .requiredOption("-s, --summary <summary>", "Task summary")
  .option("-c, --category <category>", "Category")
  .option("-o, --outcome <outcome>", "Outcome", "completed")
  .option("-f, --files <files...>", "Files touched")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await taskCommitCommand({
      summary: options.summary,
      category: options.category,
      outcome: options.outcome,
      files: options.files,
      json: options.json,
    });
  });

program
  .command("final-commit")
  .description("Persist the final managed workflow outcome through snipara_end_of_task_commit")
  .requiredOption("-s, --summary <summary>", "Final outcome summary")
  .option("-c, --category <category>", "Category", "final-commit")
  .option("-o, --outcome <outcome>", "Outcome", "completed")
  .option("-f, --files <files...>", "Files touched")
  .option("--json", "Print raw JSON")
  .action(async (options) => {
    await finalCommitCommand({
      summary: options.summary,
      category: options.category,
      outcome: options.outcome,
      files: options.files,
      json: options.json,
    });
  });

// Cache management
program
  .command("cache")
  .description("Cache management")
  .addCommand(
    new Command("clear").description("Clear the query cache").action(() => {
      clearCache();
    })
  );

program.addHelpText(
  "after",
  `

Context vs Memory

  Context commands:
    onboard-folder  Business folder onboarding without using the dashboard
    references      Scan and ingest external URLs as source-backed context snapshots
    query           Search project documents, parsed business files, and current truth
    shared-context  Load linked team/workspace standards and reusable guidance
    load-document   Open one exact source document when you already know its path
    context-pack    Pack/retrieve local-only tool outputs under .snipara/context-pack

  Memory commands:
    memory             Audit memory health, cleanup candidates, and compaction dry-runs
    recall             Ask memory about past decisions, learnings, preferences, or carryover
    session-bootstrap  Restore durable memory state at session start
    task-commit        Persist durable outcomes after work is complete
    workflow           Track visible LLM plans with phase commits that survive compaction
    team-sync          Record local repository handoffs for parallel dev work
    final-commit       Persist and close a managed workflow at the end

  Rule of thumb:
    Use context for source truth and documents.
    Use memory for decisions, learnings, preferences, and short session carryover.
`
);

function formatCliError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "Request timed out while contacting Snipara. Check the API URL, network access, and retry.";
  }

  if (error instanceof Error && /HTTP 401\b|Unauthorized/i.test(error.message)) {
    const config = loadConfig();
    const projectSuffix = config.projectId ? ` for project ${config.projectId}` : "";
    return [
      `Snipara rejected the API key${projectSuffix} (HTTP 401).`,
      "Run `npx -y snipara-companion@latest init --force` to refresh auth and rebind the workspace project.",
    ].join(" ");
  }

  if (error instanceof Error) {
    return error.message || "Unknown error";
  }

  return String(error);
}

function handleCliError(error: unknown): never {
  console.error(`\n❌ ${formatCliError(error)}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

// Parse arguments only when executed as CLI
if (require.main === module) {
  void main().catch(handleCliError);
}
