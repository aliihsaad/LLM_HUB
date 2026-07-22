# Free-Tier Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paid models are never listed, routed, fallback-selected, or probe-swept while `free_only_mode` (default ON) is active; free variants are auto-discovered and pricing drift auto-detected.

**Architecture:** A new `models.is_free` column is the source of truth for paid vs free. A `settings`-table flag `free_only_mode` (default ON when absent) gates four chokepoints: `/v1/models` listing, explicit-model resolution in the proxy, auto-route/fallback selection, and the availability sweep. The model scout classifies pricing for every OpenAI-compat platform and syncs BazaarLink free chat variants.

**Tech Stack:** Express + better-sqlite3 + Vitest (server workspace), React + Vite (client). Spec: `docs/superpowers/specs/2026-07-20-free-tier-enforcement-design.md`.

## Global Constraints

- Repo: `C:\Users\Mini\Desktop\Projects\API-HUB`, branch `feat/bazaarlink-provider`.
- Run server tests with `npx vitest run <file> --root server` from the repo root.
- 3 pre-existing failures in `src/__tests__/routes/logs.test.ts` are known and out of scope — do not fix, do not count as regressions.
- Never hard-delete model rows. `is_free` default is `1`. `free_only_mode` default is ON when the settings row is absent.
- The 12 paid BazaarLink model ids (exact list): `claude-opus-4.7`, `gpt-5.5`, `claude-sonnet-4.6`, `gemini-3-flash-preview`, `gpt-5.4`, `kimi-k2.6`, `minimax-m3`, `glm-5.1`, `deepseek-v3.2`, `qwen3.6-plus`, `gpt-5.4-mini`, `claude-haiku-4.5` (all `platform='bazaarlink'`). Free rows that must stay `is_free=1`: `auto:free`, `deepseek/deepseek-v4-flash:free`.
- No AI-attribution lines in commit messages.

---

### Task 1: `is_free` column + migration V16

**Files:**
- Modify: `server/src/db/index.ts` (add `migrateModelsV16`, call it after `migrateModelsV15(db);` in the init chain around line 52)
- Test: `server/src/__tests__/db/free-tier-migration.test.ts` (create)

**Interfaces:**
- Produces: `models.is_free INTEGER NOT NULL DEFAULT 1` column; V16 flags the 12 paid BazaarLink rows.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

const PAID_BZL = [
  'claude-opus-4.7', 'gpt-5.5', 'claude-sonnet-4.6', 'gemini-3-flash-preview',
  'gpt-5.4', 'kimi-k2.6', 'minimax-m3', 'glm-5.1', 'deepseek-v3.2',
  'qwen3.6-plus', 'gpt-5.4-mini', 'claude-haiku-4.5',
];

