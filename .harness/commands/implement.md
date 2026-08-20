---
id: implement
name: Implement
purpose: Take a task from ready to in_review — plan, branch, implement, verify, document, review, commit. Resumable.
args: "<TASK-ID>"
kind: hybrid
agents: [planner, implementer, tester, reviewer, scribe]
capabilities: [read, search, edit, shell, delegate, ask]
model: primary
---

Implement task **$1**.

This command is resumable and idempotent: running it twice must not redo finished work. Follow the
stages in order, and at each one first check whether it is already done.

## 0 — Load, and resume if there is something to resume

```bash
node .harness/bin/harness.mjs brief $1
```

That single call returns the whole cold-start read path as one payload, with the task and
the project config projected down to what implementing actually needs — four reads become
one, and the projected surface costs about 46% less. Use `--with-files` when you want the
work files inlined too, and `read-path $1` when you want to see the cost breakdown per
file rather than the content.

Read nothing beyond it unless the work forces you to. Then ask where to resume:

```bash
node .harness/bin/harness.mjs handoff resume $1
```

It prints the last **completed** stage, and you continue from the one after it (`claimed` → 5,
`planned` → 6, `implemented` → 7, `verified` → 8, `reviewed` → 10). Say which stage you resumed
from.

If it exits non-zero the handoff is malformed: **do not guess a stage.** A broken handoff that
gets read as "start over" silently redoes work and hides the breakage. Report it and stop.

## 1 — Guard: is this task workable?

- Status must be `ready` or `in_progress`. If it is `backlog`, the task is not groomed: invoke the
  **planner** to groom it, show the human the resulting acceptance criteria, and **stop** for
  confirmation before writing any code.
- If it is `blocked`, `in_review`, `done` or `cancelled`, stop and say why.

## 2 — Guard: dependencies

Any `depends_on` that is not `done` means refuse. List the blockers and stop. Do not "work around"
a dependency.

## 3 — Branch

Create or switch to the task branch. The grammar is `<git-type>/<number>-<slug>` and the CLI knows
it — do not invent one. If the working tree is dirty on a protected branch, stop and say so.

## 4 — Claim

```bash
node .harness/bin/harness.mjs task claim $1 --as implementer
git switch -c <branch>   # if it does not exist yet
```

Write `.harness/workspace/$1/handoff.json` with `stage: claimed`.

## 5 — Plan

If `.harness/workspace/$1/plan.md` does not exist, invoke the **planner** to write it.
Then: **if the plan's risk is `high`, or it touches more than one area, stop and ask the human to
confirm the approach before implementing.** Otherwise continue. Update the handoff to `planned`.

## 6 — Implement

First record what each command check does *before* any change:

```bash
node .harness/bin/harness.mjs task ac-baseline $1
```

Exit 0 means every check fails today, which is what makes it evidence. **A non-zero exit
means some check already passes**, so it cannot prove its criterion — either the work is
already done or the check tests the wrong thing. Stop and regroom; do not implement against
a criterion that cannot be proven.

Then invoke the **implementer**. It reads only the read path plus the plan. Update the handoff to
`implemented`.

## 7 — Verify

Invoke the **tester**. It runs `harness gates` and gives a verdict per criterion with evidence.

- All criteria pass → continue.
- Something fails → back to stage 6 with the tester's findings. **Maximum two loops.** After the
  second failed verification, stop, report exactly what is failing and why, and let the human decide.
  Do not keep trying.

Update the handoff to `verified`.

## 8 — Document

Invoke the **scribe** with the diff. It updates only the docs the change invalidated, then runs
`harness doctor` to confirm the codemap still tells the truth.

## 9 — Review

Invoke the **reviewer**. Address every blocking finding (that means going back to stage 6 for those
changes, then re-verifying the affected criteria). Non-blocking findings become candidate tasks, not
edits. Update the handoff to `reviewed`.

## 10 — Close

```bash
node .harness/bin/harness.mjs task set-status $1 in_review --as tester
node .harness/bin/harness.mjs commit --task $1
```

`commit` pushes to the task branch and — because the task is now `in_review` — opens the pull
request. Then report:

- what changed, in one screen;
- the criteria table with verdicts;
- the PR link;
- the single next action for the human: review and merge.

## Stopping points — do not skip these

There are exactly four places you stop and hand control to the human:

1. after grooming an ungroomed task, to confirm the acceptance criteria;
2. when the plan is `high` risk or crosses areas;
3. after two failed verification loops;
4. at `done` — only a human sets it, after merging.

Everything else is automatic.
