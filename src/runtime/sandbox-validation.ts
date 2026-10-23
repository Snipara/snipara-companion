/** Public Sandbox CLI adapter. No account, provider credentials or local fallback. */
import { spawn } from 'node:child_process';
import {expectedSandboxScope} from './sandbox-identity';

export const sandboxUnavailable = {
  status: 'needs_user_choice',
  prompt: "Snipara Sandbox n'est pas disponible pour ces tests. Souhaitez-vous utiliser un autre environnement, installer/configurer Sandbox, ou continuer sans Sandbox ?",
  choices: ['alternative', 'install', 'continue_without_sandbox'],
  execution_authorized_by_gate: false,
};

function validChoice(value: unknown, scope: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.schema_version === 'snipara.validation.choice.v1' && typeof v.scope_sha256 === 'string' && /^[a-f0-9]{64}$/.test(v.scope_sha256) && v.scope_sha256 === scope && v.authority === 'operator_asserted' && typeof v.choice === 'string' && ['alternative','install','local','skip'].includes(v.choice) && typeof v.environment === 'string' && v.environment.length <= 256 && (v.choice !== 'alternative' || v.environment.trim().length > 0) && typeof v.created_at === 'number' && Number.isFinite(v.created_at) && typeof v.expires_at === 'number' && Number.isFinite(v.expires_at) && v.expires_at > Date.now()/1000 && v.created_at <= Date.now()/1000 + 60 && v.created_at < v.expires_at && v.expires_at - v.created_at <= 86401;
}

