"""Generate the parity fixtures for `src/runtime/local-worker-routing.ts`.

The TypeScript module replaces two `snipara-orchestrator` subprocess calls that
Companion made: `route --dry-run --json` and `local-model-catalog --json`. These
fixtures are produced by the real Python implementation (snipara-orchestrator
2.0.0, `routing/resolver.py` and the catalog helpers in `cli.py`), so the port is
held to the exact behaviour it replaces. See
docs/planning/orchestrator-fold-20261115/PLAN.md.

Regenerate from the repository root, while the Python package still exists:

    PYTHONPATH=packages/agentic-orchestrator/src \
      python3 packages/cli/test/fixtures/generate_local_worker_routing_parity.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from snipara_orchestrator import cli
from snipara_orchestrator.models import ModelRequirements, WorkProfile
from snipara_orchestrator.routing.resolver import DynamicModelResolver

OUT = Path(__file__).with_name("local-worker-routing-parity.json")

LOCAL = "http://127.0.0.1:1234"


def catalog_candidate(model: str, **overrides):
    """A candidate exactly as `local-model-catalog` emits it (metadata stripped)."""
    candidate = cli.build_openai_compatible_candidate(
        base_url=LOCAL,
        model=model,
        provider="lm-studio",
        worker_role=overrides.pop("worker_role", "coding"),
        write_scope=overrides.pop("write_scope", ["src/**"]),
        capabilities=overrides.pop("capabilities", None),
        context_window=overrides.pop("context_window", None),
    ).to_payload()
    candidate.update(overrides)
    return candidate


def base(candidate_id: str, **fields):
    record = {
        "candidateId": candidate_id,
        "workerClass": "coding",
        "catalogSource": "runtime",
        "endpointType": "cloud",
        "workerRoles": ["coding"],
        "capabilities": ["code_edit"],
        "writeScope": ["src/**"],
    }
    record.update(fields)
    return record


REQ = {"workerRole": "coding", "capabilities": ["code_edit"], "writeScope": ["src/app.ts"]}

RESOLVER_CASES = [
    ("no candidates fails closed", {}, REQ, []),
    ("devstral selected with planner reasoning and strict output",
     {"taskType": "refactor", "risk": "low", "preferredProfileStrengths": ["refactor", "code"]},
     {**REQ, "plannerRetainsReasoning": True, "structuredOutputRequired": True, "preferredEndpointTypes": ["local"]},
     [catalog_candidate("ggml-org/devstral-small-2-24b")]),
    ("unavailable", {}, REQ, [base("a", isAvailable=False)]),
    ("missing capability", {}, {**REQ, "capabilities": ["code_edit", "test_generation"]}, [base("a")]),
    ("forbidden capability by default", {}, REQ, [base("a", capabilities=["code_edit", "secrets"])]),
    ("write scope outside the catalog", {}, {**REQ, "writeScope": ["docs/readme.md"]}, [base("a")]),
    ("write scope with traversal", {}, {**REQ, "writeScope": ["src/../etc/passwd"]}, [base("a")]),
    ("context budget below", {}, {**REQ, "contextBudget": "large"}, [base("a", contextBudget="small")]),
    ("reasoning below without planner", {}, {**REQ, "reasoning": "high"}, [base("a", reasoning="low")]),
    ("reasoning below but planner retains it", {}, {**REQ, "reasoning": "high", "plannerRetainsReasoning": True}, [base("a", reasoning="low")]),
    ("endpoint type not allowed", {}, {**REQ, "allowedEndpointTypes": ["local"]}, [base("a")]),
    ("role mismatch", {}, {**REQ, "workerRole": "review"}, [base("a")]),
    ("privacy class mismatch", {}, {**REQ, "privacyClass": "local"}, [base("a", metadata={"privacyClass": "cloud"})]),
    ("risk above the candidate ceiling", {"risk": "high"}, REQ, [base("a", metadata={"riskCeiling": "low"})]),
    ("local endpoint that is not loopback", {}, REQ, [base("a", endpointType="local", metadata={"baseUrl": "http://10.0.0.5:1234"})]),
    ("local endpoint with credentials in the URL", {}, REQ, [base("a", endpointType="local", metadata={"baseUrl": "http://u:p@127.0.0.1:1234"})]),
    ("worker registry entry without a base URL", {}, REQ, [base("a", endpointType="local", catalogSource="worker_registry")]),
    ("cli transport counts as loopback", {}, REQ, [base("a", endpointType="local", catalogSource="worker_registry", metadata={"transport": {"kind": "cli"}})]),
    ("declared CLI worker as Companion builds it", {"taskType": "documentation"}, {**REQ, "capabilities": [], "writeScope": []},
     [base("codex_app_server", catalogSource="declared_cli_worker", endpointType="local", capabilities=[], writeScope=[],
           isAvailable=True, requiresApiKey=False, metadata={"adapter": "codex_app_server", "command": None})]),
    ("preferred endpoint wins, then id", {}, {**REQ, "preferredEndpointTypes": ["local"]},
     [base("z-cloud"), base("b-local", endpointType="local"), base("a-local", endpointType="local")]),
    ("no preference picks the smallest id", {}, REQ, [base("m"), base("c"), base("x")]),
    ("auto low risk", {"risk": "low"}, {**REQ, "policyMode": "auto_low_risk", "approvalRequired": False}, [base("a")]),
    ("auto low risk refused for medium risk", {"risk": "medium"}, {**REQ, "policyMode": "auto_low_risk", "approvalRequired": False}, [base("a")]),
    ("unknown policy mode falls back to approval", {"risk": "low"}, {**REQ, "policyMode": "yolo", "approvalRequired": False}, [base("a")]),
    ("single star scope", {}, {**REQ, "writeScope": ["src/a.ts"]}, [base("a", writeScope=["src/*"])]),
    ("single star does not cross directories", {}, {**REQ, "writeScope": ["src/a/b.ts"]}, [base("a", writeScope=["src/*"])]),
    ("fnmatch star crosses directories", {}, {**REQ, "writeScope": ["docs/guide/a.md"]}, [base("a", writeScope=["*.md"])]),
    ("fnmatch is case sensitive", {}, {**REQ, "writeScope": ["Src/a.ts"]}, [base("a", writeScope=["src/**"])]),
    ("fnmatch class with a literal closing bracket", {}, {**REQ, "writeScope": ["src/].ts"]}, [base("a", writeScope=["src/[]].ts"])]),
    ("fnmatch negated class", {}, {**REQ, "writeScope": ["src/b.ts"]}, [base("a", writeScope=["src/[!a].ts"])]),
    ("fnmatch negated class rejects its member", {}, {**REQ, "writeScope": ["src/a.ts"]}, [base("a", writeScope=["src/[!a].ts"])]),
    ("fnmatch negated class with a leading closing bracket", {}, {**REQ, "writeScope": ["src/a.ts"]}, [base("a", writeScope=["src/[!]].ts"])]),
    ("fnmatch range", {}, {**REQ, "writeScope": ["src/m.ts"]}, [base("a", writeScope=["src/[a-z].ts"])]),
    ("fnmatch reversed range matches nothing", {}, {**REQ, "writeScope": ["src/m.ts"]}, [base("a", writeScope=["src/[z-a].ts"])]),
    ("fnmatch reversed range keeps its neighbours", {}, {**REQ, "writeScope": ["src/x.ts"]}, [base("a", writeScope=["src/[xz-a].ts"])]),
    ("fnmatch trailing hyphen is literal", {}, {**REQ, "writeScope": ["src/-.ts"]}, [base("a", writeScope=["src/[a-].ts"])]),
    ("fnmatch chained ranges", {}, {**REQ, "writeScope": ["src/d.ts"]}, [base("a", writeScope=["src/[a-c-e].ts"])]),
    ("fnmatch unclosed bracket is literal", {}, {**REQ, "writeScope": ["src/[a.ts"]}, [base("a", writeScope=["src/[a.ts"])]),
    ("fnmatch caret is literal in a class", {}, {**REQ, "writeScope": ["src/^.ts"]}, [base("a", writeScope=["src/[^].ts"])]),
    ("fnmatch leading bracket in a class", {}, {**REQ, "writeScope": ["src/[.ts"]}, [base("a", writeScope=["src/[[].ts"])]),
    ("fnmatch set operator characters are literal", {}, {**REQ, "writeScope": ["src/~.ts"]}, [base("a", writeScope=["src/[&~|].ts"])]),
    ("fnmatch question mark", {}, {**REQ, "writeScope": ["src/ab.ts"]}, [base("a", writeScope=["src/a?.ts"])]),
    ("fnmatch regex metacharacters are literal", {}, {**REQ, "writeScope": ["src/a+(b).ts"]}, [base("a", writeScope=["src/a+(b).ts"])]),
    ("fnmatch literal hyphen next to a star", {}, {**REQ, "writeScope": ["src/my-file.ts"]}, [base("a", writeScope=["src/my-*.ts"])]),
    ("fnmatch literal hyphen next to a star rejects a non-match", {}, {**REQ, "writeScope": ["src/myXfile.ts"]}, [base("a", writeScope=["src/my-*.ts"])]),
    ("fnmatch punctuation outside a class is literal", {}, {**REQ, "writeScope": ["src/x-{}=,~#&%@!'\\\"+()$^|.;:<>`]y.ts"]}, [base("a", writeScope=["src/*-{}=,~#&%@!'\\\"+()$^|.;:<>`]y.ts"])]),
    ("fnmatch punctuation outside a class rejects a non-match", {}, {**REQ, "writeScope": ["src/xy.ts"]}, [base("a", writeScope=["src/*-{}=,~#&%@!'\\\"+()$^|.;:<>`]y.ts"])]),
    ("fnmatch question mark next to a hyphen", {}, {**REQ, "writeScope": ["src/a-b.ts"]}, [base("a", writeScope=["src/a-?.ts"])]),
    ("double star everywhere", {}, {**REQ, "writeScope": ["anything/deep/x"]}, [base("a", writeScope=["**"])]),
    ("backslashes and empty segments normalised", {}, {**REQ, "writeScope": ["src\\\\nested//file.ts"]}, [base("a", writeScope=["src/**"])]),
    ("no requested scope always allowed", {}, {**REQ, "writeScope": []}, [base("a", writeScope=[])]),
    ("requested scope but candidate has none", {}, REQ, [base("a", writeScope=[])]),
    ("snake case inputs", {"task_type": "tests", "risk": "low"}, {"worker_role": "coding", "capabilities": ["code_edit"], "write_scope": ["src/x"]},
     [{"candidate_id": "s", "worker_class": "coding", "catalog_source": "runtime", "worker_roles": ["coding"], "capabilities": ["code_edit"], "write_scope": ["src/**"]}]),
    ("level aliases", {}, {**REQ, "contextBudget": "normal", "reasoning": "balanced"}, [base("a", contextBudget="medium", reasoning="minimal")]),
    ("high timeout risk and format risk warnings", {}, {**REQ, "structuredOutputRequired": True},
     [catalog_candidate("qwen3-coder-30b"), catalog_candidate("devstral-small")]),
]

MODELS = [
    {"id": "text-embedding-nomic-embed-text-v1.5"},
    {"id": "ggml-org/devstral-small-2-24b-instruct-2512-gguf", "context_length": "131072"},
    {"id": "qwen/qwen3-coder-30b", "max_context": 32768},
    {"id": "openai/gpt-oss-20b"},
]

CATALOG_CASES = [
    ("all models", {"all_models": True}, MODELS),
    ("default single model skips embeddings", {}, MODELS),
    ("prefer model", {"prefer_model": "QWEN"}, MODELS),
    ("explicit model absent from the server", {"model": "unknown-model"}, MODELS),
    ("explicit model matched by substring", {"model": "gpt-oss"}, MODELS),
    ("no models at all", {}, []),
    ("only embeddings", {}, [{"id": "nomic-embed"}, "bge-reranker"]),
    ("review role default capabilities and write scope", {"worker_role": "review", "write_scope": ["docs/**"]}, MODELS[:2]),
    ("explicit capabilities", {"capabilities": ["code_edit", "test_generation"]}, MODELS[:2]),
    ("api key environment", {"api_key_env": "SNIPARA_PARITY_KEY", "api_key_header": "x-api-key"}, MODELS[1:2]),
    ("string model records", {}, ["  model-a  ", "", {"id": ""}, {"no": "id"}]),
]


def catalog_payload(options, records):
    """Reproduce `local-model-catalog --json` with verify_models after the fetch."""
    base_url = options.get("base_url", LOCAL)
    worker_role = options.get("worker_role", "coding")
    model_records = cli.coerce_openai_model_records(records)
    model_ids = [r["id"] for r in model_records if isinstance(r.get("id"), str) and r["id"]]
    resolved = options.get("model")
    if not resolved:
        if options.get("prefer_model"):
            resolved = cli.choose_preferred_model(model_ids, options["prefer_model"])
        else:
            resolved = cli.choose_default_model(model_ids)
    capabilities = options.get("capabilities")
    return cli.openai_compatible_catalog_payload(
        base_url=base_url,
        provider=options.get("provider", "lm-studio"),
        model=resolved,
        worker_role=worker_role,
        write_scope=options.get("write_scope", []),
        capabilities=capabilities if capabilities is not None else cli.default_capabilities_for_worker(worker_role),
        model_records=model_records,
        all_model_ids=model_ids,
        emit_all_models=options.get("all_models", False),
        api_key_env=options.get("api_key_env"),
        api_key_header=options.get("api_key_header", "authorization"),
    )


def main() -> None:
    resolver = []
    for name, work_profile, requirements, candidates in RESOLVER_CASES:
        result = DynamicModelResolver().resolve(
            work_profile=WorkProfile(**work_profile),
            requirements=ModelRequirements(**requirements),
            candidates=json.loads(json.dumps(candidates)),
        )
        resolver.append({"name": name, "workProfile": work_profile, "requirements": requirements,
                         "candidates": candidates, "expected": result.to_payload()})
    os.environ["SNIPARA_PARITY_KEY"] = "not-a-real-key"
    catalog = [{"name": n, "options": o, "modelRecords": r, "expected": catalog_payload(o, r)} for n, o, r in CATALOG_CASES]
    ids = [{"input": v, "expected": cli.sanitize_candidate_id(v)}
           for v in ["LM-Studio", "http://127.0.0.1:1234", "ggml-org/Devstral_Small:Q4", "Ünïcode Modèle", "///", ""]]
    OUT.write_text(json.dumps({"source": "snipara-orchestrator 2.0.0", "resolver": resolver, "catalog": catalog,
                               "candidateIds": ids}, indent=1, ensure_ascii=False, default=str) + "\n")
    print(f"{len(resolver)} resolver cases, {len(catalog)} catalog cases, {len(ids)} id cases -> {OUT}")


if __name__ == "__main__":
    main()
