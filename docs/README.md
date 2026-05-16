# Hackathon Role Docs

Two people, two role docs, phased work with merge checkpoints.

| Doc | Owner | What they own |
|---|---|---|
| [ROLE_PIPELINE.md](./ROLE_PIPELINE.md) | **Person A** | `src/pipeline/` — image processing library (Stages 1-6) |
| [ROLE_DISTRIBUTION.md](./ROLE_DISTRIBUTION.md) | **Person B** | MCP server, CLI, measurement harness, demo, README, pitch. Also Anthropic console. |
| [PIPELINE_PHASE1_IMPLEMENTATION.md](./PIPELINE_PHASE1_IMPLEMENTATION.md) | **Person A** | Phase 1 implementation design for Stages 1-3 and the minimal `observe()` wiring |

Shared spec: [`../DESIGN.md`](../DESIGN.md)

## Phase Timeline

| Phase | Hours | A delivers | B delivers | Merge Checkpoint |
|---|---|---|---|---|
| 1 | 0-6 | Stages 1-3 (visual gate, spatial diff, OCR) | 14 screenshots + MCP server in Cursor | CLI prints diffs; Cursor shows 4 tools |
| 2 | 6-14 | Stages 4-6 + orchestrator | Measurement harness | `npm run measure` produces real numbers |
| 3 | 14-24 | Edge cases + second scenario tested | Live demo polish + README + annotated images | 3× back-to-back demos succeed |
| 4 | 24-40 | Failure detection / CLIP / multi-lang | Playwright integration / HTML report | Stretch features stable |
| 5 | 40-48 | Technical backstop | Slides + pitch + practice | Pitch is rehearsed |

## Working Discipline

- Both pin `DESIGN.md` AND their own role doc as `@` context in every Cursor Composer session
- Both work on `main` directly — files don't overlap, so no branch overhead
- `git pull` before `git push` always
- Never edit the other person's files. If you need something new exported, ask.
- At each merge checkpoint: stop, sync, verify together, then continue.
