# Region Evidence Design

Owner: Shared - Pipeline + Distribution  
Status: Proposed next feature after Phase 4  
References: [`../DESIGN.md`](../DESIGN.md), [`./PROXY_IMPLEMENTATION.md`](./PROXY_IMPLEMENTATION.md), [`./POST_PHASE3_AGENT_INTEGRATION.md`](./POST_PHASE3_AGENT_INTEGRATION.md), [`../RESULTS.md`](../RESULTS.md)

## Objective

Add a new StateLens output mode for localized visual evidence:

```text
StateLens observation:
Event: shipping_form_updated
Summary: User entered address details and selected delivery method.
Confidence: medium
Changed regions:
1. shipping_form, bbox: [120, 220, 620, 510]
2. delivery_options, bbox: [640, 300, 980, 520]

Attached visual evidence:
- crop_1: shipping form region
- crop_2: delivery options region
```

The feature should improve accuracy on frames where text-only summaries are too lossy while preserving the cost reduction from skipping redundant screenshots and avoiding full-frame vision whenever smaller evidence is enough.

## Product Thesis

StateLens should not be text-only and should not fall back to full screenshots too eagerly. The product should choose the cheapest evidence that can safely ground the reasoning model:

```text
no meaningful change -> no image
text is enough       -> compact text observation
localized pixels     -> event card + changed crops
layout uncertainty   -> low-res/annotated context snapshot
high uncertainty     -> full screenshot
```

`region_evidence` is the missing middle rung. It lets StateLens preserve important local pixels without paying for the whole screenshot.

## Current State

Already shipped:

- `ObservationResult` includes `event_type`, `event_summary`, `changed_regions`, `text_diff`, `vlm_called`, and `importance_score`.
- `spatialDiff()` computes changed pixel components as `{ x, y, w, h, label }`.
- `ocrDiff()` already crops changed regions internally for OCR.
- `routeObservation()` can return `skip_vision`, `use_text_observation`, or `use_full_vision`.
- The Anthropic proxy can replace screenshot image blocks with compact text observations.

Missing:

- First-class confidence field.
- Bbox array format for downstream consumers.
- Semantic region names such as `shipping_form` instead of coarse geometry labels such as `content area`.
- Emitted crop artifacts for changed regions.
- A route that sends text plus crops while avoiding full-frame vision.

## Non-Goals

- Do not replace the current `observe(buffer, sessionId, actionLabel)` contract.
- Do not attach crops to every changed frame.
- Do not OCR the full screenshot as a fallback.
- Do not persist screenshots or crops by default.
- Do not require DOM or accessibility snapshots for screenshot-only use.
- Do not make `region_evidence` the default route until measured accuracy and cost are understood.

## User-Facing Contract

Add an enriched observation shape. Keep the existing `ObservationResult` valid and additive.

```ts
export type ObservationConfidence = 'high' | 'medium' | 'low';

export interface EvidenceRegion {
  id: string;
  label: string;
  bbox: [number, number, number, number]; // [left, top, right, bottom]
  source: 'heuristic' | 'ocr' | 'vlm' | 'mixed';
  confidence: ObservationConfidence;
  text?: string[];
}

export interface VisualEvidence {
  id: string;
  region_id: string;
  kind: 'crop';
  media_type: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  data_base64?: string;
  file_path?: string;
}

export interface EvidenceObservation {
  changed: boolean;
  keyframe: boolean;
  importance_score: number;
  confidence: ObservationConfidence;
  event_type: string;
  event_summary: string;
  changed_regions: EvidenceRegion[];
  text_diff: TextDiff;
  visual_evidence: VisualEvidence[];
  vlm_called: boolean;
  latency_ms: number;
}
```

Example:

