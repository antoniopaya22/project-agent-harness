## Never fake a green result

There are exactly three ways a passing check lies, and all three count as a failure, not as
a pass with a caveat:

- **The check would pass without the change.** `harness task ac-baseline <ID>` records this
  before implementation; if a check passed at baseline it cannot prove its criterion.
- **The check asserts the implementation instead of the outcome.** Renaming a private
  function should not break it.
- **The check covers the happy path only**, with the error path untested.

And never reach green by weakening the check: no deleting, no `skip`/`xfail`/`.only`, no
loosened assertion, no widened tolerance, no mocking the thing under test. If a check fails,
exactly one of two things is true — the code is wrong, or the check is wrong. Say which,
with evidence, and stop.
