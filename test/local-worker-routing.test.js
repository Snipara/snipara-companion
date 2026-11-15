// Parity of the TypeScript local worker routing with the Python implementation it
// replaces (snipara-orchestrator 2.0.0). The expected payloads in the fixture were
// produced by that implementation; see test/fixtures/generate_local_worker_routing_parity.py.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fixtures = require("./fixtures/local-worker-routing-parity.json");
const {
  resolveWorkerCandidates,
  buildLocalModelCatalog,
  buildLocalModelCatalogFromRecords,
  sanitizeCandidateId,
} = require("../dist/index.js");

const camel = (options) => ({
  baseUrl: options.base_url,
  provider: options.provider,
  model: options.model,
  preferModel: options.prefer_model,
  workerRole: options.worker_role,
  writeScope: options.write_scope,
  capabilities: options.capabilities,
  allModels: options.all_models,
  apiKeyEnv: options.api_key_env,
  apiKeyHeader: options.api_key_header,
});

for (const item of fixtures.resolver) {
  test(`resolver parity: ${item.name}`, () => {
    const actual = resolveWorkerCandidates({
      workProfile: item.workProfile,
      requirements: item.requirements,
      candidates: item.candidates,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), item.expected);
  });
}

for (const item of fixtures.catalog) {
  test(`catalog parity: ${item.name}`, () => {
    const actual = buildLocalModelCatalogFromRecords(camel(item.options), item.modelRecords);
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), item.expected);
  });
}

test("candidate ids match the Python sanitiser", () => {
  for (const item of fixtures.candidateIds) {
    assert.equal(sanitizeCandidateId(item.input), item.expected, JSON.stringify(item.input));
  }
});

test("the catalog never carries the provider key itself", () => {
  process.env.SNIPARA_PARITY_KEY = "not-a-real-key";
  const catalog = buildLocalModelCatalogFromRecords(
    { apiKeyEnv: "SNIPARA_PARITY_KEY", apiKeyHeader: "x-api-key" },
    [{ id: "devstral" }]
  );
  assert.doesNotMatch(JSON.stringify(catalog), /not-a-real-key/);
});

test("remote and credential-bearing endpoints are refused before any request", () => {
  assert.throws(
    () => buildLocalModelCatalogFromRecords({ baseUrl: "http://10.0.0.5:1234" }, []),
    /require explicit allow_remote/
  );
  assert.throws(
    () => buildLocalModelCatalogFromRecords({ baseUrl: "http://u:p@127.0.0.1:1234" }, []),
    /Credentials are forbidden/
  );
  assert.throws(
    () => buildLocalModelCatalogFromRecords({ baseUrl: "ftp://127.0.0.1" }, []),
    /HTTP\(S\) URL/
  );
  assert.throws(
    () => buildLocalModelCatalogFromRecords({ preferModel: "missing" }, [{ id: "devstral" }]),
    /No \/v1\/models entry matched --prefer-model 'missing'\. Available models: devstral/
  );
});

test("buildLocalModelCatalog probes /v1/models over HTTP and sends the key header", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, key: req.headers["x-api-key"], auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: [{ id: "text-embedding-x" }, { id: "qwen/qwen3-coder-30b", max_context: 32768 }],
      })
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  process.env.SNIPARA_PARITY_KEY = "probe-key";
  try {
    const catalog = await buildLocalModelCatalog({
      baseUrl: `http://127.0.0.1:${port}/`,
      apiKeyEnv: "SNIPARA_PARITY_KEY",
      apiKeyHeader: "x-api-key",
    });
    assert.deepEqual(seen, [{ url: "/v1/models", key: "probe-key", auth: undefined }]);
    assert.equal(catalog.baseUrl, `http://127.0.0.1:${port}`);
    assert.deepEqual(catalog.models, ["text-embedding-x", "qwen/qwen3-coder-30b"]);
    assert.equal(catalog.candidates.length, 1);
    assert.equal(catalog.candidates[0].workerProfileId, "local-qwen3-coder-long-context");
    assert.doesNotMatch(JSON.stringify(catalog), /probe-key/);
  } finally {
    server.close();
  }
});

test("buildLocalModelCatalog reports an unreachable server with its URL", async () => {
  await assert.rejects(
    buildLocalModelCatalog({ baseUrl: "http://127.0.0.1:9" }),
    /Unable to read http:\/\/127\.0\.0\.1:9\/v1\/models:/
  );
});
