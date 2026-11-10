# Optional agent skills

These short skills add guidance only when a task needs it. An obvious local edit
can proceed directly. No skill requires a new managed workflow, a Snipara account
or a per-use journal. Existing project verification and authorization rules apply.

| Skill | Use when |
| --- | --- |
| [Fix with proof](snipara-fix-with-proof/SKILL.md) | Reproducing a bug or preserving its contract needs care. |
| [Resume work](snipara-resume-work/SKILL.md) | An interrupted task needs checkpoint and source reconciliation. |
| [Sourced answer](snipara-sourced-answer/SKILL.md) | A project question needs missing or conflicting evidence. |
| [Context workflow](snipara-context-workflow/SKILL.md) | Project context or continuity would change the work. |

## Install for Codex

From a checkout of `Snipara/snipara-companion`, copy the selected skill directories
from `docs/skills/` into `${CODEX_HOME:-$HOME/.codex}/skills/`. In the monorepo,
the source directory is `packages/cli/docs/skills/`. Inspect an existing directory
before replacing it so local customizations are preserved. Start a new Codex chat
after installation to refresh the skill catalog. Global installation makes the
skills available across projects; it does not force every skill into every task.

The same files ship in the npm package under `docs/skills/`. Installing Companion
does not automatically modify an agent's instructions or install skills. Other
agents may use their own supported skill directory.

## Pilot status

The three task skills retain version `0.2.0` and internal-pilot metadata. They are
publicly available for dogfooding, not a claim of measured quality improvement.
The context workflow skill is the shared concise policy. Feedback should identify
a concrete task where instructions helped, were redundant, or caused extra work;
there is no mandatory per-task log.