describe('V16 free-tier migration', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('adds is_free defaulting to 1 for every non-bazaarlink row', () => {
    const db = getDb();
    const other = db.prepare(
      "SELECT COUNT(*) n FROM models WHERE platform != 'bazaarlink' AND is_free != 1",
    ).get() as { n: number };
    expect(other.n).toBe(0);
  });

  it('flags exactly the 12 paid bazaarlink rows and keeps free routes free', () => {
    const db = getDb();
    const paid = db.prepare(
      "SELECT model_id FROM models WHERE platform = 'bazaarlink' AND is_free = 0 ORDER BY model_id",
    ).all() as { model_id: string }[];
    expect(paid.map(r => r.model_id).sort()).toEqual([...PAID_BZL].sort());
    const free = db.prepare(
      "SELECT is_free FROM models WHERE platform = 'bazaarlink' AND model_id = 'auto:free'",
    ).get() as { is_free: number };
    expect(free.is_free).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/db/free-tier-migration.test.ts --root server`
Expected: FAIL with `no such column: is_free`

- [ ] **Step 3: Implement V16**

In `server/src/db/index.ts`, insert after the closing brace of `migrateModelsV15` (search for `function migrateModelsV15`; it ends with `apply();\n}`):

```ts
/**
 * V16 (July 2026): free-tier enforcement groundwork.
 * Adds models.is_free (1 = free-tier, 0 = bills key credit) and flags the 12
 * paid BazaarLink rows seeded by V15. `auto:free` and
 * `deepseek/deepseek-v4-flash:free` stay free. Idempotent: the ALTER is
 * guarded by PRAGMA table_info and the UPDATE re-applies harmlessly.
 */
function migrateModelsV16(db: Database.Database) {
  const cols = db.prepare('PRAGMA table_info(models)').all() as { name: string }[];
  if (!cols.some(c => c.name === 'is_free')) {
    db.prepare('ALTER TABLE models ADD COLUMN is_free INTEGER NOT NULL DEFAULT 1').run();
  }

  const paidBazaarlink = [
    'claude-opus-4.7', 'gpt-5.5', 'claude-sonnet-4.6', 'gemini-3-flash-preview',
    'gpt-5.4', 'kimi-k2.6', 'minimax-m3', 'glm-5.1', 'deepseek-v3.2',
    'qwen3.6-plus', 'gpt-5.4-mini', 'claude-haiku-4.5',
  ];
  const flag = db.prepare(
    "UPDATE models SET is_free = 0 WHERE platform = 'bazaarlink' AND model_id = ?",
  );
  const tx = db.transaction(() => {
    for (const id of paidBazaarlink) flag.run(id);
  });
  tx();
}
```

Then in the init chain (search `migrateModelsV15(db);`), add directly below it:

```ts
  migrateModelsV16(db);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/db/free-tier-migration.test.ts --root server`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/db/index.ts server/src/__tests__/db/free-tier-migration.test.ts
git commit -m "feat(db): V16 is_free column, flag paid BazaarLink rows"
```

---

### Task 2: `free_only_mode` setting — lib + API

**Files:**
- Create: `server/src/lib/app-settings.ts`
- Modify: `server/src/routes/settings.ts` (append two routes)
- Test: `server/src/__tests__/routes/settings-free-only.test.ts` (create)

**Interfaces:**
- Produces: `isFreeOnlyMode(db): boolean` (default `true` when the settings row is absent), `setFreeOnlyMode(db, on: boolean): void`; REST `GET /api/settings/free-only-mode` → `{ freeOnlyMode: boolean }`, `PUT /api/settings/free-only-mode` body `{ enabled: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { isFreeOnlyMode } from '../../lib/app-settings.js';

async function request(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('free_only_mode setting', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('defaults to ON when the settings row is absent', () => {
    expect(isFreeOnlyMode(getDb())).toBe(true);
  });

  it('round-trips through the REST API', async () => {
    const off = await request(app, 'PUT', '/api/settings/free-only-mode', { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.freeOnlyMode).toBe(false);
    expect(isFreeOnlyMode(getDb())).toBe(false);

    const read = await request(app, 'GET', '/api/settings/free-only-mode');
    expect(read.body.freeOnlyMode).toBe(false);

    const on = await request(app, 'PUT', '/api/settings/free-only-mode', { enabled: true });
    expect(on.body.freeOnlyMode).toBe(true);
    expect(isFreeOnlyMode(getDb())).toBe(true);
  });

  it('rejects a non-boolean body', async () => {
    const bad = await request(app, 'PUT', '/api/settings/free-only-mode', { enabled: 'yes' });
    expect(bad.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/routes/settings-free-only.test.ts --root server`
Expected: FAIL with `Cannot find module '../../lib/app-settings.js'`

- [ ] **Step 3: Implement lib + routes**

Create `server/src/lib/app-settings.ts`:

```ts
import type Database from 'better-sqlite3';

const FREE_ONLY_KEY = 'free_only_mode';

/** Free-tier-only mode. Default ON when the settings row is absent. */
export function isFreeOnlyMode(db: Database.Database): boolean {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(FREE_ONLY_KEY) as { value: string } | undefined;
  return row ? row.value === '1' : true;
}

export function setFreeOnlyMode(db: Database.Database, on: boolean): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(FREE_ONLY_KEY, on ? '1' : '0');
}
```

Append to `server/src/routes/settings.ts` (bottom of file; add `import { isFreeOnlyMode, setFreeOnlyMode } from '../lib/app-settings.js';` at the top):

```ts
// Free-tier-only mode (default ON): hides/blocks paid catalog rows.
settingsRouter.get('/free-only-mode', (_req: Request, res: Response) => {
  res.json({ freeOnlyMode: isFreeOnlyMode(getDb()) });
});

settingsRouter.put('/free-only-mode', (req: Request, res: Response) => {
  const { enabled } = req.body ?? {};
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: "Body must be { enabled: boolean }" });
    return;
  }
  setFreeOnlyMode(getDb(), enabled);
  res.json({ freeOnlyMode: isFreeOnlyMode(getDb()) });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/routes/settings-free-only.test.ts --root server`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/app-settings.ts server/src/routes/settings.ts server/src/__tests__/routes/settings-free-only.test.ts
git commit -m "feat(settings): free_only_mode flag, default ON"
```

---

### Task 3: Proxy enforcement — listing + explicit model resolution

**Files:**
- Create: `server/src/lib/resolve-model.ts`
- Modify: `server/src/routes/proxy.ts` (listing query ~line 159; chat resolution block ~lines 1137-1188; the four capability resolution blocks — find all with `grep -n "model_enabled" server/src/routes/proxy.ts`, they sit near lines 1371, 1510, 1648, 1792)
- Test: `server/src/__tests__/routes/proxy-free-only.test.ts` (create)

**Interfaces:**
- Consumes: `isFreeOnlyMode(db)` from Task 2; `models.is_free` from Task 1.
- Produces: `resolveRoutableModel(db, modelId, requiredCapability?): Resolution` where `Resolution = { kind: 'ok'; id: number } | { kind: 'not_found' } | { kind: 'disabled' } | { kind: 'capability_missing'; capability: string } | { kind: 'paid_blocked' }`. Also `sendResolutionError(res, modelId, r)` translating non-ok kinds to HTTP responses (`paid_blocked` → 403 `code: 'paid_model_blocked'`, others → 400 `code: 'model_not_found'` with the existing message wording).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { setFreeOnlyMode } from '../../lib/app-settings.js';

async function request(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('free-only enforcement in the proxy', () => {
  let app: Express;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    // BazaarLink key so the platform is routable/listable.
    await request(app, 'POST', '/api/keys', {
      platform: 'bazaarlink', key: 'sk-bl-test', label: 'free-only-test',
    });
  });

  beforeEach(() => setFreeOnlyMode(getDb(), true));

  it('hides paid models from /v1/models when ON, shows them when OFF', async () => {
    const on = await request(app, 'GET', '/v1/models');
    const onIds = on.body.data.map((m: { id: string }) => m.id);
    expect(onIds).toContain('auto:free');
    expect(onIds).not.toContain('claude-opus-4.7');

    setFreeOnlyMode(getDb(), false);
    const off = await request(app, 'GET', '/v1/models');
    const offIds = off.body.data.map((m: { id: string }) => m.id);
    expect(offIds).toContain('claude-opus-4.7');
  });

  it('blocks an explicitly requested paid model with 403 paid_model_blocked', async () => {
    const res = await request(app, 'POST', '/v1/chat/completions', {
      model: 'claude-opus-4.7',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('paid_model_blocked');
    expect(res.body.error.message).toContain('free-tier');
  });

  it('does not block the same model when the mode is OFF', async () => {
    setFreeOnlyMode(getDb(), false);
    const res = await request(app, 'POST', '/v1/chat/completions', {
      model: 'claude-opus-4.7',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // Upstream call fails in tests (fake key) — the point is it is NOT the 403 gate.
    expect(res.status).not.toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/routes/proxy-free-only.test.ts --root server`
Expected: FAIL — paid model appears in `/v1/models` and explicit request is not 403.

- [ ] **Step 3: Create the shared resolver**

Create `server/src/lib/resolve-model.ts`:

```ts
import type Database from 'better-sqlite3';
import type { Response } from 'express';
import { isFreeOnlyMode } from './app-settings.js';

export type Resolution =
  | { kind: 'ok'; id: number }
  | { kind: 'not_found' }
  | { kind: 'disabled' }
  | { kind: 'capability_missing'; capability: string }
  | { kind: 'paid_blocked' };

/**
 * Resolve an explicitly requested model id to a routable catalog row.
 * Order of precedence: unknown → capability → disabled → paid (so error
 * messages never leak paid-model existence distinctions before validity).
 */
export function resolveRoutableModel(
  db: Database.Database,
  modelId: string,
  requiredCapability?: string | null,
): Resolution {
  const row = db.prepare(`
    SELECT m.id, m.enabled AS model_enabled, m.is_free
    FROM models m
    WHERE m.model_id = ?
  `).get(modelId) as { id: number; model_enabled: number; is_free: number } | undefined;

  if (!row) return { kind: 'not_found' };

  if (requiredCapability) {
    const cap = db.prepare(`
      SELECT enabled FROM model_capabilities
      WHERE model_db_id = ? AND capability = ?
    `).get(row.id, requiredCapability) as { enabled: number } | undefined;
    if (!cap?.enabled) return { kind: 'capability_missing', capability: requiredCapability };
  }

  if (row.model_enabled !== 1) return { kind: 'disabled' };
  if (row.is_free !== 1 && isFreeOnlyMode(db)) return { kind: 'paid_blocked' };
  return { kind: 'ok', id: row.id };
}

/** Send the standard error payload for a non-ok resolution. */
export function sendResolutionError(res: Response, modelId: string, r: Resolution): void {
  if (r.kind === 'paid_blocked') {
    res.status(403).json({
      error: {
        message: `Model '${modelId}' is a paid model and free-tier-only mode is on. ` +
          `Disable it in Settings → Free-tier only, or pick a free model from /v1/models.`,
        type: 'invalid_request_error',
        code: 'paid_model_blocked',
      },
    });
    return;
  }
  const reason =
    r.kind === 'not_found' ? 'is not in the catalog'
    : r.kind === 'disabled' ? 'is disabled'
    : `does not support ${r.kind === 'capability_missing' ? r.capability : ''}`;
  res.status(400).json({
    error: {
      message: `Model '${modelId}' ${reason}. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
      type: 'invalid_request_error',
      code: 'model_not_found',
    },
  });
}
```

- [ ] **Step 4: Wire the resolver into proxy.ts**

Add to the imports in `server/src/routes/proxy.ts`:

```ts
import { resolveRoutableModel, sendResolutionError } from '../lib/resolve-model.js';
import { isFreeOnlyMode } from '../lib/app-settings.js';
```

(a) **Listing** (`GET /models` handler, query starting `SELECT\n      m.id,` around line 159): add `m.is_free,` after `m.intelligence_rank,` in the SELECT, and change the WHERE's first line from `WHERE m.enabled = 1` to:

```sql
    WHERE m.enabled = 1
      AND (m.is_free = 1 OR NOT :freeOnly)
