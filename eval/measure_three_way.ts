// Three-way comparison harness:
//   Run A — direct to api.anthropic.com, claude-sonnet-4-6  (baseline)
//   Run B — through StateLens proxy on http://127.0.0.1:18443  (uses whichever
//           STATELENS_PROXY_SYNTH / OCR_POOL / etc env vars are set)
//   Run C — direct to api.anthropic.com, claude-haiku-4-5    (naive model-swap)
//
// The point: if Run C's cost and accuracy are similar to Run B, then most of
// Run B's savings is just "we used Haiku instead of Sonnet" — anyone could do
// that with a one-line config change. The interesting StateLens delta is
// whatever Run B captures BEYOND Run C — typically visual-gate skips (no LLM
// call at all) and routing intelligence for frames where Sonnet IS needed.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import chalk, { type ChalkInstance } from 'chalk';
import {
  createAnthropicProxyServer,
  parseProxyOptions,
} from '../src/proxy/anthropic.js';
import {
  getVlmCumulativeUsage,
  resetSession,
  resetVlmCumulativeUsage,
} from '../src/pipeline/index.js';
import { resetOcrWorker } from '../src/pipeline/ocrDiff.js';
import { runAccuracyCheck } from './accuracy_check.js';

const PROXY_PORT = 18443;
const PROXY_HOST = '127.0.0.1';
const SONNET = 'claude-sonnet-4-6';
const HAIKU = 'claude-haiku-4-5-20251001';
const PRICING: Record<string, { in: number; out: number }> = {
  [SONNET]: { in: 3.0, out: 15.0 },
  [HAIKU]: { in: 0.8, out: 4.0 },
};
const DEFAULT_DIR = './demo/screenshots/login_flow';
const RESULTS_DIR = './eval/results';
const SESSION_ID = `three_way_${Date.now()}`;
const UPSTREAM = 'https://api.anthropic.com';

const PROMPT_FIRST = 'Describe what is on this UI screenshot in one sentence.';
const PROMPT_CHANGE =
  'These are two consecutive UI screenshots. Summarize what changed between them in one sentence.';

const noChangeRe =
  /no (meaningful )?(ui )?(change|changes?)|no change occurred|no change was detected|unchanged|no(thing)? changed/i;

interface RunResult {
  label: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  perFrame: Array<{
    file: string;
    inputTokens: number;
    outputTokens: number;
    summary: string;
  }>;
}

function parseDir(): string {
  const args = process.argv.slice(2);
  const i = args.findIndex((a) => a === '--dir' || a === '-d');
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return args.find((a) => !a.startsWith('-')) ?? DEFAULT_DIR;
}

async function loadScreenshots(dir: string): Promise<{ screenshots: Buffer[]; filenames: string[] }> {
  const filenames = (await readdir(dir))
    .filter((f) => extname(f).toLowerCase() === '.png')
    .sort();
  if (filenames.length === 0) throw new Error(`No PNG files found in ${dir}`);
  const screenshots = await Promise.all(filenames.map((f) => readFile(join(dir, f))));
  return { screenshots, filenames };
}

async function runOnce(
  client: Anthropic,
  model: string,
  screenshots: Buffer[],
  filenames: string[],
  label: string,
  extraHeaders: Record<string, string> = {}
): Promise<RunResult> {
  let inputTokens = 0;
  let outputTokens = 0;
  let calls = 0;
  const perFrame: RunResult['perFrame'] = [];
  const start = Date.now();

  for (let i = 0; i < screenshots.length; i++) {
    const curr = screenshots[i];
    const prev = i > 0 ? screenshots[i - 1] : null;
    const content: Array<
      | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } }
      | { type: 'text'; text: string }
    > = [];
    if (prev) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: prev.toString('base64') },
      });
    }
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: curr.toString('base64') },
    });
    content.push({ type: 'text', text: prev ? PROMPT_CHANGE : PROMPT_FIRST });

    const r = await client.messages.create(
      {
        model,
        max_tokens: 200,
        messages: [{ role: 'user', content }],
      },
      Object.keys(extraHeaders).length ? { headers: extraHeaders } : undefined
    );

    inputTokens += r.usage.input_tokens;
    outputTokens += r.usage.output_tokens;
    calls++;
    const summary = r.content.find((c) => c.type === 'text')?.text ?? '';
    perFrame.push({
      file: filenames[i],
      inputTokens: r.usage.input_tokens,
      outputTokens: r.usage.output_tokens,
      summary,
    });
    process.stderr.write(
      chalk.dim(`  [${label}] ${filenames[i]}: ${r.usage.input_tokens} in\n`)
    );
  }

  return {
    label,
    model,
    calls,
    inputTokens,
    outputTokens,
    ms: Date.now() - start,
    perFrame,
  };
}

