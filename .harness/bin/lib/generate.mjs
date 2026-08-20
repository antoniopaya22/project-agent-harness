// Projection: one canonical definition in .harness/ -> many provider adapters.
// Adapters hold no unique knowledge (P1). Everything written here carries a GENERATED
// header, and `--check` turns drift into a non-zero exit for CI.

import fs from 'node:fs';
import path from 'node:path';
import {
  HARNESS_VERSION,
  generatedHeader,
  listFiles,
  parseFrontMatter,
  toPosixPath,
  writeFileIfChanged,
} from './util.mjs';

/** Canonical capability -> Claude Code tool names. */
const CLAUDE_TOOLS = {
  read: ['Read'],
  search: ['Glob', 'Grep'],
  edit: ['Edit', 'Write'],
  shell: ['Bash'],
  web: ['WebFetch', 'WebSearch'],
  delegate: ['Task'],
  ask: ['AskUserQuestion'],
};

/** Canonical model tier -> Claude Code model alias. */
const CLAUDE_MODEL = { fast: 'haiku', primary: 'sonnet', deep: 'opus' };

const KEEP_OPEN = '<!-- harness:keep -->';
const KEEP_CLOSE = '<!-- /harness:keep -->';

export function loadDefinitions(ctx, kind) {
  const dir = path.join(ctx.harnessDir, kind);
  return listFiles(dir, '.md').map((file) => {
    const { data, body } = parseFrontMatter(fs.readFileSync(file, 'utf8'));
    const rel = toPosixPath(path.relative(ctx.root, file));
    return {
      file,
      rel,
      id: data.id || path.basename(file, '.md'),
      data,
      body: resolveTemplates(ctx, body.trim(), { source: rel }),
    };
  });
}

function toolsFor(capabilities = []) {
  const caps = Array.isArray(capabilities) ? capabilities : [capabilities];
  const tools = [];
  for (const cap of caps) for (const t of CLAUDE_TOOLS[cap] || []) if (!tools.includes(t)) tools.push(t);
  return tools;
}

function rulesBlock(def) {
  const lines = [];
  const writes = arr(def.data.writes);
  const forbidden = arr(def.data.forbidden);
  if (writes.length) lines.push(`- You may write to: ${writes.join(', ')}. Nothing else.`);
  if (forbidden.length) lines.push(`- You must never touch: ${forbidden.join(', ')}.`);
  if (def.data.network === false) lines.push('- No network access. If you need external information, say so and stop.');
  return lines;
}

