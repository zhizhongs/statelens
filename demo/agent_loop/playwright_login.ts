// Reference agent loop that uses Playwright as the screenshot source and
// StateLens as the routing layer. The "expensive VLM" is mocked so this file
// can run without an Anthropic key — the point is to demonstrate the route
// decisions, not to make real model calls.
//
// Requires Playwright installed at runtime:
//   npm install --save-dev playwright
//   npx playwright install chromium
//
// Run with:
//   npm run build && node dist/demo/agent_loop/playwright_login.js
//
// The demo navigates to a small data: URL with a couple of staged states so
// no network access is required.

import type { Buffer } from 'node:buffer';
import { captureAndRoute, type PlaywrightLikePage } from '../../src/adapters/playwright.js';

interface DemoPage extends PlaywrightLikePage {
  setContent(html: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
}

interface LaunchedBrowser {
  newPage(): Promise<DemoPage>;
  close(): Promise<void>;
}

interface ChromiumLike {
  launch(opts?: { headless?: boolean }): Promise<LaunchedBrowser>;
}

async function loadPlaywright(): Promise<ChromiumLike> {
  try {
    // @ts-ignore - playwright is an optional runtime dependency for this demo
    const pw = await import('playwright');
    return pw.chromium as ChromiumLike;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('This demo requires playwright. Install with:');
    console.error('  npm install --save-dev playwright');
    console.error('  npx playwright install chromium');
    console.error('');
    console.error(`Underlying error: ${msg}`);
    process.exit(1);
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

let mockVlmCalls = 0;
async function mockExpensiveVlmCall(screenshot: Buffer, prompt: string): Promise<string> {
  mockVlmCalls++;
  console.log(`    [mock VLM] would send ${screenshot.length} byte screenshot with prompt: "${prompt}"`);
  return 'mocked vision response';
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map((l) => prefix + l).join('\n');
}

async function step(
  page: DemoPage,
  sessionId: string,
  actionLabel: string,
  before: () => Promise<void>
) {
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
  } else if (route.route === 'use_full_vision') {
    console.log(`           reason: ${route.reason}`);
    await mockExpensiveVlmCall(screenshot, observation.event_summary);
  } else {
    console.log(`           reason: ${route.reason}`);
  }
}

async function main() {
  const chromium = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const sessionId = `playwright_demo_${Date.now()}`;

    await step(page, sessionId, 'navigate_login', async () => {
      await page.setContent(LOGIN_PAGE);
    });

    await step(page, sessionId, 'idle_recapture', async () => {
      // no-op: identical screenshot should be killed by the visual gate
    });

    await step(page, sessionId, 'type_email', async () => {
      await page.fill('#email', 'user@example.com');
    });

    await step(page, sessionId, 'type_password', async () => {
      await page.fill('#password', 'hunter2');
    });

    await step(page, sessionId, 'submit_bad_password', async () => {
      await page.click('#submit');
    });

    console.log('');
    console.log(`Mock VLM calls actually made: ${mockVlmCalls}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
