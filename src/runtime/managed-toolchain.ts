/** Private operator-owned toolchain selection. No installation or execution. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {createHash} from "node:crypto";
import {
  MANAGED_TOOLCHAIN_COMPONENTS,
  parseManagedToolchainManifest,
  type ManagedToolchainManifest,
} from "../contracts/project-intelligence";

export interface ResolvedManagedToolchain extends ManagedToolchainManifest {
  manifestPath: string;
  manifestSha256: string;
}
export type ManagedEnvironment = Record<string, string | undefined>;
export interface ManagedToolchainOptions {
  manifestPath?: string;
  env?: ManagedEnvironment;
  home?: string;
}
export class ManagedToolchainError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "ManagedToolchainError"; }
}
const MAX_MANIFEST_BYTES = 65536;
const MAX_COMMAND_BYTES = 16 * 1024 * 1024;
const uid = () => process.getuid?.();
const within = (root: string, candidate: string) => candidate.startsWith(root + path.sep);

export function defaultManagedToolchainPath(home = os.homedir()): string {
  return path.join(home, ".local", "share", "snipara", "toolchains", "active.json");
}

function ownedDirectory(directory: string, privateMode: boolean): void {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (uid() !== undefined && info.uid !== uid()) ||
      (info.mode & (privateMode ? 0o077 : 0o022)) !== 0) {
    throw new ManagedToolchainError("toolchain_directory_unsafe", "Managed toolchain directories must be owned and not writable by other users");
  }
}

function readOwnedFile(filename: string, maximum: number, privateMode: boolean, executable = false): Buffer {
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size > maximum ||
        (uid() !== undefined && info.uid !== uid()) || (info.mode & (privateMode ? 0o077 : 0o022)) !== 0 ||
        (executable && (info.mode & 0o111) === 0)) {
      throw new ManagedToolchainError("toolchain_file_unsafe", "Managed toolchain file ownership, permissions or size are invalid");
    }
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length !== info.size) throw new Error("Managed file changed during reading");
    return bytes.subarray(0, length);
  } finally { fs.closeSync(descriptor); }
}

/** Missing default means legacy operation; an explicit, dangling or invalid selection fails closed. */
export function resolveManagedToolchain(options: ManagedToolchainOptions = {}): ResolvedManagedToolchain | null {
  const env = options.env ?? process.env;
  const selected = options.manifestPath ?? env.SNIPARA_TOOLCHAIN_MANIFEST ?? defaultManagedToolchainPath(options.home);
  const explicit = options.manifestPath !== undefined || env.SNIPARA_TOOLCHAIN_MANIFEST !== undefined;
  try {
    if (!path.isAbsolute(selected) || selected.includes("\0") || selected.length > 4096) throw new Error("Invalid manifest location");
    let pointer: fs.Stats;
    try { pointer = fs.lstatSync(selected); }
    catch (error) {
      if (!explicit && (error as {code?: string}).code === "ENOENT") return null;
      throw new ManagedToolchainError("toolchain_manifest_missing", "The selected managed toolchain is unavailable; repair the local-work installation");
    }
    if (uid() !== undefined && pointer.uid !== uid()) throw new Error("Manifest pointer is not owned");
    ownedDirectory(path.dirname(selected), true);
    const manifestPath = fs.realpathSync(selected);
    ownedDirectory(path.dirname(manifestPath), true);
    const bytes = readOwnedFile(manifestPath, MAX_MANIFEST_BYTES, true);
    const manifest = parseManagedToolchainManifest(JSON.parse(bytes.toString("utf8")) as unknown);
    if (fs.realpathSync(manifest.root) !== manifest.root) throw new Error("Bundle root is not canonical");
    ownedDirectory(manifest.root, true);
    if (!within(manifest.root, manifestPath)) throw new Error("Manifest is outside its immutable bundle");
    for (const name of MANAGED_TOOLCHAIN_COMPONENTS) {
      const component = manifest.components[name];
      if (fs.realpathSync(component.command) !== component.command || !within(manifest.root, component.command)) throw new Error("Component escaped its bundle");
      let current = path.dirname(component.command);
      while (current !== manifest.root) { ownedDirectory(current, false); current = path.dirname(current); }
      const code = readOwnedFile(component.command, MAX_COMMAND_BYTES, false, true);
      if (createHash("sha256").update(code).digest("hex") !== component.sha256) {
        throw new ManagedToolchainError("toolchain_component_changed", "An installed managed component changed; repair before execution");
      }
    }
    if (!readOwnedFile(manifestPath, MAX_MANIFEST_BYTES, true).equals(bytes) || fs.realpathSync(selected) !== manifestPath) throw new Error("Selection changed during resolution");
    return {...manifest, manifestPath, manifestSha256: createHash("sha256").update(bytes).digest("hex")};
  } catch (error) {
    if (error instanceof ManagedToolchainError) throw error;
    throw new ManagedToolchainError("toolchain_manifest_invalid", "The managed toolchain selection is invalid or changed; repair the local-work installation");
  }
}

