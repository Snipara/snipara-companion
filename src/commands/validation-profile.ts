/** Pure Sandbox request preparation/discovery. This path never authorizes execution. */
import path from 'node:path';
import {executeBounded} from '../runtime/sandbox-validation';
import {resolveManagedToolchain, managedToolchainEnvironment, assertManagedToolchainCompatibility, ManagedToolchainError} from '../runtime/managed-toolchain';
import * as fs from 'node:fs';

export interface ValidationMetadataOptions {
  request?: string;
  profile?: string;
  workspace?: string;
  image?: string;
  output?: string;
  command?: string[];
  sandboxCommand?: string;
  toolchainManifest?: string;
}

export async function validationMetadata(
  action: 'profiles' | 'inspect' | 'prepare', options: ValidationMetadataOptions,
): Promise<{exitCode: number; result: Record<string, unknown>}> {
  const args = ['validation', action];
  const parameters = action === 'inspect' ? {request: options.request}
    : action === 'prepare' ? {profile: options.profile, workspace: options.workspace, image: options.image, output: options.output}
      : {};
  if (action === 'inspect' && !options.request) throw new Error('An explicit request file is required.');
  if (action === 'prepare' && (!options.profile || !options.workspace || !options.image)) throw new Error('Profile, workspace and immutable image are required.');
  for (const [flag, value] of Object.entries(parameters)) {
    if (value !== undefined) {
      if (typeof value !== 'string' || value.includes('\0') || value.length > 4096) throw new Error('Invalid metadata argument.');
      args.push(`--${flag}`, value);
    }
  }
  if (action === 'prepare' && options.command?.length) {
    if (options.command.length > 128 || options.command.some(v => !v || v.includes('\0') || v.length > 4096)) throw new Error('Invalid command arguments.');
    args.push('--', ...options.command);
  }
  let selected: ReturnType<typeof resolveManagedToolchain>;
  try {
    selected = resolveManagedToolchain({manifestPath: options.toolchainManifest});
    if (selected) assertManagedToolchainCompatibility(selected);
    if (selected && options.sandboxCommand !== undefined && fs.realpathSync(options.sandboxCommand) !== selected.components.sandbox.command) {
      throw new ManagedToolchainError('toolchain_override_conflict', 'Explicit Sandbox command conflicts with the managed toolchain');
    }
  } catch (error) {
    return {exitCode: 2, result: {status: 'managed_toolchain_needs_attention', execution_authorized: false,
      reason_code: error instanceof ManagedToolchainError ? error.code : 'toolchain_manifest_invalid',
      reason: 'Repair the selected local-work toolchain; no installation or fallback was attempted.'}};
  }
  const env: Record<string, string | undefined> = selected ? managedToolchainEnvironment(selected) : {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key];
  try {
    const response = await executeBounded(selected?.components.sandbox.command || options.sandboxCommand || 'snipara-sandbox', args, env, 15_000);
    const value: unknown = JSON.parse(response.stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid metadata response.');
    const result = value as Record<string, unknown>;
    const valid = action === 'prepare'
      ? result.schema_version === 'snipara.sandbox.validation.v1' && typeof result.workspace === 'string' && path.isAbsolute(result.workspace) && Array.isArray(result.argv)
      : result.schema_version === `snipara.validation.${action === 'profiles' ? 'profiles' : 'inspection'}.v1` && result.execution_authorized === false && result.requirements_qualified === false;
    if (response.status !== 0 || !valid) throw new Error('Sandbox metadata contract not supported.');
    return {exitCode: 0, result};
  } catch {
    return {exitCode: 2, result: {
      status: 'validation_metadata_unavailable', execution_authorized: false,
      reason: 'Request preparation and inspection require Sandbox 2.5 or newer. Check the selected executable and request; no execution or installation was requested.',
    }};
  }
}
