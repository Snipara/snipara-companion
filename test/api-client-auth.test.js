const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createClient, listProjectsForApiKey } = require("../dist/index.js");

async function withTempHome(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-auth-"));
  const homeDir = path.join(tmpDir, "home");
  fs.mkdirSync(homeDir, { recursive: true });

  const previousHome = process.env.HOME;
  const previousApiKey = process.env.SNIPARA_API_KEY;
  const previousProjectId = process.env.SNIPARA_PROJECT_ID;
  const previousApiUrl = process.env.SNIPARA_API_URL;
  const previousDashboardUrl = process.env.SNIPARA_DASHBOARD_URL;
  const previousWebUrl = process.env.SNIPARA_WEB_URL;
  const previousFetch = global.fetch;

  process.env.HOME = homeDir;
  process.env.SNIPARA_API_URL = "https://api.snipara.com";
  delete process.env.SNIPARA_DASHBOARD_URL;
  delete process.env.SNIPARA_WEB_URL;

  try {
    await fn({ tmpDir, homeDir });
  } finally {
    global.fetch = previousFetch;

    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousApiKey === undefined) {
      delete process.env.SNIPARA_API_KEY;
    } else {
      process.env.SNIPARA_API_KEY = previousApiKey;
    }

    if (previousProjectId === undefined) {
      delete process.env.SNIPARA_PROJECT_ID;
    } else {
      process.env.SNIPARA_PROJECT_ID = previousProjectId;
    }

    if (previousApiUrl === undefined) {
      delete process.env.SNIPARA_API_URL;
    } else {
      process.env.SNIPARA_API_URL = previousApiUrl;
    }

    if (previousDashboardUrl === undefined) {
      delete process.env.SNIPARA_DASHBOARD_URL;
    } else {
      process.env.SNIPARA_DASHBOARD_URL = previousDashboardUrl;
    }

    if (previousWebUrl === undefined) {
      delete process.env.SNIPARA_WEB_URL;
    } else {
      process.env.SNIPARA_WEB_URL = previousWebUrl;
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("client retries with project token api key when env key gets 401", async () => {
  await withTempHome(async ({ homeDir }) => {
    process.env.SNIPARA_API_KEY = "stale-env-key";
    process.env.SNIPARA_PROJECT_ID = "snipara";

    fs.mkdirSync(path.join(homeDir, ".snipara"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".snipara", "tokens.json"),
      JSON.stringify(
        {
          proj_snipara_001: {
            project_slug: "snipara",
            project_id: "proj_snipara_001",
            api_key: "token-project-key",
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const seenKeys = [];
    global.fetch = async (_url, init) => {
      const apiKey = init.headers["X-API-Key"];
      seenKeys.push(apiKey);

      if (apiKey === "stale-env-key") {
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          json: async () => ({}),
        };
      }

      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  matched_targets: [],
                  callers: [],
                  depth: 1,
                  total_callers: 0,
                }),
              },
            ],
          },
        }),
      };
    };

    const client = createClient();
    const result = await client.codeCallers(
      "src.snipara_engine.SniparaEngine._handle_context_query"
    );

    assert.deepEqual(result.callers, []);
    assert.deepEqual(seenKeys, ["stale-env-key", "token-project-key"]);
  });
});

test("client surfaces 401 when no project token fallback exists", async () => {
  await withTempHome(async () => {
    process.env.SNIPARA_API_KEY = "stale-env-key";
    process.env.SNIPARA_PROJECT_ID = "snipara";

    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: async () => ({}),
      };
    };

    const client = createClient();

    await assert.rejects(
      () => client.codeCallers("src.snipara_engine.SniparaEngine._handle_context_query"),
      /HTTP 401: Unauthorized/
    );
    assert.equal(calls, 1);
  });
});

test("client plan sends relevance-first strategy by default", async () => {
  await withTempHome(async () => {
    process.env.SNIPARA_API_KEY = "test-key";
    process.env.SNIPARA_PROJECT_ID = "snipara";

    let payload;
    global.fetch = async (_url, init) => {
      payload = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  plan_id: "plan_test",
                  steps: [],
                }),
              },
            ],
          },
        }),
      };
    };

    const client = createClient();
    await client.plan("plan the roadmap", 3000);

    assert.equal(payload.params.name, "snipara_plan");
    assert.equal(payload.params.arguments.strategy, "relevance_first");
    assert.equal(payload.params.arguments.max_tokens, 3000);
  });
});

test("client evaluates Stuck Guard through automation API", async () => {
  await withTempHome(async () => {
    process.env.SNIPARA_API_KEY = "test-key";
    process.env.SNIPARA_PROJECT_ID = "test-project";

    let url;
    let payload;
    global.fetch = async (requestUrl, init) => {
      url = String(requestUrl);
      payload = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          success: true,
          data: {
            project: { id: "proj_1", slug: "test-project", name: "Test Project" },
            decision: {
              enabled: true,
              triggered: false,
              configuredMode: "inject",
              action: "none",
              score: 0,
              reasons: [],
              riskKeywords: [],
              memoryCheckedRecently: false,
              cooldownActive: false,
              eventCount: 1,
              evaluatedAt: "2026-05-12T10:00:00.000Z",
            },
            eventsEvaluated: 1,
          },
        }),
      };
    };

    const client = createClient();
    const result = await client.evaluateStuckGuard({
      includeRecent: false,
      events: [
        {
          type: "tool_call",
          client: "snipara-companion",
          workspace: "/tmp/repo",
          session_id: "sess_1",
          agent_id: "local-agent",
          timestamp: "2026-05-12T10:00:00.000Z",
          privacy_level: "standard",
          payload: { tool: "Grep", query: "missing" },
        },
      ],
    });

    assert.equal(url, "https://www.snipara.com/api/projects/test-project/automation/stuck-guard");
    assert.equal(payload.includeRecent, false);
    assert.equal(payload.events[0].payload.tool, "Grep");
    assert.equal(result.decision.action, "none");
  });
});

