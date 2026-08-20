---
id: task
name: Task
purpose: Operate on the backlog — list, inspect, create, claim, transition, split, and refine tasks.
args: "<list|show|next|new|claim|set-status|split|ac|context|describe|edit> [...]"
kind: script
capabilities: [read, shell]
model: fast
---

Run the backlog operation the user asked for: `$ARGUMENTS`

Everything goes through the CLI, which validates as it writes. **Never hand-edit a task JSON file** —
free-form edits by a model are exactly how a schema rots, and the CLI refuses what the schema forbids.

## The operations

```bash
harness task list [--status ready] [--area api] [--type feature] [--open]
harness task show <ID>
harness task next                          # ready, unblocked, unclaimed, highest priority
harness task new --type feature --title "..." [--priority high] [--area api]
harness task claim <ID> --as implementer
harness task unclaim <ID>
harness task set-status <ID> <status> [--reason "..."]
harness task ac <ID> AC1 pass --evidence "..."          # record a verdict
harness task ac-set <ID> AC2 --must "..." --check command --run "pytest ..."
harness task ac-rm <ID> AC3
harness task describe <ID> --text "..."
harness task context <ID> --area api --doc docs/adr/0003-x.md --file src/api/users.py
harness task edit <ID> [--priority|--size|--title|--estimate|--parent|--label|--depends-on]
harness task retype <ID> <type>            # only while still in backlog: the id is frozen after that
harness task split <ID> "primera parte" "segunda parte"
```

Prefix `node .harness/bin/harness.mjs` if the `harness` shim is not on the path.

## Things worth knowing before you run one

- **Ids encode the type** (`FEAT-0042`, `FIX-0007`) and are **frozen** once the task leaves `backlog`,
  because by then the id is in a branch name, in commit trailers and possibly in ClickUp. `retype`
  therefore only works on `backlog` tasks.
- **`set-status` refuses illegal transitions and unmet entry conditions.** When it refuses it prints
  exactly what is missing. That message is the specification — satisfy it rather than routing around it.
- **`done` and `cancelled` are human-only.** If you are an agent, you stop at `in_review`.
- **`new` creates a task in `backlog` with a placeholder criterion.** It cannot become `ready` until a
  real criterion with a check replaces it — that is `/plan`'s job, not a formality to skip.
- **Titles are read by non-technical colleagues** on the generated board and in ClickUp. No file paths,
  no function names. `lint-backlog` warns when a title looks technical.
- Any mutation regenerates `index.json` and `BOARD.md`. Do not edit those either.

## Report

The command you ran and its output, unembellished. If a transition was refused, show the reasons and
say what would have to change — do not attempt a workaround unless the user asks for one.
