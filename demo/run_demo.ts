// Demo runner — single-config Anthropic SDK loop over a screenshot directory.
//
// Sends one image per turn (the realistic agent pattern for computer-use,
// Claude Code, Cursor, etc.) and prints per-frame + total input tokens.
//
// The same script powers both halves of demo/record.sh:
//   ANTHROPIC_BASE_URL unset                  -> direct to api.anthropic.com
//   ANTHROPIC_BASE_URL=http://127.0.0.1:8443  -> through statelens proxy
//
// No A/B logic here — this is what an actual user's agent looks like.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import chalk from 'chalk';

const MODEL = 'claude-sonnet-4-6';
const HAIKU_MODEL = 'claude-haiku-4-5';
const SONNET_PRICE_IN_PER_M = 3.0;
const SONNET_PRICE_OUT_PER_M = 15.0;
const HAIKU_PRICE_IN_PER_M = 0.8;
const HAIKU_PRICE_OUT_PER_M = 4.0;
const DEFAULT_DIR = './demo/screenshots/login_flow';
const PROMPT = 'Describe what is on this UI screenshot in one sentence.';

function parseDir(): string {
  const args = process.argv.slice(2);
  const i = args.findIndex((a) => a === '--dir' || a === '-d');
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return args.find((a) => !a.startsWith('-')) ?? DEFAULT_DIR;
}

async function loadScreenshots(dir: string): Promise<{ buffers: Buffer[]; names: string[] }> {
  const names = (await readdir(dir))
    .filter((f) => extname(f).toLowerCase() === '.png')
    .sort();
  if (names.length === 0) throw new Error(`No PNG files found in ${dir}`);
  const buffers = await Promise.all(names.map((f) => readFile(join(dir, f))));
  return { buffers, names };
}

interface VlmUsage {
  input_tokens: number;
  output_tokens: number;
  calls: number;
}

async function getProxyVlmUsage(baseURL: string): Promise<VlmUsage | null> {
  try {
    const r = await fetch(new URL('/usage', baseURL));
    if (!r.ok) return null;
    const body = (await r.json()) as { vlm?: VlmUsage };
    return body.vlm ?? null;
  } catch {
    return null;
  }
}

async function resetProxyVlmUsage(baseURL: string): Promise<void> {
  try {
    await fetch(new URL('/usage/reset', baseURL), { method: 'POST' });
  } catch {
    // Best effort — older proxy builds may not have the endpoint.
  }
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }
  const dir = parseDir();
  const { buffers, names } = await loadScreenshots(dir);
  const baseURL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const label = baseURL.includes('127.0.0.1') || baseURL.includes('localhost') ? 'proxy' : 'direct';
  const sessionId = `demo_${Date.now()}`;

  // Make sure the proxy's cumulative Haiku counter starts at zero for this run
  // so the totals we report are this-run-only.
  if (label === 'proxy') await resetProxyVlmUsage(baseURL);

  const client = new Anthropic({ baseURL });

  console.log(chalk.bold(`Running ${buffers.length}-frame login agent (${label})`));
  console.log(chalk.dim(`baseURL = ${baseURL}`));
  console.log('');

  let totalIn = 0;
  let totalOut = 0;
  const t0 = Date.now();

  for (let i = 0; i < buffers.length; i++) {
    const r = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: buffers[i].toString('base64'),
                },
              },
              { type: 'text', text: PROMPT },
            ],
          },
        ],
      },
      label === 'proxy' ? { headers: { 'x-statelens-session-id': sessionId } } : undefined
    );
    totalIn += r.usage.input_tokens;
    totalOut += r.usage.output_tokens;
    const color = label === 'proxy' ? chalk.green : chalk.yellow;
    console.log(
      color(`  frame ${String(i + 1).padStart(2)} ${names[i]}  →  ${String(r.usage.input_tokens).padStart(5)} input tokens`)
    );
  }

  const ms = Date.now() - t0;
  const sonnetCost =
    (totalIn / 1_000_000) * SONNET_PRICE_IN_PER_M +
    (totalOut / 1_000_000) * SONNET_PRICE_OUT_PER_M;

  // Pull internal Haiku usage from the proxy. Anthropic bills these against the
  // caller's key, so we have to include them to be honest about cost.
  const vlm = label === 'proxy' ? await getProxyVlmUsage(baseURL) : null;
  const haikuCost = vlm
    ? (vlm.input_tokens / 1_000_000) * HAIKU_PRICE_IN_PER_M +
      (vlm.output_tokens / 1_000_000) * HAIKU_PRICE_OUT_PER_M
    : 0;
  const totalInputAll = totalIn + (vlm?.input_tokens ?? 0);
  const totalOutputAll = totalOut + (vlm?.output_tokens ?? 0);
  const totalCost = sonnetCost + haikuCost;

  console.log('');
  console.log(chalk.bold(`Totals (${label}):`));
  if (vlm) {
    console.log(`  Sonnet input   ${totalIn.toLocaleString()} tokens`);
    console.log(`  Sonnet output  ${totalOut.toLocaleString()} tokens`);
    console.log(`  Haiku input    ${vlm.input_tokens.toLocaleString()} tokens   ${chalk.dim('(internal, billed to your key)')}`);
    console.log(`  Haiku output   ${vlm.output_tokens.toLocaleString()} tokens`);
    console.log(`  ${chalk.bold('total input')}    ${totalInputAll.toLocaleString()} tokens`);
  } else {
    console.log(`  input tokens   ${totalIn.toLocaleString()}`);
    console.log(`  output tokens  ${totalOut.toLocaleString()}`);
  }
  console.log(`  wall time      ${(ms / 1000).toFixed(1)}s`);
  console.log(`  ${chalk.bold('cost')}           $${totalCost.toFixed(4)}`);
  console.log('');

  // Machine-readable line for record.sh — totals already include any Haiku internals.
  console.log(
    `STATELENS_DEMO_RESULT label=${label} input=${totalInputAll} output=${totalOutputAll} cost=${totalCost.toFixed(6)} ms=${ms}`
  );
}

main().catch((err) => {
  console.error(chalk.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
