/** Bounded, workspace-local I/O for immutable Controller bridge artifacts. */
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

export const BRIDGE_MAX_BYTES = 2_000_000;
export function bridgeHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
export function bridgeCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(bridgeCanonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${bridgeCanonical(object[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Bridge artifacts cannot contain undefined values");
  return encoded;
}
export function bridgeLocalPath(cwd: string, file: string): string {
  const root = fs.realpathSync(cwd);
  const resolved = path.resolve(root, file);
  const relative = path.relative(root, resolved);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Bridge paths must remain inside the workspace");
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error("Bridge paths cannot use symlinks");
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  }
  return resolved;
}
export function readBridgeBytes(cwd: string, file: string, limit = BRIDGE_MAX_BYTES): Buffer {
  const resolved = bridgeLocalPath(cwd, file);
  const fd = fs.openSync(
    resolved,
    fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0)
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("Bridge source must be a regular file");
    if (stat.size > limit) throw new Error("Bridge source exceeds its byte limit");
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > limit || fs.fstatSync(fd).size > limit) {
      throw new Error("Bridge source exceeds its byte limit");
    }
    const bytes = buffer.subarray(0, size);
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
export function readBridgeSource(
  cwd: string,
  file: string
): { value: unknown; hash: string; relative: string } {
  const bytes = readBridgeBytes(cwd, file);
  return {
    value: parseBridgeJson(bytes.toString("utf8")),
    hash: bridgeHash(bytes),
    relative: path
      .relative(fs.realpathSync(cwd), bridgeLocalPath(cwd, file))
      .split(path.sep)
      .join("/"),
  };
}
/** Reject ambiguous keys and non-finite values before cross-language admission. */
export function parseBridgeJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const stack: Array<Set<string> | null> = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "{") stack.push(new Set());
    else if (char === "[") stack.push(null);
    else if (char === "}" || char === "]") stack.pop();
    else if (char === '"') {
      const start = index;
      while (++index < text.length) {
        if (text[index] === "\\") index++;
        else if (text[index] === '"') break;
      }
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] === ":") {
        const key = JSON.parse(text.slice(start, index + 1)) as string;
        const keys = stack.at(-1);
        if (!keys || keys.has(key)) throw new Error("Ambiguous duplicate artifact JSON key");
        keys.add(key);
      }
    }
    if (stack.length > 128) throw new Error("Artifact JSON exceeds its nesting bound");
  }
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Artifact JSON contains a non-finite number");
    if (Array.isArray(item)) pending.push(...item);
    else if (item !== null && typeof item === "object") pending.push(...Object.values(item));
  }
  return value;
}
export function writeBridgeImmutable(cwd: string, file: string, value: unknown): string {
  return writeBridgeImmutableBytes(cwd, file, Buffer.from(`${bridgeCanonical(value)}\n`, "utf8"));
}
/** The same no-clobber discipline for readable exports and JSON artifacts. */
export function writeBridgeImmutableBytes(cwd: string, file: string, bytes: Buffer): string {
  const resolved = bridgeLocalPath(cwd, file);
  if (bytes.length > BRIDGE_MAX_BYTES) throw new Error("Bridge artifact exceeds its byte limit");
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  bridgeLocalPath(cwd, file);
  try {
    const fd = fs.openSync(
      resolved,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600
    );
    try {
      fs.writeFileSync(fd, bytes);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
    if (bridgeHash(readBridgeBytes(cwd, file)) !== bridgeHash(bytes)) {
      throw new Error("Immutable bridge artifact collision; existing bytes differ");
    }
  }
  return bridgeHash(bytes);
}
