import { hashDecisionJsonValue } from "./decision-request";

export const AGENT_CONTEXT_MANIFEST_VERSION = "snipara.agent_context_manifest.v0" as const;
export const AGENT_CONTEXT_VALIDATION_VERSION = "snipara.agent_context_validation.v0" as const;
export const AGENT_CONTEXT_RESOLUTION_VERSION = "snipara.agent_context_resolution.v0" as const;

export const AGENT_CONTEXT_LAYER_KINDS = ["organization", "project", "role"] as const;
export const AGENT_CONTEXT_MEMORY_SCOPES = ["agent", "project", "team"] as const;

export type AgentContextLayerKind = (typeof AGENT_CONTEXT_LAYER_KINDS)[number];
export type AgentContextMemoryScope = (typeof AGENT_CONTEXT_MEMORY_SCOPES)[number];
export type AgentContextAuthority = "canonical" | "supporting" | "generated";
export type AgentContextTier = "HOT" | "WARM" | "COLD";
export type AgentContextValidationStatus = "valid" | "review_required" | "invalid";

export interface AgentContextSource {
  id: string;
  path: string;
  authority: AgentContextAuthority;
  tier: AgentContextTier;
  required: boolean;
  description?: string;
}

export interface AgentContextMemoryReference {
  scope: "project" | "team";
  category: string;
  description?: string;
}

export interface AgentContextSharedLayer {
  sourceIds: string[];
  memory: AgentContextMemoryReference[];
}

export interface AgentContextRole {
  description: string;
  capabilities: string[];
  boundaries: string[];
  queryHints: string[];
  sourceIds: string[];
  memory: AgentContextMemoryReference[];
}

export interface AgentContextBudget {
  totalTokens: number;
  organizationTokens: number;
  projectTokens: number;
  roleTokens: number;
  memoryTokens: number;
}

export interface AgentContextPromotionTarget {
  scope: "project" | "team";
  category: string;
  description?: string;
}

export interface AgentContextAgentMemoryPolicy {
  localCategory: string;
  defaultWriteScope: "agent";
  promotionRequiresReview: true;
  promotionTargets: AgentContextPromotionTarget[];
}

export interface AgentContextAgent {
  agentId: string;
  displayName: string;
  roles: string[];
  budget: AgentContextBudget;
  memory: AgentContextAgentMemoryPolicy;
}

export interface AgentContextManifest {
  schemaVersion: typeof AGENT_CONTEXT_MANIFEST_VERSION;
  organization: AgentContextSharedLayer;
  project: AgentContextSharedLayer & {
    id?: string;
    name?: string;
  };
  sources: AgentContextSource[];
  roles: Record<string, AgentContextRole>;
  agents: Record<string, AgentContextAgent>;
}

export interface AgentContextValidationFinding {
  id: string;
  severity: "info" | "warning" | "error";
  summary: string;
  refs: string[];
  reasonCodes: string[];
}

export interface AgentContextValidationReport {
  schemaVersion: typeof AGENT_CONTEXT_VALIDATION_VERSION;
  generatedAt: string;
  manifestHash: string;
  status: AgentContextValidationStatus;
  manifest?: AgentContextManifest;
  findings: AgentContextValidationFinding[];
  caveats: string[];
}

export interface AgentContextResolvedLayer {
  kind: AgentContextLayerKind;
  id: string;
  sourceIds: string[];
  memoryCategories: string[];
  tokenBudget: number;
  reason: string;
}

export interface AgentContextResolvedSource extends AgentContextSource {
  includedBy: AgentContextLayerKind[];
  reasons: string[];
}

export interface AgentContextRecallRequest {
  scope: AgentContextMemoryScope;
  category: string;
  agentId?: string;
  reason: string;
}

export interface AgentContextResolution {
  schemaVersion: typeof AGENT_CONTEXT_RESOLUTION_VERSION;
  manifestHash: string;
  task: string;
  agent: {
    alias: string;
    agentId: string;
    displayName: string;
    roles: string[];
  };
  capabilities: string[];
  boundaries: string[];
  queryHints: string[];
  budget: AgentContextBudget;
  layers: AgentContextResolvedLayer[];
  sources: AgentContextResolvedSource[];
  excludedRoleSourceIds: string[];
  memory: {
    recall: AgentContextRecallRequest[];
    defaultWrite: {
      scope: "agent";
      agentId: string;
      category: string;
      reviewRequired: false;
    };
    promotion: Array<
      AgentContextPromotionTarget & {
        reviewRequired: true;
        reason: string;
      }
    >;
  };
  explanation: string[];
  caveats: string[];
}