```

Because better-sqlite3 named params in this codebase use `?` positional style, instead implement as a template split:

```ts
  const freeOnly = isFreeOnlyMode(db);
  const models = db.prepare(`
    ... existing SELECT with m.is_free added ...
    WHERE m.enabled = 1
      ${freeOnly ? 'AND m.is_free = 1' : ''}
      ... rest of existing WHERE unchanged ...
  `).all() as UnifiedModelListRow[];
```

(b) **Chat explicit-model block** (lines ~1137-1188): replace the entire `if (requestedModel) { ... }` body (both the capability and non-capability branches) with:

```ts
  if (requestedModel) {
    const db = getDb();
    const resolution = resolveRoutableModel(db, requestedModel, requiredCapability);
    if (resolution.kind !== 'ok') {
      sendResolutionError(res, requestedModel, resolution);
      return;
    }
    preferredModel = resolution.id;
  } else if (!requiredCapability) {
    preferredModel = getStickyModel(messages);
  }
```

(c) **The four capability blocks** (embeddings/images/audio/etc.): run
`grep -n "model_enabled" server/src/routes/proxy.ts` — each hit cluster is a
`SELECT m.id, mc.enabled AS capability_enabled, m.enabled AS model_enabled ... WHERE m.model_id = ?`
followed by `!row || !row.capability_enabled` and `row.model_enabled !== 1` rejections. Replace each cluster with the same pattern, passing that block's capability constant:

```ts
    const resolution = resolveRoutableModel(db, requestedModel, capability);
    if (resolution.kind !== 'ok') {
      sendResolutionError(res, requestedModel, resolution);
      return;
    }
    const modelDbId = resolution.id; // keep the variable name the block already used