function costFor(tokens: number, pricePerMillion: number): number {
  return (tokens / 1_000_000) * pricePerMillion;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

async function bootProxy(): Promise<() => Promise<void>> {
  process.env.STATELENS_PROXY_ACTIVE = '1';
  process.env.STATELENS_ANTHROPIC_UPSTREAM_BASE_URL = UPSTREAM;
  const opts = parseProxyOptions(
    ['--provider', 'anthropic', '--host', PROXY_HOST, '--port', String(PROXY_PORT), '--upstream', UPSTREAM],
    process.env
  );
  opts.logLevel = 'silent';
  const server = createAnthropicProxyServer(opts);
  await new Promise<void>((resolve) => server.listen(PROXY_PORT, PROXY_HOST, resolve));
  console.log(chalk.dim(`Proxy listening on http://${PROXY_HOST}:${PROXY_PORT}\n`));
  return () =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
}

export async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }
  const dir = parseDir();
  const { screenshots, filenames } = await loadScreenshots(dir);

  console.log(chalk.bold(`\n3-way measurement on ${screenshots.length} screenshots from ${dir}\n`));

  const stopProxy = await bootProxy();
  try {
    const directClient = new Anthropic();
    const proxyClient = new Anthropic({ baseURL: `http://${PROXY_HOST}:${PROXY_PORT}` });

    resetSession(SESSION_ID);
    resetVlmCumulativeUsage();

    console.log(chalk.yellow('Run A — direct, claude-sonnet-4-6 (baseline) ...'));
    const A = await runOnce(directClient, SONNET, screenshots, filenames, 'A');

    resetSession(SESSION_ID);
    resetVlmCumulativeUsage();

    console.log('');
    console.log(chalk.green('Run B — through StateLens proxy ...'));
    const B = await runOnce(proxyClient, SONNET, screenshots, filenames, 'B', {
      'x-statelens-session-id': SESSION_ID,
    });
    const haiku = getVlmCumulativeUsage();

    console.log('');
    console.log(chalk.cyan('Run C — direct, claude-haiku-4-5 (naive model swap) ...'));
    const C = await runOnce(directClient, HAIKU, screenshots, filenames, 'C');

    const costA = costFor(A.inputTokens, PRICING[SONNET].in) + costFor(A.outputTokens, PRICING[SONNET].out);
    const costBSonnet = costFor(B.inputTokens, PRICING[SONNET].in) + costFor(B.outputTokens, PRICING[SONNET].out);
    const costBHaiku = costFor(haiku.input_tokens, PRICING[HAIKU].in) + costFor(haiku.output_tokens, PRICING[HAIKU].out);
    const costB = costBSonnet + costBHaiku;
    const totalBInputTokens = B.inputTokens + haiku.input_tokens;
    const costC = costFor(C.inputTokens, PRICING[HAIKU].in) + costFor(C.outputTokens, PRICING[HAIKU].out);

    const reductionVsA = (val: number) => ((A.inputTokens - val) / A.inputTokens) * 100;
    const costReductionVsA = (val: number) => ((costA - val) / costA) * 100;
    const latencyReductionVsA = (val: number) => ((A.ms - val) / A.ms) * 100;

    console.log('');
    console.log(chalk.bold(`\n=== 3-way summary (${screenshots.length} frames from ${dir}) ===\n`));

    const fmtRow = (label: string, color: ChalkInstance, calls: number, tokens: number, cost: number, ms: number) => {
      console.log(
        color(`  ${label.padEnd(22)} ${fmt(calls).padStart(4)} calls   ${fmt(tokens).padStart(8)} tokens   $${cost.toFixed(4)}   ${(ms / 1000).toFixed(1)}s`)
      );
    };
    console.log(chalk.dim('                              calls       tokens         cost     wall'));
    fmtRow('A direct/sonnet', chalk.yellow, A.calls, A.inputTokens, costA, A.ms);
    fmtRow('B statelens', chalk.green, B.calls, totalBInputTokens, costB, B.ms);
    fmtRow('C direct/haiku', chalk.cyan, C.calls, C.inputTokens, costC, C.ms);

    console.log('');
    console.log(chalk.bold('  Savings vs direct/sonnet (A):'));
    console.log(
      `    B (statelens):     ${chalk.green(reductionVsA(totalBInputTokens).toFixed(1) + '%')} tokens   ${chalk.green(costReductionVsA(costB).toFixed(1) + '%')} cost   ${chalk.green(latencyReductionVsA(B.ms).toFixed(1) + '%')} latency`
    );
    console.log(
      `    C (haiku swap):    ${chalk.cyan(reductionVsA(C.inputTokens).toFixed(1) + '%')} tokens   ${chalk.cyan(costReductionVsA(costC).toFixed(1) + '%')} cost   ${chalk.cyan(latencyReductionVsA(C.ms).toFixed(1) + '%')} latency`
    );

    console.log('');
    console.log(chalk.bold('  StateLens delta over naive Haiku-swap (B vs C):'));
    const tokenDelta = ((C.inputTokens - totalBInputTokens) / C.inputTokens) * 100;
    const costDelta = ((costC - costB) / costC) * 100;
    const latencyDelta = ((C.ms - B.ms) / C.ms) * 100;
    console.log(
      `    tokens:   ${tokenDelta >= 0 ? chalk.green(`${tokenDelta.toFixed(1)}% fewer`) : chalk.red(`${(-tokenDelta).toFixed(1)}% more`)}`
    );
    console.log(
      `    cost:     ${costDelta >= 0 ? chalk.green(`${costDelta.toFixed(1)}% cheaper`) : chalk.red(`${(-costDelta).toFixed(1)}% more expensive`)}`
    );
    console.log(
      `    latency:  ${latencyDelta >= 0 ? chalk.green(`${latencyDelta.toFixed(1)}% faster`) : chalk.red(`${(-latencyDelta).toFixed(1)}% slower`)}`
    );
    console.log('');

    await mkdir(RESULTS_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = join(RESULTS_DIR, `three_way_${timestamp}.json`);
    await writeFile(
      outPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          source: { type: 'screenshot_directory', path: dir, mode: 'three_way' },
          frame_count: screenshots.length,
          proxy: { host: PROXY_HOST, port: PROXY_PORT, upstream: UPSTREAM },
          // Run A (direct Sonnet) — shape matches accuracy_check.ts expectations
          run_a: {
            calls: A.calls,
            input_tokens: A.inputTokens,
            output_tokens: A.outputTokens,
            wall_time_ms: A.ms,
            estimated_cost: costA,
            per_frame: A.perFrame,
          },
          run_b: {
            sonnet_calls: B.calls,
            sonnet_input_tokens: B.inputTokens,
            sonnet_output_tokens: B.outputTokens,
            haiku_input_tokens: haiku.input_tokens,
            haiku_output_tokens: haiku.output_tokens,
            total_input_tokens: totalBInputTokens,
            wall_time_ms: B.ms,
            estimated_cost: costB,
            per_frame: B.perFrame.map((f) => ({
              ...f,
              action: noChangeRe.test(f.summary)
                ? ('skipped' as const)
                : ('text_summary' as const),
            })),
          },
          run_c: {
            calls: C.calls,
            input_tokens: C.inputTokens,
            output_tokens: C.outputTokens,
            wall_time_ms: C.ms,
            estimated_cost: costC,
            per_frame: C.perFrame,
          },
          pricing: PRICING,
        },
        null,
        2
      )
    );
    console.log(chalk.dim(`Saved to ${outPath}\n`));

    console.log(chalk.bold('Accuracy: B (statelens) vs A (direct Sonnet)'));
    await runAccuracyCheck(outPath);

    // Run accuracy of C vs A by writing a temp run_b-shaped file with C's data.
    const cAsBPath = outPath.replace('.json', '.run_c_vs_a.json');
    const cAsBData = {
      timestamp: new Date().toISOString(),
      model: SONNET,
      haiku_model: HAIKU,
      source: { type: 'screenshot_directory', path: dir, mode: 'haiku_swap' },
      frame_count: screenshots.length,
      run_a: {
        calls: A.calls,
        input_tokens: A.inputTokens,
        output_tokens: A.outputTokens,
        wall_time_ms: A.ms,
        estimated_cost: costA,
        per_frame: A.perFrame,
      },
      run_b: {
        sonnet_calls: 0,
        sonnet_input_tokens: 0,
        sonnet_output_tokens: 0,
        haiku_input_tokens: C.inputTokens,
        haiku_output_tokens: C.outputTokens,
        total_input_tokens: C.inputTokens,
        wall_time_ms: C.ms,
        estimated_cost: costC,
        per_frame: C.perFrame.map((f) => ({
          ...f,
          action: 'text_summary' as const,
        })),
      },
      savings: {
        token_reduction_pct: reductionVsA(C.inputTokens),
        cost_reduction_pct: costReductionVsA(costC),
        latency_reduction_pct: latencyReductionVsA(C.ms),
      },
      pricing: PRICING,
    };
    await writeFile(cAsBPath, JSON.stringify(cAsBData, null, 2));
    console.log('');
    console.log(chalk.bold('Accuracy: C (haiku swap) vs A (direct Sonnet)'));
    await runAccuracyCheck(cAsBPath);
  } finally {
    await stopProxy();
    await resetOcrWorker();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(msg));
    process.exit(1);
  });
}
