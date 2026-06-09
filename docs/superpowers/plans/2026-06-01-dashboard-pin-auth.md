# Dashboard PIN Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional PIN login for the dashboard and management APIs without changing `/v1` client authentication.

**Architecture:** Add focused backend auth service, auth routes, and conditional middleware backed by the existing SQLite settings table. Add a React auth gate plus Settings page for enabling, disabling, changing, logging in, and logging out.

**Tech Stack:** Express 5, better-sqlite3, Node crypto, Vitest, React 19, TanStack Query, shadcn-style local UI components.

---

### Task 1: Backend Auth Contract

**Files:**
- Create: `server/src/__tests__/routes/admin-auth.test.ts`
- Create: `server/src/services/admin-auth.ts`
- Create: `server/src/routes/auth.ts`
- Create: `server/src/middleware/adminAuth.ts`
- Modify: `server/src/app.ts`

- [ ] Write failing route tests for PIN enable, login, blocking, disabling, and `/v1` passthrough.
- [ ] Run `npm run test -w server -- src/__tests__/routes/admin-auth.test.ts` and confirm tests fail before implementation.
- [ ] Implement admin PIN hashing, session cookie helpers, auth routes, and middleware.
- [ ] Run the narrow auth test and confirm it passes.

### Task 2: Dashboard Auth UI

**Files:**
- Modify: `client/src/lib/api.ts`
- Create: `client/src/components/auth-gate.tsx`
- Create: `client/src/pages/SettingsPage.tsx`
- Modify: `client/src/App.tsx`

- [ ] Make `apiFetch` include same-origin credentials.
- [ ] Add an auth gate that renders a PIN form when `/api/auth/status` says a PIN is required.
- [ ] Add Settings nav/page with PIN enable, disable, change, and logout controls.
- [ ] Build the client to verify TypeScript and bundle output.

### Task 3: Verification

**Files:**
- Modify only if verification reveals an implementation bug.

- [ ] Run `npm run test -w server -- src/__tests__/routes/admin-auth.test.ts`.
- [ ] Run `npm run test -w server`.
- [ ] Run `npm run build`.
- [ ] Save a Vault memory with the implementation outcome.
