// Accuracy comparison: does StateLens's compressed signal capture the same
// events as the raw-image baseline?
//
// For each non-skipped frame, ask Haiku to judge whether Run A's Sonnet
// summary (produced from the raw image) and Run B's StateLens summary
// describe the same UI event. Output: per-frame verdict + overall agreement.
//
// Usage: node dist/eval/accuracy_check.js <results.json>
//   e.g.  node dist/eval/accuracy_check.js eval/results/phase3_optimized.json

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile } from 'node:fs/promises';
import chalk from 'chalk';

const JUDGE_MODEL = 'claude-haiku-4-5-20251001';

interface ResultsFile {
  timestamp: string;
  frame_count: number;
  run_a: {
    per_frame: Array<{ file: string; summary?: string }>;
  };
  run_b: {
    per_frame: Array<{
      file: string;
      action: 'skipped' | 'text_summary' | 'vlm_handled';
      summary?: string;
    }>;
  };
}

export interface FrameVerdict {
  file: string;
  action: string;
  run_a_summary: string;
  run_b_summary: string;
  agreement: 'match' | 'partial' | 'miss' | 'na';
  reason: string;
}

export interface AccuracyCheckRun {
  outPath: string;
  data: {
    results_file: string;
    judge_model: string;
    total: number;
    excluded_session_start: number;
    skipped: number;
    matches: number;
    partials: number;
    misses: number;
    strict_agreement: number;
    lenient_agreement: number;
    verdicts: FrameVerdict[];
  };
}

// First-frame session_start has no prior frame to compare against — exclude from accuracy.
function isSessionStart(summary: string): boolean {
  return /First screenshot in session/i.test(summary);
}

async function judgeFrame(
  client: Anthropic,
  a: string,
  b: string,
  filename: string
): Promise<{ verdict: 'match' | 'partial' | 'miss'; reason: string }> {
  const prompt = `You are comparing two one-sentence descriptions of the same UI screenshot.

Description A (from raw image): ${a}

Description B (from compressed signal): ${b}

Do these describe the same UI event? Respond with JSON only:
{"verdict": "match" | "partial" | "miss", "reason": "one short sentence"}

- "match": both describe the same primary event, even if wording differs
- "partial": B captures part of A but misses or distorts a key detail
- "miss": B refers to a different event, or B is too vague to be useful`;

  const r = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 150,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = r.content.find((c) => c.type === 'text')?.text ?? '';
  const clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    const parsed = JSON.parse(clean) as { verdict: 'match' | 'partial' | 'miss'; reason: string };
    return parsed;
  } catch {
    return { verdict: 'miss', reason: `judge could not parse: ${text.slice(0, 80)}` };
  }
}

