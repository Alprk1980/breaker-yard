#!/usr/bin/env node
/**
 * Generate content with the local model, validate it, repair the failures, write what passes.
 * Dependency-free. Run through `npm run gen -- <kind> ...`, which loads the game's TypeScript
 * validators via Node's type stripping and tools/register-ts.mjs.
 *
 *   npm run gen -- materials [--ask "extra brief"] [--dry]
 *   npm run gen -- ships [--count 2] [--ask "..."] [--replace id,id] [--dry]
 *
 * A kind is a prompt file, a data file and a validator:
 *   - `tableErrors(table)`: the reply is one JSON array checked as a whole (cross-entry balance
 *     rules) and written only when the whole table passes.
 *   - `errors(entry)`: entries are checked one by one; passing ones are merged by id (new ids
 *     added, shipped ids replaced only when --replace names them).
 * Every attempt is saved to generated/<kind>-<stamp>-<n>.json (gitignored).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { materialTableErrors } from '../src/sim/materialSchema.ts';
import { shipErrors } from '../src/sim/ships.ts';

const KINDS = {
  materials: {
    prompt: 'prompts/materials.txt',
    data: 'src/data/materials.json',
    tableErrors: materialTableErrors,
  },
  ships: {
    prompt: 'prompts/ships.txt',
    data: 'src/data/ships.json',
    errors: shipErrors,
  },
};

const args = process.argv.slice(2);
const kindName = args[0];
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] ?? fallback : fallback);
const kind = KINDS[kindName];
const base = (process.env.NARRATIVE_URL ?? 'http://100.66.95.17:1234/v1').replace(/\/$/, '');
const model = process.env.NARRATIVE_MODEL ?? 'qwen/qwen3.8-27b';
if (kind === undefined) {
  console.error(`usage: npm run gen -- <${Object.keys(KINDS).join('|')}> [--count N] [--ask "..."] [--replace id,id] [--dry]`);
  process.exit(1);
}
const count = Number(opt('--count', '2'));
const replace = new Set((opt('--replace', '') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const shipped = existsSync(kind.data) ? JSON.parse(readFileSync(kind.data, 'utf8')) : [];

/**
 * Streams the reply: a reasoning model can think for longer than fetch waits for response
 * headers (5 minutes), and streaming sends them at once. Only answer text is kept.
 */
async function ask(messages) {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 24000, stream: true }),
  });
  if (!res.ok) throw new Error(`model: HTTP ${res.status}`);
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let thinking = 0;
  let finish = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
      try {
        const choice = JSON.parse(line.slice(5)).choices?.[0];
        content += choice?.delta?.content ?? '';
        thinking += (choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? '').length;
        if (choice?.finish_reason) finish = choice.finish_reason;
      } catch {
        // A keep-alive or partial line; the next chunk completes it.
      }
    }
  }
  console.log(`  reply: ${content.length} chars of answer after ${thinking} chars of thinking (finish: ${finish || '?'})`);
  return content;
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

/** Per-entry problems, plus a clash with a shipped id the run is not replacing. */
function entryErrors(e) {
  const out = kind.errors(e);
  if (typeof e?.id === 'string' && !replace.has(e.id) && shipped.some((s) => s.id === e.id)) {
    out.push(`${e.id}: id already used; pick a new id`);
  }
  return out;
}

const prompt = readFileSync(kind.prompt, 'utf8')
  .replaceAll('{{count}}', String(count))
  .replaceAll('{{ask}}', opt('--ask', ''))
  .replaceAll('{{existing}}', shipped.map((e) => `${e.id} (${e.name ?? ''})`).join(', ') || 'none yet');
const messages = [{ role: 'user', content: prompt }];
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync('generated', { recursive: true });
let passing = kind.tableErrors ? null : [];
for (let attempt = 1; attempt <= 3; attempt++) {
  console.log(`attempt ${attempt}/3: asking ${model}…`);
  const reply = await ask(messages);
  writeFileSync(`generated/${kindName}-${stamp}-${attempt}.json`, reply);
  const entries = parse(reply);
  if (entries === null) {
    console.log('  no JSON array in the reply');
    messages.push({ role: 'assistant', content: reply }, { role: 'user', content: 'Answer with only the JSON array, complete and valid.' });
    continue;
  }
  const problems = kind.tableErrors ? kind.tableErrors(entries) : entries.flatMap(entryErrors);
  console.log(`  ${entries.length} entries, ${problems.length} problem(s)${problems.length ? `:\n    ${problems.join('\n    ')}` : ''}`);
  if (kind.tableErrors) {
    if (problems.length === 0) {
      passing = entries;
      break;
    }
  } else {
    for (const e of entries) {
      if (entryErrors(e).length === 0 && !passing.some((p) => p.id === e.id)) passing.push(e);
    }
    if (problems.length === 0) break;
  }
  messages.push({ role: 'assistant', content: reply }, { role: 'user', content: `Fix these and answer the whole JSON array again:\n- ${problems.join('\n- ')}` });
}

if (kind.tableErrors) {
  if (passing === null) {
    console.log('no passing table; nothing written (attempts are in generated/)');
    process.exit(2);
  }
  if (args.includes('--dry')) console.log(`${JSON.stringify(passing, null, 2)}\n--dry: nothing written`);
  else {
    mkdirSync(kind.data.slice(0, kind.data.lastIndexOf('/')), { recursive: true });
    writeFileSync(kind.data, `${JSON.stringify(passing, null, 2)}\n`);
    console.log(`wrote ${kind.data}; run npm test`);
  }
  process.exit(0);
}

// Merge: new ids are added; a shipped id is written over only when --replace names it.
const wanted = replace.size > 0 ? passing.filter((e) => replace.has(e.id)) : passing.filter((e) => !shipped.some((s) => s.id === e.id));
const merged = [...shipped.map((s) => wanted.find((w) => w.id === s.id) ?? s), ...wanted.filter((w) => !shipped.some((s) => s.id === w.id))];
if (args.includes('--dry') || wanted.length === 0) console.log(`${wanted.length} entr(ies) would merge; nothing written`);
else {
  mkdirSync(kind.data.slice(0, kind.data.lastIndexOf('/')), { recursive: true });
  writeFileSync(kind.data, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`merged ${wanted.length} entr(ies) into ${kind.data}: ${wanted.map((e) => e.id).join(', ')}; run npm test`);
}
