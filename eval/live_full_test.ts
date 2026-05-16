import 'dotenv/config';
import chalk from 'chalk';
import { captureLiveLoginScreenshots } from '../demo/agent_loop/playwright_login.js';
import { runAccuracyCheck } from './accuracy_check.js';
import { runMeasurementOnScreenshots } from './measure_tokens.js';

interface CliOptions {
  runAccuracy: boolean;
}

function parseOptions(): CliOptions {
  const args = process.argv.slice(2);
  return {
    runAccuracy: !args.includes('--no-accuracy'),
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export async function main(): Promise<void> {
  const options = parseOptions();
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set. Check .env or environment.');
  }

  console.log(chalk.bold('\nCapturing live computer-use login flow...\n'));
  const capture = await captureLiveLoginScreenshots();
  console.log(
    chalk.green(
      `Captured ${capture.screenshots.length} fresh screenshots from ${capture.mode}; no demo/screenshots folder was read.`
    )
  );

  const measurement = await runMeasurementOnScreenshots({
    screenshots: capture.screenshots,
    filenames: capture.filenames,
    taskLabel: `${capture.screenshots.length}-frame live computer-use login flow`,
    source: {
      type: 'live_computer_use',
      scenario: capture.scenario,
      capture_mode: capture.mode,
      filenames: capture.filenames,
    },
    outputPrefix: 'live_login',
  });

  const data = measurement.data as {
    savings: {
      token_reduction_pct: number;
      cost_reduction_pct: number;
      latency_reduction_pct: number;
    };
  };

  let accuracyPath: string | null = null;
  if (options.runAccuracy) {
    console.log('');
    console.log(chalk.bold('Running accuracy judge on the live result...'));
    const accuracy = await runAccuracyCheck(measurement.outPath);
    accuracyPath = accuracy.outPath;

    console.log('');
    console.log(chalk.bold('Live full-test summary'));
    console.log(`  Token reduction:   ${data.savings.token_reduction_pct.toFixed(1)}%`);
    console.log(`  Cost reduction:    ${data.savings.cost_reduction_pct.toFixed(1)}%`);
    console.log(`  Strict accuracy:   ${pct(accuracy.data.strict_agreement)}`);
    console.log(`  Lenient accuracy:  ${pct(accuracy.data.lenient_agreement)}`);
  } else {
    console.log('');
    console.log(chalk.bold('Live efficiency summary'));
    console.log(`  Token reduction:   ${data.savings.token_reduction_pct.toFixed(1)}%`);
    console.log(`  Cost reduction:    ${data.savings.cost_reduction_pct.toFixed(1)}%`);
    console.log('  Accuracy:          skipped (--no-accuracy)');
  }

  console.log('');
  console.log(chalk.bold('Saved artifacts'));
  console.log(`  Efficiency JSON:   ${measurement.outPath}`);
  if (accuracyPath) console.log(`  Accuracy JSON:     ${accuracyPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(message));
    process.exit(1);
  });
}
