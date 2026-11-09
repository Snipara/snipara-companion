/** Shared data contract only. Filesystem trust and execution belong to consumers. */
export const MANAGED_TOOLCHAIN_VERSION = "snipara.toolchain.v1" as const;
export const MANAGED_TOOLCHAIN_COMPONENTS = ["companion", "orchestrator", "sandbox"] as const;
export type ManagedToolchainComponentName = typeof MANAGED_TOOLCHAIN_COMPONENTS[number];

export interface ManagedToolchainComponent {
  version: string;
  command: string;
  sha256: string;
}

export interface ManagedToolchainManifest {
  schemaVersion: typeof MANAGED_TOOLCHAIN_VERSION;
  bundleId: string;
  root: string;
  components: Record<ManagedToolchainComponentName, ManagedToolchainComponent>;
  contracts: {taskReference: 1; validation: 1};
  capabilities: string[];
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max &&
  !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

function canonicalAbsolute(value: unknown): value is string {
  return bounded(value, 4096) && value.startsWith("/") && value !== "/" &&
    !value.endsWith("/") && !value.split("/").some((part, index) => index > 0 && ["", ".", ".."].includes(part));
}

/** Parse a bounded wire object, without trusting its paths, hashes or capabilities. */
export function parseManagedToolchainManifest(value: unknown): ManagedToolchainManifest {
  if (!object(value) || value.schemaVersion !== MANAGED_TOOLCHAIN_VERSION ||
      !bounded(value.bundleId, 128) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.bundleId) ||
      !canonicalAbsolute(value.root) || !object(value.components) || !object(value.contracts) ||
      value.contracts.taskReference !== 1 || value.contracts.validation !== 1 ||
      !Array.isArray(value.capabilities) || value.capabilities.length > 32 ||
      !value.capabilities.every((item) => bounded(item, 64) && /^[a-z][a-z0-9_-]*$/.test(item)) ||
      new Set(value.capabilities).size !== value.capabilities.length) {
    throw new Error("Unsupported or invalid managed toolchain manifest");
  }
  const root = value.root;
  const components = {} as Record<ManagedToolchainComponentName, ManagedToolchainComponent>;
  for (const name of MANAGED_TOOLCHAIN_COMPONENTS) {
    const component = value.components[name];
    if (!object(component) || !bounded(component.version, 64) ||
        !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(component.version) ||
        !canonicalAbsolute(component.command) || !component.command.startsWith(root + "/") ||
        typeof component.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(component.sha256)) {
      throw new Error("Invalid managed component identity");
    }
    components[name] = {version: component.version, command: component.command, sha256: component.sha256};
  }
  return {
    schemaVersion: MANAGED_TOOLCHAIN_VERSION,
    bundleId: value.bundleId,
    root,
    components,
    contracts: {taskReference: 1, validation: 1},
    capabilities: [...value.capabilities] as string[],
  };
}

/** Stable across harmless request formatting and task presentation changes. */
export function managedValidationScope(requestSha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(requestSha256)) throw new Error("Invalid canonical Sandbox request identity");
  return `snipara-validation:${requestSha256}`;
}
