# Monorepo Node validation image prototype

This is an **unqualified recipe**, not an installed image or evidence of a
passing check. It extends the adjacent generic preparation guide for the
pnpm monorepo. An exploratory local build using a verified local base image
passed offline lint and type checks; the digest-pinned input workflow has not
yet been qualified. Do not use the recipe as a release gate until its inputs,
build and actual requested checks have been independently reviewed and qualified.

## Reviewed inputs

Create a dedicated build context outside the repository. Copy this directory's
`Dockerfile` and `.dockerignore` into its root, then supply only:

- `workspace/`: root `package.json`, `pnpm-lock.yaml`,
  `pnpm-workspace.yaml`, the reviewed, credential-free `.npmrc`, `patches/`,
  and each participating `apps/*/package.json` and `packages/*/package.json`.
  The lockfile and manifests must come from the same source snapshot. Do not
  copy repository source, user configuration, tokens or `.env` files.
- `pnpm-store/`: a reviewed pnpm 10.28.0 store containing all lockfile entries
  for the selected architecture. `--offline` fails when any input is missing.
- `npm-cache/`: a reviewed, already prepared npm cache, including metadata and
  tarballs needed for the package-install smoke test on that architecture.
- `prisma/`: the exact Prisma `schema-engine` and `libquery_engine.so.node`
  binaries for the lockfile's engine version, architecture and OpenSSL ABI, and
  `SHA256SUMS` containing their independently verified hashes using those two
  file names. Review provenance and expected hashes before building; a hash
  generated from the supplied binaries alone is not provenance.

Use a pre-seeded digest-pinned base with Node 24, npm, Git, `sha256sum` and
pnpm 10.28.0 already installed. Record the base digest, platform, lockfile and
manifest hashes, cache inventories, engine version and hashes. The recipe skips
all dependency lifecycle scripts; packages requiring native builds or generated
clients need separately reviewed offline preparation. The allowlist is an
additional boundary, not a substitute for reviewing the context and caches.

## Build and qualify

After explicitly reviewing the inputs, use the real context and digest:

```sh
BASE_IMAGE='reviewed-base@sha256:REPLACE_WITH_REVIEWED_DIGEST'
CONTEXT='/absolute/path/to/reviewed-context'
docker image inspect "$BASE_IMAGE" > base-image.json
docker build --pull=false --network=none --build-arg BASE_IMAGE="$BASE_IMAGE" \
  --file "$CONTEXT/Dockerfile" --tag reviewed-monorepo:local "$CONTEXT"
docker image inspect reviewed-monorepo:local > dependency-image.json
```

Inspect the builder separately: `--network=none` constrains build `RUN` steps,
not every builder image-resolution operation. Abort rather than pull a missing
base. Record the resulting local `sha256:<image-id>` and compare the observed
inventory and runtime capabilities to the intended checks.

Make an immutable, bounded source snapshot and a reviewed Sandbox request that
uses that image ID, declares the actual commands and artifacts, and passes no
provider credentials. For pnpm checks, the request must copy the prepared root
`node_modules` and each needed workspace `node_modules` from
`/opt/reviewed-monorepo` into `/work`, preserving their relative symlinks. The
Prisma engine paths in the image must reach the generator; Turbo's environment
filter must explicitly pass the two `PRISMA_*` variables. For npm smoke tests,
copy `/opt/reviewed-npm-cache` to writable temporary storage and set
`npm_config_cache` to that copy and `npm_config_offline=true`. The image root
is read-only during Sandbox runs. Do not run database migrations or tests during
image preparation.

```sh
snipara-sandbox validation gate --request reviewed-request.json --scope workflow:lot
snipara-companion validation run --request reviewed-request.json --scope workflow:lot --store reviewed-store --no-reuse
snipara-sandbox validation verify --request reviewed-request.json --run-id ACTUAL_RUN_ID --store reviewed-store
```

Run the meaningful lint, type, package and installation checks required by the
lot within that request, with bounded resources and a durable receipt. A gate
only reports readiness. Verify the run and artifacts, and recheck exact source,
request, image and artifacts before integration. Missing dependencies, ABI
mismatches, unsupported snapshot sizes or missing Docker capabilities remain
failures; do not silently download, broaden access or run tests on the host.

The package checks shared with npm CI can be run inside the prepared Sandbox
environment with `bash scripts/validate-node-package.sh snipara-companion packages/cli full`.
The `full` mode includes the offline package smoke test; `tests` omits packaging.
CI and local Sandbox runs remain separate evidence, even when commands match.

To exercise the real published Sandbox parser, prepare a separate reviewed
image containing the pinned `snipara-sandbox` executable and run
`SNIPARA_REAL_SANDBOX_COMMAND=/absolute/path/to/snipara-sandbox node --test packages/cli/test/sandbox-real-parser.test.js`
inside Sandbox. Without that explicit executable the test is skipped. The test
checks that the scoped Companion call reaches the real verify command; it does
not verify a receipt or qualify nested Docker execution.

Prettier currently formats entire staged files. When an existing file produces
a large unrelated diff, record and review a separate formatting baseline before
changing the hook policy; do not silently exclude the file from checks. A
collaboration lease coordinates cooperative actors only: it cannot prevent
another process from writing the Git index. Use a dedicated worktree, a distinct
actor for each task, and recheck the staged paths and HEAD before integration.
