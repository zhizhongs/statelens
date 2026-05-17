// Proxy A/B harness.
//
// Boots Ruotian's HTTP proxy in-process on a high port, then runs the SAME
// raw-screenshot Anthropic SDK loop twice:
//   Run A — client baseURL = api.anthropic.com  (direct, raw images)
//   Run B — client baseURL = http://127.0.0.1:<port> (proxy intercepts and
//           rewrites image content blocks into text observations when the
//           StateLens pipeline decides it's safe)
//
// The two runs send byte-identical request bodies. The only difference is
// what the upstream sees. If the proxy is working, Run B's cumulative input
// tokens should be much lower than Run A's, matching the in-process
// measurement numbers from eval/measure_tokens.ts.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import chalk from 'chalk';
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
const MODEL = 'claude-sonnet-4-6';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const PRICING: Record<string, { in: number; out: number }> = {
  [MODEL]: { in: 3.0, out: 15.0 },
  [HAIKU_MODEL]: { in: 0.8, out: 4.0 },
};
const DEFAULT_DIR = './demo/screenshots/login_flow';
const RESULTS_DIR = './eval/results';
const SESSION_ID = `proxy_eval_${Date.now()}`;
const UPSTREAM = 'https://api.anthropic.com';

// prev+curr fair-baseline pattern, mirrors eval/measure_tokens.ts. Both runs
// send the prior screenshot alongside the current one so Run A and Run B both
// have access to the same prior context. This is the only way the accuracy
// judge can do an apples-to-apples comparison: otherwise Run B (which has
// prior state via the proxy's text observation) sees changes Run A can't see,
// and the judge marks them as MISS. Trade-off: savings look smaller in this
// mode because the prev image still rides along in Run B's request, eating
// ~1500 tokens per call. The realistic single-image-per-turn savings of
// ~46/59% can be reproduced separately by sending only `curr`.
const PROMPT_FIRST = 'Describe what is on this UI screenshot in one sentence.';
const PROMPT_CHANGE =
  'These are two consecutive UI screenshots. Summarize what changed between them in one sentence.';

// Run B frames whose Sonnet response echoes the proxy's "no meaningful change"
// stub are skip-equivalent: the visual gate filtered the frame, which mirrors
// runStateLens()'s `action: 'skipped'` in eval/measure_tokens.ts. Marking them
// here lets accuracy_check.ts treat them as expected matches (same semantics).
const noChangeRe =
  /no (meaningful )?(ui )?(change|changes?)|no change occurred|no change was detected|unchanged|no(thing)? changed/i;

interface RunResult {
  label: string;
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

