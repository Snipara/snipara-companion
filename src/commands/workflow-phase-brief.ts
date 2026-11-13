import type { RLMClient, RecallResult, ContextQueryResult, CollaborationStateResponse, CodeGraphNodeResult } from "../api/client";
import type { ManagedWorkflowPhase } from "./workflows";
import type { CollaborationLocalState } from "./collaboration";
import { teamSyncFilesOverlap } from "./team-sync";
import { briefSummary } from "../runtime/memory-sources";

const labels = { tasks: "Tasks", risks: "Risks", sessions: "Other sessions", memories: "Memories", context: "Context" };
type Section = keyof typeof labels;
export type PhaseBrief = Partial<Record<Section, string[]>> & { skipped?: string[]; text: string };
type Lookups = {
  risks: Record<string, unknown>;
  sessions: CollaborationStateResponse;
  memories: RecallResult;
  context: ContextQueryResult;
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
// A memory is only useful when its constraint can be read: 160 characters cut most of them before the point,
// and a 230-character section left the second memory as a bare id (real use, 2026-11-13).
const MEMORY_CHARS = 380;
const line = (value: string, max = 160): string => briefSummary(value.replace(/\s+/g, " "), max);
export function phaseBriefFiles(phase: Pick<ManagedWorkflowPhase, "files" | "tasks">): string[] {
  return [...new Set([...(phase.files ?? []), ...(phase.tasks ?? []).flatMap(task => task.files ?? [])])];
}

/** Advice concerns the supplied plan, before legacy normalization synthesizes a task. */
export function phasePlanAdvice(phases: Array<{ id: string; files?: string[]; tasks?: Array<{ title: string; files?: string[] }> }>): string[] {
  const advice: string[] = [];
  const missing = phases.filter(phase => !phase.tasks?.length);
  if (missing.length) advice.push(`Add simple tasks to phases: ${missing.map(phase => phase.id).join(", ")}.`);
  const crowded = phases.filter(phase => (phase.tasks?.length ?? 0) > 7);
  const oversized = phases.some(phase => phase.tasks?.some(task => task.title.length > 200 || (task.files?.length ?? 0) > 5));
  const splitAdvice = [
    ...(crowded.length ? ["Split phases into at most 7 simple tasks."] : []),
    ...(oversized ? ["Shorten task titles to 200 characters and split tasks touching more than 5 files."] : []),
  ];
  if (splitAdvice.length) advice.push(splitAdvice.join(" "));
  if (!phases.some(phase => phase.files?.length || phase.tasks?.some(task => task.files?.length)))
    advice.unshift("Add files to phases or tasks so Risks and Other sessions can be computed.");
  return advice.map(value => line(value, 240));
}

export function assemblePhaseBrief(phase: Pick<ManagedWorkflowPhase, "files" | "tasks">,
  raw: Partial<Lookups>, local: Partial<CollaborationLocalState> = {}, skipped: string[] = []): PhaseBrief {
  const sections: Partial<Record<Section, string[]>> = {};
  const files = phaseBriefFiles(phase);
  sections.tasks = (phase.tasks ?? []).map((task, index) =>
    `${index + 1}. ${task.id}: ${task.title}${(task.files ?? phase.files)?.length ? ` (${(task.files ?? phase.files)!.join(", ")})` : ""}`);
  const risks = raw.risks;
  if (risks) {
    const freshness = object(risks.index_freshness);
    const suffix = `; indexed ${String(freshness.indexed_commit_sha ?? "unknown").slice(0, 12)}${list(freshness.warnings).length ? "; stale/warning" : ""}`;
    const groups = new Map<string, Map<string, string>>();
    for (const chain of list(object(risks.impact).impact_chains)) {
      const value = object(chain);
      const source = object(value.source) as unknown as CodeGraphNodeResult;
      const target = object(value.target) as unknown as CodeGraphNodeResult;
      if (!source.file_path || !files.some(file => teamSyncFilesOverlap([file], [source.file_path])) || !target.file_path || files.some(file => teamSyncFilesOverlap([file], [target.file_path]))) continue;
      const dependents = groups.get(source.file_path) ?? new Map<string, string>();
      dependents.set(target.symbol_key ?? target.file_path, target.qualified_name ?? target.file_path);
      groups.set(source.file_path, dependents);
    }
    sections.risks = [...groups].slice(0, 3).map(([file, dependents]) =>
      `${line(`${file}: ${dependents.size}+ dependents; ${[...dependents.values()].slice(0, 2).join(", ")}`, 140)}${suffix}`);
    // Newer servers list the files that import or call the changed ones; prefer that list to the chains.
    const dependents = object((risks as unknown as Record<string, unknown>).dependents);
    const rows = list(dependents.dependents).map(value => object(value)).filter(row => typeof row.file_path === "string");
    if (rows.length) {
      const named = [...rows.filter(row => !row.is_test), ...rows.filter(row => row.is_test)].slice(0, 4).map(row => String(row.file_path));
      sections.risks = [`${line(`${dependents.total_dependents ?? rows.length} files depend on the changed files (${dependents.test_files ?? 0} tests): ${named.join(", ")}`, 190)}${suffix}`];
    }
  }
  if (raw.sessions && files.length) {
    const current = (id: string | null | undefined) => Boolean(id && [local.workSessionId, local.sessionId, ...Object.values(local.workflowSessions ?? {})].includes(id));
    // Leases carry the actor that claimed them, not the work session: our own are recognised by the actor of
    // our own session, otherwise every phase brief listed the workflow's own file claims as another session.
    const ownActors = raw.sessions.sessions.filter(session => current(session.id) || current(session.sessionId))
      .map(session => (session as unknown as Record<string, unknown>).actorId).filter(Boolean);
    const activeLeases = raw.sessions.leases.filter(lease => lease.status === "ACTIVE" && !current(lease.workSessionId) &&
      !current(lease.claimedByActorId) && !ownActors.includes(lease.claimedByActorId) &&
      (!lease.expiresAt || Date.parse(lease.expiresAt) > Date.now()));
    const sessions = raw.sessions.sessions.filter(session => session.status === "ACTIVE" && !current(session.id) && !current(session.sessionId));
    const rows = sessions.flatMap(session => {
      const leases = activeLeases.filter(lease => lease.workSessionId === session.id);
      const common = files.filter(file => teamSyncFilesOverlap([file], [...(session.dirtyFiles ?? []), ...leases.map(lease => lease.resourceId)]));
      if (!common.length && !(local.repository && session.repository === local.repository)) return [];
      return [`${session.actorLabel ?? session.client ?? session.id}: ${common.join(", ") || "same repository"}; ${session.lastHeartbeatAt ?? session.startedAt ?? "activity unknown"}`];
    });
    for (const lease of activeLeases) {
      if (sessions.some(session => session.id === lease.workSessionId) || !teamSyncFilesOverlap(files, [lease.resourceId])) continue;
      rows.push(`${lease.claimedByLabel ?? lease.claimedByActorId}: ${lease.resourceId}; ${lease.heartbeatAt ?? lease.claimedAt ?? "activity unknown"}`);
    }
    sections.sessions = rows.slice(0, 3);
  }
  if (!object(raw.memories).no_supporting_memory) sections.memories = raw.memories?.memories.slice(0, 3).map(memory => {
    const source = object(list(object(memory).sources)[0]);
    const pointer = source.path ? ` (${source.path}${source.line_start ? `:${source.line_start}` : ""}${source.heading ? `#${source.heading}` : ""})` : source.commit ? ` (${source.commit})` : "";
    return `${memory.memory_id} [${memory.type}]: ${line(memory.content, MEMORY_CHARS)}${pointer}`;
  });
  if (!object(raw.context).no_supporting_source && !object(raw.context?.retrieval_diagnostics).no_supporting_source)
    // References mode returns the hits in section_refs and leaves sections empty.
    sections.context = [...(raw.context?.sections ?? []), ...(list(object(raw.context).section_refs) as unknown as NonNullable<typeof raw.context>["sections"])].filter(section => section.file && !/^(shared|team)[-_ ]context/i.test(section.title))
      .slice(0, 3).map(section => `${section.file}:${section.lines.join("-")} — ${section.title}`);
  // Each section has a bounded share, so long task lists cannot starve later sections.
  const brief: PhaseBrief = { text: "" };
  const rendered: string[] = [];
  for (const key of Object.keys(labels) as Section[]) {
    let remaining = key === "tasks" ? 360 : key === "memories" ? 3 * (MEMORY_CHARS + 90) : 230;
    const kept: string[] = [];
    for (const value of sections[key] ?? []) {
      if (remaining < 24) break;
      if (key === "risks" && value.length > remaining) break;
      const item = line(value, Math.min(remaining, key === "tasks" ? 200 : key === "memories" ? MEMORY_CHARS + 90 : 240));
      kept.push(item); remaining -= item.length + 1;
    }
    if (kept.length) { brief[key] = kept; rendered.push(`${labels[key]}:\n${kept.join("\n")}`); }
  }
  if (skipped.length) { brief.skipped = skipped; rendered.push(`Skipped: ${skipped.join(", ")}`); }
  brief.text = rendered.join("\n");
  return brief;
}

/** Four concurrent reads; the client owns request aborts, these timers bound assembly even for a stalled transport. */
export async function buildPhaseBrief(phase: ManagedWorkflowPhase, options: {
  client?: Pick<RLMClient, "codeImpact" | "getCollaborationState" | "recallMemories" | "queryContext">;
  local?: Partial<CollaborationLocalState>; timeoutMs?: number;
} = {}): Promise<{ brief: PhaseBrief; briefLookups: Partial<Lookups> }> {
  const raw: Partial<Lookups> = {};
  const skipped: string[] = [];
  const client = process.env.SNIPARA_LOCAL_ONLY === "1" ? undefined : options.client;
  if (client) {
    const files = phaseBriefFiles(phase);
    // The phase title alone: on production (2026-11-12) the title joined with every task sentence made the
    // judge abstain for both memories and context, while the title returned usable results.
    const query = phase.title;
    const calls = {
      ...(files.length ? { risks: () => client.codeImpact({ changedFiles: files, direction: "in", depth: 1, limit: 100 }),
        sessions: () => client.getCollaborationState() } : {}),
      memories: () => client.recallMemories(query, { limit: 3, task: query }),
      // Sections, not references: the brief prints the passages themselves.
      context: () => client.queryContext(query, 600, { includeSharedContext: false,
        includeAnswerPack: false, includeAllTiers: false, autoDecompose: false, includeMetadata: false }),
    };
    await Promise.all(Object.entries(calls).map(async ([name, call]) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([Promise.resolve().then(async () => await call()), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), Math.min(options.timeoutMs ?? 12000, 15000));
        })]);
        // A tool-level error envelope (e.g. code impact "response_budget_too_small") is not a result.
        if (value && typeof value === "object" && typeof (value as Record<string, unknown>).error === "string") throw new Error("unavailable");
        Object.assign(raw, { [name]: value });
      } catch (error) {
        skipped.push(`${name} (${error instanceof Error && /timeout|abort/i.test(error.message) ? "timeout" : "unavailable"})`);
      } finally { clearTimeout(timer); }
    }));
  }
  return { brief: assemblePhaseBrief(phase, raw, options.local, skipped.sort()), briefLookups: raw };
}
