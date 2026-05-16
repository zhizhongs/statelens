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
import { resetOcrWorker } from '../src/pipeline/ocrDiff.js';

const MODEL = 'claude-sonnet-4-6';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// Anthropic published pricing per 1M tokens — update if pricing changes
const PRICING: Record<string, { in: number; out: number }> = {
  [MODEL]: { in: 3.0, out: 15.0 },
  [HAIKU_MODEL]: { in: 0.80, out: 4.0 },
};

const DEFAULT_SCREENSHOTS_DIR = './demo/screenshots/login_flow';
const RESULTS_DIR = './eval/results';

// CLI: `npm run measure -- <dir>` or `npm run measure -- --dir <dir>`.
// Falls back to the default login_flow directory.
function parseScreenshotsDir(): string {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === 'measure' ? rawArgs.slice(1) : rawArgs;
  const flagIdx = args.findIndex((a) => a === '--dir' || a === '-d');
  if (flagIdx >= 0 && args[flagIdx + 1]) return args[flagIdx + 1];
  const positional = args.find((a) => !a.startsWith('-'));
  return positional ?? DEFAULT_SCREENSHOTS_DIR;
}

async function loadScreenshotsFromDir(
  screenshotsDir: string
): Promise<{ screenshots: Buffer[]; filenames: string[] }> {
  const filenames = (await readdir(screenshotsDir))
    .filter((f) => extname(f).toLowerCase() === '.png')
    .sort();

  if (filenames.length === 0) {
    throw new Error(`No PNG files found in ${screenshotsDir}`);
  }

  const screenshots = await Promise.all(
    filenames.map((f) => readFile(join(screenshotsDir, f)))
  );

  return { screenshots, filenames };
}
// Run A sends BOTH the previous and current screenshots to Sonnet and asks
// "what changed". This is a fair baseline because StateLens internally also
// uses prev+curr (via visualGate / spatialDiff / ocrDiff / vlmExplain). The
// baseline becomes more expensive (2 images per call vs 1), which makes the
// savings story more honest — a naive agent doing real change detection
// would pass both frames just like we do here. First frame has no prev so
// uses a state-description prompt instead.
const PROMPT_FIRST =
  'Describe what is on this UI screenshot in one sentence.';
const PROMPT_CHANGE =
  'These are two consecutive UI screenshots. Summarize what changed between them in one sentence.';

export interface RunAResult {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  perFrame: Array<{ file: string; inputTokens: number; outputTokens: number; summary: string }>;
}

export interface RunBResult {
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
    summary: string;
  }>;
}

export interface MeasurementInput {
  screenshots: Buffer[];
  filenames: string[];
  taskLabel?: string;
  source?: Record<string, unknown>;
  outputPrefix?: string;
}

export interface MeasurementRun {
  outPath: string;
  data: Record<string, unknown>;
  runA: RunAResult;
  runB: RunBResult;
}

export async function runBaseline(
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
      source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') },
    });
    content.push({ type: 'text', text: prev ? PROMPT_CHANGE : PROMPT_FIRST });
    const r = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      messages: [{ role: 'user', content }],
    });
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
      chalk.dim(`  [A] ${filenames[i]}: ${r.usage.input_tokens} in\n`)
    );
  }

  return { calls, inputTokens, outputTokens, ms: Date.now() - start, perFrame };
}

export async function runStateLens(
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
        summary: 'no_change',
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
      const downstreamSummary = r.content.find((c) => c.type === 'text')?.text ?? '';
      perFrame.push({
        file: filenames[i],
        action: 'text_summary',
        sonnetInputTokens: r.usage.input_tokens,
        sonnetOutputTokens: r.usage.output_tokens,
        // We capture the StateLens event_summary (the upstream signal Sonnet reasoned over)
        // followed by Sonnet's downstream paraphrase. Accuracy comparison uses the StateLens
        // summary since that's what the agent would see in a real loop.
        summary: `${obs.event_summary} | downstream: ${downstreamSummary}`,
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
        summary: obs.event_summary,
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
  B: RunBResult,
  taskLabel = `${frameCount}-frame UI flow analysis`
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
  console.log(chalk.bold(`Task: ${taskLabel}`));
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

export async function runMeasurementOnScreenshots({
  screenshots,
  filenames,
  taskLabel = `${screenshots.length}-frame UI flow analysis`,
  source,
  outputPrefix = 'run',
}: MeasurementInput): Promise<MeasurementRun> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set. Check .env or environment.');
  }

  const client = new Anthropic();

  if (screenshots.length === 0 || screenshots.length !== filenames.length) {
    throw new Error('Measurement requires a non-empty screenshot list with matching filenames.');
  }

  console.log(
    chalk.bold(
      `\nRunning A/B measurement on ${screenshots.length} screenshots against ${MODEL}...\n`
    )
  );

  console.log(chalk.yellow('Run A — Baseline (raw images to Sonnet)...'));
  const A = await runBaseline(client, screenshots, filenames);

  console.log('');
  console.log(chalk.green('Run B — StateLens compression...'));
  let B: RunBResult;
  try {
    B = await runStateLens(client, screenshots, filenames);
  } finally {
    await resetOcrWorker();
  }

  printResults(screenshots.length, A, B, taskLabel);

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
    source,
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

  const safePrefix = outputPrefix.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  const outPath = join(RESULTS_DIR, `${safePrefix}_${timestamp}.json`);
  await writeFile(outPath, JSON.stringify(resultData, null, 2));
  console.log(chalk.dim(`Results saved to ${outPath}`));
  return { outPath, data: resultData, runA: A, runB: B };
}

export async function main(): Promise<void> {
  const screenshotsDir = parseScreenshotsDir();
  const { screenshots, filenames } = await loadScreenshotsFromDir(screenshotsDir);
  await runMeasurementOnScreenshots({
    screenshots,
    filenames,
    taskLabel: `${screenshots.length}-frame screenshot-directory flow analysis`,
    source: { type: 'screenshot_directory', path: screenshotsDir },
    outputPrefix: 'run',
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(message));
    process.exit(1);
  });
}
