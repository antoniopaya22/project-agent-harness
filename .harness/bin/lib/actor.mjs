// Who is acting. The distinction matters exactly once, and it is load-bearing:
// human-only transitions (done, cancelled) are the system's handbrake.

import path from 'node:path';
import process from 'node:process';
import { listFiles } from './util.mjs';

export function agentIds(ctx) {
  return listFiles(path.join(ctx.harnessDir, 'agents'), '.md').map((f) => path.basename(f, '.md'));
}

/**
 * `--as <id>`; falls back to $HARNESS_ACTOR, then to a human.
 * An id that matches a defined agent is an agent; anything else is a human.
 */
export function actor(ctx, flags = {}) {
  const raw = flags.as || process.env.HARNESS_ACTOR || 'human';
  const id = String(raw);
  const kind = agentIds(ctx).includes(id) ? 'agent' : 'human';
  return { kind, id };
}