```json
{
  "changed": true,
  "keyframe": true,
  "importance_score": 0.72,
  "confidence": "medium",
  "event_type": "shipping_form_updated",
  "event_summary": "User entered address details and selected delivery method.",
  "changed_regions": [
    {
      "id": "crop_1",
      "label": "shipping_form",
      "bbox": [120, 220, 620, 510],
      "source": "mixed",
      "confidence": "medium",
      "text": ["Name", "Address", "Zip Code", "Chicago"]
    },
    {
      "id": "crop_2",
      "label": "delivery_options",
      "bbox": [640, 300, 980, 520],
      "source": "mixed",
      "confidence": "medium",
      "text": ["Delivery", "Tuesday", "$4.95"]
    }
  ],
  "text_diff": {
    "added": ["5801 South Ellis Avenue", "Chicago", "Tuesday 19"],
    "removed": []
  },
  "visual_evidence": [
    {
      "id": "crop_1",
      "region_id": "crop_1",
      "kind": "crop",
      "media_type": "image/png",
      "width": 500,
      "height": 290,
      "data_base64": "..."
    },
    {
      "id": "crop_2",
      "region_id": "crop_2",
      "kind": "crop",
      "media_type": "image/png",
      "width": 340,
      "height": 220,
      "data_base64": "..."
    }
  ],
  "vlm_called": true,
  "latency_ms": 812
}
```

## API Plan

Keep `observe()` unchanged.

Add a new evidence-aware API:

```ts
export interface ObserveEvidenceOptions {
  sessionId?: string;
  actionLabel?: string;
  includeCrops?: boolean;
  cropEncoding?: 'base64' | 'file';
  maxCrops?: number;
  maxCropEdge?: number;
}

export async function observeWithEvidence(
  screenshotBuffer: Buffer,
  options?: ObserveEvidenceOptions
): Promise<EvidenceObservation>;
```

Default behavior:

- `includeCrops` defaults to `false` for library and MCP callers.
- The proxy may enable crops only when routing chooses `use_region_evidence`.
- `maxCrops` defaults to `3`.
- `maxCropEdge` defaults to `768`.
- Crops are PNG by default.

Why a new function:

- Avoids breaking existing users.
- Avoids bloating every `ObservationResult`.
- Lets the proxy request evidence only when it will actually use it.

## Routing Plan

Extend the route union:

```ts
export type ObservationRoute =
  | { route: 'skip_vision'; reason: string; observation: ObservationResult }
  | { route: 'use_text_observation'; context: string; observation: ObservationResult }
  | { route: 'use_region_evidence'; context: string; evidence: VisualEvidence[]; observation: EvidenceObservation }
  | { route: 'use_context_snapshot'; context: string; evidence: VisualEvidence[]; observation: EvidenceObservation }
  | { route: 'use_full_vision'; reason: string; observation: ObservationResult };
```

Initial routing policy:

| Condition | Route |
|---|---|
| no meaningful change | `skip_vision` |
| reliable OCR and high confidence text summary | `use_text_observation` |
| 1-3 localized regions, medium confidence, visual details matter | `use_region_evidence` |
| many regions or layout-level change, but full image is still avoidable | `use_context_snapshot` |
| invalid screenshot, analysis error, very low confidence, dense visual change | `use_full_vision` |

Do not send crops when text is already enough.

## Confidence Model

Confidence should describe the reliability of the observation, not the importance of the frame.

Inputs:

- Visual gate agreement and diff area stability.
- OCR reliability from existing `isTextReliable()` logic.
- VLM parse success and whether the summary references observed text or regions.
- Region-label source: heuristic-only is weaker than OCR or VLM-assisted labeling.
- Region count and coverage: many fragmented regions lower confidence.

Suggested scoring:

```text
high:
  reliable OCR or successful VLM summary
  1-3 stable regions
  semantic label source is ocr, vlm, or mixed

medium:
  meaningful change detected
  labels are plausible but partly heuristic
  summary is useful but not value-perfect

low:
  noisy OCR, fragmented regions, failed VLM parse, or high ambiguity
```

Confidence should be conservative. Low confidence routes to full vision unless a caller explicitly opts into cheaper behavior.

