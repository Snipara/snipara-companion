export const READABILITY_BUDGET = {
  targetLines: 200,
  splitLines: 400,
} as const;

export type ChangeBudgetStatus = "within_budget" | "review" | "split";

export interface ChangeBudgetInput {
  fileCount: number;
  addedLines: number;
  deletedLines: number;
}

export interface ChangeBudget extends ChangeBudgetInput {
  changedLines: number;
  status: ChangeBudgetStatus;
  targetLines: number;
  splitLines: number;
}

function numstatLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function numstatValue(value: string): number {
  if (value === "-") {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function parseGitNumstat(output: string): ChangeBudgetInput {
  return numstatLines(output).reduce(
    (totals, line) => {
      const [added = "", deleted = ""] = line.split("\t");
      return {
        fileCount: totals.fileCount + 1,
        addedLines: totals.addedLines + numstatValue(added),
        deletedLines: totals.deletedLines + numstatValue(deleted),
      };
    },
    { fileCount: 0, addedLines: 0, deletedLines: 0 }
  );
}

export function buildChangeBudget(input: ChangeBudgetInput): ChangeBudget {
  const changedLines = input.addedLines + input.deletedLines;
  const status =
    changedLines > READABILITY_BUDGET.splitLines
      ? "split"
      : changedLines >= READABILITY_BUDGET.targetLines
        ? "review"
        : "within_budget";

  return {
    ...input,
    changedLines,
    status,
    targetLines: READABILITY_BUDGET.targetLines,
    splitLines: READABILITY_BUDGET.splitLines,
  };
}
