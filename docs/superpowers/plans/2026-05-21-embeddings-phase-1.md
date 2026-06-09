# Embeddings Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first capability-aware OpenAI-compatible endpoint: `POST /v1/embeddings`.

**Architecture:** Keep the existing chat route stable while adding optional provider capabilities and a generic capability-aware router path. Start with OpenAI-compatible embedding pass-through and catalog rows for providers with primary documentation support.

**Tech Stack:** Express 5, TypeScript, zod, better-sqlite3, Vitest, existing provider abstraction.

---

### Task 1: Provider Embedding Pass-Through

**Files:**
- Modify: `shared/types.ts`
- Modify: `server/src/providers/base.ts`
- Modify: `server/src/providers/openai-compat.ts`
- Test: `server/src/__tests__/providers/openai-compat.test.ts`

- [ ] **Step 1: Write failing provider test**

Add a test that calls `provider.createEmbedding('key', ['one', 'two'], 'embed-model', { encoding_format: 'float' })`, asserts the URL is `/embeddings`, asserts body fields pass through, and asserts `_routed_via` is set.

- [ ] **Step 2: Verify it fails**

Run: `npm run test -w server -- server/src/__tests__/providers/openai-compat.test.ts`

Expected: fails because `createEmbedding` does not exist.

- [ ] **Step 3: Implement minimal provider support**

Add shared `EmbeddingInput`, `EmbeddingOptions`, `EmbeddingResponse`, and provider `createEmbedding` support. Implement `OpenAICompatProvider.createEmbedding()` as a `POST ${baseUrl}/embeddings` pass-through.

- [ ] **Step 4: Verify provider test passes**

Run: `npm run test -w server -- server/src/__tests__/providers/openai-compat.test.ts`

Expected: provider tests pass.

### Task 2: Capability-Aware Embedding Routing

**Files:**
- Modify: `server/src/db/index.ts`
- Modify: `server/src/services/router.ts`
- Test: `server/src/__tests__/services/router.test.ts`

- [ ] **Step 1: Write failing router test**

Add a test that inserts an OpenRouter key and asserts `routeCapabilityRequest('embeddings')` returns an embedding-capable route. Add a second test that inserts only a chat-only Groq key and asserts embeddings routing exhausts instead of routing to chat models.

- [ ] **Step 2: Verify it fails**

Run: `npm run test -w server -- server/src/__tests__/services/router.test.ts`

Expected: fails because capability metadata and `routeCapabilityRequest` do not exist.

- [ ] **Step 3: Implement minimal capability metadata**

Add a `model_capabilities` table keyed by `model_db_id` and `capability`. Seed embedding rows for OpenRouter, Mistral, and Cohere embedding models. Add `routeCapabilityRequest(capability, estimatedTokens, skipKeys, requestedModel?)`.

- [ ] **Step 4: Verify router tests pass**

Run: `npm run test -w server -- server/src/__tests__/services/router.test.ts`

Expected: router tests pass.

### Task 3: `/v1/embeddings` Route

**Files:**
- Modify: `server/src/routes/proxy.ts`
- Test: `server/src/__tests__/routes/embeddings.test.ts`

- [ ] **Step 1: Write failing route tests**

Add tests for:
- valid embeddings request routes to provider and returns `object: "list"`
- explicit unknown model returns `model_not_found`
- no embedding-capable provider returns a routing error

- [ ] **Step 2: Verify they fail**

Run: `npm run test -w server -- server/src/__tests__/routes/embeddings.test.ts`

Expected: fails because `/v1/embeddings` is not registered.

- [ ] **Step 3: Implement route**

Add zod validation for OpenAI embedding fields: `input`, `model`, `encoding_format`, `dimensions`, and `user`. Authenticate consistently with chat. Use `routeCapabilityRequest('embeddings', ...)`, call `route.provider.createEmbedding`, set `X-Routed-Via`, record request/tokens, and retry retryable errors.

- [ ] **Step 4: Verify route tests pass**

Run: `npm run test -w server -- server/src/__tests__/routes/embeddings.test.ts`

Expected: route tests pass.

### Task 4: Capabilities Dashboard Surface

**Files:**
- Modify: `shared/types.ts`
- Modify: `server/src/routes/models.ts`
- Modify: `client/src/App.tsx`
- Modify: `client/src/lib/api.ts`
- Create: `client/src/pages/CapabilitiesPage.tsx`

- [ ] **Step 1: Add backend capability response shape**

Expose each provider/model capability through an admin API response so the dashboard can render endpoint lights for `chat`, `embeddings`, `vision`, `images`, and `audio`.

- [ ] **Step 2: Add dashboard page**

Create a compact capabilities matrix page grouped by provider. Each cell is a status light: configured and supported, supported but missing key, or not supported.

- [ ] **Step 3: Add navigation**

Add the Capabilities page to the existing dashboard navigation without changing existing routes.

- [ ] **Step 4: Verify frontend build**

Run: `npm run build`

Expected: server and client compile successfully.

### Task 5: Documentation and Regression

**Files:**
- Modify: `README.md`
- Modify: Vault memory `vm_cRPcSHDWbmPKBtwX`

- [ ] **Step 1: Update README**

Move embeddings out of "Not yet supported" and add a compact usage example.

- [ ] **Step 2: Run focused tests**

Run: `npm run test -w server -- server/src/__tests__/providers/openai-compat.test.ts server/src/__tests__/services/router.test.ts server/src/__tests__/routes/embeddings.test.ts`

Expected: all focused tests pass.

- [ ] **Step 3: Run server test suite**

Run: `npm run test -w server`

Expected: all server tests pass.

- [ ] **Step 4: Save progress to Vault**

Save a session memory with changed files, test status, and next step: multimodal vision chat support.
