const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function withTempHome(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-cache-"));
  const homeDir = path.join(tmpDir, "home");
  fs.mkdirSync(homeDir, { recursive: true });

  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    fn({ tmpDir, homeDir });
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function loadCacheModule() {
  const modulePath = require.resolve("../dist/index.js");
  delete require.cache[modulePath];
  return require("../dist/index.js");
}

function sampleResult(query, title = "Auth Overview") {
  return {
    sections: [
      {
        title,
        content: "Auth middleware validates bearer tokens before request routing.",
        file: "src/auth.ts",
        lines: [10, 40],
        relevance_score: 0.95,
        token_count: 42,
        truncated: false,
      },
    ],
    total_tokens: 42,
    max_tokens: 8000,
    query,
    suggestions: [],
  };
}

test("local query cache reuses exact entries within the same workspace and options", () => {
  withTempHome(({ tmpDir }) => {
    const { createLocalQueryCache } = loadCacheModule();
    const repoDir = path.join(tmpDir, "repo");
    const nestedDir = path.join(repoDir, "src");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.mkdirSync(nestedDir, { recursive: true });

    const cache = createLocalQueryCache({
      cwd: nestedDir,
      projectId: "project-alpha",
      sessionId: "sess_alpha",
    });

    cache.save(
      { query: `Read ${path.join(repoDir, "src", "auth.ts")} auth middleware`, maxTokens: 8000 },
      sampleResult("auth middleware")
    );

    const hit = cache.lookup({
      query: `Read ${path.join(repoDir, "src", "auth.ts")} auth middleware`,
      maxTokens: 8000,
    });

    assert.ok(hit);
    assert.equal(hit.strategy, "exact");
    assert.equal(hit.result.sections[0].file, "src/auth.ts");

    const miss = cache.lookup({
      query: `Read ${path.join(repoDir, "src", "auth.ts")} auth middleware`,
      maxTokens: 4000,
    });
    assert.equal(miss, null);
  });
});

test("local query cache can reuse nearby queries in the same workspace", () => {
  withTempHome(({ tmpDir }) => {
    const { createLocalQueryCache } = loadCacheModule();
    const repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });

    const cache = createLocalQueryCache({
      cwd: repoDir,
      projectId: "project-alpha",
      sessionId: "sess_alpha",
    });

    cache.save(
      { query: "Read src/auth.ts auth middleware bearer tokens", maxTokens: 8000 },
      sampleResult("auth middleware")
    );

    const hit = cache.lookup({
      query: "Grep src/auth.ts auth middleware bearer tokens",
      maxTokens: 8000,
    });

    assert.ok(hit);
    assert.equal(hit.strategy, "nearby");
    assert.ok(hit.similarity >= 0.82);
  });
});

test("warm snapshot provides a session-local fallback when no exact entry exists", () => {
  withTempHome(({ tmpDir }) => {
    const { createLocalQueryCache } = loadCacheModule();
    const repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });

    const cache = createLocalQueryCache({
      cwd: repoDir,
      projectId: "project-alpha",
      sessionId: "sess_alpha",
    });

    const stored = cache.storeWarmSnapshot({
      critical: {
        memories: [
          {
            title: "Pricing Strategy",
            text: "Pricing strategy keeps the Team plan at $149 per month and pushes enterprise upsell.",
          },
        ],
        count: 1,
        tokens: 24,
      },
      daily: {
        memories: [],
        count: 0,
        tokens: 0,
      },
      total_tokens: 120,
    });

    assert.equal(stored.storedEntries, 1);

    const hit = cache.lookup({
      query: "pricing strategy for the team plan",
      maxTokens: 8000,
    });

    assert.ok(hit);
    assert.equal(hit.strategy, "warm");
    assert.equal(hit.sourceQuery, "session-bootstrap");
    assert.match(hit.result.sections[0].content, /Team plan at \$149/i);
  });
});

test("workspace scoping prevents reuse across repositories", () => {
  withTempHome(({ tmpDir }) => {
    const { createLocalQueryCache } = loadCacheModule();
    const repoOne = path.join(tmpDir, "repo-one");
    const repoTwo = path.join(tmpDir, "repo-two");
    fs.mkdirSync(path.join(repoOne, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repoTwo, ".git"), { recursive: true });

    const cacheOne = createLocalQueryCache({
      cwd: repoOne,
      projectId: "project-alpha",
      sessionId: "sess_alpha",
    });

    cacheOne.save(
      { query: "Read src/licensing.ts enterprise edition", maxTokens: 8000 },
      sampleResult("enterprise edition", "Licensing")
    );

    const cacheTwo = createLocalQueryCache({
      cwd: repoTwo,
      projectId: "project-alpha",
      sessionId: "sess_beta",
    });

    const hit = cacheTwo.lookup({
      query: "Read src/licensing.ts enterprise edition",
      maxTokens: 8000,
    });

    assert.equal(hit, null);
  });
});
