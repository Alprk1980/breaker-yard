#!/usr/bin/env node
/**
 * Generate content with the local model, validate it, repair the failures, write what passes.
 * Dependency-free (Node 24: global fetch, and type stripping to import the TS validators).
 *
 *   node tools/qwen-gen.mjs <kind> [--ask "extra brief"] [--dry]
 *
 * A kind is a prompt file, a data file and a validator. `table` kinds are one JSON array checked as a
 * whole (cross-entry balance rules), so the reply is written only when the whole table passes.
 * Every attempt is saved to generated/<kind>-<stamp>-<n>.json (gitignored).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { materialTableErrors } from '../src/sim/materialSchema.ts';

const KINDS = {
  materials: {
    prompt: 'prompts/materials.txt',
    data: 'src/data/materials.json',
    tableErrors: materialTableErrors,
  },
};

const args = process.argv.slice(2);
const kindName = args[0];
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] ?? fallback : fallback);
const kind = KINDS[kindName];
const base = (process.env.NARRATIVE_URL ?? 'http://100.66.95.17:1234/v1').replace(/\/$/, '');
const model = process.env.NARRATIVE_MODEL ?? 'qwen/qwen3.8-27b';
if (kind === undefined) {
  console.error(`usage: node tools/qwen-gen.mjs <${Object.keys(KINDS).join('|')}> [--ask "..."] [--dry]`);
  process.exit(1);
}

async function ask(messages) {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 16000 }),
  });
  if (!res.ok) throw new Error(`model: HTTP ${res.status}`);
  const body = await res.json();
  return String(body.choices?.[0]?.message?.content ?? '');
}

/** The JSON array in a reply (thinking and code fences stripped), or null. */
function parse(reply) {
  const text = reply.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const prompt = readFileSync(kind.prompt, 'utf8').replaceAll('{{ask}}', opt('--ask', ''));
const messages = [{ role: 'user', content: prompt }];
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync('generated', { recursive: true });
let passing = null;
for (let attempt = 1; attempt <= 3; attempt++) {
  console.log(`attempt ${attempt}/3: asking ${model}…`);
  const reply = await ask(messages);
  writeFileSync(`generated/${kindName}-${stamp}-${attempt}.json`, reply);
  const table = parse(reply);
  if (table === null) {
    console.log('  no JSON array in the reply');
    messages.push({ role: 'assistant', content: reply }, { role: 'user', content: 'Answer with only the JSON array, complete and valid.' });
    continue;
  }
  const problems = kind.tableErrors(table);
  console.log(`  ${table.length} entries, ${problems.length} problem(s)${problems.length ? `:\n    ${problems.join('\n    ')}` : ''}`);
  if (problems.length === 0) {
    passing = table;
    break;
  }
  messages.push({ role: 'assistant', content: reply }, { role: 'user', content: `Fix these and answer the whole JSON array again:\n- ${problems.join('\n- ')}` });
}
if (passing === null) {
  console.log('no passing table; nothing written (attempts are in generated/)');
  process.exit(2);
} else if (args.includes('--dry')) {
  console.log(JSON.stringify(passing, null, 2));
  console.log('--dry: nothing written');
} else {
  mkdirSync(kind.data.slice(0, kind.data.lastIndexOf('/')), { recursive: true });
  writeFileSync(kind.data, `${JSON.stringify(passing, null, 2)}\n`);
  console.log(`wrote ${kind.data} — run npm test`);
}
