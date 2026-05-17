// Reference agent loop that uses Playwright as the screenshot source and
// StateLens as the routing layer. The "expensive VLM" is mocked so this file
// can run without an Anthropic key — the point is to demonstrate the route
// decisions, not to make real model calls.
//
// Uses Playwright when installed:
//   npm install --save-dev playwright
//   npx playwright install chromium
//
// If Playwright is not available, it falls back to a tiny virtual page that
// renders fresh screenshots on demand. The fallback keeps the pitch demo
// runnable without replaying demo/screenshots.
//
// Run with:
//   npm run build
//   npm run demo:computer-use
//
// The demo navigates to a small data: URL with a couple of staged states so
// no network access is required.

import { Buffer } from 'node:buffer';
import sharp from 'sharp';
import { captureAndRoute, type PlaywrightLikePage } from '../../src/adapters/playwright.js';
import {
  estimateRouteSavings,
  type ObservationRoute,
} from '../../src/adapters/routeObservation.js';
import { getTimeline, resetSession } from '../../src/pipeline/index.js';
import { resetOcrWorker } from '../../src/pipeline/ocrDiff.js';

export interface DemoPage extends PlaywrightLikePage {
  setContent(html: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
}

export interface LiveLoginCapture {
  screenshots: Buffer[];
  filenames: string[];
  mode: string;
  scenario: 'login';
}

interface LaunchedBrowser {
  newPage(): Promise<DemoPage>;
  close(): Promise<void>;
}

interface ChromiumLike {
  launch(opts?: { headless?: boolean }): Promise<LaunchedBrowser>;
}

function shortRuntimeError(err: unknown): string {
  const firstLine = (err instanceof Error ? err.message : String(err)).split('\n')[0];
  return firstLine.length > 220 ? `${firstLine.slice(0, 217)}...` : firstLine;
}

async function loadPlaywright(): Promise<ChromiumLike | null> {
  try {
    // @ts-ignore - playwright is an optional runtime dependency for this demo
    const pw = await import('playwright');
    return pw.chromium as ChromiumLike;
  } catch (err) {
    console.warn('Playwright is not installed; using the built-in virtual computer-use page.');
    console.warn('Install the real browser runtime with:');
    console.warn('  npm install --save-dev playwright');
    console.warn('  npx playwright install chromium');
    console.warn('');
    console.warn(`Underlying error: ${shortRuntimeError(err)}`);
    return null;
  }
}

const LOGIN_PAGE = `
<!doctype html>
<html><head><style>
  body { font-family: system-ui; margin: 40px; }
  .banner { padding: 12px; border-radius: 6px; margin-bottom: 16px; display: none; }
  .banner.error { background: #fee; color: #900; border: 1px solid #f99; display: block; }
  input { display: block; padding: 8px; margin: 8px 0; width: 240px; }
  button { padding: 8px 16px; }
</style></head>
<body>
  <h1>Sign in</h1>
  <div id="banner" class="banner"></div>
  <input id="email" placeholder="Email" />
  <input id="password" type="password" placeholder="Password" />
  <button id="submit">Sign in</button>
  <script>
    document.getElementById('submit').addEventListener('click', () => {
      const b = document.getElementById('banner');
      b.className = 'banner error';
      b.textContent = 'Invalid password';
    });
  </script>
</body></html>
`;

interface LoginScenarioStep {
  filename: string;
  actionLabel: string;
  run(page: DemoPage): Promise<void>;
}

const LIVE_LOGIN_STEPS: LoginScenarioStep[] = [
  {
    filename: '001.png',
    actionLabel: 'navigate_login',
    run: async (page) => {
      await page.setContent(LOGIN_PAGE);
    },
  },
  {
    filename: '002.png',
    actionLabel: 'observe:idle_recapture',
    run: async () => {
      // no-op: identical screenshot should be killed by the visual gate
    },
  },
  {
    filename: '003.png',
    actionLabel: 'type_email',
    run: async (page) => {
      await page.fill('#email', 'user@example.com');
    },
  },
  {
    filename: '004.png',
    actionLabel: 'type_password',
    run: async (page) => {
      await page.fill('#password', 'hunter2');
    },
  },
  {
    filename: '005.png',
    actionLabel: 'submit_bad_password',
    run: async (page) => {
      await page.click('#submit');
    },
  },
];

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

class VirtualLoginPage implements DemoPage {
  private email = '';
  private password = '';
  private banner = '';

  async setContent(): Promise<void> {
    this.email = '';
    this.password = '';
    this.banner = '';
  }