test("automation config bundle uses dashboard API URL", async () => {
  await withTempHome(async () => {
    process.env.SNIPARA_API_KEY = "test-key";
    process.env.SNIPARA_PROJECT_ID = "test-project";

    let url;
    global.fetch = async (requestUrl) => {
      url = String(requestUrl);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          success: true,
          data: {
            files: [{ path: ".claude/settings.json", content: "{}" }],
            instructions: [],
          },
        }),
      };
    };

    const client = createClient();
    const result = await client.getAutomationConfigBundle("claude-code");

    assert.equal(
      url,
      "https://www.snipara.com/api/projects/test-project/automation/config?format=files&client=claude-code"
    );
    assert.equal(result.files[0].path, ".claude/settings.json");
  });
});

test("automation config bundle prefers workspace auth over stale env key", async () => {
  await withTempHome(async ({ tmpDir }) => {
    const repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, ".snipara", "companion"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".snipara", "companion", "config.json"),
      JSON.stringify({
        apiKey: "workspace-project-key",
        projectId: "workspace-project",
        apiUrl: "https://api.snipara.com",
      }),
      "utf8"
    );
    process.env.SNIPARA_API_KEY = "stale-env-key";
    process.env.SNIPARA_PROJECT_ID = "stale-env-project";

    let url;
    let apiKey;
    global.fetch = async (requestUrl, init) => {
      url = String(requestUrl);
      apiKey = init.headers["X-API-Key"];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          success: true,
          data: {
            files: [{ path: ".claude/settings.json", content: "{}" }],
            instructions: [],
          },
        }),
      };
    };

    const client = createClient(5000, { cwd: repoDir });
    await client.getAutomationConfigBundle("claude-code");

    assert.equal(
      url,
      "https://www.snipara.com/api/projects/workspace-project/automation/config?format=files&client=claude-code"
    );
    assert.equal(apiKey, "workspace-project-key");
  });
});

test("listProjectsForApiKey uses dashboard API URL", async () => {
  await withTempHome(async () => {
    let url;
    global.fetch = async (requestUrl) => {
      url = String(requestUrl);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          success: true,
          data: [{ id: "proj_1", slug: "test-project", name: "Test Project" }],
        }),
      };
    };

    const result = await listProjectsForApiKey("test-key", "https://api.snipara.com");

    assert.equal(url, "https://www.snipara.com/api/cli/projects");
    assert.equal(result[0].slug, "test-project");
  });
});

test("queryContext requests answer packs and maps quality metadata", async () => {
  await withTempHome(async () => {
    process.env.SNIPARA_API_KEY = "test-key";
    process.env.SNIPARA_PROJECT_ID = "snipara";

    let payload;
    global.fetch = async (_url, init) => {
      payload = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  sections: [
                    {
                      title: "Agent workflow",
                      content: "Use answer_pack first.",
                      file: "AGENTS.md",
                      lines: [10, 20],
                      relevance_score: 0.9,
                      token_count: 42,
                      quality_score: 0.87,
                      quality_flags: ["is_truncated"],
                    },
                  ],
                  total_tokens: 123,
                  answer_pack: {
                    source_facts: [{ claim: "Use answer_pack first." }],
                    verification_checklist: ["Check caveats."],
                  },
                  answer_pack_included: true,
                  answer_pack_tokens: 55,
                }),
              },
            ],
          },
        }),
      };
    };

    const client = createClient();
    const result = await client.queryContext("agent workflow", 1500);

    assert.equal(payload.params.name, "snipara_context_query");
    assert.equal(payload.params.arguments.include_answer_pack, true);
    assert.equal(payload.params.arguments.include_metadata, true);
    assert.equal(result.answer_pack_included, true);
    assert.equal(result.answer_pack_tokens, 55);
    assert.equal(result.answer_pack.source_facts[0].claim, "Use answer_pack first.");
    assert.equal(result.sections[0].quality_score, 0.87);
    assert.deepEqual(result.sections[0].quality_flags, ["is_truncated"]);
  });
});

test("connection probe uses lightweight settings tool before stats", async () => {
  await withTempHome(async () => {
    process.env.SNIPARA_API_KEY = "test-key";
    process.env.SNIPARA_PROJECT_ID = "snipara";

    const seenTools = [];
    global.fetch = async (_url, init) => {
      const payload = JSON.parse(init.body);
      seenTools.push(payload.params.name);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: true }),
              },
            ],
          },
        }),
      };
    };

    const client = createClient();
    const result = await client.probeConnection();

    assert.equal(result.connected, true);
    assert.equal(result.tool, "snipara_settings");
    assert.deepEqual(seenTools, ["snipara_settings"]);
  });
});
