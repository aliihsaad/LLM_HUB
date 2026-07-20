# Free-Tier Enforcement — Design

**Date:** 2026-07-20 · **Status:** Approved by operator · **Branch:** feat/bazaarlink-provider (successor)

## Problem

The BazaarLink integration (V15) seeded 12 paid models as `enabled=1`. They are listed in
`/v1/models`, routable, in the fallback chain, and probed by the 30-minute availability
sweep — all of which can spend real key credit. The hub is a free-tier aggregator; nothing
in the schema distinguishes paid from free, and the scout's zero-price detection is
OpenRouter-only.

## Goals

1. Paid models are never listed, routed, fallback-selected, or probe-swept unless the
   operator explicitly opts in.
2. The catalog knows *why* a model is excluded (paid ≠ disabled ≠ quarantined).
3. Free variants (`:free`, zero-priced) are discovered automatically for BazaarLink, and
   pricing drift (free → paid) is detected on every sweep.

## Non-Goals

Per-request cost estimation, budget caps, spend dashboards (future work). Image/video-gen
models (zero-"priced" but billed elsewhere) stay out of scope and out of the catalog.

## Design

### 1. Schema (migration V16)

- `ALTER TABLE models ADD COLUMN is_free INTEGER NOT NULL DEFAULT 1` (guarded by
  `PRAGMA table_info` check, consistent with existing migration style).
- Set `is_free = 0` for the 12 paid BazaarLink rows (explicit id list:
  claude-opus-4.7, gpt-5.5, claude-sonnet-4.6, gemini-3-flash-preview, gpt-5.4,
  kimi-k2.6, minimax-m3, glm-5.1, deepseek-v3.2, qwen3.6-plus, gpt-5.4-mini,
  claude-haiku-4.5). `auto:free` and `deepseek/deepseek-v4-flash:free` remain `is_free=1`.

### 2. Global setting

- `settings` key `free_only_mode`, `'1'`(default when absent)/`'0'`.
- Helper `isFreeOnlyMode(db)` in `server/src/lib/settings.ts` (new small module; read per
  call — SQLite point reads are cheap).
- REST: extend `routes/settings.ts` with GET/PUT for the flag; client Settings page gets a
  "Free-tier only" toggle (default ON) with a one-line explanation.

### 3. Enforcement chokepoints (active when the mode is ON)

- **Listing** (`/v1/models`, capability listings in `routes/proxy.ts`): add
  `AND m.is_free = 1`.
- **Routing**: extract the ~6 near-identical "resolve requested model" query blocks in
  `routes/proxy.ts` into one shared helper `resolveRoutableModel(db, modelId, capability)`
  returning a typed result (`ok | not_found | disabled | paid_blocked | capability_missing`).
  Paid + mode ON → HTTP 403 `{ code: 'paid_model_blocked', message: names the setting }`.
  Explicit pin = explicit error; no silent substitution. Auto-routing simply never selects
  `is_free = 0` rows.
- **Fallback chain**: chain builder in `routes/fallback.ts` (and any service it uses)
  excludes `is_free = 0` when mode ON.
- **Availability sweep** (`scoutAllModels`): query becomes
  `WHERE enabled = 1 AND (is_free = 1 OR :freeOnly = 0)` — stops probe spend on paid models.
- **Dashboard APIs**: still return paid rows, with `isFree` in the payload; client Models +
  Fallback pages render an amber `PAID` badge (greyed row when mode ON).

### 4. Scout: pricing-aware discovery + drift detection

- Generalize `hasZeroPricing`: remove the `platform === 'openrouter'` restriction — any
  OpenAI-compat list entry carrying `pricing` is classified. Priced > 0 → insert
  `is_free = 0, enabled = 0`; priced 0 → `is_free = 1, enabled = 1`.
- Add `bazaarlink` to `CATALOG_SYNC_PLATFORMS` with a platform filter: zero-priced AND
  chat-usable (context_length > 0 or `:free` suffix) AND text output modality — excludes
  the 44 image/video-gen zero-priced entries.
- **Pricing drift**: on each sync, re-check pricing of existing rows for platforms that
  expose pricing; a row whose upstream price becomes non-zero flips to `is_free = 0`
  (logged). A synced row missing from the upstream list is set `enabled = 0` (logged);
  never hard-deleted.

### 5. Testing (TDD)

- V16: exactly the 12 rows flagged; the two free rows untouched; idempotent re-run.
- Proxy: paid model → 403 `paid_model_blocked` when ON; routable when OFF; `/v1/models`
  hides paid when ON, shows when OFF.
- Scout: zero-price → free/enabled; priced → paid/disabled; bazaarlink filter rejects
  image/video ids; drift flips `is_free`; missing-upstream disables.
- Fallback: chain skips paid when ON.
- Sweep: paid rows not probed when ON.

### 6. Error handling

Blocked requests name the model, the reason (`paid model`), and the remedy (Settings →
Free-tier only). Scout sync failures never disable existing rows on transient fetch errors
(only an authoritative 200 catalog response missing the model counts as "gone").
