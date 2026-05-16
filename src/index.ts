#!/usr/bin/env node
// CLI entry — DESIGN.md Section 5.

const command = process.argv[2];

switch (command) {
  case 'serve':
    import('./server.js');
    break;
  case 'proxy':
    import('./proxy/anthropic.js').then((m) => m.main(process.argv.slice(3)));
    break;
  case 'run': {
    const dir = process.argv[3];
    if (!dir) {
      console.error('Usage: statelens run <screenshot_dir>');
      process.exit(1);
    }
    import('../demo/run.js').then((m) => m.processDirectory(dir));
    break;
  }
  case 'measure':
    import('../eval/measure_tokens.js').then((m) => m.main());
    break;
  case 'live-demo':
    import('../demo/agent_loop/playwright_login.js').then((m) => m.runLiveLoginDemo());
    break;
  case 'live-eval':
    import('../eval/live_full_test.js').then((m) => m.main());
    break;
  default:
    console.log('StateLens CLI');
    console.log('');
    console.log('Usage:');
    console.log('  statelens serve              Start MCP server on stdio');
    console.log('  statelens proxy              Start local Anthropic-compatible proxy');
    console.log('  statelens run <dir>          Batch process a screenshot directory');
    console.log('  statelens live-demo          Run live computer-use agent loop demo');
    console.log('  statelens live-eval          Capture live demo and run efficiency + accuracy eval');
    console.log('  statelens measure            Run A/B token measurement harness');
    console.log('');
    console.log('See DESIGN.md for details.');
    process.exit(command ? 1 : 0);
}