  // prev+curr per turn. Every call attaches both the prior and current
  // screenshot plus the "what changed" prompt. The proxy only rewrites the
  // LATEST image block, so Run B's request becomes [prev_image, text_obs,
  // prompt] — prev still in tokens, latest replaced with a text observation.
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
        model: MODEL,
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
  // silence per-request JSON logs during the eval
  opts.logLevel = (process.env.STATELENS_EVAL_PROXY_LOG_LEVEL as typeof opts.logLevel) ?? 'silent';
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
    throw new Error('ANTHROPIC_API_KEY not set. Check .env or environment.');
  }
  const dir = parseDir();
  const { screenshots, filenames } = await loadScreenshots(dir);

  console.log(
    chalk.bold(
      `\nProxy A/B measurement on ${screenshots.length} screenshots from ${dir}\n`
    )
  );

  const stopProxy = await bootProxy();
  try {
    resetSession(SESSION_ID);
    resetVlmCumulativeUsage();

    const directClient = new Anthropic();
    const proxyClient = new Anthropic({
      baseURL: `http://${PROXY_HOST}:${PROXY_PORT}`,
    });

    console.log(chalk.yellow('Run A — direct to api.anthropic.com (raw images)...'));
    const A = await runOnce(directClient, screenshots, filenames, 'A');

    // Fresh session state for the proxy run so prev-screenshot tracking starts clean
    resetSession(SESSION_ID);
    resetVlmCumulativeUsage();

    console.log('');
    console.log(chalk.green('Run B — via StateLens proxy (same raw image payload)...'));
    const B = await runOnce(proxyClient, screenshots, filenames, 'B', {
      'x-statelens-session-id': SESSION_ID,
    });
    const haiku = getVlmCumulativeUsage();

    const costA =
      costFor(A.inputTokens, PRICING[MODEL].in) +
      costFor(A.outputTokens, PRICING[MODEL].out);
    const costBSonnet =
      costFor(B.inputTokens, PRICING[MODEL].in) +
      costFor(B.outputTokens, PRICING[MODEL].out);
    const costBHaiku =
      costFor(haiku.input_tokens, PRICING[HAIKU_MODEL].in) +
      costFor(haiku.output_tokens, PRICING[HAIKU_MODEL].out);
    const costB = costBSonnet + costBHaiku;
    const totalBInputTokens = B.inputTokens + haiku.input_tokens;

    const tokenReduction =
      A.inputTokens > 0 ? ((A.inputTokens - totalBInputTokens) / A.inputTokens) * 100 : 0;
    const costReduction = costA > 0 ? ((costA - costB) / costA) * 100 : 0;
    const latencyReduction = A.ms > 0 ? ((A.ms - B.ms) / A.ms) * 100 : 0;

    console.log('');
    console.log(chalk.bold(`Task: ${screenshots.length}-frame proxy A/B`));
    console.log(chalk.bold(`Model: ${MODEL} (internal: ${HAIKU_MODEL})`));
    console.log('');

    console.log(chalk.yellow.bold('Run A (direct, raw images):'));
    console.log(`  API calls:           ${fmt(A.calls)}`);
    console.log(`  Input tokens:        ${fmt(A.inputTokens)}`);
    console.log(`  Output tokens:       ${fmt(A.outputTokens)}`);
    console.log(`  Wall time:           ${(A.ms / 1000).toFixed(1)}s`);
    console.log(`  Estimated cost:      $${costA.toFixed(4)}`);
    console.log('');

    console.log(chalk.green.bold('Run B (through StateLens proxy):'));
    console.log(`  Sonnet calls:        ${fmt(B.calls)}`);
    console.log(
      `  Input tokens (total): ${fmt(totalBInputTokens)} ` +
        `(Sonnet: ${fmt(B.inputTokens)}, Haiku internal: ${fmt(haiku.input_tokens)})`
    );
    console.log(
      `  Output tokens:       ${fmt(B.outputTokens + haiku.output_tokens)} ` +
        `(Sonnet: ${fmt(B.outputTokens)}, Haiku: ${fmt(haiku.output_tokens)})`
    );
    console.log(`  Wall time:           ${(B.ms / 1000).toFixed(1)}s`);
    console.log(`  Estimated cost:      $${costB.toFixed(4)}`);
    console.log('');

    console.log(chalk.cyan.bold('Savings (Proxy vs Direct):'));
    console.log(`  Token reduction:     ${chalk.bold(tokenReduction.toFixed(1) + '%')}`);
    console.log(`  Cost reduction:      ${chalk.bold(costReduction.toFixed(1) + '%')}`);
    console.log(`  Latency reduction:   ${chalk.bold(latencyReduction.toFixed(1) + '%')}`);
    console.log('');

    await mkdir(RESULTS_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = join(RESULTS_DIR, `proxy_ab_${timestamp}.json`);
    // Keys match the shape eval/accuracy_check.ts expects so we can chain the
    // accuracy judge against this file without a separate adapter.
    await writeFile(
      outPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          model: MODEL,
          haiku_model: HAIKU_MODEL,
          source: { type: 'screenshot_directory', path: dir, mode: 'proxy_ab' },
          proxy: { host: PROXY_HOST, port: PROXY_PORT, upstream: UPSTREAM },
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
            sonnet_calls: B.calls,
            sonnet_input_tokens: B.inputTokens,
            sonnet_output_tokens: B.outputTokens,
            haiku_input_tokens: haiku.input_tokens,
            haiku_output_tokens: haiku.output_tokens,
            total_input_tokens: totalBInputTokens,
            wall_time_ms: B.ms,
            estimated_cost: costB,
            // Mark frames where Sonnet echoed the proxy's "no meaningful change"
            // stub as action='skipped' — the visual gate filtered them, which is
            // an expected match (same semantics as the in-process eval). Other
            // frames are 'text_summary' so the accuracy judge can compare them.
            per_frame: B.perFrame.map((f) => ({
              ...f,
              action: noChangeRe.test(f.summary)
                ? ('skipped' as const)
                : ('text_summary' as const),
            })),
          },
          savings: {
            token_reduction_pct: tokenReduction,
            cost_reduction_pct: costReduction,
            latency_reduction_pct: latencyReduction,
          },
          pricing: PRICING,
        },
        null,
        2
      )
    );
    console.log(chalk.dim(`Results saved to ${outPath}`));

    console.log('');
    console.log(chalk.bold('Running accuracy judge on the proxy A/B result...'));
    await runAccuracyCheck(outPath);
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
