import * as fs from "node:fs";
import * as path from "node:path";
import {
  evaluateMemoryPilot,
  parseMemoryPilotRequest,
  resolveAgentContext,
  stableDecisionJsonStringify,
  type PilotSource,
} from "../contracts/project-intelligence";

const MAX_BYTES = 1_048_576;

function readJson(file: string): unknown {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES)
      throw new Error("Expected a bounded regular JSON file");
    const content = fs.readFileSync(fd, "utf8");
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("JSON input exceeds size limit");
    return JSON.parse(content);
  } finally {
    fs.closeSync(fd);
  }
}

function readSource(root: string, source: { id: string; path: string }): PilotSource {
  try {
    const resolved = fs.realpathSync(path.resolve(root, source.path));
    const relative = path.relative(root, resolved);
    if (
      !relative ||
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    )
      return { id: source.id, unavailable: "unsafe_path" };
    const fd = fs.openSync(
      resolved,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return { id: source.id, unavailable: "unsafe_path" };
      if (stat.size > MAX_BYTES) return { id: source.id, unavailable: "too_large" };
      const content = fs.readFileSync(fd, "utf8");
      return Buffer.byteLength(content) > MAX_BYTES
        ? { id: source.id, unavailable: "too_large" }
        : { id: source.id, content };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { id: source.id, unavailable: "missing" };
  }
}

export async function agentMemoryPilotCommand(options: {
  input: string;
  consumer: string;
  manifest?: string;
  previous?: string;
  output?: string;
  cwd?: string;
}): Promise<void> {
  const root = fs.realpathSync(options.cwd ?? process.cwd());
  const manifest = readJson(path.resolve(root, options.manifest ?? "snipara.agent-context.json"));
  const request = parseMemoryPilotRequest(readJson(path.resolve(root, options.input)));
  const producer = resolveAgentContext({
    manifest,
    agent: request.producer,
    task: request.taskId,
  });
  const consumer = resolveAgentContext({
    manifest,
    agent: options.consumer,
    task: request.taskId,
  });
  const requested = new Set(request.candidates.map((candidate) => candidate.sourceId));
  const consumerSources = new Set(consumer.sources.map((source) => source.id));
  // Never open a source merely because a candidate asks for it.
  const sources = producer.sources
    .filter((source) => requested.has(source.id) && consumerSources.has(source.id))
    .map((source) => readSource(root, source));
  const receipt = evaluateMemoryPilot({
    manifest,
    request,
    consumer: options.consumer,
    sources,
    previous: options.previous ? readJson(path.resolve(root, options.previous)) : undefined,
  });
  const serialized = `${stableDecisionJsonStringify(receipt)}\n`;
  if (options.output) {
    // Append-only by filename: no --force; replays must use a new receipt.
    fs.writeFileSync(path.resolve(root, options.output), serialized, {
      flag: "wx",
      mode: 0o600,
    });
  }
  console.log(serialized.trimEnd());
  if (
    receipt.decisions.some(
      (decision) => decision.outcome === "needs_evidence" || decision.outcome === "needs_human"
    )
  )
    process.exitCode = 2;
}