export function managedToolchainEnvironment(toolchain: ResolvedManagedToolchain, original = process.env): ManagedEnvironment {
  const env: ManagedEnvironment = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "SNIPARA_SANDBOX_VALIDATION_WORKSPACE"]) {
    if (original[name]) env[name] = original[name];
  }
  env.SNIPARA_TOOLCHAIN_MANIFEST = toolchain.manifestPath;
  return env;
}

/** The managed façade supports this reviewed generation of the three local components. */
export function assertManagedToolchainCompatibility(toolchain: ManagedToolchainManifest): void {
  for (const [name, major, minimumMinor] of [["companion", 4, 2], ["orchestrator", 1, 16], ["sandbox", 3, 0]] as const) {
    const version = toolchain.components[name].version;
    const parts = version.split(".").map(Number);
    if (parts[0] !== major || !Number.isInteger(parts[1]) || parts[1] < minimumMinor || version.includes("-")) {
      throw new ManagedToolchainError("toolchain_version_incompatible", "Repair local-work with a compatible stable Companion, Orchestrator and Sandbox bundle");
    }
  }
}

export function managedTaskRuntime(explicitCommand?: string): {orchestratorBin?: string; orchestratorEnv?: ManagedEnvironment} {
  const selected = resolveManagedToolchain();
  if (!selected) return {orchestratorBin: explicitCommand};
  assertManagedToolchainCompatibility(selected);
  if (explicitCommand !== undefined && fs.realpathSync(explicitCommand) !== selected.components.orchestrator.command) {
    throw new ManagedToolchainError("toolchain_override_conflict", "Explicit Orchestrator command conflicts with the managed toolchain");
  }
  return {orchestratorBin: selected.components.orchestrator.command, orchestratorEnv: managedToolchainEnvironment(selected)};
}

export function inspectManagedToolchain(options: ManagedToolchainOptions = {}): Record<string, unknown> {
  try {
    const selected = resolveManagedToolchain(options);
    if (selected) assertManagedToolchainCompatibility(selected);
    return {schemaVersion: "snipara.toolchain_status.v1", status: selected ? "available" : "not_configured",
      installed: selected !== null, callable: null, authorized: null, environmentReady: null,
      verified: null, executionAuthorized: false, bundleId: selected?.bundleId ?? null,
      components: selected?.components ?? null, capabilities: selected?.capabilities ?? [],
      detail: selected ? "Installed files match the selected bundle; execution and environment readiness are checked when requested" : "Context and standalone tools remain available without a managed local-work bundle",
      nextAction: selected ? null : "create-snipara --profile local-work"};
  } catch (error) {
    return {schemaVersion: "snipara.toolchain_status.v1", status: "needs_attention", installed: false,
      callable: false, authorized: null, environmentReady: null, verified: null, executionAuthorized: false,
      reasonCode: error instanceof ManagedToolchainError ? error.code : "toolchain_manifest_invalid",
      detail: "Repair the selected local-work toolchain before execution; no installation or fallback was attempted",
      nextAction: "create-snipara repair --profile local-work"};
  }
}

/** An operator setting wins; otherwise use the actual current workspace's Git root. */
export function managedCoordinationRoot(requestWorkspace: string, explicit?: string, env = process.env, cwd = process.cwd()): string {
  let selected = explicit ?? env.SNIPARA_SANDBOX_VALIDATION_WORKSPACE;
  if (!selected) {
    selected = fs.realpathSync(cwd);
    let current = selected;
    while (true) {
      try { if (fs.lstatSync(path.join(current, ".git"))) { selected = current; break; } } catch { /* Walk existing parents only. */ }
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
  }
  const root = fs.realpathSync(selected);
  const actualCwd = fs.realpathSync(cwd);
  if (actualCwd !== root && !within(root, actualCwd)) throw new ManagedToolchainError("cwd_outside_coordination_root", "Run validation from within the approved workspace, or select its approved root explicitly");
  const workspace = fs.realpathSync(requestWorkspace);
  if (workspace !== root && !within(root, workspace)) throw new ManagedToolchainError("workspace_outside_coordination_root", "The validation request is outside the current approved workspace");
  return root;
}
