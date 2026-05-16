import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import chalk from 'chalk';
import {
  observe,
  resetSession,
  getVlmCumulativeUsage,
  resetVlmCumulativeUsage,
} from '../src/pipeline/index.js';

const MODEL = 'claude-sonnet-4-6';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// Anthropic published pricing per 1M tokens — update if pricing changes
const PRICING: Record<string, { in: number; out: number }> = {
  [MODEL]: { in: 3.0, out: 15.0 },
  [HAIKU_MODEL]: { in: 0.80, out: 4.0 },
};

const SCREENSHOTS_DIR = './demo/screenshots/login_flow';
const RESULTS_DIR = './eval/results';
const PROMPT =
  'Summarize what changed since the previous screenshot in one sentence.';

interface RunAResult {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  perFrame: Array<{ file: string; inputTokens: number; outputTokens: number }>;
}

interface RunBResult {
  sonnetCalls: number;
  sonnetInputTokens: number;
  sonnetOutputTokens: number;
  haikuCalls: number;
  haikuInputTokens: number;
  haikuOutputTokens: number;
  skippedFrames: number;
  ms: number;
  perFrame: Array<{
    file: string;
    action: 'skipped' | 'text_summary' | 'vlm_handled';
    sonnetInputTokens: number;
    sonnetOutputTokens: number;
  }>;
}

async function runBaseline(
  client: Anthropic,
  screenshots: Buffer[],
  filenames: string[]
): Promise<RunAResult> {
  let inputTokens = 0;
  let outputTokens = 0;
  let calls = 0;
  const perFrame: RunAResult['perFrame'] = [];
  const start = Date.now();

  for (let i = 0; i < screenshots.length; i++) {
    const buf = screenshots[i];
    const r = await client.messages.create({
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
                data: buf.toString('base64'),
              },
            },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    });
    inputTokens += r.usage.input_tokens;
    outputTokens += r.usage.output_tokens;
    calls++;
    perFrame.push({
      file: filenames[i],
      inputTokens: r.usage.input_tokens,
      outputTokens: r.usage.output_tokens,
    });
    process.stderr.write(
      chalk.dim(`  [A] ${filenames[i]}: ${r.usage.input_tokens} in\n`)
    );
  }

  return { calls, inputTokens, outputTokens, ms: Date.now() - start, perFrame };
}

