# Resume useful work

Companion is optional. This path works without Orchestrator, a running model or
a surviving conversation. Snipara Hosted MCP can also be used without either
local module. Orchestrator has its own independent `controller brief` command.

```sh
snipara-companion workflow checkpoint --json
snipara-companion workflow resume --json
```

The existing workflow commands capture a local, content-addressed checkpoint
when they save work state. `checkpoint` explicitly captures the current files
without completing a task. A new snapshot keeps the initial dirty baseline;
previous context-pack bodies remain historical artifacts.

The resume output adds `continuity`: the goal and criteria, files, decisions
and reasons, attempt outcomes including failed approaches and recovery reasons,
evidence references, missing checks, blockers, remaining tasks and a structured
next action. Task and phase commits retain explicit `--decision`, `--why`,
`--constraint`, `--alternative`, `--observed-outcome` and `--evidence` locally.
These are caller declarations. A `passed:` declaration is not independently
observed execution evidence or integration permission.

Resume compares the current HEAD, committed tree, branch, index and dirty file
bytes with the checkpoint. It checks bound relative artifacts and hashes before
using them, and checks scoped local decisions for expiry, invalidation and newly
pending authority. Original dirty files and subsequent changes are separate.

| Status | Meaning |
| --- | --- |
| `exact_snapshot` | Compared local state and bound artifacts match; functional success and remote freshness remain separate. |
| `drift_revalidation_required` | Repository, contract, decision or source state changed, or older attempt history is incomplete. Inspect the changes before continuing. |
| `blocked` | A required artifact, repository observation or required decision cannot be verified. Repair that prerequisite first. |

Copy the project folder including `.snipara` and referenced artifacts to move a
checkpoint. Matching relative paths, repository ancestry and contents are still
required. Historical absolute paths do not authorize reading outside the new
workspace. Files that exceed observation bounds remain unverified; symlinks and
nonregular evidence files are rejected. Raw transcripts and secret-like content
are excluded or redacted. This is local provenance, not a signed attestation.
Directory, root and glob scopes remain valid declarations; their expansion is
explicitly nonexhaustive. A scope never authorizes reading outside the workspace.

The Hosted bootstrap, Team Sync and What Changed observations are returned
separately. Offline errors preserve the local checkpoint; an empty hosted
`changes` list does not establish an unchanged repository. Remote observations
have a response hash and timestamp and do not rewrite the historical snapshot.
Supplemental session observations also use bounded local reads. Unsafe or
oversized inputs make that supplement unavailable while the continuity brief
remains readable. Raw activity event payloads are omitted from resume output.

Old workflows without a continuity snapshot report incomplete history. An
explicit `checkpoint` can start capturing their current state; missing earlier
attempts cannot be reconstructed. An invalid existing snapshot cannot silently
reset the original baseline. Restore its verified pack or inspect the historical
data before deliberately starting a new workflow.

Reading a checkpoint never runs the stored commands, retries a task, resets a
budget, promotes private memory, restores a process or integrates changes. Use
the existing explicit task retry/start and runtime reattach/rehydrate commands.
Companion reports cost as unknown when no measured usage source exists.
