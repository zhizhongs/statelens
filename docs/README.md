# Hackathon Role Docs

Two people, two role docs, phased work with merge checkpoints.

| Doc | Owner | What they own |
|---|---|---|
| [ROLE_PIPELINE.md](./ROLE_PIPELINE.md) | **Person A** | `src/pipeline/` — image processing library (Stages 1-6) |
| [ROLE_DISTRIBUTION.md](./ROLE_DISTRIBUTION.md) | **Person B** | MCP server, CLI, measurement harness, demo, README, pitch. Also Anthropic console. |
| [PIPELINE_PHASE1_IMPLEMENTATION.md](./PIPELINE_PHASE1_IMPLEMENTATION.md) | **Person A** | Phase 1 implementation design for Stages 1-3 and the minimal `observe()` wiring |
| [PIPELINE_PHASE2_IMPLEMENTATION.md](./PIPELINE_PHASE2_IMPLEMENTATION.md) | **Person A** | Phase 2 implementation design for importance scoring, selective VLM, usage accounting, and timeline assembly |
| [POST_PHASE3_AGENT_INTEGRATION.md](./POST_PHASE3_AGENT_INTEGRATION.md) | **Shared** | Supplementary design for integrating the completed Phase 3 pipeline into real computer-use agent loops |
| [PROXY_IMPLEMENTATION.md](./PROXY_IMPLEMENTATION.md) | **Shared** | Implementation design for the Anthropic-compatible local proxy/gateway |
| [REGION_EVIDENCE_DESIGN.md](./REGION_EVIDENCE_DESIGN.md) | **Shared** | Region Evidence route + crop generation — `observeWithEvidence()`, semantic region labels, `use_region_evidence` / `use_context_snapshot` routes, and the `STATELENS_REGION_EVIDENCE=1` proxy flag |
| [DEMO_AND_EVAL.md](./DEMO_AND_EVAL.md) | **Person B** | Demo, live eval, and measurement commands |
| [DEMO_SCRIPT.md](./DEMO_SCRIPT.md) | **Person B** | Exact prompt and flow for the live Cursor MCP demo + stress-test checklist + backup plan |

Shared spec: [`../DESIGN.md`](../DESIGN.md)

Phase 3 baseline results: [`../eval/results/phase3_baseline.json`](../eval/results/phase3_baseline.json) — real Anthropic API token deltas.

## Phase Timeline

| Phase | Hours | A delivers | B delivers | Merge Checkpoint |
|---|---|---|---|---|
| 1 | 0-6 | Stages 1-3 (visual gate, spatial diff, OCR) | 14 screenshots + MCP server in Cursor | CLI prints diffs; Cursor shows 4 tools |
| 2 | 6-14 | Stages 4-6 + orchestrator | Measurement harness | `npm run measure` produces real numbers |
| 3 | 14-24 | Edge cases tested (~~second scenario skipped~~) | Live demo polish + README + measured baseline | `npm run measure` produces real numbers |
| 4 | 24-40 | Failure detection / CLIP / multi-lang | Playwright integration / HTML report | Stretch features stable |
| 5 | 40-48 | Technical backstop | Slides + pitch + practice | Pitch is rehearsed |
| Post-4 | — | Region Evidence: `observeWithEvidence()`, semantic region labels, crop builder, `use_region_evidence` / `use_context_snapshot` routes, proxy rewrite behind `STATELENS_REGION_EVIDENCE=1` | — | Tests green; default `observe()` contract unchanged |

## Working Discipline

- Both pin `DESIGN.md` AND their own role doc as `@` context in every Cursor Composer session
- Both work on `main` directly — files don't overlap, so no branch overhead
- `git pull` before `git push` always
- Never edit the other person's files. If you need something new exported, ask.
- At each merge checkpoint: stop, sync, verify together, then continue.
