# Automatic memory observation pilot

`snipara-companion agent-context memory-pilot --help`

This opt-in local command reads a trusted Agent Context manifest and a bounded
candidate JSON file. It automatically checks exact source excerpts or scalar JSON
values, producing `auto_validated`, `auto_invalidated`, `needs_evidence`,
`needs_human`, or `excluded` decisions. Missing evidence can be retried without
human approval. Semantic/business judgments are never approved merely because
their text occurs in a document.

Use `--input candidates.json --consumer <agent> --output receipt.json`, then
`--previous receipt.json --output next-receipt.json` on a later invocation. Current
sources and both profiles are rechecked every time. Outputs are never overwritten.
Exit 2 indicates unresolved evidence or judgment; exit 0 means evaluation
completed, including negative decisions, not universal approval.

The request schema is `snipara.agent_memory_pilot.v1`, with `taskId`, `producer`
and `candidates`. Each candidate contains `id`, `sourceId`, `sourceHash`
(`sha256:` plus 64 lowercase hex characters), `scope` (`agent`, `project`, `team`),
`category`, and `assertion`. Supported assertions:

```json
{ "kind": "json_value", "keys": ["replicas"], "value": 2 }
```

```json
{ "kind": "source_excerpt", "text": "Exact source passage" }
```

```json
{ "kind": "interpretation", "text": "A claim requiring judgment" }
```

Source observations are data, not instructions, execution proofs or authorization.
Requests and source files are bounded; paths must stay inside the workspace.
Use non-secret source material. The local manifest is the trust boundary; profile
aliases are not authenticated hosted identities. Receipt hashes detect drift,
not malicious forgery by a user controlling the workspace.

This pilot does not mutate hosted memory, run agents, or change the existing
hosted promotion policy. It reuses Agent Context's source and target allowlists.

The manifest must declare a stable `project.id`. Resume is bound to that project,
task and producer. Observation payloads use a conservative byte allowance capped
by the smaller profile memory budget; this is not measured model token usage.
Common credential patterns are rejected, but this is not comprehensive secret
detection. Source selection remains the responsibility of the manifest owner.
