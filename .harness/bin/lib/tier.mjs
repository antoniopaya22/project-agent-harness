// Which model tier a task deserves.
//
// The tier is assigned by role today and it is fixed: the planner always thinks hard, the
// implementer always uses the middle one. That is wrong in both directions — the deepest
// model on a two-line chore is money burnt, and the cheapest on a delicate design is worse
// than money burnt.
//
// This suggests a tier from what the task itself says. It is **advisory on purpose**: the
// signals here are cheap proxies (type, size, blast radius) and cheap proxies get it wrong
// often enough that a hard rule would be a cage. A caller may always pick another tier.

export const TIERS = ['fast', 'primary', 'deep'];

/** Types that are mostly mechanical, and types that are mostly judgement. */
const MECHANICAL = new Set(['chore', 'docs', 'test']);
const JUDGEMENT = new Set(['spike', 'epic']);

const SIZE_WEIGHT = { XS: 0, S: 0, M: 1, L: 2, XL: 3 };

/**
 * @returns {{tier:string, why:string[], advisory:true}}
 */
export function suggestTier(task, { allTasks = null } = {}) {
  const why = [];
  let score = 1; // primary is the default: most work is ordinary work

  const type = task.type || 'chore';
  if (MECHANICAL.has(type)) {
    score -= 1;
    why.push(`el tipo \`${type}\` es sobre todo mecánico`);
  }
  if (JUDGEMENT.has(type)) {
    score += 1;
    why.push(`el tipo \`${type}\` es sobre todo criterio, no ejecución`);
  }

  const size = String(task.size || 'M').toUpperCase();
  const weight = SIZE_WEIGHT[size] ?? 1;
  if (weight >= 2) {
    score += 1;
    why.push(`tamaño ${size}`);
  } else if (weight === 0 && !JUDGEMENT.has(type)) {
    score -= 1;
    why.push(`tamaño ${size}`);
  }

  // Blast radius: a task other tasks wait on is one where a wrong turn is expensive, because
  // the cost lands on everything downstream and not just here.
  const blocks = allTasks ? allTasks.filter((t) => (t.depends_on || []).includes(task.id)).length : 0;
  if (blocks >= 3) {
    score += 1;
    why.push(`desbloquea ${blocks} tareas: equivocarse aquí sale caro fuera de aquí`);
  }

  if ((task.acceptance_criteria || []).length >= 4) {
    score += 1;
    why.push(`${task.acceptance_criteria.length} criterios de aceptación`);
  }

  // A criterion nobody can check by running something needs somebody to exercise judgement.
  const manual = (task.acceptance_criteria || []).filter((ac) => ac.check?.type !== 'command').length;
  if (manual >= 2) {
    score += 1;
    why.push(`${manual} criterios sin comprobación automática`);
  }

  if (task.priority === 'critical') {
    score += 1;
    why.push('prioridad crítica');
  }
  if ((task.labels || []).some((l) => /riesgo|risk|seguridad|security|migracion|migration/i.test(l))) {
    score += 1;
    why.push('etiquetada como arriesgada');
  }

  const tier = TIERS[Math.min(TIERS.length - 1, Math.max(0, score))];
  if (why.length === 0) why.push('nada la distingue: trabajo ordinario');
  return { tier, why, advisory: true };
}

/** What the tier costs relative to the others, so the suggestion can be argued with. */
export const TIER_NOTE = {
  fast: 'lo más barato: cambios mecánicos con un criterio claro',
  primary: 'el término medio: implementación ordinaria',
  deep: 'lo más caro: diseño, investigación o algo cuyo error se propaga',
};

export function renderSuggestion(task, suggestion) {
  const lines = [
    `${task.id}: nivel sugerido ${suggestion.tier}`,
    `   ${TIER_NOTE[suggestion.tier]}`,
    ...suggestion.why.map((w) => `   · ${w}`),
    '   Es una sugerencia: las señales son proxies baratos y se equivocan. Elige otro si lo ves.',
  ];
  return lines.join('\n');
}
