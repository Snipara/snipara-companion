const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildOnboardFolderManifest,
  buildSyncDocumentsDryRun,
  collectSyncDocumentsInput,
} = require("../dist/index.js");

const cliPath = path.join(__dirname, "..", "dist", "index.js");

function withTempManifest(payload, callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-manifest-"));
  const file = path.join(dir, "manifest.json");
  fs.writeFileSync(file, JSON.stringify(payload), "utf8");
  try {
    return callback(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("sync manifest applies metadata defaults and workflow defaults", () => {
  withTempManifest(
    {
      dryRun: true,
      reindex: true,
      reindexKind: "doc",
      metadata: {
        assetClass: "BUSINESS_DOCUMENT",
        usageMode: "current_truth",
        sourceKind: "google_drive",
        freshnessPolicy: { maxAgeDays: 30 },
      },
      documents: [
        {
          path: "clients/xyz/current.md",
          content: "# Current",
          metadata: {
            clientId: "xyz",
            sourceSnapshotAt: "2026-03-01T10:00:00Z",
          },
        },
        {
          path: "references/acme/diagram.md",
          content: "# Diagram",
          metadata: {
            assetClass: "DIAGRAM",
            usageMode: "historical_reference",
            sourceKind: "upload",
            referenceProvenance: {
              sourceClientId: "acme",
              sourceProjectId: "network-redesign",
            },
          },
        },
      ],
    },
    (file) => {
      const collected = collectSyncDocumentsInput({ file });
      assert.equal(collected.manifestOptions.dryRun, true);
      assert.equal(collected.manifestOptions.reindex, true);
      assert.equal(collected.documents.length, 2);
      assert.equal(collected.documents[0].kind, "DOC");
      assert.equal(collected.documents[0].format, "md");
      assert.equal(collected.documents[0].metadata.assetClass, "BUSINESS_DOCUMENT");
      assert.equal(collected.documents[0].metadata.sourceKind, "google_drive");
      assert.equal(collected.documents[1].kind, "DOC");
      assert.equal(collected.documents[1].format, "md");
      assert.equal(collected.documents[1].metadata.assetClass, "DIAGRAM");
      assert.equal(collected.documents[1].metadata.usageMode, "historical_reference");

      const dryRun = buildSyncDocumentsDryRun(collected.documents, {
        reindex: true,
        reindexKind: "doc",
        now: new Date("2026-04-25T12:00:00Z"),
      });
      assert.equal(dryRun.total, 2);
      assert.equal(dryRun.invalid_metadata, 0);
      assert.equal(dryRun.stale, 1);
      assert.equal(dryRun.needs_reupload, 1);
      assert.equal(dryRun.needs_metadata_review, 0);
      assert.equal(dryRun.documents[0].recommended_action, "reupload");
      assert.equal(dryRun.documents[0].kind, "DOC");
      assert.equal(dryRun.documents[0].format, "md");
      assert.equal(dryRun.documents[0].content_hash.length, 64);
      assert.match(dryRun.documents[0].reasons.join(","), /source_snapshot_expired/);
    }
  );
});

test("sync directory collects supported binary parser files as base64", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-sync-dir-"));
  try {
    fs.mkdirSync(path.join(dir, "nested"));
    fs.writeFileSync(path.join(dir, "notes.md"), "# Notes", "utf8");
    fs.writeFileSync(path.join(dir, "nested", "network.vsdx"), Buffer.from("vsdx-bytes"));
    fs.writeFileSync(path.join(dir, "ignored.png"), Buffer.from("png"));

    const collected = collectSyncDocumentsInput({ dir, recursive: true, prefix: "business" });

    assert.deepEqual(
      collected.documents.map((document) => ({
        path: document.path,
        kind: document.kind,
        format: document.format,
      })),
      [
        { path: "business/nested/network.vsdx", kind: "BINARY", format: "vsdx" },
        { path: "business/notes.md", kind: "DOC", format: "md" },
      ]
    );
    assert.match(collected.documents[0].content, /^base64:/);

    const dryRun = buildSyncDocumentsDryRun(collected.documents, {
      now: new Date("2026-04-25T12:00:00Z"),
    });

    assert.equal(dryRun.total, 2);
    assert.equal(dryRun.invalid_metadata, 0);
    assert.equal(dryRun.documents[0].size_bytes, Buffer.byteLength("vsdx-bytes"));
    assert.equal(dryRun.documents[0].content_hash.length, 64);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sync dry-run rejects raw binary payloads in manifests", () => {
  const dryRun = buildSyncDocumentsDryRun(
    [
      {
        path: "diagrams/network.vsdx",
        content: "raw-vsdx-bytes",
        kind: "BINARY",
        format: "vsdx",
      },
    ],
    { now: new Date("2026-04-25T12:00:00Z") }
  );

  assert.equal(dryRun.invalid_metadata, 1);
  assert.equal(dryRun.documents[0].status, "invalid_metadata");
  assert.deepEqual(dryRun.documents[0].reasons, ["binary_content_must_be_base64"]);
});

test("sync dry-run reports invalid known metadata", () => {
  const dryRun = buildSyncDocumentsDryRun(
    [
      {
        path: "bad.md",
        content: "# Bad",
        metadata: {
          assetClass: "BUSINESS_DOC",
          usageMode: "current_truth",
          sourceKind: "unknown_provider",
          freshnessPolicy: { maxAgeDays: 0 },
        },
      },
    ],
    { now: new Date("2026-04-25T12:00:00Z") }
  );

  assert.equal(dryRun.invalid_metadata, 1);
  assert.equal(dryRun.would_sync, 0);
  assert.equal(dryRun.documents[0].status, "invalid_metadata");
  assert.deepEqual(dryRun.documents[0].reasons.slice(0, 3), [
    "invalid_asset_class",
    "invalid_source_kind",
    "invalid_freshness_policy_max_age_days",
  ]);
});

test("sync-documents dry-run does not require hosted MCP config", () => {
  withTempManifest(
    {
      documents: [
        {
          path: "docs/spec.md",
          content: "# Spec",
          metadata: {
            assetClass: "BUSINESS_DOCUMENT",
            usageMode: "current_truth",
            sourceSnapshotAt: "2026-04-25T10:30:00Z",
          },
        },
      ],
    },
    (file) => {
      const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-home-"));
      const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-cwd-"));
      try {
        const result = spawnSync(
          process.execPath,
          [cliPath, "sync-documents", "--file", file, "--dry-run", "--json"],
          {
            cwd: isolatedCwd,
            encoding: "utf8",
            env: {
              ...process.env,
              HOME: isolatedHome,
              SNIPARA_API_KEY: "",
              SNIPARA_PROJECT_ID: "",
              SNIPARA_SESSION_ID: "",
            },
          }
        );

        assert.equal(result.status, 0, result.stderr);
        const payload = JSON.parse(result.stdout);
        assert.equal(payload.dry_run, true);
        assert.equal(payload.total, 1);
        assert.equal(payload.remote_diff_available, false);
      } finally {
        fs.rmSync(isolatedHome, { recursive: true, force: true });
        fs.rmSync(isolatedCwd, { recursive: true, force: true });
      }
    }
  );
});

test("onboard-folder classifies a business folder and adds business metadata", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-onboard-business-"));
  try {
    fs.mkdirSync(path.join(dir, "client-notes"));
    fs.writeFileSync(path.join(dir, "client-notes", "discovery.md"), "# Discovery", "utf8");
    fs.writeFileSync(path.join(dir, "proposal.pdf"), Buffer.from("%PDF"));
    fs.writeFileSync(path.join(dir, "budget.xlsx"), Buffer.from("sheet"));

    const manifest = buildOnboardFolderManifest({
      dir,
      prefix: "clients/acme",
      snapshotAt: "2026-04-25T12:00:00Z",
      sourceProvider: "chatgpt_drive",
      sourceKind: "llm_connector",
      clientId: "acme",
    });

    assert.equal(manifest.classification.mode, "business_context");
    assert.equal(manifest.summary.supported_documents, 2);
    assert.equal(manifest.summary.unsupported_business_files, 1);
    assert.equal(manifest.sync.documents[0].path, "clients/acme/client-notes/discovery.md");
    assert.equal(manifest.sync.documents[0].metadata.usageMode, "current_truth");
    assert.equal(manifest.sync.documents[0].metadata.assetClass, "BUSINESS_DOCUMENT");
    assert.equal(manifest.sync.documents[0].metadata.sourceProvider, "chatgpt_drive");
    assert.equal(manifest.sync.documents[0].metadata.sourceKind, "llm_connector");
    assert.equal(manifest.sync.documents[0].metadata.extractionMethod, "llm_client_connector");
    assert.equal(manifest.dryRun.invalid_metadata, 0);
    assert.match(manifest.sync.documents[1].content, /^base64:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("onboard-folder detects mixed repos and separates repo docs from business context", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-onboard-mixed-"));
  try {
    fs.mkdirSync(path.join(dir, "src"));
    fs.mkdirSync(path.join(dir, "client"));
    fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
    fs.writeFileSync(path.join(dir, "README.md"), "# Repo", "utf8");
    fs.writeFileSync(path.join(dir, "src", "index.ts"), "export {}", "utf8");
    fs.writeFileSync(path.join(dir, "client", "proposal.docx"), Buffer.from("docx"));

    const manifest = buildOnboardFolderManifest({
      dir,
      snapshotAt: "2026-04-25T12:00:00Z",
    });

    assert.equal(manifest.classification.mode, "mixed");
    const readme = manifest.sync.documents.find((document) => document.path === "README.md");
    const proposal = manifest.sync.documents.find(
      (document) => document.path === "client/proposal.docx"
    );

    assert.equal(readme.metadata.contextLane, "repo_docs");
    assert.equal(proposal.metadata.contextLane, "business_context");
    assert.equal(proposal.metadata.assetClass, "BUSINESS_DOCUMENT");
    assert.match(manifest.warnings.join("\n"), /mixed/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("onboard-folder CLI preview does not require hosted MCP config and can write a sync manifest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-onboard-cli-"));
  const output = path.join(dir, "snipara-onboard.json");
  try {
    fs.writeFileSync(path.join(dir, "notes.md"), "# Notes", "utf8");

    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-home-"));
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "onboard-folder",
        dir,
        "--json",
        "--write-manifest",
        output,
        "--snapshot-at",
        "2026-04-25T12:00:00Z",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: isolatedHome,
          SNIPARA_API_KEY: "",
          SNIPARA_PROJECT_ID: "",
          SNIPARA_SESSION_ID: "",
        },
      }
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schemaVersion, "snipara.onboard-folder.v1");
    assert.equal(payload.dryRun.dry_run, true);
    assert.equal(payload.sync.documents.length, 1);

    const syncManifest = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(syncManifest.documents.length, 1);
    assert.equal(syncManifest.onboarding.schemaVersion, "snipara.onboard-folder.v1");
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