  async fill(selector: string, value: string): Promise<void> {
    if (selector === '#email') this.email = value;
    if (selector === '#password') this.password = value;
  }

  async click(selector: string): Promise<void> {
    if (selector === '#submit') this.banner = 'Invalid password';
  }

  async screenshot(): Promise<Buffer> {
    const passwordMask = this.password ? '*'.repeat(Math.min(this.password.length, 12)) : '';
    const stateFill = this.banner
      ? '#fee2e2'
      : this.password
        ? '#dcfce7'
        : this.email
          ? '#dbeafe'
          : '#f1f5f9';
    const stateStroke = this.banner
      ? '#ef4444'
      : this.password
        ? '#22c55e'
        : this.email
          ? '#3b82f6'
          : '#94a3b8';
    const stateLabel = this.banner
      ? 'Error state'
      : this.password
        ? 'Password entered'
        : this.email
          ? 'Email entered'
          : 'Waiting for input';
    const emailFill = this.email ? '#dbeafe' : '#ffffff';
    const passwordFill = this.password ? '#dcfce7' : '#ffffff';
    const bannerMarkup = this.banner
      ? `<rect x="78" y="136" width="420" height="84" rx="6" fill="#fee2e2" stroke="#ef4444"/>
         <text x="100" y="186" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#991b1b">${escapeHtml(this.banner)}</text>`
      : '';

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="900" height="620">
        <rect width="900" height="620" fill="#f8fafc"/>
        <rect x="56" y="56" width="500" height="480" rx="10" fill="#ffffff" stroke="#cbd5e1"/>
        <rect x="584" y="56" width="260" height="480" rx="10" fill="${stateFill}" stroke="${stateStroke}" stroke-width="3"/>
        <text x="614" y="128" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#111827">Live state</text>
        <text x="614" y="172" font-family="Arial, sans-serif" font-size="22" fill="#111827">${stateLabel}</text>
        <rect x="614" y="216" width="190" height="18" rx="9" fill="${stateStroke}"/>
        <rect x="614" y="258" width="150" height="18" rx="9" fill="${stateStroke}" opacity="0.72"/>
        <rect x="614" y="300" width="110" height="18" rx="9" fill="${stateStroke}" opacity="0.44"/>
        <text x="78" y="116" font-family="Arial, sans-serif" font-size="36" font-weight="700" fill="#111827">Sign in</text>
        ${bannerMarkup}
        <text x="78" y="242" font-family="Arial, sans-serif" font-size="18" fill="#374151">Email</text>
        <rect x="78" y="258" width="420" height="48" rx="6" fill="${emailFill}" stroke="#94a3b8"/>
        <text x="96" y="289" font-family="Arial, sans-serif" font-size="20" fill="#111827">${escapeHtml(this.email)}</text>
        <text x="78" y="350" font-family="Arial, sans-serif" font-size="18" fill="#374151">Password</text>
        <rect x="78" y="366" width="420" height="48" rx="6" fill="${passwordFill}" stroke="#94a3b8"/>
        <text x="96" y="397" font-family="Arial, sans-serif" font-size="22" fill="#111827">${escapeHtml(passwordMask)}</text>
        <rect x="78" y="452" width="124" height="48" rx="6" fill="#16a34a"/>
        <text x="110" y="483" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#ffffff">Sign in</text>
      </svg>
    `;

    return sharp(Buffer.from(svg)).png().toBuffer();
  }
}

interface DemoTarget {
  page: DemoPage;
  close(): Promise<void>;
  mode: string;
}

async function createDemoTarget(): Promise<DemoTarget> {
  const chromium = await loadPlaywright();
  if (chromium) {
    try {
      const browser = await chromium.launch({ headless: true });
      return {
        page: await browser.newPage(),
        close: () => browser.close(),
        mode: 'Playwright browser',
      };
    } catch (err) {
      console.warn('Playwright could not launch Chromium; using the built-in virtual computer-use page.');
      console.warn(`Underlying error: ${shortRuntimeError(err)}`);
    }
  }

  return {
    page: new VirtualLoginPage(),
    close: async () => {},
    mode: 'virtual computer-use page',
  };
}

export async function captureLiveLoginScreenshots(): Promise<LiveLoginCapture> {
  const target = await createDemoTarget();
  try {
    const screenshots: Buffer[] = [];
    const filenames: string[] = [];

    for (const scenarioStep of LIVE_LOGIN_STEPS) {
      await scenarioStep.run(target.page);
      screenshots.push(await target.page.screenshot({ type: 'png' }));
      filenames.push(scenarioStep.filename);
    }

    return {
      screenshots,
      filenames,
      mode: target.mode,
      scenario: 'login',
    };
  } finally {
    await target.close();
    await resetOcrWorker();
  }
}

let mockVlmCalls = 0;
async function mockExpensiveVlmCall(screenshot: Buffer, prompt: string): Promise<string> {
  mockVlmCalls++;
  console.log(`    [mock VLM] would send ${screenshot.length} byte screenshot with prompt: "${prompt}"`);
  return 'mocked vision response';
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map((l) => prefix + l).join('\n');
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function printFinalSummary(sessionId: string, routes: ObservationRoute[]): void {
  const timeline = getTimeline(sessionId);
  const savings = estimateRouteSavings(routes);
  const skipped = routes.filter((r) => r.route === 'skip_vision').length;
  const textOnly = routes.filter((r) => r.route === 'use_text_observation').length;

  console.log('');
  console.log('--- Live StateLens session summary ---');
  console.log(`Screenshots captured on the fly: ${fmt(timeline.total_screenshots)}`);
  console.log(`Keyframes in timeline:          ${fmt(timeline.keyframes)}`);
  console.log(`Routes:                         ${fmt(skipped)} skipped, ${fmt(textOnly)} text, ${fmt(savings.downstream_vision_calls)} full vision`);
  console.log('');
  console.log('Downstream agent savings:');
  console.log(`  Full screenshot calls avoided: ${fmt(savings.downstream_vision_calls_saved)} / ${fmt(savings.total_observations)}`);
  console.log(`  Estimated input tokens saved:  ${fmt(savings.estimated_downstream_input_tokens_saved)} ` +
    `(assumes ${fmt(savings.assumed_tokens_per_screenshot)} tokens/screenshot)`);
  console.log('');
  console.log('StateLens internal accounting:');
  console.log(`  Internal VLM calls made:       ${fmt(timeline.vlm_calls_made)}`);
  console.log(`  Pipeline VLM calls saved:      ${fmt(timeline.vlm_calls_saved)} / ${fmt(timeline.total_screenshots)} (${timeline.reduction_pct.toFixed(1)}%)`);
  console.log(`  Pipeline tokens saved:         ${fmt(timeline.estimated_tokens_saved)}`);
}

async function step(
  page: DemoPage,
  sessionId: string,
  actionLabel: string,
  before: () => Promise<void>
): Promise<ObservationRoute> {
  await before();
  const { screenshot, observation, route } = await captureAndRoute(page, { sessionId, actionLabel });
  const tag =
    route.route === 'skip_vision'
      ? 'SKIP  '
      : route.route === 'use_text_observation'
        ? 'TEXT  '
        : 'VISION';
  console.log(
    `[${tag}] ${actionLabel.padEnd(22)} ` +
      `event=${observation.event_type.padEnd(18)} ` +
      `score=${observation.importance_score.toFixed(2)}`
  );

  if (route.route === 'use_text_observation') {
    console.log(`           context:\n${indent(route.context, '             ')}`);
  } else if (
    route.route === 'use_region_evidence' ||
    route.route === 'use_context_snapshot'
  ) {
    console.log(`           context:\n${indent(route.context, '             ')}`);
    console.log(`           evidence: ${route.evidence.length} crop(s)`);
  } else if (route.route === 'use_full_vision') {
    console.log(`           reason: ${route.reason}`);
    await mockExpensiveVlmCall(screenshot, observation.event_summary);
  } else {
    console.log(`           reason: ${route.reason}`);
  }

  return route;
}

export async function runLiveLoginDemo(): Promise<void> {
  const target = await createDemoTarget();
  try {
    const { page } = target;
    const sessionId = `playwright_demo_${Date.now()}`;
    const routes: ObservationRoute[] = [];
    mockVlmCalls = 0;
    resetSession(sessionId);

    console.log(`Live computer-use agent loop: ${target.mode}, capturing screenshots on the fly.`);
    console.log('');

    for (const scenarioStep of LIVE_LOGIN_STEPS) {
      routes.push(await step(page, sessionId, scenarioStep.actionLabel, () => scenarioStep.run(page)));
    }

    console.log('');
    console.log(`Mock VLM calls actually made: ${mockVlmCalls}`);
    printFinalSummary(sessionId, routes);
  } finally {
    await target.close();
    await resetOcrWorker();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLiveLoginDemo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
