/** Public Sandbox CLI adapter. No account, provider credentials or local fallback. */
import { spawn } from 'node:child_process';
import {expectedSandboxScope} from './sandbox-identity';

const DEFAULT_PROBE_TIMEOUT_SECONDS = 30;
const MAX_PROBE_TIMEOUT_SECONDS = 60;
const DIAGNOSTIC_CONTROL_GRACE_SECONDS = 30;
const ADAPTER_STARTUP_ALLOWANCE_SECONDS = 10;

function redactDiagnostic(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|rk|snipara)[-_][A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replaceAll('\0', '').slice(0, 2000);
}

function sanitizeDiagnostics(value: Record<string, unknown>): Record<string, unknown> {
  const result = {...value};
  for (const key of ['reason', 'error', 'stderr']) {
    if (typeof result[key] === 'string') result[key] = redactDiagnostic(result[key]);
  }
  if (result.readiness && typeof result.readiness === 'object' && !Array.isArray(result.readiness)) {
    const readiness = {...result.readiness as Record<string, unknown>};
    for (const key of ['reason', 'error', 'stderr']) {
      if (typeof readiness[key] === 'string') readiness[key] = redactDiagnostic(readiness[key] as string);
    }
    result.readiness = readiness;
  }
  return result;
}

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
  sandboxCommand?: string; probeTimeoutSeconds?: number;
  noReuse?: boolean; orchestratorCommand?: string; coordinationRoot?: string;
}): Promise<{ exitCode: number; result: Record<string, unknown> }> {
  if (!['gate', 'choose', 'diagnose', 'run', 'verify', 'status', 'cancel'].includes(action)) {
    throw new Error('Unsupported Sandbox validation action');
  }
  const diagnostic = ['gate', 'diagnose'].includes(action);
  if (options.probeTimeoutSeconds !== undefined && (!diagnostic || !Number.isInteger(options.probeTimeoutSeconds) || options.probeTimeoutSeconds < 1 || options.probeTimeoutSeconds > MAX_PROBE_TIMEOUT_SECONDS)) {
    return {exitCode: 2, result: {...sandboxUnavailable, stage: 'adapter_input', reason_code: 'invalid_probe_timeout', reason: 'probeTimeoutSeconds is an integer from 1 to 60, supported only for diagnose and gate.'}};
  }
  if (((options.noReuse || options.orchestratorCommand !== undefined || options.coordinationRoot !== undefined) && (action !== 'run' || !options.scope?.trim())) || (action === 'run' && options.scope !== undefined && !options.scope.trim())) {
    return {exitCode: 2, result: {...sandboxUnavailable, stage: 'adapter_input', reason_code: 'explicit_scope_required', reason: 'Coordinated run controls require validation run with an explicit workflow or lot scope.'}};
  }
  if (process.platform === 'win32') return {exitCode: 2, result: {...sandboxUnavailable, reason: 'Repository validation currently qualifies macOS/Linux Docker only.'}};
  const requiresRequest = ['gate','choose','diagnose','run','verify'].includes(action);
  const requiresRun = ['verify','status','cancel'].includes(action);
  if ((requiresRequest && (!options.request || options.request.includes('\0'))) || (requiresRun && !/^[a-f0-9]{32}$/.test(options.runId || '')) || (['gate','choose'].includes(action) && !options.scope)) {
    return {exitCode: 2, result: {...sandboxUnavailable, reason: 'Explicit request, workflow scope and valid run identity are required for the selected action.'}};
  }
  if (action === 'choose' && (!options.acknowledgeUserChoice || !['alternative','install','local','skip'].includes(options.choice || '') || (options.choice === 'alternative' && !options.environment))) return {exitCode: 2, result: {...sandboxUnavailable, reason: 'An explicit acknowledged user choice is required.'}};
  const delegated = action === 'run' && !!options.scope;
  const args = ['validation', action];
  const parameters = delegated
    ? {request: options.request, scope: options.scope, store: options.store, 'sandbox-command': options.sandboxCommand, 'coordination-root': options.coordinationRoot}
    : {request: options.request, scope: action === 'run' ? undefined : options.scope, 'run-id': options.runId, store: ['run', 'verify', 'status', 'cancel'].includes(action) ? options.store : undefined, choice: options.choice, environment: options.environment};
  for (const [flag, value] of Object.entries(parameters)) {
    if (value !== undefined) args.push(`--${flag}`, value);
  }
  if (delegated && options.noReuse) args.push('--no-reuse');
  if (!delegated && options.acknowledgeUserChoice) args.push('--acknowledge-user-choice');
  // Omit the new option by default so older published Sandbox CLIs remain compatible.
  if (options.probeTimeoutSeconds !== undefined) args.push('--probe-timeout-seconds', String(options.probeTimeoutSeconds));
  const env: Record<string, string | undefined> = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  const command = delegated ? options.orchestratorCommand || 'snipara-orchestrator' : options.sandboxCommand || 'snipara-sandbox';
  if (delegated) {
    try {
      const capability = await executeBounded(command, ['validation', 'run', '--help'], env, 10_000);
      if (capability.status !== 0 || !/(?:^|\s)--no-reuse(?:\s|,|$)/m.test(capability.stdout)) throw new Error('The Orchestrator validation run command does not expose --no-reuse.');
    } catch (error) {
      return {exitCode: 2, result: {status: 'orchestrator_update_required', stage: 'adapter_capability', reason_code: 'orchestrator_update_required', reason: `Scoped validation requires Orchestrator 1.14 or newer with validation reuse support. ${redactDiagnostic((error as Error).message)}`, execution_authorized_by_gate: false}};
    }
  }
  let child: {stdout: string; stderr: string; status: number | null};
  const timeoutMs = diagnostic
    ? ((options.probeTimeoutSeconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS) + DIAGNOSTIC_CONTROL_GRACE_SECONDS + ADAPTER_STARTUP_ALLOWANCE_SECONDS) * 1000
    : action === 'run' ? 960_000 : 30_000;
  try {
    child = await executeBounded(command, args, env, timeoutMs);
  } catch (error) {
    const failure = error as Error & {code?: string};
    if (delegated) return {exitCode: 2, result: {status: 'validation_reuse_needs_review', work_reuse: {state: 'needs_review'}, stage: 'adapter_process', reason_code: failure.code === 'ETIMEDOUT' ? 'orchestrator_process_timeout' : failure.code === 'EOUTPUT' ? 'orchestrator_output_limit' : 'orchestrator_process_failed', reason: redactDiagnostic(failure.message || 'Orchestrator process failed.'), adapter_timeout_seconds: timeoutMs / 1000, execution_authorized_by_gate: false}};
    return {exitCode: 2, result: {...sandboxUnavailable, stage: 'adapter_process', reason_code: failure.code === 'ETIMEDOUT' ? 'sandbox_process_timeout' : failure.code === 'EOUTPUT' ? 'sandbox_output_limit' : 'sandbox_process_failed', reason: redactDiagnostic(failure.message || 'Sandbox process failed to start.'), adapter_timeout_seconds: timeoutMs / 1000}};
  }
  try {
    const value: unknown = JSON.parse(child.stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Sandbox response');
    const result = value as Record<string, unknown>;
    const workReuse = result.work_reuse && typeof result.work_reuse === 'object' && !Array.isArray(result.work_reuse) ? result.work_reuse as Record<string, unknown> : undefined;
    if (delegated && workReuse?.state === 'needs_review' && (result.status === 'needs_user_choice' || result.status === 'user_choice_recorded')) {
      if (result.run_id !== undefined || result.execution_authorized_by_gate !== false || (result.sandbox_used !== undefined && result.sandbox_used !== false) || Array.from(options.scope!).length > 256) throw new Error('Invalid nonexecution gate response');
      const scope = result.scope_sha256 === undefined ? undefined : expectedSandboxScope(options.request!, options.scope!);
      if (result.scope_sha256 !== scope) throw new Error('Invalid gate scope binding');
      if (result.status === 'needs_user_choice') {
        const allowed = ['alternative', 'install', 'continue_without_sandbox', 'local', 'skip'];
        const choices = Array.isArray(result.choices) ? result.choices.map(value => typeof value === 'string' ? value : value && typeof value === 'object' && !Array.isArray(value) && typeof value.label === 'string' && value.label.length <= 256 ? value.id : undefined) : [];
        if (typeof result.prompt !== 'string' || !result.prompt.trim() || result.prompt.length > 2000 || choices.length < 1 || choices.length > allowed.length || new Set(choices).size !== choices.length || !choices.every(value => typeof value === 'string' && allowed.includes(value))) throw new Error('Invalid unavailable gate choices');
        return {exitCode: 2, result: sanitizeDiagnostics({...result, prompt: redactDiagnostic(result.prompt)})};
      }
      const choice = result.choice as Record<string, unknown> | undefined;
      if (!scope || result.sandbox_used !== false || result.proof_requirement_waived !== false || !validChoice(choice, scope) || choice?.choice === 'install') throw new Error('Invalid recorded gate choice');
      return {exitCode: 2, result: sanitizeDiagnostics(result)};
    }
    if (delegated && result.run_id === undefined && ((result.status === 'validation_in_progress' && workReuse?.state === 'in_progress') || (result.status === 'validation_reuse_needs_review' && workReuse?.state === 'needs_review'))) {
      return {exitCode: 2, result: sanitizeDiagnostics(result)};
    }
    if (delegated && (!workReuse || typeof workReuse.state !== 'string' || !['executed', 'reused', 'needs_review'].includes(workReuse.state))) throw new Error('Invalid validation reuse metadata');
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
    const failed = result.status === 'needs_user_choice' || (action === 'verify' && result.valid !== true) || (action === 'diagnose' && result.ready !== true) || (action === 'run' && (result.status !== 'passed' || result.cleanup_complete !== true)) || (delegated && workReuse?.state === 'needs_review');
    return {exitCode: failed ? 2 : child.status ?? 2, result: sanitizeDiagnostics(result)};
  } catch {
    if (delegated) return {exitCode: 2, result: {status: 'validation_reuse_needs_review', work_reuse: {state: 'needs_review'}, stage: 'adapter_response', reason_code: 'orchestrator_response_invalid', reason: child.stderr ? redactDiagnostic(child.stderr) : 'Orchestrator returned an unsupported or malformed response after execution was attempted; inspect its evidence before retrying.', execution_authorized_by_gate: false}};
    return {exitCode: 2, result: {...sandboxUnavailable, stage: 'adapter_response', reason_code: 'sandbox_response_invalid', reason: child.stderr ? redactDiagnostic(child.stderr) : 'Sandbox returned an unsupported or malformed response; update/configure it or select an alternative.'}};
  }
}


/** Drain bounded output and terminate the whole owned process group on failure. */
export function executeBounded(command: string, args: string[], env: Record<string, string | undefined>, timeoutMs: number): Promise<{stdout: string; stderr: string; status: number | null}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false});
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The owned process group has already exited. */ } } };
    const cleanup = () => { clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); process.removeListener('exit', kill); };
    const fail = (error: Error) => { failure = error; kill(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); cleanup(); reject(error); };
    const interrupt = () => fail(new Error('Sandbox parent interrupted'));
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    process.once('exit', kill);
    timer = setTimeout(() => fail(Object.assign(new Error('Sandbox process exceeded its adapter deadline.'), {code: 'ETIMEDOUT'})), timeoutMs);
    child.on('error', error => { cleanup(); kill(); reject(error); });
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) fail(Object.assign(new Error('Sandbox output budget exceeded'), {code: 'EOUTPUT'}));
      else chunks.push(chunk);
    };
    child.stdout.on('data', collect(chunks));
    child.stderr.on('data', collect(errorChunks));
    child.on('close', status => {
      cleanup();
      kill();
      if (failure) { kill(); reject(failure); }
      else resolve({stdout: Buffer.concat(chunks).toString('utf8'), stderr: Buffer.concat(errorChunks).toString('utf8'), status});
    });
  });
}


function validVerifiedReceipt(value: unknown, runId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r=value as Record<string,unknown>;
  return r.schema_version==='snipara.sandbox.validation.v1' && r.run_id===runId && r.status==='passed' && r.cleanup_complete===true && r.exit_code===0 && r.backend==='docker';
}