function arr(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Two substitutions, both there to stop the same thing: the same fact written twice.
 *
 * `{{config:a.b.c}}` pulls a value out of project.json, so a number like the verification
 * loop limit lives in configuration instead of as prose inside a prompt.
 *
 * `{{include:name}}` splices in `.harness/includes/<name>.md`, so the hard rules and a
 * role's procedure are written once and referenced. Duplicated prompt text is paid for on
 * every invocation and, worse, is two places that will drift apart.
 */
export function resolveTemplates(ctx, text, { source = '' } = {}) {
  const unresolved = [];
  let out = String(text).replace(/\{\{config:([A-Za-z0-9_.]+)\}\}/g, (_, dotted) => {
    const value = dotted.split('.').reduce((node, key) => (node == null ? undefined : node[key]), ctx.project);
    if (value === undefined || value === null) {
      unresolved.push(`{{config:${dotted}}}`);
      return `{{config:${dotted}}}`;
    }
    return String(value);
  });

  out = out.replace(/\{\{include:([A-Za-z0-9_-]+)\}\}/g, (_, name) => {
    const file = path.join(ctx.harnessDir, 'includes', `${name}.md`);
    if (!fs.existsSync(file)) {
      unresolved.push(`{{include:${name}}}`);
      return `{{include:${name}}}`;
    }
    return fs.readFileSync(file, 'utf8').trim();
  });

  if (unresolved.length) {
    // Left in place on purpose: a silently blank substitution would delete an instruction
    // and nobody would notice. Doctor turns these into an error.
    process.stderr.write(`harness generate: unresolved in ${source}: ${unresolved.join(', ')}\n`);
  }
  return out;
}

/** Every generated agent/command prompt gets the same preamble, so the roster reads as one system. */
function preamble(ctx) {
  return [
    'Read `.harness/ENTRYPOINT.md` first if you have not already. It defines the read path, the',
    'status machine and the hard rules; nothing below overrides it.',
    '',
    `Write all user-facing output and all deliverables in \`${ctx.project.project.output_language}\`.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Adapter: Claude Code
// ---------------------------------------------------------------------------

function claudeAgentFile(ctx, def) {
  const tools = toolsFor(def.data.capabilities);
  const fm = ['---'];
  fm.push(`name: ${def.id}`);
  fm.push(`description: ${def.data.purpose || def.data.name || def.id}`);
  if (tools.length) fm.push(`tools: ${tools.join(', ')}`);
  const model = CLAUDE_MODEL[def.data.model];
  if (model) fm.push(`model: ${model}`);
  fm.push('---');

  const rules = rulesBlock(def);
  const parts = [
    fm.join('\n'),
    '',
    generatedHeader(def.rel),
    '',
    preamble(ctx),
    '',
    def.body,
  ];
  if (rules.length) {
    parts.push('', '## Hard limits (from your definition)', '', rules.join('\n'));
  }
  return `${parts.join('\n')}\n`;
}

function claudeCommandFile(ctx, def) {
  const tools = toolsFor(def.data.capabilities);
  const fm = ['---'];
  fm.push(`description: ${def.data.purpose || def.id}`);
  if (def.data.args) fm.push(`argument-hint: ${def.data.args}`);
  if (tools.length) fm.push(`allowed-tools: ${tools.join(', ')}`);
  const model = CLAUDE_MODEL[def.data.model];
  if (model) fm.push(`model: ${model}`);
  fm.push('---');

  return `${[fm.join('\n'), '', generatedHeader(def.rel), '', preamble(ctx), '', def.body].join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Adapter: root instruction files (CLAUDE.md, AGENTS.md)
// ---------------------------------------------------------------------------

function rootInstructions(ctx, { flavour, agents, commands, keep }) {
  const p = ctx.project;
  const lines = [];
  lines.push(generatedHeader('.harness/ (ENTRYPOINT.md, agents/, commands/)'));
  lines.push('');
  lines.push(`# ${p.project.name}`);
  lines.push('');
  lines.push('This repository is managed by **harness v' + HARNESS_VERSION + '**.');
  lines.push('');
  lines.push('**Start here: [`.harness/ENTRYPOINT.md`](.harness/ENTRYPOINT.md).** It is short and it is');
  lines.push('authoritative: it defines the cold-start read path, the task status machine, the hard rules');
  lines.push('and where your output goes. Do not explore the repository to orient yourself.');
  lines.push('');
  lines.push('```');
  lines.push('1. .harness/ENTRYPOINT.md            rules + map');
  lines.push('2. .harness/backlog/tasks/<ID>.json  the task (it tells you what else to read)');
  lines.push('3. .harness/project.json             gates, areas, git conventions');
  lines.push('4. docs/areas/<area>.md              the slice of architecture you need');
  lines.push('```');
  lines.push('');
  lines.push(`Deliverables are written in \`${p.project.output_language}\`.`);
  lines.push('');

  if (flavour === 'agents_md') {
    lines.push('## Roles');
    lines.push('');
    lines.push('This harness defines specialised roles. If your tool has no subagent mechanism, adopt one');
    lines.push('role at a time explicitly and respect its limits — they are what keep the work honest');
    lines.push('(for example: the role that verifies is not allowed to fix, so it cannot mark its own work good).');
    lines.push('');
    for (const a of agents) {
      lines.push(`- **${a.id}** — ${a.data.purpose || ''} Definition: \`${a.rel}\`.`);
      const f = arr(a.data.forbidden);
      if (f.length) lines.push(`  Never: ${f.join(', ')}.`);
    }
    lines.push('');
    lines.push('## Workflows');
    lines.push('');
    lines.push('Each of these is a numbered runbook you can follow or paste as a prompt:');
    lines.push('');
    for (const cmd of commands) {
      lines.push(`- \`${cmd.id}\`${cmd.data.args ? ` ${cmd.data.args}` : ''} — ${cmd.data.purpose || ''} → \`docs/runbooks/${cmd.id}.md\``);
    }
    lines.push('');
  } else {
    lines.push('## Available agents and commands');
    lines.push('');
    lines.push(`Subagents: ${agents.map((a) => `\`${a.id}\``).join(', ')}.`);
    lines.push('');
    lines.push(`Slash commands: ${commands.map((cmd) => `\`/${cmd.id}\``).join(', ')}.`);
    lines.push('');
  }

  lines.push('## The CLI');
  lines.push('');
  lines.push('`harness` is deterministic and is the only way to run project commands:');
  lines.push('');
  lines.push('```bash');
  lines.push('node .harness/bin/harness.mjs status');
  lines.push('```');
  lines.push('');
  lines.push('Never invent a lint/test/build command — use `harness gate <name>`.');
  lines.push('');

  if (keep) {
    lines.push(KEEP_OPEN);
    lines.push(keep);
    lines.push(KEEP_CLOSE);
    lines.push('');
  }

  return lines.join('\n');
}

function extractKeep(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf(KEEP_OPEN);
  if (start === -1) return null;
  const end = text.indexOf(KEEP_CLOSE, start);
  if (end === -1) return null;
  return text.slice(start + KEEP_OPEN.length, end).trim();
}

// ---------------------------------------------------------------------------
// Adapter: runbooks (degradation path for providers without slash commands)
// ---------------------------------------------------------------------------

function runbook(ctx, def) {
  const lines = [];
  lines.push(generatedHeader(def.rel));
  lines.push('');
  lines.push(`# Runbook: ${def.id}${def.data.args ? ` ${def.data.args}` : ''}`);
  lines.push('');
  lines.push(def.data.purpose || '');
  lines.push('');
  lines.push('Your tool has no slash-command mechanism, so this is the same instruction set as a');
  lines.push('document. Paste it as a prompt, substituting the arguments.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(def.body);
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** @returns {{path:string, content:string}[]} the full desired state of all adapters */
export function plan(ctx) {
  const providers = ctx.project.providers || {};
  const agents = loadDefinitions(ctx, 'agents');
  const commands = loadDefinitions(ctx, 'commands');
  const out = [];

  if (providers.claude !== false) {
    for (const a of agents) {
      out.push({ path: path.join('.claude', 'agents', `${a.id}.md`), content: claudeAgentFile(ctx, a) });
    }
    for (const cmd of commands) {
      out.push({ path: path.join('.claude', 'commands', `${cmd.id}.md`), content: claudeCommandFile(ctx, cmd) });
    }
    out.push({
      path: 'CLAUDE.md',
      content: rootInstructions(ctx, {
        flavour: 'claude',
        agents,
        commands,
        keep: extractKeep(path.join(ctx.root, 'CLAUDE.md')),
      }),
    });
  }

  if (providers.agents_md !== false) {
    out.push({
      path: 'AGENTS.md',
      content: rootInstructions(ctx, {
        flavour: 'agents_md',
        agents,
        commands,
        keep: extractKeep(path.join(ctx.root, 'AGENTS.md')),
      }),
    });
    for (const cmd of commands) {
      out.push({ path: path.join('docs', 'runbooks', `${cmd.id}.md`), content: runbook(ctx, cmd) });
    }
  }

  // Overrides are merged verbatim, last, so a project can keep provider-specific tweaks
  // without losing them on regeneration.
  const overridesRoot = path.join(ctx.harnessDir, 'overrides');
  if (fs.existsSync(overridesRoot)) {
    for (const provider of fs.readdirSync(overridesRoot)) {
      const base = path.join(overridesRoot, provider);
      if (!fs.statSync(base).isDirectory()) continue;
      for (const file of walk(base)) {
        // Kept platform-native: this path is re-joined onto ctx.root when written.
        out.push({ path: path.relative(base, file), content: fs.readFileSync(file, 'utf8') });
      }
    }
  }

  return out;
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

export function apply(ctx) {
  const written = [];
  for (const item of plan(ctx)) {
    if (writeFileIfChanged(path.join(ctx.root, item.path), item.content)) written.push(item.path);
  }
  return written;
}

/** @returns {{drifted:string[], missing:string[]}} */
export function check(ctx) {
  const drifted = [];
  const missing = [];
  for (const item of plan(ctx)) {
    const full = path.join(ctx.root, item.path);
    if (!fs.existsSync(full)) {
      missing.push(item.path);
      continue;
    }
    const actual = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
    if (actual !== item.content.replace(/\r\n/g, '\n')) drifted.push(item.path);
  }
  return { drifted, missing };
}
