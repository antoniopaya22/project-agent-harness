---
id: verify
name: Verify
purpose: Run the quality gates and give a per-criterion verdict with evidence, without fixing anything.
args: "[TASK-ID]"
kind: hybrid
agents: [tester]
capabilities: [read, search, edit, shell]
model: primary
---

Verify task **$1** (if no id is given, the task on the current branch).

## Do this

```bash
node .harness/bin/harness.mjs gates
node .harness/bin/harness.mjs task show $1
```

Then invoke the **tester**, whose defining constraint is that it cannot fix the code. It:

1. records every gate result verbatim, exit codes included;
2. takes each acceptance criterion in turn and produces `pass` / `fail` / `unverifiable`, with
   evidence that can be quoted — for a `command` check, the command and its output; for a `review`
   check, the specific lines;
3. actively looks for green results that lie: a test that would pass without the change, a test that
   asserts the implementation instead of the outcome, a criterion satisfied only on the happy path.
   Any of those is a `fail`, not a `pass` with a note;
4. records each verdict with `harness task ac $1 <ACn> <verdict> --evidence "..."`;
5. writes `.harness/workspace/$1/verification.md`.

If everything passes and the required gates are green:

```bash
node .harness/bin/harness.mjs task set-status $1 in_review --as tester
```

## Never

- Do not fix production code here, not even trivially. Report it and stop.
- Do not delete, skip, `xfail` or loosen a test to reach green.
- Do not mark a criterion `pass` without evidence, or `unverifiable` to dodge the work.
- Do not edit the criteria.

## Report

A criteria table with verdicts and evidence, the gate results, and one closing line: either
`ready for review` or `back to implementation:` followed by the specific reasons. No hedging.