```

Keep each block's surrounding variable names intact (some call it `row.id`, some `preferredModel`).

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/__tests__/routes/proxy-free-only.test.ts src/__tests__/routes/models-capabilities.test.ts src/__tests__/routes/proxy-model-hardening.test.ts --root server`
Expected: PASS. `proxy-model-hardening` guards the old wording — if it fails on message text, align `sendResolutionError` wording to the assertion (the wording above matches the current messages).

- [ ] **Step 6: Commit**

```bash
git add server/src/lib/resolve-model.ts server/src/routes/proxy.ts server/src/__tests__/routes/proxy-free-only.test.ts
git commit -m "feat(proxy): free-only enforcement in listing + explicit model resolution"
```

---

### Task 4: Auto-route, fallback chain, sweep exclusion + dashboard `isFree`

**Files:**
- Modify: `server/src/routes/proxy.ts` (auto-route candidate query — locate with `grep -n "FROM fallback_config" server/src/routes/proxy.ts`)
- Modify: `server/src/routes/fallback.ts` (GET `/` chain query ~line 22)
- Modify: `server/src/services/model-scout.ts` (`scoutAllModels` query ~line 278)
- Modify: `server/src/routes/models.ts` (dashboard model list — locate the main `SELECT ... FROM models` and add `is_free`)
- Test: `server/src/__tests__/routes/fallback-free-only.test.ts` (create)

