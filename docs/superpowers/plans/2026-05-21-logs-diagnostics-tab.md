# Logs Diagnostics Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated Logs dashboard tab backed by structured diagnostics and provider rankings.

**Architecture:** A new Express route aggregates existing request logs, API key health, model metadata, and fallback penalties into one diagnostics response. The React page renders summary stats, flags, provider ranking, and filtered recent logs.

**Tech Stack:** Express, better-sqlite3, TypeScript, Vitest, React, TanStack Query, shadcn table/button/select components.

---

### Task 1: Backend Tests

**Files:**
- Create: `server/src/__tests__/routes/logs.test.ts`

- [x] **Step 1: Write failing tests**

Test `GET /api/logs` with seeded success/error request rows and provider keys. Assert summary counts, error categorization, provider ranking, flags, and query filters.

- [x] **Step 2: Verify RED**

Run:

```powershell
npm run test -w server -- src/__tests__/routes/logs.test.ts
```

Expected: fails with 404 because `/api/logs` does not exist.

### Task 2: Shared Types

**Files:**
- Modify: `shared/types.ts`

- [x] **Step 1: Add logs diagnostics types**

Add `LogErrorCategory`, `DiagnosticSeverity`, `LogSummary`, `DiagnosticFlag`, `ProviderRanking`, `LogEntry`, and `LogsDiagnosticsResponse`.

### Task 3: Backend Route

**Files:**
- Create: `server/src/routes/logs.ts`
- Modify: `server/src/app.ts`

- [x] **Step 1: Implement error classifier**

Map provider and routing messages to categories, severity, and suggestions.

- [x] **Step 2: Implement SQL aggregates**

Whitelist `range` and `status`, bind platform/model filters, limit recent logs to 1-500, and compute summary/rankings/flags.

- [x] **Step 3: Mount route**

Mount `logsRouter` at `/api/logs`.

### Task 4: Frontend Page

**Files:**
- Create: `client/src/pages/LogsPage.tsx`
- Modify: `client/src/App.tsx`

- [x] **Step 1: Add page and route**

Add navigation item and `/logs` route.

- [x] **Step 2: Render diagnostics**

Fetch `/api/logs`, add range/status/provider controls, stat strip, provider ranking table, flags panel, and recent logs table.

### Task 5: Verification

**Files:**
- Modify: `README.md` if the dashboard feature list needs updating.

- [x] **Step 1: Run focused and full checks**

Run logs tests, full server tests, and workspace build.

- [x] **Step 2: Browser-check the tab**

Start the dev server and inspect `/logs` for non-overlapping, readable UI.

- [x] **Step 3: Save Vault memory**

Save implementation summary, verification, and remaining realtime/log follow-ups.