export async function invokeSandboxValidation(action: string, options: {
  request?: string; scope?: string; runId?: string; store?: string;
  choice?: string; environment?: string; acknowledgeUserChoice?: boolean;
  sandboxCommand?: string;
}): Promise<{ exitCode: number; result: Record<string, unknown> }> {
  if (!['gate', 'choose', 'diagnose', 'run', 'verify', 'status', 'cancel'].includes(action)) {
    throw new Error('Unsupported Sandbox validation action');
  }
  if (process.platform === 'win32') return {exitCode: 2, result: {...sandboxUnavailable, reason: 'Repository validation currently qualifies macOS/Linux Docker only.'}};
  const requiresRequest = ['gate','choose','diagnose','run','verify'].includes(action);
  const requiresRun = ['verify','status','cancel'].includes(action);
  if ((requiresRequest && (!options.request || options.request.includes('\0'))) || (requiresRun && !/^[a-f0-9]{32}$/.test(options.runId || '')) || (['gate','choose'].includes(action) && !options.scope)) {
    return {exitCode: 2, result: {...sandboxUnavailable, reason: 'Explicit request, workflow scope and valid run identity are required for the selected action.'}};
  }
  if (action === 'choose' && (!options.acknowledgeUserChoice || !['alternative','install','local','skip'].includes(options.choice || '') || (options.choice === 'alternative' && !options.environment))) return {exitCode: 2, result: {...sandboxUnavailable, reason: 'An explicit acknowledged user choice is required.'}};
  const args = ['validation', action];
  for (const [flag, value] of Object.entries({request: options.request, scope: options.scope, 'run-id': options.runId, store: options.store, choice: options.choice, environment: options.environment})) {
    if (value !== undefined) args.push(`--${flag}`, value);
  }
  if (options.acknowledgeUserChoice) args.push('--acknowledge-user-choice');
  const env: Record<string, string | undefined> = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  let child: {stdout: string; status: number | null};
  try {
    child = await executeBounded(options.sandboxCommand || 'snipara-sandbox', args, env, action === 'run' ? 960_000 : 30_000);
  } catch {
    return {exitCode: 2, result: {...sandboxUnavailable, reason: 'Sandbox process exceeded its deadline/output budget or failed to start.'}};
  }
  try {
    const value: unknown = JSON.parse(child.stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Sandbox response');
    const result = value as Record<string, unknown>;
    const schema = result.schema_version === 'snipara.sandbox.validation.v1';
    const identity = ['gate','choose'].includes(action) && typeof result.scope_sha256 === 'string' && result.scope_sha256 === expectedSandboxScope(options.request!, options.scope!);
    const ready = result.readiness as Record<string, unknown> | undefined;
    const choice = result.choice as Record<string, unknown> | undefined;
    const valid = action === 'gate'
      ? identity && result.sandbox_used === false && result.execution_authorized_by_gate === false && (
        (result.status === 'sandbox_ready' && ready?.schema_version === 'snipara.sandbox.validation.v1' && ready.ready === true && ready.backend === 'docker' && typeof ready.image_id === 'string' && !!ready.image_id) ||
        (result.status === 'needs_user_choice' && result.execution_authorized_by_gate === false && Array.isArray(result.choices) && result.choices.length > 0) ||
        (result.status === 'user_choice_recorded' && result.proof_requirement_waived === false && validChoice(choice, result.scope_sha256) && choice?.choice !== 'install'))
      : action === 'choose' ? identity && validChoice(result, result.scope_sha256) && result.choice === options.choice && result.environment === (options.environment || '')
      : action === 'diagnose' ? typeof result.ready === 'boolean' && schema && result.backend === 'docker'
      : action === 'cancel' ? result.cancel_requested === true && result.run_id === options.runId
      : action === 'verify' ? schema && typeof result.valid === 'boolean' && result.run_id === options.runId && Array.isArray(result.reasons) && (result.valid === false || (result.reasons.length === 0 && validVerifiedReceipt(result.receipt, options.runId!)))
      : schema && typeof result.run_id === 'string' && /^[a-f0-9]{32}$/.test(result.run_id) && (!options.runId || result.run_id === options.runId) && typeof result.status === 'string' && ['preparing','running','passed','failed','timeout','cancelled','environment_incompatible','artifact_error','collection_error','cleanup_failed','error','interrupted'].includes(String(result.status)) && typeof result.cleanup_complete === 'boolean';
    if (!valid) throw new Error('Unsupported Sandbox response schema');
    const failed = result.status === 'needs_user_choice' || (action === 'verify' && result.valid !== true) || (action === 'diagnose' && result.ready !== true) || (action === 'run' && (result.status !== 'passed' || result.cleanup_complete !== true));
    return {exitCode: failed ? 2 : child.status ?? 2, result};
  } catch {
    return {exitCode: 2, result: {...sandboxUnavailable, reason: 'Sandbox returned an unsupported or malformed response; update/configure it or select an alternative.'}};
  }
}


/** Drain bounded output and terminate the whole owned process group on failure. */
export function executeBounded(command: string, args: string[], env: Record<string, string | undefined>, timeoutMs: number): Promise<{stdout: string; status: number | null}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {env, detached: true, stdio: ['ignore', 'pipe', 'ignore'], shell: false});
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The owned process group has already exited. */ } } };
    const cleanup = () => { clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); process.removeListener('exit', kill); };
    const fail = (error: Error) => { failure = error; kill(); child.stdout.destroy(); child.unref(); cleanup(); reject(error); };
    const interrupt = () => fail(new Error('Sandbox parent interrupted'));
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    process.once('exit', kill);
    timer = setTimeout(() => fail(new Error('Sandbox deadline exceeded')), timeoutMs);
    child.on('error', error => { cleanup(); kill(); reject(error); });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) fail(new Error('Sandbox output budget exceeded'));
      else chunks.push(chunk);
    });
    child.on('close', status => {
      cleanup();
      kill();
      if (failure) { kill(); reject(failure); }
      else resolve({stdout: Buffer.concat(chunks).toString('utf8'), status});
    });
  });
}


function validVerifiedReceipt(value: unknown, runId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r=value as Record<string,unknown>;
  return r.schema_version==='snipara.sandbox.validation.v1' && r.run_id===runId && r.status==='passed' && r.cleanup_complete===true && r.exit_code===0 && r.backend==='docker';
}
