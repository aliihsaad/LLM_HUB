# Realtime Audio Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /v1/realtime/sessions` for Gemini Live ephemeral realtime audio sessions.

**Architecture:** Keep realtime transport client-direct for this phase. The server validates the OpenAI-style session request, routes to a `realtime_audio` provider capability, creates a constrained Gemini auth token, and returns a short-lived client secret plus WebSocket URL.

**Tech Stack:** Express, TypeScript, Zod, Vitest, better-sqlite3, Gemini Developer API `v1alpha/auth_tokens`.

---

### Task 1: Route Test

**Files:**
- Create: `server/src/__tests__/routes/realtime-sessions.test.ts`

- [x] **Step 1: Write the failing test**

Create tests that add a Google key, mock Gemini `auth_tokens`, call `POST /v1/realtime/sessions`, and expect an OpenAI-like `realtime.session` response routed through Google. Add a second test that rejects `mistral-large-latest` with `model_not_found`.

- [x] **Step 2: Verify RED**

Run:

```powershell
npm run test -w server -- src/__tests__/routes/realtime-sessions.test.ts
```

Expected: fails because the endpoint does not exist yet.

### Task 2: Provider Test

**Files:**
- Modify: `server/src/__tests__/providers/google.test.ts`

- [x] **Step 1: Write the failing test**

Add a test for `GoogleProvider.createRealtimeSession` that captures the fetch URL/body and expects:

```ts
expect(url).toContain('/v1alpha/auth_tokens?key=test-key');
expect(body.bidiGenerateContentSetup.model).toBe('models/gemini-2.5-flash-native-audio-preview-12-2025');
expect(body.bidiGenerateContentSetup.generationConfig.responseModalities).toEqual(['AUDIO']);
```

- [x] **Step 2: Verify RED**

Run the provider test file. Expected: fails because `createRealtimeSession` is not implemented.

### Task 3: Types And Provider

**Files:**
- Modify: `shared/types.ts`
- Modify: `server/src/providers/base.ts`
- Modify: `server/src/providers/google.ts`

- [x] **Step 1: Add shared realtime request/response types**

Define `RealtimeSessionRequest`, `RealtimeSessionResponse`, and `RealtimeResponseModality`.

- [x] **Step 2: Add provider contract**

Add `BaseProvider.createRealtimeSession` with the same default unsupported-error pattern as speech/images/audio text.

- [x] **Step 3: Implement Google token creation**

Call `https://generativelanguage.googleapis.com/v1alpha/auth_tokens?key=...` with `bidiGenerateContentSetup`, `expireTime`, `newSessionExpireTime`, and `uses: 1`. Normalize the returned token from `name` or `authToken.name`.

### Task 4: Routing And Catalog

**Files:**
- Modify: `server/src/services/router.ts`
- Modify: `server/src/db/index.ts`
- Modify: `server/src/routes/proxy.ts`
- Modify: `server/src/routes/models.ts` only if the public capability list needs adjustment

- [x] **Step 1: Add `realtime_audio` internal capability**

Extend the router capability union.

- [x] **Step 2: Seed Gemini Live models**

Insert Gemini Live model rows and capabilities: visible `audio`, internal `realtime_audio`, fallback disabled.

- [x] **Step 3: Add `POST /v1/realtime/sessions`**

Validate JSON body with Zod, normalize `model: "auto"` to omitted, reject explicit models without `realtime_audio`, route via `routeCapabilityRequest`, call `createRealtimeSession`, record tokens/success/logs, and return JSON.

### Task 5: Docs And Verification

**Files:**
- Modify: `README.md`

- [x] **Step 1: Update docs**

Document `POST /v1/realtime/sessions` as a beta first slice and note that clients connect directly to Gemini Live with the returned ephemeral token.

- [x] **Step 2: Run focused and full checks**

Run focused realtime tests, full server tests, server build, and client build.

- [x] **Step 3: Save Vault memory**

Save the outcome, touched files, verification commands, and remaining next steps for realtime relay/UI/logs work.
