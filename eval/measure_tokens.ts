// Primary demo artifact — DESIGN.md Section 7.1 and Section 11.
// Person B: A/B harness measuring real Anthropic API token deltas
// with and without StateLens compression.
//
// Run A: send each screenshot as raw image to Claude Sonnet, accumulate usage.
// Run B: route each screenshot through observe(); send only event_summary
//        as text when keyframe && !vlm_called; skip entirely if !changed.
//        Add getCumulativeUsage() (Haiku calls inside StateLens) to the total.
//
// Honest accounting: Run B's reported total INCLUDES Haiku tokens consumed
// inside StateLens. Without this, the savings claim is invalid.

export async function main(): Promise<void> {
  // TODO Person B: implement per DESIGN.md Section 7.1.
  console.log('measure_tokens not implemented yet — see DESIGN.md Section 7.1');
  console.log('');
  console.log('Required env: ANTHROPIC_API_KEY');
  console.log('Required input: demo/screenshots/login_flow/*.png');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