**Interfaces:**
- Consumes: `isFreeOnlyMode(db)`, `models.is_free`.
- Produces: fallback GET rows carry `isFree: boolean`; auto-routing and `scoutAllModels` never touch `is_free = 0` rows while the mode is ON.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { setFreeOnlyMode } from '../../lib/app-settings.js';

async function request(app: Express, method: string, path: string) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, { method });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('free-only in fallback + sweep surfaces', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => setFreeOnlyMode(getDb(), true));

  it('fallback GET still lists paid rows but tags them isFree=false', async () => {
    const { status, body } = await request(app, 'GET', '/api/fallback');
    expect(status).toBe(200);
    const rows = body.chain ?? body;
    const paid = rows.find((r: { model_id: string }) => r.model_id === 'claude-opus-4.7');
    expect(paid).toBeDefined();
    expect(paid.isFree).toBe(false);
    const free = rows.find((r: { model_id: string }) => r.model_id === 'auto:free');
    expect(free.isFree).toBe(true);
  });

  it('sweep candidate selection skips paid rows when ON and includes them when OFF', async () => {
    const db = getDb();
    const { selectSweepCandidateIds } = await import('../../services/model-scout.js');
    const onIds = selectSweepCandidateIds(db);
    const paidRow = db.prepare(
      "SELECT id FROM models WHERE platform = 'bazaarlink' AND model_id = 'claude-opus-4.7'",
    ).get() as { id: number };
    expect(onIds).not.toContain(paidRow.id);

    setFreeOnlyMode(db, false);
    const offIds = selectSweepCandidateIds(db);
    expect(offIds).toContain(paidRow.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/routes/fallback-free-only.test.ts --root server`
Expected: FAIL — `isFree` undefined and `selectSweepCandidateIds` not exported.

- [ ] **Step 3: Implement the three exclusions + tag**

(a) `server/src/routes/fallback.ts` GET `/` (query at ~line 22): add `m.is_free,` after `m.monthly_token_budget` in the SELECT list, and wherever the handler maps rows into the response objects, add `isFree: row.is_free === 1,` to the mapped object. (The GET keeps showing paid rows — the dashboard is the operator view.)

(b) `server/src/services/model-scout.ts`: replace the inline query in `scoutAllModels` with an exported helper so the test above can call it:

```ts
/** Enabled models eligible for the availability sweep. Paid rows are skipped
 *  while free-only mode is on so probes never spend key credit. */
export function selectSweepCandidateIds(db: ReturnType<typeof getDb>): number[] {
  const freeOnly = isFreeOnlyMode(db);
  const rows = db.prepare(`
    SELECT id FROM models WHERE enabled = 1 ${freeOnly ? 'AND is_free = 1' : ''}
  `).all() as { id: number }[];
  return rows.map(r => r.id);
}
```

with `import { isFreeOnlyMode } from '../lib/app-settings.js';` added, and `scoutAllModels` starting:

```ts
  const db = getDb();
  const ids = selectSweepCandidateIds(db);
  console.log(`[ModelScout] Checking ${ids.length} models...`);
  const results: AvailabilityCheck[] = [];
  for (const id of ids) {
```

(c) **Auto-route**: run `grep -n "FROM fallback_config" server/src/routes/proxy.ts`. In the candidate-selection query the retry loop uses (JOIN of `fallback_config` + `models` filtered on `m.enabled = 1`), add the same conditional fragment right after the `m.enabled = 1` predicate:

```ts
      ${isFreeOnlyMode(db) ? 'AND m.is_free = 1' : ''}
```

(d) `server/src/routes/models.ts`: locate the dashboard list query (`grep -n "FROM models" server/src/routes/models.ts`, the main list endpoint) — add `m.is_free,`/`is_free,` to the SELECT and `isFree: row.is_free === 1` (or `m.is_free === 1`, matching the file's row-mapping style) to the response objects.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/__tests__/routes/fallback-free-only.test.ts src/__tests__/routes/fallback.test.ts --root server`
Expected: PASS (existing fallback tests stay green; if a fallback test snapshot-matches row keys, add `isFree` to its expected object).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/fallback.ts server/src/routes/proxy.ts server/src/routes/models.ts server/src/services/model-scout.ts server/src/__tests__/routes/fallback-free-only.test.ts
git commit -m "feat(routing): exclude paid models from auto-route, fallback selection, and sweep"
```

---

### Task 5: Scout — pricing everywhere, BazaarLink sync, drift detection

**Files:**
- Modify: `server/src/services/model-scout.ts`
- Test: `server/src/__tests__/services/model-scout-pricing.test.ts` (create)

**Interfaces:**
- Consumes: `models.is_free`, `isFreeOnlyMode`.
- Produces: `DiscoveredModelCandidate` gains `isFree?: boolean`; `isBazaarlinkFreeChatEntry(entry): boolean` exported for tests; `applyPricingDrift(db, platform, entries): { becamePaid: string[]; wentMissing: string[] }` exported.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  isBazaarlinkFreeChatEntry,
  applyPricingDrift,
} from '../../services/model-scout.js';

describe('scout pricing classification', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('accepts zero-priced chat entries and rejects image/video and priced ones', () => {
    const freeChat = {
      id: 'deepseek/deepseek-v4-flash:free',
      context_length: 1048576,
      pricing: { prompt: '0', completion: '0' },
      architecture: { output_modalities: ['text'] },
    };
    const videoGen = {
      id: 'bytedance/seedance-2.0',
      context_length: 0,
      pricing: { prompt: '0', completion: '0' },
      architecture: { output_modalities: ['video'] },
    };
    const paidChat = {
      id: 'glm-5.2',
      context_length: 1048576,
      pricing: { prompt: '0.000001', completion: '0.000002' },
      architecture: { output_modalities: ['text'] },
    };
    expect(isBazaarlinkFreeChatEntry(freeChat)).toBe(true);
    expect(isBazaarlinkFreeChatEntry(videoGen)).toBe(false);
    expect(isBazaarlinkFreeChatEntry(paidChat)).toBe(false);
  });

  it('flips is_free on pricing drift and disables rows missing upstream', () => {
    const db = getDb();
    // auto:free drifts to paid; glm-5.1 vanishes from the upstream list.
    const upstream = [
      { id: 'auto:free', pricing: { prompt: '0.000001', completion: '0.000001' } },
      { id: 'claude-opus-4.7', pricing: { prompt: '0.000015', completion: '0.000075' } },
      // ...the rest of the bazaarlink ids except glm-5.1, pricing irrelevant here
      ...['gpt-5.5','claude-sonnet-4.6','gemini-3-flash-preview','gpt-5.4','kimi-k2.6',
          'minimax-m3','deepseek-v3.2','qwen3.6-plus','gpt-5.4-mini','claude-haiku-4.5',
          'deepseek/deepseek-v4-flash:free']
        .map(id => ({ id, pricing: { prompt: '0.000001', completion: '0.000001' } })),
    ];

    const result = applyPricingDrift(db, 'bazaarlink', upstream);
    expect(result.becamePaid).toContain('auto:free');
    expect(result.wentMissing).toContain('glm-5.1');

    const auto = db.prepare(
      "SELECT is_free FROM models WHERE platform='bazaarlink' AND model_id='auto:free'",
    ).get() as { is_free: number };
    expect(auto.is_free).toBe(0);

    const glm = db.prepare(
      "SELECT enabled FROM models WHERE platform='bazaarlink' AND model_id='glm-5.1'",
    ).get() as { enabled: number };
    expect(glm.enabled).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/services/model-scout-pricing.test.ts --root server`
Expected: FAIL — the two functions are not exported.

- [ ] **Step 3: Implement in `model-scout.ts`**

(a) Add `'bazaarlink'` to `CATALOG_SYNC_PLATFORMS` (line ~37).

(b) Export the entry filter (place near `isZeroPrice`):

```ts
/** BazaarLink sync keeps only zero-priced, chat-usable, text-output entries —
 *  the 44 zero-"priced" image/video-gen models bill elsewhere and stay out. */
export function isBazaarlinkFreeChatEntry(entry: OpenAICompatModelListEntry & { context_length?: number | null }): boolean {
  const zero = isZeroPrice(entry.pricing?.prompt) && isZeroPrice(entry.pricing?.completion);
  if (!zero) return false;
  const chatUsable = (entry.context_length ?? 0) > 0 || (entry.id ?? '').includes(':free');
  if (!chatUsable) return false;
  const outputs = entry.architecture?.output_modalities ?? ['text'];
  return outputs.includes('text') && !outputs.some(o => o === 'image' || o === 'video');
}
```

Also widen `OpenAICompatModelListEntry` with `context_length?: number | null;`.

(c) In the discovery loop (line ~352-382), replace the classification block:

```ts
        const hasPricing = entry.pricing?.prompt != null || entry.pricing?.completion != null;
        const hasZeroPricing = hasPricing
          && isZeroPrice(entry.pricing?.prompt) && isZeroPrice(entry.pricing?.completion);
        const isLikelyFree = /:free|free-tier|free model|trial|sandbox/i.test(`${entry.id} ${entry.name ?? ''}`) || hasZeroPricing;

        if (platform === 'bazaarlink' && !isBazaarlinkFreeChatEntry(entry)) continue;

        const shouldPersist = isLikelyFree || CATALOG_SYNC_PLATFORMS.has(platform as Platform);
        if (!shouldPersist) continue;
```

and extend the pushed candidate with:

```ts
          enabledByDefault: isLikelyFree,
          isFree: hasPricing ? hasZeroPricing : true,
```

(d) `DiscoveredModelCandidate` gains `isFree?: boolean;`. In `discoverAndPersistNewModels`, add `is_free` to `insertModel`'s column list and `?` placeholders, and pass `candidate.isFree === false ? 0 : 1` in the run call (position matching the column).

(e) Add the drift function (bottom of file):

```ts
/**
 * Re-verify pricing + presence for a pricing-bearing platform's existing rows.
 * Only call with an authoritative (HTTP 200) upstream list — never on fetch
 * errors, so transient failures cannot disable the catalog.
 */
export function applyPricingDrift(
  db: ReturnType<typeof getDb>,
  platform: Platform,
  entries: Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }>,
): { becamePaid: string[]; wentMissing: string[] } {
  const byId = new Map(entries.filter(e => e.id).map(e => [e.id as string, e]));
  const rows = db.prepare(
    'SELECT model_id, is_free, enabled FROM models WHERE platform = ?',
  ).all(platform) as { model_id: string; is_free: number; enabled: number }[];

  const becamePaid: string[] = [];
  const wentMissing: string[] = [];
  const setPaid = db.prepare('UPDATE models SET is_free = 0 WHERE platform = ? AND model_id = ?');
  const disable = db.prepare('UPDATE models SET enabled = 0 WHERE platform = ? AND model_id = ?');

  const tx = db.transaction(() => {
    for (const row of rows) {
      const upstream = byId.get(row.model_id);
      if (!upstream) {
        if (row.enabled === 1) {
          disable.run(platform, row.model_id);
          wentMissing.push(row.model_id);
        }
        continue;
      }
      const hasPricing = upstream.pricing?.prompt != null || upstream.pricing?.completion != null;
      const zero = hasPricing
        && isZeroPrice(upstream.pricing?.prompt) && isZeroPrice(upstream.pricing?.completion);
      if (hasPricing && !zero && row.is_free === 1) {
        setPaid.run(platform, row.model_id);
        becamePaid.push(row.model_id);
      }
    }
  });
  tx();

  if (becamePaid.length) console.warn(`[ModelScout] ${platform}: pricing drift, now paid: ${becamePaid.join(', ')}`);
  if (wentMissing.length) console.warn(`[ModelScout] ${platform}: missing upstream, disabled: ${wentMissing.join(', ')}`);
  return { becamePaid, wentMissing };
}
```

(f) Call it from the discovery loop right after a successful `res.json()` for platforms with pricing (bazaarlink at minimum):

```ts
      if (platform === 'bazaarlink') {
        applyPricingDrift(db, platform as Platform, (data.data ?? []) as Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }>);
      }
```

(`db` = `getDb()` — the loop already has access; add it if the discovery function doesn't.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/__tests__/services/model-scout-pricing.test.ts src/__tests__/services/model-scout.test.ts --root server`
Expected: PASS (existing scout tests unaffected — openrouter classification result is unchanged: zero-priced openrouter entries still get `isLikelyFree=true`).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/model-scout.ts server/src/__tests__/services/model-scout-pricing.test.ts
git commit -m "feat(scout): pricing-aware classification, bazaarlink free sync, drift detection"
```

---

### Task 6: Client UI — Settings toggle + PAID badges; README; full verify

**Files:**
- Modify: `client/src/pages/SettingsPage.tsx` (toggle), `client/src/pages/FallbackPage.tsx` + `client/src/pages/ModelsPage.tsx` (badge)
- Modify: `README.md`
- Test: manual UI check + full suite + build (client has no component test harness wired — server tests cover the API contract).

**Interfaces:**
- Consumes: `GET/PUT /api/settings/free-only-mode`; `isFree` on fallback + models API rows.

- [ ] **Step 1: Settings toggle**

Read `client/src/pages/SettingsPage.tsx` first and mirror its existing section/card markup and data-fetch style (react-query if present, plain fetch otherwise). Add a "Free-tier only" card:

```tsx
const [freeOnly, setFreeOnly] = useState<boolean | null>(null)

useEffect(() => {
  fetch('/api/settings/free-only-mode')
    .then(r => r.json())
    .then(d => setFreeOnly(d.freeOnlyMode))
    .catch(() => setFreeOnly(true))
}, [])

async function toggleFreeOnly() {
  const next = !freeOnly
  setFreeOnly(next)
  await fetch('/api/settings/free-only-mode', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: next }),
  })
}
```

```tsx
<div className="...existing card classes...">
  <div>
    <h3 className="...existing heading classes...">Free-tier only</h3>
    <p className="...existing muted classes...">
      Hide paid models from /v1/models and block them from routing, fallback,
      and availability probes. Default: on.
    </p>
  </div>
  <button
    onClick={toggleFreeOnly}
    disabled={freeOnly === null}
    className={freeOnly ? '...existing toggle-on classes...' : '...existing toggle-off classes...'}
  >
    {freeOnly ? 'ON' : 'OFF'}
  </button>
</div>
```

Replace every `...existing * classes...` with the class strings used by the neighboring settings cards — copy them verbatim from the file.

- [ ] **Step 2: PAID badge**

In `FallbackPage.tsx` and `ModelsPage.tsx`, in the row rendering where `display_name`/`displayName` is shown, add after the name element (styling matches the pages' existing badge/pill spans if any; otherwise this amber pill):

```tsx
{row.isFree === false && (
  <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-500">
    paid
  </span>
)}
```

Add `isFree?: boolean` to the row's local type/interface in each file.

- [ ] **Step 3: README**

Change the BazaarLink line added earlier to:

```markdown
- BazaarLink (`auto:free` = 4M tokens/day free; paid models hidden by default — Settings → "Free-tier only")
```

- [ ] **Step 4: Full verification**

```bash
npx vitest run --root server        # expect: only the 3 known logs.test.ts failures
npm run build                       # server tsc + client tsc/vite must pass
```

Then start the dev server (or let the running `tsx watch` hot-reload), open the dashboard: Settings shows the toggle ON, Models/Fallback show amber `paid` badges on the 12 BazaarLink rows, `/v1/models` response contains no paid ids.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/SettingsPage.tsx client/src/pages/FallbackPage.tsx client/src/pages/ModelsPage.tsx README.md
git commit -m "feat(ui): free-tier-only toggle and paid badges"
```
