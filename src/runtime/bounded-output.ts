/**
 * Bounds a JSON value for an agent's context: long arrays keep their first items and say how many
 * were left out, long strings are cut, and named heavy keys are dropped. Commands print the bounded
 * value by default and the full one with `--detail`.
 */
export interface BoundOptions {
  maxItems?: number;
  maxChars?: number;
  dropKeys?: readonly string[];
}

export function boundJson(value: unknown, options: BoundOptions = {}): unknown {
  const maxItems = options.maxItems ?? 8;
  const maxChars = options.maxChars ?? 600;
  const drop = new Set(options.dropKeys ?? []);
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return node.length > maxChars
        ? `${node.slice(0, maxChars)}… (${node.length - maxChars} more characters)`
        : node;
    }
    if (Array.isArray(node)) {
      const kept = node.slice(0, maxItems).map(walk);
      return node.length > maxItems ? [...kept, { omitted: node.length - maxItems }] : kept;
    }
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (!drop.has(key)) out[key] = walk(child);
      }
      return out;
    }
    return node;
  };
  return walk(value);
}

/** Counts by a string field, for a list too long to print. */
export function countBy(items: readonly unknown[], field: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key =
      item && typeof item === "object" ? String((item as Record<string, unknown>)[field]) : "?";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