async function runStateLens(
  client: Anthropic,
  screenshots: Buffer[],
  filenames: string[]
): Promise<RunBResult> {
  resetSession('eval');
  resetVlmCumulativeUsage();

  let sonnetCalls = 0;
  let sonnetInputTokens = 0;
  let sonnetOutputTokens = 0;
  let skippedFrames = 0;
  const perFrame: RunBResult['perFrame'] = [];
  const start = Date.now();

  for (let i = 0; i < screenshots.length; i++) {
    const buf = screenshots[i];
    const obs = await observe(buf, 'eval');

    if (!obs.changed) {
      skippedFrames++;
      perFrame.push({
        file: filenames[i],
        action: 'skipped',
        sonnetInputTokens: 0,
        sonnetOutputTokens: 0,
      });
      process.stderr.write(chalk.dim(`  [B] ${filenames[i]}: skipped\n`));
      continue;
    }

    if (obs.keyframe && !obs.vlm_called) {
      const r = await client.messages.create({
        model: MODEL,
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Screenshot event: ${obs.event_summary}`,
              },
            ],
          },
        ],
      });
      sonnetInputTokens += r.usage.input_tokens;
      sonnetOutputTokens += r.usage.output_tokens;
      sonnetCalls++;
      perFrame.push({
        file: filenames[i],
        action: 'text_summary',
        sonnetInputTokens: r.usage.input_tokens,
        sonnetOutputTokens: r.usage.output_tokens,
      });
      process.stderr.write(
        chalk.dim(`  [B] ${filenames[i]}: text → ${r.usage.input_tokens} in\n`)
      );
    } else {
      perFrame.push({
        file: filenames[i],
        action: 'vlm_handled',
        sonnetInputTokens: 0,
        sonnetOutputTokens: 0,
      });
      process.stderr.write(
        chalk.dim(`  [B] ${filenames[i]}: vlm handled internally\n`)
      );
    }
  }

  const haiku = getVlmCumulativeUsage();
  const haikuCalls = perFrame.filter((f) => f.action === 'vlm_handled').length;
  return {
    sonnetCalls,
    sonnetInputTokens,
    sonnetOutputTokens,
    haikuCalls,
    haikuInputTokens: haiku.input_tokens,
    haikuOutputTokens: haiku.output_tokens,
    skippedFrames,
    ms: Date.now() - start,
    perFrame,
  };
}

function costForTokens(tokens: number, pricePerMillion: number): number {
  return (tokens / 1_000_000) * pricePerMillion;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function printResults(
  frameCount: number,
  A: RunAResult,
  B: RunBResult
): void {
  const costA =
    costForTokens(A.inputTokens, PRICING[MODEL].in) +
    costForTokens(A.outputTokens, PRICING[MODEL].out);

  const costBSonnet =
    costForTokens(B.sonnetInputTokens, PRICING[MODEL].in) +
    costForTokens(B.sonnetOutputTokens, PRICING[MODEL].out);
  const costBHaiku =
    costForTokens(B.haikuInputTokens, PRICING[HAIKU_MODEL].in) +
    costForTokens(B.haikuOutputTokens, PRICING[HAIKU_MODEL].out);
  const costB = costBSonnet + costBHaiku;

  const totalBInputTokens = B.sonnetInputTokens + B.haikuInputTokens;
  const totalBOutputTokens = B.sonnetOutputTokens + B.haikuOutputTokens;

  const tokenReduction =
    A.inputTokens > 0
      ? ((A.inputTokens - totalBInputTokens) / A.inputTokens) * 100
      : 0;
  const costReduction = costA > 0 ? ((costA - costB) / costA) * 100 : 0;
  const latencyReduction = A.ms > 0 ? ((A.ms - B.ms) / A.ms) * 100 : 0;

  console.log('');
  console.log(chalk.bold(`Task: ${frameCount}-frame login flow analysis`));
  console.log(
    chalk.bold(
      `Model: ${MODEL} (StateLens internal: ${HAIKU_MODEL})`
    )
  );
  console.log('');

  console.log(chalk.yellow.bold('Run A (baseline, raw images):'));
  console.log(`  API calls:           ${fmt(A.calls)}`);
  console.log(`  Input tokens:        ${fmt(A.inputTokens)}`);
  console.log(`  Output tokens:       ${fmt(A.outputTokens)}`);
  console.log(`  Wall time:           ${(A.ms / 1000).toFixed(1)}s`);
  console.log(`  Estimated cost:      $${costA.toFixed(4)}`);
  console.log('');

  console.log(chalk.green.bold('Run B (StateLens compression):'));
  console.log(`  Sonnet API calls:    ${fmt(B.sonnetCalls)}`);
  console.log(`  Haiku calls (inside): ${fmt(B.haikuCalls)}`);
  console.log(`  Frames skipped:      ${fmt(B.skippedFrames)}`);
  console.log(
    `  Input tokens (total): ${fmt(totalBInputTokens)}  (Sonnet: ${fmt(B.sonnetInputTokens)}, Haiku: ${fmt(B.haikuInputTokens)})`
  );
  console.log(`  Output tokens:       ${fmt(totalBOutputTokens)}`);
  console.log(`  Wall time:           ${(B.ms / 1000).toFixed(1)}s`);
  console.log(`  Estimated cost:      $${costB.toFixed(4)}`);
  console.log('');

  console.log(chalk.cyan.bold('Savings:'));
  console.log(
    `  Token reduction:     ${chalk.bold(tokenReduction.toFixed(1) + '%')}`
  );
  console.log(
    `  Cost reduction:      ${chalk.bold(costReduction.toFixed(1) + '%')}`
  );
  console.log(
    `  Latency reduction:   ${chalk.bold(latencyReduction.toFixed(1) + '%')}`
  );
  console.log('');
}

export async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      chalk.red('ANTHROPIC_API_KEY not set. Check .env or environment.')
    );
    process.exit(1);
  }

  const client = new Anthropic();

  const files = (await readdir(SCREENSHOTS_DIR))
    .filter((f) => extname(f).toLowerCase() === '.png')
    .sort();

  if (files.length === 0) {
    console.error(chalk.red(`No PNG files found in ${SCREENSHOTS_DIR}`));
    process.exit(1);
  }

  const screenshots = await Promise.all(
    files.map((f) => readFile(join(SCREENSHOTS_DIR, f)))
  );

  console.log(
    chalk.bold(
      `\nRunning A/B measurement on ${screenshots.length} screenshots against ${MODEL}...\n`
    )
  );

  console.log(chalk.yellow('Run A — Baseline (raw images to Sonnet)...'));
  const A = await runBaseline(client, screenshots, files);

  console.log('');
  console.log(chalk.green('Run B — StateLens compression...'));
  const B = await runStateLens(client, screenshots, files);

  printResults(screenshots.length, A, B);

  // Save results JSON
  await mkdir(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const totalBInputTokens = B.sonnetInputTokens + B.haikuInputTokens;
  const costA =
    costForTokens(A.inputTokens, PRICING[MODEL].in) +
    costForTokens(A.outputTokens, PRICING[MODEL].out);
  const costBSonnet =
    costForTokens(B.sonnetInputTokens, PRICING[MODEL].in) +
    costForTokens(B.sonnetOutputTokens, PRICING[MODEL].out);
  const costBHaiku =
    costForTokens(B.haikuInputTokens, PRICING[HAIKU_MODEL].in) +
    costForTokens(B.haikuOutputTokens, PRICING[HAIKU_MODEL].out);

  const resultData = {
    timestamp: new Date().toISOString(),
    model: MODEL,
    haiku_model: HAIKU_MODEL,
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
      sonnet_calls: B.sonnetCalls,
      haiku_calls: B.haikuCalls,
      skipped_frames: B.skippedFrames,
      sonnet_input_tokens: B.sonnetInputTokens,
      sonnet_output_tokens: B.sonnetOutputTokens,
      haiku_input_tokens: B.haikuInputTokens,
      haiku_output_tokens: B.haikuOutputTokens,
      total_input_tokens: totalBInputTokens,
      wall_time_ms: B.ms,
      estimated_cost: costBSonnet + costBHaiku,
      per_frame: B.perFrame,
    },
    savings: {
      token_reduction_pct:
        A.inputTokens > 0
          ? ((A.inputTokens - totalBInputTokens) / A.inputTokens) * 100
          : 0,
      cost_reduction_pct:
        costA > 0
          ? ((costA - (costBSonnet + costBHaiku)) / costA) * 100
          : 0,
      latency_reduction_pct:
        A.ms > 0 ? ((A.ms - B.ms) / A.ms) * 100 : 0,
    },
    pricing: PRICING,
  };

  const outPath = join(RESULTS_DIR, `run_${timestamp}.json`);
  await writeFile(outPath, JSON.stringify(resultData, null, 2));
  console.log(chalk.dim(`Results saved to ${outPath}`));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
