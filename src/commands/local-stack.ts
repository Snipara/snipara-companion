import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "node:child_process";

type ExpectedSectionName = "context" | "decisions" | "impact" | "verification" | "continuity";

export interface LocalMemoryCommandOptions {
  binary?: string;
  args?: string[];
}

export interface EvalExportOptions {
  id?: string;
  name?: string;
  description?: string;
  summary?: string;
  context?: string[];
  decision?: string[];
  impact?: string[];
  verification?: string[];
  continuity?: string[];
  files?: string[];
  commandRun?: string[];
  output?: string;
  dir?: string;
  json?: boolean;
}

export interface EvalRunOptions {
  cases: string[];
  runner?: string;
  packageSpec?: string;
  json?: boolean;
  strict?: boolean;
}

export interface EvalCaseArtifact {
  id: string;
  name?: string;
  description?: string;
  tags: string[];
  expected: Partial<
    Record<
      ExpectedSectionName,
      Array<{
        id: string;
        text?: string;
        statement?: string;
        target?: string;
        check?: string;
        command?: string;
        handoff?: string;
        keywords: string[];
        files?: string[];
      }>
    >
  >;
  observed: {
    answer: string;
    filesChanged: string[];
    commandsRun: string[];
    artifacts: Array<{ path: string; content: string }>;
  };
  thresholds: {
    overall: number;
  };
}

function uniqueStrings(values?: string[]): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function keywordHints(value: string): string[] {
  return uniqueStrings(
    value
      .split(/[^A-Za-z0-9_.:/-]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 4)
      .slice(0, 8)
  );
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function maybeLocalArtifact(
  rootDir: string,
  relativePath: string
): { path: string; content: string } | null {
  const absolutePath = path.join(rootDir, relativePath);
  const value = readJsonFile(absolutePath);
  if (!value) {
    return null;
  }
  return {
    path: relativePath,
    content: JSON.stringify(value, null, 2).slice(0, 4000),
  };
}

function expectedItems(
  section: ExpectedSectionName,
  values: string[],
  files: string[]
): NonNullable<EvalCaseArtifact["expected"][ExpectedSectionName]> {
  return values.map((value, index) => {
    const id = `${section}-${index + 1}`;
    const base = {
      id,
      keywords: keywordHints(value),
      ...(section === "impact" && files.length > 0 ? { files } : {}),
    };

    switch (section) {
      case "context":
        return { ...base, text: value };
      case "decisions":
        return { ...base, statement: value };
      case "impact":
        return { ...base, target: value };
      case "verification":
        return { ...base, check: value, command: value };
      case "continuity":
        return { ...base, handoff: value };
    }
  });
}

export function buildEvalCaseArtifact(options: EvalExportOptions = {}): EvalCaseArtifact {
  const rootDir = path.resolve(options.dir ?? process.cwd());
  const files = uniqueStrings(options.files);
  const commandsRun = uniqueStrings(options.commandRun);
  const summary = options.summary?.trim() || "Snipara companion local workflow evaluation";
  const id = options.id?.trim() || slugify(summary, "snipara-companion-eval");
  const expected: EvalCaseArtifact["expected"] = {};

  const sectionInputs: Record<ExpectedSectionName, string[]> = {
    context: uniqueStrings(options.context),
    decisions: uniqueStrings(options.decision),
    impact: uniqueStrings(options.impact),
    verification: uniqueStrings(options.verification),
    continuity: uniqueStrings(options.continuity),
  };

  for (const [section, values] of Object.entries(sectionInputs) as Array<
    [ExpectedSectionName, string[]]
  >) {
    if (values.length > 0) {
      expected[section] = expectedItems(section, values, files);
    }
  }

  const artifacts = [
    maybeLocalArtifact(rootDir, path.join(".snipara", "workflow", "current.json")),
    maybeLocalArtifact(rootDir, path.join(".snipara", "team-sync", "session.json")),
  ].filter((artifact): artifact is { path: string; content: string } => artifact !== null);

  return {
    id,
    ...(options.name ? { name: options.name } : {}),
    ...(options.description ? { description: options.description } : {}),
    tags: ["snipara-companion", "mini-snipara", "local-continuity"],
    expected,
    observed: {
      answer: summary,
      filesChanged: files,
      commandsRun,
      artifacts,
    },
    thresholds: {
      overall: 70,
    },
  };
}

function writeOutput(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function runCommand(command: string, args: string[], missingHint: string): number {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    console.error(`${command} failed to start: ${result.error.message}`);
    console.error(missingHint);
    return 127;
  }

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  return typeof result.status === "number" ? result.status : 1;
}

export async function memoryLocalCommand(options: LocalMemoryCommandOptions): Promise<void> {
  const binary = options.binary || process.env.SNIPARA_MEMORY_BIN || "snipara-memory";
  const args = options.args && options.args.length > 0 ? options.args : ["--help"];
  const code = runCommand(
    binary,
    args,
    "Install the local memory engine with: pip install snipara-memory"
  );
  process.exitCode = code;
}

export async function evalExportCommand(options: EvalExportOptions): Promise<void> {
  const rootDir = path.resolve(options.dir ?? process.cwd());
  const output = path.resolve(
    rootDir,
    options.output ?? path.join(".snipara", "evals", "case.json")
  );
  const artifact = buildEvalCaseArtifact(options);
  const content = `${JSON.stringify(artifact, null, 2)}\n`;
  writeOutput(output, content);

  if (options.json) {
    console.log(JSON.stringify({ output, case: artifact }, null, 2));
    return;
  }

  console.log(`Wrote eval case: ${output}`);
  console.log(`Run with: snipara-companion eval run ${output}`);
}

export async function evalRunCommand(options: EvalRunOptions): Promise<void> {
  if (!options.cases || options.cases.length === 0) {
    throw new Error("eval run requires at least one case file");
  }

  const runner = options.runner || process.env.SNIPARA_EVALS_RUNNER || "npx";
  const packageSpec = options.packageSpec || "snipara-evals@latest";
  const args =
    path.basename(runner) === "snipara-evals"
      ? ["run", ...options.cases]
      : ["--yes", packageSpec, "run", ...options.cases];

  if (options.json) {
    args.push("--json");
  }
  if (options.strict) {
    args.push("--fail-on-threshold");
  }

  const code = runCommand(
    runner,
    args,
    "Install or run the evaluator with: npm install -g snipara-evals"
  );
  process.exitCode = code;
}
