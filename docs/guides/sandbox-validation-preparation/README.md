# Review dependency images and validation requests

This preparation packet complements the existing Sandbox guide. It separates
restricted Python snippets, deterministic Docker validation, and provider-native
agent sandboxes. Only the deterministic validation contract is described here.
It needs no Snipara account or provider key and currently qualifies macOS/Linux
with a local Docker daemon. CLI discovery, MCP configuration and gate readiness
are separate observations; none establishes a passing repository test.

## Complete CI profiles

Sandbox 2.5 adds `validation profiles`, `validation inspect --request FILE` and
`validation prepare --profile python-ci|node-ci --workspace DIRECTORY --image DIGEST`.
Companion 4.1 exposes the same commands. These operations describe tools or print
a request; they never install dependencies or execute the request. `--output FILE`
creates a new request without replacing an existing file. An explicit command
can follow `--`; otherwise Python selects pytest and Node selects npm test.

The Python image contract includes pytest, mypy, Ruff, build and hatchling. The
Node image uses project-locked TypeScript, ESLint and tsup dependencies. The
recipes below check those tools while deliberately preparing the image. Supply
all transitive dependencies with pinned hashes/local caches; the catalog is not
a dependency installer or a claim that an arbitrary image contains those tools.

After reviewing the prepared request, use the same explicit lot for CLI and MCP:

```sh
snipara-companion validation gate --request request.json --scope feature-tests
snipara-companion validation run --request request.json --scope feature-tests
```

MCP `validation_run` accepts that request object plus `scope`. It uses Orchestrator
1.15 coordination inside its operator-approved root. Match that root with CLI
`--coordination-root` when working from a different repository subdirectory.
Omitting scope remains legacy raw execution outside coordination. Pure request
inspection normalizes defaults/formatting; fresh verification still determines
whether the current source and evidence can actually be reused.

## Review a dependency image before building or testing

The two adjacent Dockerfiles are **offline recipe templates**, reviewed for
bounded inputs and dependency provenance. They have not been built or qualified
as new images by this change. They deliberately require an already prepared base
image, a project-owned lockfile and a local wheelhouse or npm cache. Missing
inputs fail preparation. Dependency installation uses only the supplied local
artifacts. No workstation installation is performed. Preparing those inputs or
enabling network access is a separate explicit operator decision.

The 2.5 candidate profile requests were qualified against two reviewed local
images, composed offline from existing prepared layers without dependency
downloads: Python image
`sha256:7ee8be762486e7c9095b784041c9c11fb74ef9684a9dfa6aa55ec140c9716a01`
and Node image
`sha256:d9271366691cc6aedc4547c014d2d28471e770e386b03ee8d15c97aa90fd2754`.
Both passed the actual profile requirements and a bounded execution with fresh
receipt verification. These are workstation-local image identities, not public
image references or qualification of the adjacent recipe templates.

