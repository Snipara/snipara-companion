<a id="distribution-et-versions-compatibles"></a>

# Distribution and compatible versions

This documentation accompanies the Companion candidate **3.7.2** prepared for
the verifiable path. A local artifact that is built and tested is not a
published version. Use the file and the fingerprint indicated in the folder
delivery folder; `@latest` and a plugin's pins may refer to another version.

<a id="installer-un-artefact-préparé"></a>

## Install a prepared artifact

In a disposable directory, install the exact tarball without lifecycle scripts, then invoke its own entry point:
lifecycle scripts, then invoke its own entry point:

```sh
npm install --prefix /chemin/installation --ignore-scripts /chemin/snipara-companion-3.7.2.tgz
/chemin/installation/node_modules/.bin/snipara-companion --help
```

The npm dependencies must be available in the cache or on the registry.
This installation publishes nothing, configures no Snipara account, and does not
launch an agent. Keep the tarball with its SHA-256. A source update requires
rebuilding, testing, and reviewing a new artifact.

The CommonJS build bundles the runtime ESM dependency graphs to remain
loadable under Node 18. The source mirror keeps the same build configuration.
Verify the actual installed entry point on the minimal engine announced, including
configuration read/write, and not only
on the Node of the development workstation.

<a id="choisir-son-parcours"></a>

## Choose your path

| Chosen tools | Entry point | Limit |
| --- | --- | --- |
| Hosted MCP only | Context and memory queries via the existing client | No local Companion tracking nor implicit Controller |
| Companion only | `task start`, `task work`, `task verify`, `task decide`, `task resume` | No Orchestrator agent required; unobserved proofs remain unknown |
| Standalone Orchestrator | `task intake`, `task start`, `task show`, `task resume` | Use its package and guides; no Companion required |
| Both | Workflow export, bridge revised then Controller | Preserve identities, policies, evidence, and versions; no implicit launch |

The [path guide](TASK_JOURNEY.md), the [per-task context](TASK_CONTEXT.md)
and the [resume](WORK_CONTINUITY.md) describe the exact commands. The
local task operations do not require a Hosted activation. A command
for memory or remote retrieval keeps its own access requirements.

<a id="contrats-et-reprise"></a>

## Contracts and resume

The pair prepared for the full path is Companion **3.7.2** and
Orchestrator **1.10.0**. This does not declare any other incompatible pair:
the contracts actually present determine what each reader accepts.

- Older exports without versioned context keep their behavior of
  reference or title; the absence of a source does not prove it was loaded.
- `source-context-v1` preserves the context and its rich references.
  `runtime-source-context-v1` additionally links the exact pack bodies provided to
  each task and its consumer. An unknown version or an altered
  binding must be rejected before creating a Controller.
- Loading an old workflow does not silently migrate it to a new
  contract. Keep the original; prepare/export a new copy with the
  existing commands if the path requires more evidence.
- A resume revalidates repository, index, and components. A preserved
  history does not represent fresh evidence from a runtime still alive.

Before a different combination, verify its export with the consumer
exact ; a refusal requires an update or a new export, without removing the
security fields to get the file accepted. The validation of a bridge
does not prove either the semantic use of the context by a model, or its success.

<a id="vérification-de-livraison"></a>

## Delivery verification

The public suites of the repository can target this entry point by
`SNIPARA_COMPANION_TEST_CLI=/chemin/installation/node_modules/snipara-companion/dist/index.js`.
an explicitly provided but empty value, missing from disk, or invalid
fails; it must not fall back to the checkout build. Without this variable,
the suites keep their usual source path. The receipt must verify the origin of the
Python imports of the installed wheel when the bridge is exercised.

The create-snipara, MCP, OpenClaw, and business packages remain independent.
Their publications are only required if their own behavior changes.
The pins of a plugin and the public Companion mirror constitute separate
surfaces to be revalidated during a later authorized delivery.

Known demonstrations, the exposed public campaign, and the L7 collector
do not replace the independent L6 qualification nor the human measures L7.
Neither installation, nor reinstallation, nor a folder merges or deploys code.
