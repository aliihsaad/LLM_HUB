# Dashboard Quota And Capability Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dashboard quota and capability status reflect multiple independent provider keys more accurately.

**Architecture:** Keep routing unchanged. Add effective quota metadata to existing fallback APIs and improve existing dashboard pages to display base budget, key multiplier, effective budget, and clearer capability states.

**Tech Stack:** Express, better-sqlite3, Vitest, React, Vite, TanStack Query, Tailwind/shadcn UI.

---

### Task 1: Backend Effective Quota Metadata

**Files:**
- Modify: `server/src/routes/fallback.ts`
- Modify: `server/src/routes/models.ts`
- Test: `server/src/__tests__/routes/fallback.test.ts`

- [x] Add a focused Vitest case for `/api/fallback/token-usage` that inserts multiple enabled keys for one provider and expects `baseBudget`, `keyCount`, and `effectiveBudget`.
- [x] Update fallback key counts to match router behavior: `enabled = 1 AND status != 'invalid'`.
- [x] Return each model's parsed `baseBudget`, routable `keyCount`, `effectiveBudget`, and compatibility `budget` equal to `effectiveBudget`.
- [x] Update models/capabilities key counts to use the same routable-key condition.
- [x] Run `npm run test -w server -- src/__tests__/routes/fallback.test.ts src/__tests__/routes/models-capabilities.test.ts`.

### Task 2: Fallback UI Quota Labels

**Files:**
- Modify: `client/src/pages/FallbackPage.tsx`

- [x] Extend local TypeScript interfaces with `baseBudget`, `keyCount`, and `effectiveBudget`.
- [x] Render token bar segments from effective budget.
- [x] Show model rows with a compact multiplier label such as `~6M tok/mo x 3 keys = ~18M`.
- [x] Preserve existing drag/reorder behavior.

### Task 3: Capabilities UI Readability

**Files:**
- Modify: `client/src/pages/CapabilitiesPage.tsx`

- [x] Add a compact legend for green, amber, and muted states.
- [x] Replace bare dot/count cells with readable text: `Routable`, `No key`, or `-`, while keeping supported model counts visible.
- [x] Keep table layout compact on wide desktop.

### Task 4: Verification

**Files:**
- Read: build/test output only

- [x] Run focused server tests.
- [x] Run `npm run build -w client`.
- [x] Note any unrelated lint failures if `npm run lint -w client` is run.
- [x] Save completion summary to Vault with touched files and remaining next steps.