## Semantic Region Labeling

Add a small `regionLabeler` stage after OCR and before final routing:

```text
ChangedRegion[] + region-local OCR + optional VLM explanation
  -> EvidenceRegion[]
```

Label sources:

1. Geometry fallback:
   - `top_banner`
   - `left_sidebar`
   - `right_panel`
   - `content_area`
   - `center_modal`

2. OCR keyword heuristics:
   - `shipping_form`: name, address, zip, city, state, phone, email, shipping
   - `delivery_options`: delivery, shipping method, pickup, date, express, standard
   - `payment_method`: card, paypal, apple pay, google pay, cvv, expiration
   - `login_form`: username, email, password, sign in, login
   - `error_message`: error, invalid, required, failed, denied
   - `navigation`: next, continue, back, checkout, submit

3. VLM-assisted labeling:
   - When Stage 5 already calls VLM, ask it to return `regions` with labels and confidence.
   - Do not add a new VLM call solely for labels unless the route is about to use crops and confidence is below the threshold.

Proposed VLM JSON extension:

```json
{
  "event_type": "shipping_form_updated",
  "summary": "User entered address details and selected delivery method.",
  "important_text": ["5801 South Ellis Avenue", "Tuesday 19"],
  "confidence": "medium",
  "regions": [
    {
      "label": "shipping_form",
      "region_index": 0,
      "confidence": "medium"
    },
    {
      "label": "delivery_options",
      "region_index": 1,
      "confidence": "medium"
    }
  ]
}
```

## Crop Generation

Add `evidenceCropper.ts`.

Responsibilities:

- Clamp crop bounds to screenshot dimensions.
- Optionally pad regions by 8-16 px so labels and context are not clipped.
- Resize crops to `maxCropEdge`.
- Encode as PNG.
- Return either base64 data or file paths.
- Never persist by default.

Pseudocode:

```ts
export interface CropOptions {
  maxCrops: number;
  maxCropEdge: number;
  paddingPx: number;
  encoding: 'base64' | 'file';
}

export async function buildVisualEvidence(
  screenshotBuffer: Buffer,
  regions: EvidenceRegion[],
  options: CropOptions
): Promise<VisualEvidence[]>;
```

Crop selection:

- Sort by importance: semantic label confidence, area, text presence, then reading order.
- Cap at `maxCrops`.
- Merge heavily overlapping regions before cropping.
- Avoid crops that cover most of the screen. Those should route to `context_snapshot` or `full_vision`.

## Proxy Behavior

For `use_region_evidence`, rewrite the Anthropic request as:

1. A text block containing the observation.
2. One image block per selected crop.

Example replacement:

```text
StateLens observation for the latest UI screenshot:
Event: shipping_form_updated
Summary: User entered address details and selected delivery method.
Confidence: medium
Changed regions:
1. shipping_form, bbox: [120, 220, 620, 510], evidence: crop_1
2. delivery_options, bbox: [640, 300, 980, 520], evidence: crop_2

The full screenshot was removed to save vision tokens. The attached crops are the changed regions only.
```

Then attach `crop_1` and `crop_2` image blocks.

The proxy should log route decisions in debug mode, but not log crop bytes unless `STATELENS_LOG_IMAGES=1`.

## Cost Guardrails

The feature must be measured against the same baseline as `RESULTS.md`.

Rules:

- `region_evidence` must not run on `no_change`.
- `region_evidence` must not run when `use_text_observation` is high confidence.
- Default crop count is at most 3.
- Crop image long edge is capped at 768 px.
- If total crop area exceeds 45% of the screenshot area, prefer `context_snapshot` or `full_vision`.
- If crop count would exceed 3, prefer `context_snapshot` or full vision depending on confidence.

Expected impact:

- Token reduction may drop from today's best case because crop images are not free.
- Accuracy should improve on form-heavy and visually localized changes.
- Cost should remain well below full-screenshot baseline when crops are selective.