export async function runAccuracyCheck(resultsPath: string): Promise<AccuracyCheckRun> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set. Check .env or environment.');
  }

  const results: ResultsFile = JSON.parse(await readFile(resultsPath, 'utf-8'));
  const client = new Anthropic();

  const aByFile = new Map<string, string>();
  for (const f of results.run_a.per_frame) {
    if (f.summary) aByFile.set(f.file, f.summary);
  }

  const verdicts: FrameVerdict[] = [];
  let matches = 0;
  let partials = 0;
  let misses = 0;
  let skipped = 0;
  let naCount = 0;

  console.log(chalk.bold(`\nJudging accuracy on ${results.run_b.per_frame.length} frames (parallel)...\n`));

  // Pre-classify each frame into one of: skipped, na (session_start), judgeable.
  const judgeableFrames: typeof results.run_b.per_frame = [];
  for (const bFrame of results.run_b.per_frame) {
    if (bFrame.action === 'skipped') {
      skipped++;
      verdicts.push({
        file: bFrame.file,
        action: 'skipped',
        run_a_summary: aByFile.get(bFrame.file) ?? '',
        run_b_summary: '(filtered by visual gate — no AI call)',
        agreement: 'match',
        reason: 'StateLens filtered the frame; no observation produced — counts as agreement by construction',
      });
      continue;
    }
    const b = bFrame.summary ?? '';
    if (isSessionStart(b)) {
      naCount++;
      verdicts.push({
        file: bFrame.file,
        action: bFrame.action,
        run_a_summary: aByFile.get(bFrame.file) ?? '',
        run_b_summary: b,
        agreement: 'na',
        reason: 'session_start has no prior frame to compare against — excluded from accuracy by construction',
      });
      continue;
    }
    judgeableFrames.push(bFrame);
  }

  // Parallelize judge calls (max ~4 in flight to be polite to the API).
  const CONCURRENCY = 4;
  const judged: FrameVerdict[] = [];
  for (let i = 0; i < judgeableFrames.length; i += CONCURRENCY) {
    const chunk = judgeableFrames.slice(i, i + CONCURRENCY);
    const batch = await Promise.all(
      chunk.map(async (bFrame) => {
        const a = aByFile.get(bFrame.file) ?? '';
        const b = bFrame.summary ?? '';
        if (!a || !b) {
          return {
            file: bFrame.file,
            action: bFrame.action,
            run_a_summary: a,
            run_b_summary: b,
            agreement: 'miss' as const,
            reason: 'missing summary text for one or both runs',
          };
        }
        const { verdict, reason } = await judgeFrame(client, a, b, bFrame.file);
        return {
          file: bFrame.file,
          action: bFrame.action,
          run_a_summary: a,
          run_b_summary: b,
          agreement: verdict,
          reason,
        };
      })
    );
    judged.push(...batch);
  }

  for (const v of judged) {
    if (v.agreement === 'match') matches++;
    else if (v.agreement === 'partial') partials++;
    else if (v.agreement === 'miss') misses++;
    const color =
      v.agreement === 'match' ? chalk.green : v.agreement === 'partial' ? chalk.yellow : chalk.red;
    console.log(`  ${v.file}: ${color(v.agreement.toUpperCase())}  — ${v.reason}`);
  }
  for (const v of verdicts) {
    if (v.agreement === 'na') console.log(chalk.dim(`  ${v.file}: n/a (session_start, excluded)`));
    else if (v.action === 'skipped') console.log(chalk.dim(`  ${v.file}: skipped (visual gate)`));
  }
  verdicts.push(...judged);

  const total = results.run_b.per_frame.length;
  const judgedCount = matches + partials + misses;
  // session_start (na) frames are excluded entirely. Skipped frames count as matches
  // (correctly filtered as "no change"). Strict = matches only. Lenient = matches + partials.
  const denom = total - naCount;
  const strict = denom > 0 ? (matches + skipped) / denom : 0;
  const lenient = denom > 0 ? (matches + partials + skipped) / denom : 0;

  console.log('');
  console.log(chalk.bold('=== Accuracy summary ==='));
  console.log(`  Total frames:           ${total}`);
  console.log(`  Excluded (session_start): ${naCount}`);
  console.log(`  Skipped (visual gate):  ${skipped}`);
  console.log(`  Judged:                 ${judgedCount}`);
  console.log(`    Match:                ${chalk.green(matches)}`);
  console.log(`    Partial:              ${chalk.yellow(partials)}`);
  console.log(`    Miss:                 ${chalk.red(misses)}`);
  console.log('');
  console.log(`  Strict agreement:       ${(strict * 100).toFixed(1)}%  (matches + skipped) / ${denom}`);
  console.log(`  Lenient agreement:      ${(lenient * 100).toFixed(1)}%  (matches + partials + skipped) / ${denom}`);

  const outPath = resultsPath.replace(/\.json$/, '.accuracy.json');
  const data = {
    results_file: resultsPath,
    judge_model: JUDGE_MODEL,
    total,
    excluded_session_start: naCount,
    skipped,
    matches,
    partials,
    misses,
    strict_agreement: strict,
    lenient_agreement: lenient,
    verdicts,
  };
  await writeFile(outPath, JSON.stringify(data, null, 2));
  console.log(chalk.dim(`\n  Saved verdicts to ${outPath}`));
  return { outPath, data };
}

export async function main(): Promise<void> {
  const resultsPath = process.argv[2];
  if (!resultsPath) {
    throw new Error('Usage: node dist/eval/accuracy_check.js <results.json>');
  }
  await runAccuracyCheck(resultsPath);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(message));
    process.exit(1);
  });
}
