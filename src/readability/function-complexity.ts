import path from "path";
import ts from "typescript";

export const FUNCTION_COMPLEXITY_BUDGET = {
  review: { complexity: 10, depth: 4, lines: 60 },
  split: { complexity: 15, depth: 6, lines: 100 },
} as const;

export type FunctionComplexityStatus = "within_budget" | "review" | "split";

export interface ChangedLineRange {
  start: number;
  end: number;
}

export interface FunctionComplexityInput {
  filePath: string;
  source: string;
  changedLines: ChangedLineRange[];
}

export interface FunctionComplexityFinding {
  filePath: string;
  name: string;
  line: number;
  endLine: number;
  lines: number;
  complexity: number;
  maxDepth: number;
  status: FunctionComplexityStatus;
}

export interface FunctionComplexityReport {
  status: FunctionComplexityStatus;
  fileCount: number;
  functionCount: number;
  functions: FunctionComplexityFinding[];
  budget: typeof FUNCTION_COMPLEXITY_BUDGET;
}

const JAVASCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"]);
const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
]);
const COMPLEXITY_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.CaseClause,
]);
const DEPTH_KINDS = new Set([
  ...COMPLEXITY_KINDS,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
]);
const LOGICAL_KINDS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

export function isFunctionComplexityFile(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return [".ts", ".tsx", ".mts", ".cts"].includes(extension) || JAVASCRIPT_EXTENSIONS.has(extension);
}

export function parseGitChangedLineRanges(output: string): Map<string, ChangedLineRange[]> {
  const ranges = new Map<string, ChangedLineRange[]>();
  let currentFile: string | undefined;

  for (const line of output.split(/\r?\n/)) {
    if (line === "+++ /dev/null") {
      currentFile = undefined;
      continue;
    }
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length);
      if (!ranges.has(currentFile)) ranges.set(currentFile, []);
      continue;
    }
    if (!currentFile) continue;
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Number.parseInt(match[1], 10);
    const count = Number.parseInt(match[2] ?? "1", 10);
    if (count > 0) {
      ranges.get(currentFile)?.push({ start, end: start + count - 1 });
    }
  }

  return ranges;
}

function scriptKind(filePath: string): ts.ScriptKind {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".tsx" || extension === ".jsx") return ts.ScriptKind.TSX;
  if (JAVASCRIPT_EXTENSIONS.has(extension)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isFunctionNode(node: ts.Node): boolean {
  return FUNCTION_KINDS.has(node.kind);
}

function functionName(node: ts.Node, sourceFile: ts.SourceFile): string {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const named = node as ts.NamedDeclaration;
  if (named.name) return named.name.getText(sourceFile);

  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isPropertyAssignment(parent)) return parent.name.getText(sourceFile);
  return "<anonymous>";
}

function intersectsChangedLines(line: number, endLine: number, ranges: ChangedLineRange[]): boolean {
  return ranges.some((range) => range.start <= endLine && range.end >= line);
}

function complexityContribution(node: ts.Node): number {
  return COMPLEXITY_KINDS.has(node.kind) ||
    (ts.isBinaryExpression(node) && LOGICAL_KINDS.has(node.operatorToken.kind))
    ? 1
    : 0;
}

function depthContribution(node: ts.Node): number {
  return DEPTH_KINDS.has(node.kind) ? 1 : 0;
}

function functionMetrics(node: ts.Node): { complexity: number; maxDepth: number } {
  let complexity = 1;
  let maxDepth = 0;

  const visit = (current: ts.Node, depth: number): void => {
    if (current !== node && isFunctionNode(current)) return;
    complexity += complexityContribution(current);
    const nextDepth = depth + depthContribution(current);
    maxDepth = Math.max(maxDepth, nextDepth);
    ts.forEachChild(current, (child) => visit(child, nextDepth));
  };

  ts.forEachChild(node, (child) => visit(child, 0));
  return { complexity, maxDepth };
}

function functionStatus(
  complexity: number,
  maxDepth: number,
  lines: number
): FunctionComplexityStatus {
  if (
    complexity > FUNCTION_COMPLEXITY_BUDGET.split.complexity ||
    maxDepth > FUNCTION_COMPLEXITY_BUDGET.split.depth ||
    lines > FUNCTION_COMPLEXITY_BUDGET.split.lines
  ) {
    return "split";
  }
  if (
    complexity > FUNCTION_COMPLEXITY_BUDGET.review.complexity ||
    maxDepth > FUNCTION_COMPLEXITY_BUDGET.review.depth ||
    lines > FUNCTION_COMPLEXITY_BUDGET.review.lines
  ) {
    return "review";
  }
  return "within_budget";
}

function analyzeFile(input: FunctionComplexityInput): FunctionComplexityFinding[] {
  const sourceFile = ts.createSourceFile(
    input.filePath,
    input.source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(input.filePath)
  );
  const findings: FunctionComplexityFinding[] = [];

  const visit = (node: ts.Node): void => {
    if (isFunctionNode(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      if (intersectsChangedLines(line, endLine, input.changedLines)) {
        const lines = endLine - line + 1;
        const { complexity, maxDepth } = functionMetrics(node);
        findings.push({
          filePath: input.filePath,
          name: functionName(node, sourceFile),
          line,
          endLine,
          lines,
          complexity,
          maxDepth,
          status: functionStatus(complexity, maxDepth, lines),
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return findings;
}

export function buildFunctionComplexityReport(
  inputs: FunctionComplexityInput[]
): FunctionComplexityReport {
  const functions = inputs.flatMap(analyzeFile);
  const status = functions.some((item) => item.status === "split")
    ? "split"
    : functions.some((item) => item.status === "review")
      ? "review"
      : "within_budget";

  return {
    status,
    fileCount: inputs.length,
    functionCount: functions.length,
    functions,
    budget: FUNCTION_COMPLEXITY_BUDGET,
  };
}