Success target:

| Flow | Target |
|---|---|
| Login | keep cost reduction above 80% |
| Checkout | keep cost reduction above 65% |
| Checkout lenient accuracy | improve above current 77.8% |
| Full vision fallbacks | only for errors, dense layouts, or low confidence |

## Implementation Plan

### Phase 1 - Types and Formatting

- Add `ObservationConfidence`, `EvidenceRegion`, `VisualEvidence`, and `EvidenceObservation`.
- Add bbox formatting helper.
- Add observation text formatter with confidence, bbox, and evidence ids.
- Tests for formatting and backward compatibility.

### Phase 2 - Evidence Region Builder

- Add `regionLabeler.ts`.
- Convert `ChangedRegion` to `EvidenceRegion`.
- Add OCR keyword label heuristics.
- Add confidence assignment.
- Tests for checkout, login, error, and fallback labels.

### Phase 3 - Crop Builder

- Add `evidenceCropper.ts`.
- Generate padded, clamped, resized crops.
- Support base64 and file-backed encodings.
- Tests for clamping, max crop count, overlap merge, and max edge resize.

### Phase 4 - API and Router

- Add `observeWithEvidence()`.
- Extend `ObservationRoute` with `use_region_evidence`.
- Keep `routeObservation()` stable or add `routeEvidenceObservation()` to avoid breaking callers.
- Tests for route selection and cost guardrails.

### Phase 5 - Proxy Integration

- Teach request rewriting to replace a full screenshot with text plus crop image blocks.
- Preserve fail-open behavior.
- Add proxy tests verifying request shape and no image logging by default.

### Phase 6 - Measurement

- Re-run login and checkout token measurements.
- Re-run accuracy checks.
- Add a result file comparing:
  - current text-only/proxy route
  - region-evidence route
  - full screenshot baseline

## Test Plan

Unit tests:

- `bboxFromRegion()` converts `{ x, y, w, h }` to `[x1, y1, x2, y2]`.
- `regionLabeler()` labels shipping, delivery, payment, login, error, and fallback regions.
- `confidenceForRegion()` lowers confidence for noisy OCR and fragmented regions.
- `evidenceCropper()` clamps and pads correctly.
- Router chooses `use_region_evidence` only for localized medium-confidence changes.

Integration tests:

- `observeWithEvidence()` returns no visual evidence for no-change.
- Text-sufficient changes remain text-only.
- Localized visual changes return 1-3 crops.
- Proxy rewrite emits one text block plus crop image blocks.
- Analysis errors still forward unchanged/full vision.

Eval tests:

- Login flow cost and accuracy.
- Checkout flow cost and accuracy.
- A visual-widget flow where text OCR is weak but crops should help.

## Open Questions

- Should crop payloads be base64 by default in MCP, or should MCP return file paths to avoid large JSON responses?
- Should `confidence` be top-level only, region-level only, or both?
- Should semantic region labels be snake_case strings only, or should we expose a richer role taxonomy?
- Do we need `context_snapshot` in the same milestone, or should `region_evidence` ship first?
- Should the VLM prompt label regions only when Stage 5 is already being called, or should `region_evidence` allow one extra cheap label call?

## Rollout

1. Land types and docs with no runtime behavior change.
2. Add `observeWithEvidence()` behind an explicit API.
3. Add proxy `use_region_evidence` behind `STATELENS_REGION_EVIDENCE=1`.
4. Measure token and accuracy impact.
5. Make route eligible by default only if cost stays within guardrails.

## Acceptance Criteria

- Existing tests and public `observe()` behavior still pass.
- A checkout form update can produce semantic labels such as `shipping_form` and `delivery_options`.
- Evidence crops are attached only when the router chooses `use_region_evidence`.
- No-change and high-confidence text frames remain image-free.
- Invalid screenshots and analysis errors still fail open to full vision.
- Measurement shows crop evidence improves at least one known checkout miss or partial without erasing the cost reduction.
