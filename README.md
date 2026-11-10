# snipara-companion

[![npm version](https://img.shields.io/npm/v/snipara-companion.svg)](https://www.npmjs.com/package/snipara-companion)
[![CI](https://github.com/Snipara/snipara-companion/actions/workflows/ci.yml/badge.svg)](https://github.com/Snipara/snipara-companion/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](./package.json)

**Keep AI coding work understandable, verifiable and resumable.**

Companion works alongside your coding agent. Give a task a goal, scope and
acceptance criteria; inspect the affected code; keep decisions and evidence;
resume with a clear next action after a new chat or a handoff.

Local tasks and code impact need no Snipara account or model API key. Hosted
Snipara adds sourced project context and shared memory when you connect it.
Orchestrator adds optional execution and integration controls. Each can be
used independently.

For a clear, bounded edit, work directly with your agent and run the relevant
checks. Add a managed task when continuity or evidence tracking helps. The
[optional agent skills](docs/skills/README.md) follow the same principle.

<a id="install"></a>

## Start with a local task

Requires Node.js 18+. Run from the repository you want to work on:

```bash
npx -y snipara-companion@latest task start "Handle missing customer input" \
  --id customer-input \
  --accept "Missing input returns the agreed validation error" \
  --file src/customer.ts \
  --check "pnpm test"
npx -y snipara-companion@latest task work customer-input
```

Replace the file and check with your project's actual scope and command. Work
with your existing agent, then inspect verification and the next decision:

```bash
npx -y snipara-companion@latest task verify customer-input
npx -y snipara-companion@latest task decide customer-input
npx -y snipara-companion@latest task resume customer-input
```

`task verify` proposes checks; it does not execute them. `task decide` keeps
missing verification visible. A reported success is separate from observed
checks, independent review and permission to integrate. Starting a task
preserves another active workflow rather than replacing it.

See the [five-step task journey](docs/TASK_JOURNEY.md) for recording outcomes,
GitHub issue intake, evidence, closure and the optional Orchestrator bridge.

## Check what a change affects

Run a bounded local impact query before editing:

```bash
npx -y snipara-companion@latest code impact \
  --changed-files src/auth/session.ts --source local
```

Local impact reads your checkout. TypeScript and JavaScript analysis includes
symbols and call/import relationships; Python and Go have import-level
fallbacks. Missing files and truncated traversal remain explicit limitations.
With Hosted configured, automatic selection can combine the indexed graph with
local changes; use `--source local` for an offline query.

<a id="agent-continuity"></a>

## Resume without reconstructing the chat

```bash
npx -y snipara-companion@latest workflow resume --json
npx -y snipara-companion@latest workflow resume --detail --json
npx -y snipara-companion@latest continue-workspace --include-session-context --json
```

Since Companion 4.0, `workflow resume --json` returns a compact versioned
overview. Use `--detail` for the full payload, including when the overview
reports `overview_incomplete`. Update integrations that expected the old full
JSON. `continue-workspace` exposes the editor-facing continuity contract.

Workflow state and evidence live under `.snipara/`. Resume compares current
repository state with the checkpoint and reports drift, failed attempts,
missing evidence and the next action. A saved running marker does not prove a
process is alive. See [work continuity](docs/WORK_CONTINUITY.md).

## Optional managed local setup

To prepare compatible local tools and a native client connection together:

```bash
npx -y create-snipara@latest init --profile local-work --client codex
# Use --client claude-code for Claude Code.
npx -y create-snipara@latest doctor
```

This path requires the supported Node.js and Python runtimes. It prepares
Companion, Orchestrator and Sandbox without requiring a Snipara account.
It does not install Docker, prepare dependency images or run tests. Keep the
standalone Companion path above if you only need task tracking and impact.
See [create-snipara](https://www.npmjs.com/package/create-snipara).

## Validate a repository change

Companion delegates repository checks to Snipara Sandbox. Use an immutable
source snapshot, an already prepared dependency image and a reviewed request.
The preparation guide includes an example request and offline image recipes:
[prepare validation](https://github.com/Snipara/snipara-companion/blob/main/docs/guides/sandbox-validation-preparation/README.md).

```bash
snipara-companion validation profiles
snipara-companion validation inspect --request request.json
snipara-companion validation gate --request request.json --scope customer-input:tests
snipara-companion validation run --request request.json --scope customer-input:tests
```

Install Companion globally with `npm install -g snipara-companion` to use the
short command form, or prefix it with `npx -y snipara-companion@latest`.
Readiness is separate from a passing run. Scoped coordination requires a
compatible Orchestrator, selected from the managed toolchain when available.
Reused receipts require fresh verification; `--no-reuse` requests a fresh run.
If the environment is unavailable, choose an explicit alternative instead of
silently executing on the host.

<a id="local-first-hosted-when-useful"></a>

## Add sourced project context when useful

For shared documentation, reviewed decisions and cross-session project memory:

```bash
npx -y create-snipara@latest init --client cursor --starter
npx -y snipara-companion@latest session-bootstrap \
  --include-session-context --max-context-tokens 1000
```

Follow onboarding to select and authorize the intended project. Hosted queries
need that connection and indexed sources. Review the selected documents before
uploading them. For a local Project Brief preview:

```bash
snipara-companion docs bootstrap --preview
snipara-companion source status --json
```

Your agent keeps using its own LLM. Hosted MCP can also be connected directly
without Companion. Local workflow artifacts, shared context and reviewed
durable memory have separate roles; a task closeout is not automatically an
approved project decision.

<a id="free-local-surface"></a>

## Choose the command for the job

| Need                                      | Commands                                                        | Guide                                            |
| ----------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------ |
| One scoped task                           | `task start/work/verify/decide/resume`                          | [Task journey](docs/TASK_JOURNEY.md)             |
| Code impact and source snapshots          | `code impact`, `source init/sync/status`                        | [Advanced reference](docs/ADVANCED_REFERENCE.md) |
| A phased plan                             | `workflow start`, `phase-start`, `phase-commit`, `final-commit` | [Portable workflows](docs/portable-methods.md)   |
| Per-task source context                   | `workflow task-start`, `workflow export-context`                | [Task context](docs/TASK_CONTEXT.md)             |
| Checkpoints and handoffs                  | `workflow checkpoint/resume`, `team-sync`                       | [Continuity](docs/WORK_CONTINUITY.md)            |
| Environment diagnostics                   | `doctor`, `toolchain status`, `validation inspect/gate`         | [Distribution](docs/DISTRIBUTION.md)             |
| Local usage visibility                    | `workflow efficiency --json`                                    | CLI `workflow efficiency --help`                 |
| Detailed integrations, policy and workers | `agent-context`, `context-control`, `workers`, `context-pack`   | [Advanced reference](docs/ADVANCED_REFERENCE.md) |

`workflow run` chooses a workflow mode; root `run` is the separate Project
Intelligence flow. `final-commit` records workflow closure, not a Git commit.
Use `--help` for the commands supported by your installed version.

<a id="command-reference"></a>

## Versions and documentation

Read [package.json](package.json) for this source tree's version. The npm
badge reports registry metadata; plugin pins and installed tools may differ.
Read [the changelog](CHANGELOG.md) and
[distribution and compatibility](docs/DISTRIBUTION.md) before upgrading.

- [Detailed command and integration reference](docs/FULL_REFERENCE.md)
- [Advanced workflows and contracts](docs/ADVANCED_REFERENCE.md)
- [Online command reference](https://www.snipara.com/docs/integration/companion/reference)
- [Snipara Sandbox](https://github.com/Snipara/snipara-sandbox)
- [Snipara plugin for Claude Code and Codex](https://github.com/Snipara/snipara-claude)

## Development

The public repository is a focused source mirror. Its source and documentation
are maintained together in the owning Snipara workspace and synchronized here.
The standalone checkout includes its shared contracts and public guides.

Use the scripts in [package.json](package.json) for build, lint, type checks and
tests. Repository validation should use the reviewed Sandbox request and
prepared dependency image described above. A documentation review alone does
not qualify runtime behavior or publish a package.

MIT licensed. See [package metadata](package.json) for repository and support links.