export interface ValidateAgentContextManifestInput {
  manifest: unknown;
  generatedAt?: string | Date;
}

export interface ResolveAgentContextInput {
  manifest: unknown;
  agent: string;
  task: string;
  generatedAt?: string | Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isoTimestamp(value?: string | Date): string {
  const parsed = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid timestamp: ${String(value)}`);
  }
  return parsed.toISOString();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizedStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map(normalizedString);
  if (values.some((entry) => !entry)) return undefined;
  return uniqueStrings(values as string[]);
}

function isSafeIdentifier(value: string): boolean {
  return /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value);
}

function isSafeSourcePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized) ||
    segments.includes("..") ||
    segments.includes(".") ||
    normalized.includes("\0")
  ) {
    return false;
  }
  const filename = segments.at(-1)?.toLowerCase() ?? "";
  return (
    filename !== ".env" &&
    !filename.startsWith(".env.") &&
    !filename.endsWith(".pem") &&
    !filename.endsWith(".key") &&
    filename !== "id_rsa" &&
    filename !== "id_ed25519"
  );
}

function finding(
  id: string,
  severity: AgentContextValidationFinding["severity"],
  summary: string,
  refs: string[] = [],
  reasonCodes: string[] = [id]
): AgentContextValidationFinding {
  return { id, severity, summary, refs, reasonCodes };
}

function normalizeSources(
  value: unknown,
  findings: AgentContextValidationFinding[]
): AgentContextSource[] {
  if (!Array.isArray(value)) {
    findings.push(finding("sources_not_array", "error", "sources must be an array."));
    return [];
  }
  const sources: AgentContextSource[] = [];
  const seen = new Set<string>();
  value.forEach((candidate, index) => {
    const ref = `sources[${index}]`;
    if (!isRecord(candidate)) {
      findings.push(finding("source_not_object", "error", `${ref} must be an object.`, [ref]));
      return;
    }
    const id = normalizedString(candidate.id);
    const sourcePath = normalizedString(candidate.path);
    const authority = candidate.authority;
    const tier = candidate.tier;
    if (!id || !isSafeIdentifier(id)) {
      findings.push(finding("source_id_invalid", "error", `${ref}.id is invalid.`, [ref]));
      return;
    }
    if (seen.has(id)) {
      findings.push(
        finding("source_id_duplicate", "error", `Source id "${id}" is duplicated.`, [ref])
      );
      return;
    }
    seen.add(id);
    if (!sourcePath || !isSafeSourcePath(sourcePath)) {
      findings.push(
        finding(
          "source_path_invalid",
          "error",
          `${ref}.path must be a safe project-relative, non-secret path.`,
          [ref]
        )
      );
      return;
    }
    if (!["canonical", "supporting", "generated"].includes(String(authority))) {
      findings.push(
        finding("source_authority_invalid", "error", `${ref}.authority is invalid.`, [ref])
      );
      return;
    }
    if (!["HOT", "WARM", "COLD"].includes(String(tier))) {
      findings.push(finding("source_tier_invalid", "error", `${ref}.tier is invalid.`, [ref]));
      return;
    }
    const description = normalizedString(candidate.description);
    sources.push({
      id,
      path: sourcePath,
      authority: authority as AgentContextAuthority,
      tier: tier as AgentContextTier,
      required: candidate.required !== false,
      ...(description ? { description } : {}),
    });
  });
  return sources;
}

function normalizeMemoryReferences(
  value: unknown,
  ref: string,
  findings: AgentContextValidationFinding[]
): AgentContextMemoryReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    findings.push(finding("memory_not_array", "error", `${ref} must be an array.`, [ref]));
    return [];
  }
  const result: AgentContextMemoryReference[] = [];
  value.forEach((candidate, index) => {
    const candidateRef = `${ref}[${index}]`;
    if (!isRecord(candidate)) {
      findings.push(
        finding("memory_reference_not_object", "error", `${candidateRef} must be an object.`, [
          candidateRef,
        ])
      );
      return;
    }
    const scope = candidate.scope;
    const category = normalizedString(candidate.category);
    if (scope !== "project" && scope !== "team") {
      findings.push(
        finding(
          "memory_reference_scope_invalid",
          "error",
          `${candidateRef}.scope must be project or team.`,
          [candidateRef]
        )
      );
      return;
    }
    if (!category || !isSafeIdentifier(category)) {
      findings.push(
        finding(
          "memory_reference_category_invalid",
          "error",
          `${candidateRef}.category is invalid.`,
          [candidateRef]
        )
      );
      return;
    }
    const description = normalizedString(candidate.description);
    result.push({ scope, category, ...(description ? { description } : {}) });
  });
  return result.filter(
    (entry, index, entries) =>
      entries.findIndex(
        (candidate) => candidate.scope === entry.scope && candidate.category === entry.category
      ) === index
  );
}

function normalizeSourceIds(
  value: unknown,
  ref: string,
  sourceIds: Set<string>,
  findings: AgentContextValidationFinding[]
): string[] {
  const values = normalizedStringArray(value);
  if (!values) {
    findings.push(finding("source_ids_invalid", "error", `${ref} must be a string array.`, [ref]));
    return [];
  }
  for (const sourceId of values) {
    if (!sourceIds.has(sourceId)) {
      findings.push(
        finding(
          "source_reference_unknown",
          "error",
          `${ref} references unknown source "${sourceId}".`,
          [ref, sourceId]
        )
      );
    }
  }
  return values;
}

function normalizeSharedLayer(
  value: unknown,
  ref: "organization" | "project",
  sourceIds: Set<string>,
  findings: AgentContextValidationFinding[]
): AgentContextManifest["organization"] | AgentContextManifest["project"] {
  if (!isRecord(value)) {
    findings.push(finding(`${ref}_not_object`, "error", `${ref} must be an object.`, [ref]));
    return { sourceIds: [], memory: [] };
  }
  const layer = {
    sourceIds: normalizeSourceIds(value.sourceIds, `${ref}.sourceIds`, sourceIds, findings),
    memory: normalizeMemoryReferences(value.memory, `${ref}.memory`, findings),
  };
  if (ref === "project") {
    const id = normalizedString(value.id);
    const name = normalizedString(value.name);
    return { ...layer, ...(id ? { id } : {}), ...(name ? { name } : {}) };
  }
  return layer;
}

function normalizeRoles(
  value: unknown,
  sourceIds: Set<string>,
  findings: AgentContextValidationFinding[]
): Record<string, AgentContextRole> {
  if (!isRecord(value)) {
    findings.push(finding("roles_not_object", "error", "roles must be an object.", ["roles"]));
    return {};
  }
  const roles: Record<string, AgentContextRole> = {};
  for (const [roleId, candidate] of Object.entries(value)) {
    const ref = `roles.${roleId}`;
    if (!isSafeIdentifier(roleId) || !isRecord(candidate)) {
      findings.push(finding("role_invalid", "error", `${ref} is invalid.`, [ref]));
      continue;
    }
    const description = normalizedString(candidate.description);
    const capabilities = normalizedStringArray(candidate.capabilities);
    const boundaries = normalizedStringArray(candidate.boundaries);
    const queryHints = normalizedStringArray(candidate.queryHints);
    if (!description || !capabilities || !boundaries || !queryHints) {
      findings.push(
        finding(
          "role_fields_invalid",
          "error",
          `${ref} requires description plus capabilities, boundaries, and queryHints arrays.`,
          [ref]
        )
      );
      continue;
    }
    roles[roleId] = {
      description,
      capabilities,
      boundaries,
      queryHints,
      sourceIds: normalizeSourceIds(candidate.sourceIds, `${ref}.sourceIds`, sourceIds, findings),
      memory: normalizeMemoryReferences(candidate.memory, `${ref}.memory`, findings),
    };
  }
  if (Object.keys(roles).length === 0) {
    findings.push(finding("roles_empty", "error", "At least one role is required.", ["roles"]));
  }
  return roles;
}

function normalizeBudget(
  value: unknown,
  ref: string,
  findings: AgentContextValidationFinding[]
): AgentContextBudget | undefined {
  if (!isRecord(value)) {
    findings.push(finding("budget_not_object", "error", `${ref} must be an object.`, [ref]));
    return undefined;
  }
  const keys = [
    "totalTokens",
    "organizationTokens",
    "projectTokens",
    "roleTokens",
    "memoryTokens",
  ] as const;
  const result = {} as AgentContextBudget;
  for (const key of keys) {
    const amount = value[key];
    if (!Number.isInteger(amount) || Number(amount) < (key === "totalTokens" ? 1 : 0)) {
      findings.push(
        finding(
          "budget_value_invalid",
          "error",
          `${ref}.${key} must be a ${key === "totalTokens" ? "positive" : "non-negative"} integer.`,
          [ref]
        )
      );
      return undefined;
    }
    result[key] = Number(amount);
  }
  const allocated =
    result.organizationTokens + result.projectTokens + result.roleTokens + result.memoryTokens;
  if (allocated > result.totalTokens) {
    findings.push(
      finding(
        "budget_overallocated",
        "error",
        `${ref} allocates ${allocated} tokens above totalTokens ${result.totalTokens}.`,
        [ref]
      )
    );
    return undefined;
  }
  return result;
}

function normalizeAgentMemoryPolicy(
  value: unknown,
  ref: string,
  findings: AgentContextValidationFinding[]
): AgentContextAgentMemoryPolicy | undefined {
  if (!isRecord(value)) {
    findings.push(finding("agent_memory_not_object", "error", `${ref} must be an object.`, [ref]));
    return undefined;
  }
  const localCategory = normalizedString(value.localCategory);
  if (!localCategory || !isSafeIdentifier(localCategory)) {
    findings.push(
      finding("agent_local_category_invalid", "error", `${ref}.localCategory is invalid.`, [ref])
    );
    return undefined;
  }
  if (value.defaultWriteScope !== "agent") {
    findings.push(
      finding(
        "agent_default_write_scope_unsafe",
        "error",
        `${ref}.defaultWriteScope must be agent for the V0 dogfood contract.`,
        [ref]
      )
    );
    return undefined;
  }
  if (value.promotionRequiresReview !== true) {
    findings.push(
      finding(
        "agent_promotion_review_required",
        "error",
        `${ref}.promotionRequiresReview must be true.`,
        [ref]
      )
    );
    return undefined;
  }
  if (!Array.isArray(value.promotionTargets)) {
    findings.push(
      finding(
        "agent_promotion_targets_invalid",
        "error",
        `${ref}.promotionTargets must be an array.`,
        [ref]
      )
    );
    return undefined;
  }
  const promotionTargets: AgentContextPromotionTarget[] = [];
  value.promotionTargets.forEach((candidate, index) => {
    const candidateRef = `${ref}.promotionTargets[${index}]`;
    if (!isRecord(candidate)) {
      findings.push(
        finding("agent_promotion_target_invalid", "error", `${candidateRef} is invalid.`, [
          candidateRef,
        ])
      );
      return;
    }
    const scope = candidate.scope;
    const category = normalizedString(candidate.category);
    if ((scope !== "project" && scope !== "team") || !category || !isSafeIdentifier(category)) {
      findings.push(
        finding("agent_promotion_target_invalid", "error", `${candidateRef} is invalid.`, [
          candidateRef,
        ])
      );
      return;
    }
    const description = normalizedString(candidate.description);
    promotionTargets.push({
      scope,
      category,
      ...(description ? { description } : {}),
    });
  });
  return {
    localCategory,
    defaultWriteScope: "agent",
    promotionRequiresReview: true,
    promotionTargets: promotionTargets.filter(
      (entry, index, entries) =>
        entries.findIndex(
          (candidate) => candidate.scope === entry.scope && candidate.category === entry.category
        ) === index
    ),
  };
}

function normalizeAgents(
  value: unknown,
  roles: Record<string, AgentContextRole>,
  findings: AgentContextValidationFinding[]
): Record<string, AgentContextAgent> {
  if (!isRecord(value)) {
    findings.push(finding("agents_not_object", "error", "agents must be an object.", ["agents"]));
    return {};
  }
  const agents: Record<string, AgentContextAgent> = {};
  const agentIds = new Set<string>();
  for (const [alias, candidate] of Object.entries(value)) {
    const ref = `agents.${alias}`;
    if (!isSafeIdentifier(alias) || !isRecord(candidate)) {
      findings.push(finding("agent_invalid", "error", `${ref} is invalid.`, [ref]));
      continue;
    }
    const agentId = normalizedString(candidate.agentId);
    const displayName = normalizedString(candidate.displayName);
    const agentRoles = normalizedStringArray(candidate.roles);
    const budget = normalizeBudget(candidate.budget, `${ref}.budget`, findings);
    const memory = normalizeAgentMemoryPolicy(candidate.memory, `${ref}.memory`, findings);
    if (!agentId || !isSafeIdentifier(agentId) || !displayName || !agentRoles?.length) {
      findings.push(
        finding(
          "agent_fields_invalid",
          "error",
          `${ref} requires valid agentId, displayName, and at least one role.`,
          [ref]
        )
      );
      continue;
    }
    if (agentIds.has(agentId)) {
      findings.push(
        finding("agent_id_duplicate", "error", `agentId "${agentId}" is duplicated.`, [ref])
      );
      continue;
    }
    agentIds.add(agentId);
    for (const roleId of agentRoles) {
      if (!roles[roleId]) {
        findings.push(
          finding("agent_role_unknown", "error", `${ref} references unknown role "${roleId}".`, [
            ref,
            roleId,
          ])
        );
      }
    }
    if (budget && memory) {
      agents[alias] = { agentId, displayName, roles: agentRoles, budget, memory };
    }
  }
  if (Object.keys(agents).length === 0) {
    findings.push(finding("agents_empty", "error", "At least one agent is required.", ["agents"]));
  }
  return agents;
}

export function validateAgentContextManifest(
  input: ValidateAgentContextManifestInput
): AgentContextValidationReport {
  const findings: AgentContextValidationFinding[] = [];
  const manifestRecord = isRecord(input.manifest) ? input.manifest : undefined;
  if (!manifestRecord) {
    findings.push(finding("manifest_not_object", "error", "Manifest must be a JSON object."));
  } else if (manifestRecord.schemaVersion !== AGENT_CONTEXT_MANIFEST_VERSION) {
    findings.push(
      finding(
        "manifest_schema_version_invalid",
        "error",
        `Manifest schemaVersion must be ${AGENT_CONTEXT_MANIFEST_VERSION}.`
      )
    );
  }

  const sources = normalizeSources(manifestRecord?.sources, findings);
  const sourceIds = new Set(sources.map((source) => source.id));
  const organization = normalizeSharedLayer(
    manifestRecord?.organization,
    "organization",
    sourceIds,
    findings
  ) as AgentContextManifest["organization"];
  const project = normalizeSharedLayer(
    manifestRecord?.project,
    "project",
    sourceIds,
    findings
  ) as AgentContextManifest["project"];
  const roles = normalizeRoles(manifestRecord?.roles, sourceIds, findings);
  const agents = normalizeAgents(manifestRecord?.agents, roles, findings);
  for (const [alias, agent] of Object.entries(agents)) {
    const allowedPromotionTargets = new Set(
      [
        ...organization.memory,
        ...project.memory,
        ...agent.roles.flatMap((roleId) => roles[roleId]?.memory ?? []),
      ].map((entry) => `${entry.scope}:${entry.category}`)
    );
    for (const target of agent.memory.promotionTargets) {
      const targetKey = `${target.scope}:${target.category}`;
      if (!allowedPromotionTargets.has(targetKey)) {
        findings.push(
          finding(
            "agent_promotion_target_outside_context",
            "error",
            `Agent "${alias}" cannot promote to undeclared or unassigned memory target "${targetKey}".`,
            [`agents.${alias}.memory.promotionTargets`, targetKey],
            ["agent_promotion_target_outside_context", "cross_role_memory_write_blocked"]
          )
        );
      }
    }
  }

  const referencedSources = new Set([
    ...organization.sourceIds,
    ...project.sourceIds,
    ...Object.values(roles).flatMap((role) => role.sourceIds),
  ]);
  for (const source of sources) {
    if (!referencedSources.has(source.id)) {
      findings.push(
        finding(
          "source_unused",
          "warning",
          `Source "${source.id}" is declared but not used by any context layer.`,
          [source.id]
        )
      );
    }
  }

  const hasError = findings.some((entry) => entry.severity === "error");
  const status: AgentContextValidationStatus = hasError
    ? "invalid"
    : findings.some((entry) => entry.severity === "warning")
      ? "review_required"
      : "valid";
  const manifest: AgentContextManifest | undefined =
    !hasError && manifestRecord
      ? {
          schemaVersion: AGENT_CONTEXT_MANIFEST_VERSION,
          organization,
          project,
          sources,
          roles,
          agents,
        }
      : undefined;

  return {
    schemaVersion: AGENT_CONTEXT_VALIDATION_VERSION,
    generatedAt: isoTimestamp(input.generatedAt),
    manifestHash: hashDecisionJsonValue(input.manifest),
    status,
    ...(manifest ? { manifest } : {}),
    findings,
    caveats: [
      "Agent Context V0 plans context and memory retrieval; it does not read files or call hosted memory.",
      "Agent-local memory is isolated for retrieval, but remains auditable by authorized organization administrators.",
      "Role memory reuses exact categories inside existing project or team scopes; V0 adds no database scope.",
    ],
  };
}

function tokenBudgetForLayer(kind: AgentContextLayerKind, budget: AgentContextBudget): number {
  if (kind === "organization") return budget.organizationTokens;
  if (kind === "project") return budget.projectTokens;
  return budget.roleTokens;
}

function resolvedLayer(
  kind: AgentContextLayerKind,
  id: string,
  sourceIds: string[],
  memory: AgentContextMemoryReference[],
  budget: AgentContextBudget
): AgentContextResolvedLayer {
  return {
    kind,
    id,
    sourceIds: uniqueStrings(sourceIds),
    memoryCategories: uniqueStrings(memory.map((entry) => `${entry.scope}:${entry.category}`)),
    tokenBudget: tokenBudgetForLayer(kind, budget),
    reason:
      kind === "organization"
        ? "Shared company truth required by every configured agent."
        : kind === "project"
          ? "Shared Snipara project truth required by every configured agent."
          : `Role-specific context selected because the agent is assigned role "${id}".`,
  };
}

export function resolveAgentContext(input: ResolveAgentContextInput): AgentContextResolution {
  const validation = validateAgentContextManifest({
    manifest: input.manifest,
    generatedAt: input.generatedAt,
  });
  if (!validation.manifest || validation.status === "invalid") {
    const reasons = validation.findings
      .filter((entry) => entry.severity === "error")
      .map((entry) => entry.summary)
      .join(" ");
    throw new Error(`Invalid Agent Context manifest. ${reasons}`.trim());
  }
  const task = input.task.trim();
  if (!task) throw new Error("Agent Context resolution requires a non-empty task.");
  const manifest = validation.manifest;
  const alias =
    manifest.agents[input.agent] !== undefined
      ? input.agent
      : Object.entries(manifest.agents).find(([, agent]) => agent.agentId === input.agent)?.[0];
  if (!alias) {
    throw new Error(`Unknown agent "${input.agent}".`);
  }
  const agent = manifest.agents[alias];
  const selectedRoles = agent.roles.map((roleId) => [roleId, manifest.roles[roleId]] as const);
  const layers: AgentContextResolvedLayer[] = [
    resolvedLayer(
      "organization",
      "organization",
      manifest.organization.sourceIds,
      manifest.organization.memory,
      agent.budget
    ),
    resolvedLayer(
      "project",
      manifest.project.id ?? "project",
      manifest.project.sourceIds,
      manifest.project.memory,
      agent.budget
    ),
    ...selectedRoles.map(([roleId, role]) =>
      resolvedLayer("role", roleId, role.sourceIds, role.memory, agent.budget)
    ),
  ];

  const sourcesById = new Map(manifest.sources.map((source) => [source.id, source] as const));
  const resolvedSources = new Map<
    string,
    { source: AgentContextSource; includedBy: AgentContextLayerKind[]; reasons: string[] }
  >();
  for (const layer of layers) {
    for (const sourceId of layer.sourceIds) {
      const source = sourcesById.get(sourceId);
      if (!source) continue;
      const current = resolvedSources.get(sourceId) ?? {
        source,
        includedBy: [],
        reasons: [],
      };
      current.includedBy.push(layer.kind);
      current.reasons.push(layer.reason);
      resolvedSources.set(sourceId, current);
    }
  }

  const includedSourceIds = new Set(resolvedSources.keys());
  const selectedRoleIds = new Set(agent.roles);
  const excludedRoleSourceIds = uniqueStrings(
    Object.entries(manifest.roles)
      .filter(([roleId]) => !selectedRoleIds.has(roleId))
      .flatMap(([, role]) => role.sourceIds)
      .filter((sourceId) => !includedSourceIds.has(sourceId))
  ).sort();

  const recall: AgentContextRecallRequest[] = [
    {
      scope: "agent",
      agentId: agent.agentId,
      category: agent.memory.localCategory,
      reason: "Retrieve private working memory for this agent identity.",
    },
  ];
  const appendLayerMemory = (memory: AgentContextMemoryReference[], reason: string): void => {
    for (const entry of memory) {
      recall.push({ scope: entry.scope, category: entry.category, reason });
    }
  };
  appendLayerMemory(
    manifest.organization.memory,
    "Retrieve reviewed memory shared across the organization."
  );
  appendLayerMemory(manifest.project.memory, "Retrieve memory shared across the Snipara project.");
  for (const [roleId, role] of selectedRoles) {
    appendLayerMemory(role.memory, `Retrieve reviewed memory shared with role "${roleId}".`);
  }
  const deduplicatedRecall = recall.filter(
    (entry, index, entries) =>
      entries.findIndex(
        (candidate) =>
          candidate.scope === entry.scope &&
          candidate.category === entry.category &&
          candidate.agentId === entry.agentId
      ) === index
  );

  return {
    schemaVersion: AGENT_CONTEXT_RESOLUTION_VERSION,
    manifestHash: validation.manifestHash,
    task,
    agent: {
      alias,
      agentId: agent.agentId,
      displayName: agent.displayName,
      roles: agent.roles,
    },
    capabilities: uniqueStrings(selectedRoles.flatMap(([, role]) => role.capabilities)),
    boundaries: uniqueStrings(selectedRoles.flatMap(([, role]) => role.boundaries)),
    queryHints: uniqueStrings(selectedRoles.flatMap(([, role]) => role.queryHints)),
    budget: agent.budget,
    layers,
    sources: [...resolvedSources.values()].map(({ source, includedBy, reasons }) => ({
      ...source,
      includedBy: uniqueStrings(includedBy) as AgentContextLayerKind[],
      reasons: uniqueStrings(reasons),
    })),
    excludedRoleSourceIds,
    memory: {
      recall: deduplicatedRecall,
      defaultWrite: {
        scope: "agent",
        agentId: agent.agentId,
        category: agent.memory.localCategory,
        reviewRequired: false,
      },
      promotion: agent.memory.promotionTargets.map((target) => ({
        ...target,
        reviewRequired: true,
        reason: `Promotion to ${target.scope}:${target.category} requires explicit human review.`,
      })),
    },
    explanation: [
      `Resolved organization → project → ${agent.roles.join(" + ")} context for ${agent.displayName}.`,
      `${resolvedSources.size} source(s) included; ${excludedRoleSourceIds.length} source(s) exclusive to other roles excluded.`,
      "New memories stay agent-local unless an allowed project or team promotion is reviewed.",
    ],
    caveats: validation.caveats,
  };
}

export function isAgentContextValidationReport(
  value: unknown
): value is AgentContextValidationReport {
  return (
    isRecord(value) &&
    value.schemaVersion === AGENT_CONTEXT_VALIDATION_VERSION &&
    typeof value.status === "string" &&
    Array.isArray(value.findings)
  );
}

export function isAgentContextResolution(value: unknown): value is AgentContextResolution {
  return (
    isRecord(value) &&
    value.schemaVersion === AGENT_CONTEXT_RESOLUTION_VERSION &&
    isRecord(value.agent) &&
    Array.isArray(value.layers) &&
    Array.isArray(value.sources) &&
    isRecord(value.memory)
  );
}
