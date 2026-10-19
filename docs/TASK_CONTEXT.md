# Task-local source context

Companion uses the existing workflow and Hosted Snipara tools to load source
content for a specific task. Tasks without a `contextRequest` keep their existing
behavior and make no mandatory context calls.

```json
{
  "goal": "Implement a bounded change",
  "steps": [{
    "id": "implementation",
    "tasks": [{
      "id": "update-service",
      "query": "Implement the reviewed service contract",
      "files": ["src/service.ts"],
      "contextRequest": {
        "queries": ["service contract error behavior"],
        "maxTokens": 4000,
        "maxChunks": 8,
        "timeoutMs": 30000
      }
    }]
  }]
}
```

Start the workflow with the saved plan, then start its task:

```sh
snipara-companion workflow start --goal "Implement a bounded change" --plan-file plan.json
snipara-companion workflow task-start implementation update-service --json
```

`task-start` queries Hosted Snipara with references enabled and calls
`snipara_get_chunk` for the selected IDs. Known IDs can instead be supplied as
`contextRequest.chunkIds`. Duplicate IDs load once. Returned content is source
data and cannot grant execution permissions or expand the task's file scope.

The response includes the actual source bodies in `task_context`, and a
`context_envelope.materialization` receipt pointing at an existing local
context-pack. The receipt binds workflow, phase, task, attempt, canonical context
request and packed bytes. Symbolic inputs record their upstream pack identities.
It establishes local client observation of loading, rather than independent task
success, native worker injection or semantic use of the content.

The full request must succeed before the task becomes in progress or consumes an
attempt. Missing, mismatched, truncated, conflicting, oversized or secret-like
content, marked MCP errors and failed transport block preparation. The deadline
bounds the whole preparation's hosted calls, rather than restarting a full
timeout for every chunk. The existing context-pack secret detector is retained;
this path does not silently enable sensitive storage.

Limits: 8 queries; 16 chunks maximum (8 by default); context token budget 16,000
maximum (4,000 by default); timeout 120,000 ms maximum (30,000 by default). Chunk
token counts are server-reported, with UTF-8 bytes as a conservative fallback.
The complete packed payload, including metadata, is also bounded to
`min(262144, maxTokens * 8)` UTF-8 bytes. These are operational bounds, not billing
or measured model-input token counts.

## Hosted planner compatibility

Numeric step identities and explicit IDs, including nested task aliases, are
resolved before workflow state is created. Unknown, ambiguous and cyclic graphs
are rejected, including cycles through phase completion and member tasks.
Repeated action labels receive distinct stable IDs. Context-bearing phase starts
use the same preparation path; phase completion cannot bypass required loading.

The planner's `decompose`, `context_query` and `multi_query` instructions retain
their parameters. A multi-query is materialized through bounded reference-based
context queries so every selected chunk has a retrievable identity. Only the
advertised `$stepN.sub_queries`, index/slice and optional `.query` data-reference
forms are resolved, against declared completed dependencies with observed output.
An empty remaining slice is explicit zero retrieval work. No expression is
executed as code. Unknown operation parameters fail instead of disappearing.
Other planner operations retain advisory metadata in the task envelope and do
not execute recommended tools.

## Resume and evidence boundaries

```sh
snipara-companion workflow resume --include-session-context --json
```

Resume verifies the current task's saved pack bytes and request identity and
returns its source bodies in `task_contexts`. Hosted session-context errors remain
explicit while the local snapshot can still be restored. The snapshot's original
receipt describes when content was loaded; it does not prove the source is still
current. Starting a new attempt loads again. A changed request or altered pack
blocks restoration.

Workflow drift during asynchronous preparation is checked before state changes.
This is not a cross-process lock or an atomic compare-and-swap guarantee.
Controller/native-runtime injection, independently authenticated reviewers,
complete objective acceptance and the consolidated evidence dossier remain
separate contracts and qualification steps.
