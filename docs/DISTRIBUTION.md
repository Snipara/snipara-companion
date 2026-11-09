<a id="distribution-et-versions-compatibles"></a>

# Distribution and compatible versions

Use [package.json](../package.json) and [CHANGELOG.md](../CHANGELOG.md)
for this source tree's Companion version and release changes.
Registry state, plugin pins and the installed executable are separate observations.

## Choose an installation

| Need                                           | Installation                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| One local task or impact check                 | `npx -y snipara-companion@latest` followed by the command               |
| Daily standalone use                           | `npm install -g snipara-companion`                                      |
| Compatible local tools and native client setup | `npx -y create-snipara@latest init --profile local-work --client codex` |
| Reproduce an exact candidate                   | Install its reviewed tarball and retain its hash                        |

Standalone Companion requires Node.js 18+. Managed local work also requires
the Python runtime supported by the installer. It prepares Companion,
Orchestrator and Sandbox; it does not install Docker, dependency images or a
model, and does not execute repository checks. Hosted context remains optional.

<a id="installer-un-artefact-préparé"></a>

## Install a prepared artifact

Use the exact filename from the delivery record. For a reviewed 4.2.0 candidate:

```sh
npm install --prefix /path/to/install --ignore-scripts /path/to/snipara-companion-4.2.0.tgz
/path/to/install/node_modules/.bin/snipara-companion --help
```

Dependencies must already be cached or available from the registry. Add
`--offline` when verifying a prepared offline installation. Keep the tarball
and SHA-256 together; `@latest` is not a reproducible candidate identity.
Verify the installed entry point on the supported Node.js version, including
configuration access. A local source build is not proof of a published package.

<a id="choisir-son-parcours"></a>

## Choose your path

| Tools                      | Entry point                                      | Boundary                                                         |
| -------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| Hosted MCP only            | Source and memory queries in the existing client | No local task tracking or implicit Controller                    |
| Companion only             | `task start/work/verify/decide/resume`           | No account or Orchestrator required; missing checks stay visible |
| Orchestrator only          | `task intake/start/show/resume`                  | Independent Controller and proof controls                        |
| Managed local work         | `create-snipara init --profile local-work`       | Compatible tools; no automatic test or worker launch             |
| Explicit combined workflow | Context export and reviewed Controller bridge    | Exact identities, policy, evidence and consumer compatibility    |

See [task journey](TASK_JOURNEY.md), [task context](TASK_CONTEXT.md) and
[continuity](WORK_CONTINUITY.md). Repository checks require a prepared
[Sandbox validation request](https://github.com/Snipara/snipara-companion/blob/main/docs/guides/sandbox-validation-preparation/README.md).

<a id="contrats-et-reprise"></a>

## Compatibility and migration

- **Resume JSON:** from 4.0, `workflow resume --json` is a compact overview.
  Add `--detail` for the full payload and inspect `overview_incomplete` results.
- **Managed tools:** use the installer's selected versions and
  `toolchain status`; do not infer compatibility by mixing arbitrary latest
  releases. Plugin pins have their own delivery lifecycle.
- **Scoped validation:** needs a compatible Orchestrator and Sandbox contract.
  The gate and coordinator establish scope; the Sandbox receipt binds the
  request, source, image and artifacts. Reuse requires fresh verification. A
  missing coordinator cannot silently
  fall back to uncoordinated execution.
- **Task context:** `source-context-v1` retains references and context;
  `runtime-source-context-v1` additionally binds exact task bodies. Older
  reference-only exports do not prove a source was loaded. Unknown versions
  or changed bindings require inspection and a compatible export.
- **Task progress:** versioned task references and evidence-derived progress
  distinguish recorded closure from current verified completion. A saved
  running marker does not restore a process or prove it remains alive.

Retain old checkpoints before an explicit refresh. Do not remove contract or
security fields to make an incompatible export pass admission.

<a id="vérification-de-livraison"></a>

## Verify the delivered artifact

The public suites can target an installed CLI with
`SNIPARA_COMPANION_TEST_CLI=/path/to/install/node_modules/snipara-companion/dist/index.js`.
An explicitly empty, absent or invalid target fails instead of falling back to
the checkout build. Without the variable, suites use their normal source path.
Run executable repository checks through the reviewed validation environment.

Retain source, request, image and artifact identities with the results. Verify
Python import origin separately when testing an installed Orchestrator bridge.
Static documentation review, package installation, runtime checks, independent
review, human pilots and publication each establish different evidence.
