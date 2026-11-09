/** Stable native-client bootstrap: one private selection for the whole stdio session. */
import {spawn} from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  assertManagedToolchainCompatibility, managedToolchainEnvironment,
  resolveManagedToolchain, ManagedToolchainError,
  type ManagedEnvironment,
} from "./managed-toolchain";

export function prepareManagedMcpLaunch(options: {workspaceRoot: string; manifestPath?: string}): {
  command: string; args: string[]; cwd: string; env: ManagedEnvironment;
} {
  if (!path.isAbsolute(options.workspaceRoot) || options.workspaceRoot.includes("\0") ||
      fs.realpathSync(options.workspaceRoot) !== options.workspaceRoot || !fs.statSync(options.workspaceRoot).isDirectory()) {
    throw new ManagedToolchainError("workspace_root_invalid", "The native client must supply its canonical existing workspace root");
  }
  const selected = resolveManagedToolchain({manifestPath: options.manifestPath});
  if (!selected) throw new ManagedToolchainError("toolchain_manifest_missing", "Install local-work before starting its native tool connection");
  assertManagedToolchainCompatibility(selected);
  const env = managedToolchainEnvironment(selected);
  env.SNIPARA_SANDBOX_VALIDATION_WORKSPACE = options.workspaceRoot;
  env.SNIPARA_SANDBOX_VALIDATION_ENABLED = "1";
  return {command: selected.components.sandbox.command, args: ["mcp-serve"], cwd: options.workspaceRoot, env};
}

/** The server is intentionally persistent; disconnect and signals have a bounded owned shutdown. */
export async function launchManagedMcp(options: {workspaceRoot: string; manifestPath?: string}): Promise<number> {
  if (process.platform === "win32") throw new ManagedToolchainError("platform_unqualified", "Managed local-work currently supports macOS and Linux");
  const launch = prepareManagedMcpLaunch(options);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {cwd: launch.cwd, env: launch.env, detached: true, stdio: ["pipe", "pipe", "pipe"], shell: false});
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const signalOwned = (signal: "SIGKILL" | "SIGTERM") => { if (child.pid) { try { process.kill(-child.pid, signal); } catch { /* Already exited. */ } } };
    const force = () => {
      signalOwned("SIGKILL"); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (!settled) { settled = true; cleanup(); resolve(2); }
    };
    const stop = () => { signalOwned("SIGTERM"); timer ??= setTimeout(force, 3000); };
    const disconnect = () => { timer ??= setTimeout(force, 3000); };
    const cleanup = () => {
      clearTimeout(timer); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); process.removeListener("exit", force);
      process.stdin.removeListener("end", disconnect); process.stdin.unpipe(child.stdin);
      child.stdout.unpipe(process.stdout); child.stderr.unpipe(process.stderr);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("exit", force);
    process.stdin.once("end", disconnect);
    process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    child.stdin.on("error", stop);
    // A descendant retaining a pipe must not keep a disconnected native session alive.
    child.once("exit", disconnect);
    child.once("error", () => { if (settled) return; settled = true; cleanup(); force(); reject(new ManagedToolchainError("toolchain_launch_failed", "The selected local-work server could not start; repair the installation")); });
    child.once("close", (code) => { if (settled) return; settled = true; cleanup(); force(); resolve(code ?? 2); });
  });
}
