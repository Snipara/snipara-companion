# Semantic Code Graph

`snipara-companion code impact` builds a structural graph from the current
checkout and adds a deterministic semantic model above it. The semantic layer
does not replace `CALLS`, `REFERENCES`, `IMPORTS`, or `CONTAINS` edges. It
classifies what those nodes and edges mean for a change.

## Semantic model v1

Local manifests and impact results expose `snipara.semantic.v1`. Each assertion
contains:

- `subject`: a stable local symbol key or edge identity;
- `predicate`: `public_api`, `implicit_contract`, `architecture_role`, or
  `dependency_criticality`;
- `value`: the inferred classification;
- `confidence`: a backward-compatible bounded rule-strength prior from `0` to
  `1`, explicitly qualified by `scoreKind: "heuristic_prior"` and
  `calibrated: false`;
- `source` and `extractorVersion`;
- `evidence`: the export modifier, symbol kind, file/path pattern, or graph edge
  that produced the assertion.

The extractor recognizes explicit TypeScript and Go exports, route and MCP
surfaces, exported type contracts, and common Repository, Adapter, Facade,
Controller, Service, Worker, Factory, schema, route-handler, and test roles.
`confidence` is not a probability, measured accuracy, or cross-project metric.
It is a deterministic prior used for relative ranking and explanation inside
one rule configuration. `semantic.scoreContract.basis` is
`hand-tuned-v1`; the values must be calibrated against measured outcomes before
that status can change. Name-only patterns have a lower prior than explicit
export, route, or graph evidence.

### Project naming rules

Projects can extend or replace built-in English naming conventions with
`.snipara/semantic-rules.json`:

```json
{
  "replaceDefaults": false,
  "sensitivePathTerms": ["securite", "facturation"],
  "contractPathTerms": ["contrats"],
  "testPathTerms": ["essais"],
  "architectureRoleTerms": {
    "repository": ["depot"],
    "service": ["metier"]
  }
}
```

Terms are case-insensitive literal strings, not regular expressions. Each group
is limited to 64 terms of at most 80 characters and role names are normalized.
Invalid config is reported in `semantic.ruleConfig.warnings`; it never aborts
overlay construction. Set `replaceDefaults: true` only when the project wants
configured naming terms to replace built-in naming conventions. Explicit
exports, route surfaces, and graph evidence continue to apply.

## Dependency criticality

Criticality is evaluated for symbols and for the edges traversed by impact:

- `critical`: runtime-exposed route/MCP surfaces and sensitive auth, billing,
  schema, webhook, or deploy paths;
- `important`: explicit module exports and inferred contract boundaries;
- `ordinary`: normal application dependencies without stronger evidence;
- `incidental`: test-only, containment, or weak-confidence dependencies.

Local risk scoring adds bounded `semanticRiskPoints` for critical traversed
dependencies and contracts in the changed files. The output lists the exact
assertions and the formula; callers never receive a hidden semantic multiplier.
Large impact traversals cap returned assertions at 2,000 (repository manifests
at 5,000) and report total/returned counts in `semantic.truncation`; risk uses
the complete pre-truncation counts.

## Hybrid provenance

Hybrid queries preserve hosted canonical assertions and local checkout-delta
assertions under `snipara.semantic.hybrid.v1`. Snipara unions the evidence but
does not manufacture cross-source edges or assertions.

## Historical regression paths

Hosted impact can associate sanitized warning/error execution traces with
graph paths by their tracked files. Version 1 reports sample count, an
uncalibrated shadow association strength, event IDs, and a suggested risk
delta. This surface is intentionally
`mode: shadow` and `riskContributionEnabled: false`: temporal association is
not causal proof, and it cannot affect risk until separately calibrated and
promoted.

The local overlay has no durable outcome stream, so it returns the same shadow
contract with zero samples and directs callers to hosted evidence when needed.

## Example

```bash
npx -y snipara-companion code impact \
  --source local \
  --changed-files src/auth/session-repository.ts \
  --depth 4 \
  --json
```

Inspect `result.semantic.assertions`, `result.semantic.summary`, and
`result.risk.semanticRiskPoints` in the response.