The build flag `--network=none` controls **RUN instructions**, not every Docker
daemon or builder operation. Use an already seeded builder and independently
verify its offline image-resolution boundary; a local daemon image inspection
alone does not qualify a separate builder. Abort if the selected builder needs
a base download. This packet has not exercised or qualified that build boundary.
See the [Docker build networking reference](https://docs.docker.com/reference/cli/docker/buildx/build/#set-the-networking-mode-for-the-run-instructions-during-build---network).

- Python: provide `requirements.lock` with exact versions and wheel hashes plus
  matching files in `wheelhouse/`. `pip --require-hashes --no-index` refuses
  unpinned, changed or missing dependencies.
- Node: provide the reviewed `package.json`, `package-lock.json` and matching
  `npm-cache/`. `npm ci --offline --ignore-scripts` preserves the lockfile and
  disables lifecycle hooks. Dependencies needing native compilation, generated
  clients or lifecycle hooks need a separately reviewed preparation step; this
  recipe does not claim they work. The recipe exposes its reviewed dependencies
  at `/node_modules`, so normal Node resolution from `/work` can find them even
  when Sandbox clears `NODE_PATH`.
- Use a small dedicated build context containing only those reviewed inputs and
  the selected Dockerfile. Never copy a working repository, `.env`, registry
  credentials, user home or provider keys into it. The adjacent `.dockerignore`
  is an additional context allowlist.
- Select a base reference pinned by manifest digest that already exists locally.
  Record its resolved local image ID, architecture, recipe and lockfile hashes.
  A recipe alone does not make a reproducible environment: retain the resulting
  image ID and dependency inventories too.

After separately approving a build, an operator can use this reviewed sequence
with their actual prepared context and base reference:

```sh
set -eu
BASE_IMAGE='reviewed-base@sha256:REPLACE_WITH_REVIEWED_MANIFEST_DIGEST'
CONTEXT='/absolute/path/to/reviewed-build-context'
docker image inspect "$BASE_IMAGE" > base-image-inspection.json
# The prior inspection must succeed. No automatic download or fallback is allowed.
docker build --pull=false --network=none \
  --build-arg BASE_IMAGE="$BASE_IMAGE" \
  --file "$CONTEXT/Dockerfile.python-offline" \
  --tag reviewed-project-tests:local "$CONTEXT"
docker image inspect reviewed-project-tests:local > dependency-image-inspection.json
```

Use the returned **local `sha256:<image-id>`** in a validation request. Do not
reuse a mutable tag as evidence of an unchanged environment. The Node recipe
uses the same sequence with `Dockerfile.node-offline` and an already prepared
Node base. These commands are instructions for an explicitly approved build;
this documentation change performs no build or installation.

## Review the immutable request preview

Copy `request.example.json` outside this documentation folder, replace both
placeholders, select the actual command and artifacts, and review the complete
file. Do not execute the example unchanged. Requirements check the capabilities
actually used by the task; they do not install missing modules or commands.
Sandbox runs an immutable source snapshot with offline networking and explicit
CPU, memory, PID, disk and command-time limits.

The pure `previewSandboxValidationRequest(fileText)` helper returns a bounded,
redacted summary of the workspace, immutable-image reference, command, limits
and requirements plus `requestFileSha256`. That digest identifies **file bytes**,
including whitespace. It is not Sandbox's canonical `request_sha256`, a source
snapshot digest, an image signature or an approval. The preview deliberately
reports `validatedBySandbox:false`, `canonicalRequestIdentity:false` and
`executionAuthorized:false`. The standalone runtime remains the authoritative
request validator.

After reviewing the request and authorized lot, use explicit actions:

```sh
snipara-companion validation diagnose --request validation-request.json
snipara-companion validation gate --request validation-request.json --scope reviewed-lot
snipara-companion validation run --request validation-request.json --store .snipara/validation
snipara-companion validation verify --request validation-request.json \
  --store .snipara/validation --run-id RETURNED_32_HEX_RUN_ID
```

The probe timeout is separate from the repository command timeout. New compatible
candidates expose `--probe-timeout-seconds 1..60` only on `diagnose` and `gate`;
check each installed CLI's help before supplying it. Older published runtimes
may reject that option. A longer diagnostic allowance does not extend the test
command, remove isolation or qualify a failed cleanup.

If a capability is unavailable, retain its actual stage/reason and ask for the
scoped explicit choice: configure Sandbox, use another environment, or continue
without it. Do not install, download, execute on the host, or waive a required
Controller proof gate automatically. Distinguish local tests from no tests.

## Display historical verification in a task card

After an **explicit** public verification call, its JSON can be saved at the
bound task artifact location:

```sh
snipara-companion validation verify --request validation-request.json \
  --store .snipara/validation --run-id RETURNED_32_HEX_RUN_ID \
  > .snipara/tasks/EXISTING_TASK_SLUG/sandbox-verification.json
```

The task folder must already belong to the selected task. Keep a failed verifier
response too; do not rewrite it as a success. `task show` and `task resume` read
this saved observation through the existing safe artifact reader. They do not
call Docker, execute verification, refresh an image or run tests.

The saved JSON is editable. `savedVerifierClaim:valid` only reports what that
historical file claims. It grants no new proof, integration authority or fresh
reuse eligibility. The card always reports `verificationFresh:false`,
`executionAuthorized:false`, and `reuse.status:requires_fresh_verification`.
A caller-created success object, readiness response or valid hash cannot turn
that into green proof. Digests establish equality/integrity checks, not a
signature or authenticity guarantee.

When current identities were independently observed, the projection displays
request, snapshot and image drift. It preserves the public verifier's exact
`request_changed`, `snapshot_changed`, `image_changed`, `artifact_changed`,
`artifact_path_invalid`, `log_changed`, `artifacts_incomplete` and
`run_not_accepted` reasons, alongside missing/invalid binding reasons. Unknown
future reason strings are bounded and redacted. It exposes only safe IDs and
digests; raw logs, source contents and secret-bearing paths are omitted.

The optional verify command is a **preview**. Following it is a separate
explicit action against the exact request, run and store. A fresh passing public
verifier result can be consumed by the existing proof gate; the historical card
itself never promotes saved JSON into that authority. Changed source, command,
request, image, log or artifact must retain its refusal reason or receive new
proof under the same authorization.


## Prepared Companion preview command

The prepared Companion 4.0.0 candidate adds a local request preview:

```sh
snipara-companion validation preview --request .snipara/validation/request.json
```

This reads at most 64 KiB from an in-workspace regular file. It does not invoke Sandbox, contact Docker, validate the request through the engine or authorize execution. The file-byte digest is not the Sandbox canonical request identity. Publication and installation of this candidate remain separate steps.

An existing task card reads an optional `.snipara/tasks/<task-id>/sandbox-verification.json` through the same contained file boundary. Malformed, oversized or unsafe optional evidence degrades that observation without turning it into a passing test or blocking unrelated inspection. A displayed saved `valid` claim remains editable and historical; current reuse always requires fresh explicit verification.
