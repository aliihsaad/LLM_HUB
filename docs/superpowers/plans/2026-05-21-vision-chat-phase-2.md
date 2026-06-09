# Vision Chat Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept OpenAI-compatible image inputs in `/v1/chat/completions` and route them to vision-capable free/configured providers.

**Architecture:** Extend the existing chat message type and Zod validation to support OpenAI `content` part arrays. Route requests with image parts through the existing capability router using `vision`; start with Google/Gemini inline data conversion because Gemini supports multimodal image input and the user has configured Google keys.

**Tech Stack:** Express, Zod, better-sqlite3, Vitest, TypeScript, Google Gemini generateContent API.

---

### Task 1: Shared Types And Validation

**Files:**
- Modify: `shared/types.ts`
- Modify: `server/src/routes/proxy.ts`
- Test: `server/src/__tests__/routes/proxy-vision.test.ts`

- [x] Write a route test proving `/v1/chat/completions` accepts `content` arrays with `{ type: "text" }` and `{ type: "image_url" }`.
- [x] Add shared content part types for text and image URL input.
- [x] Update Zod validation and request mapping to preserve content arrays.
- [x] Update input token estimation for content arrays with text plus a conservative image token estimate.

### Task 2: Capability-Aware Vision Routing

**Files:**
- Modify: `server/src/routes/proxy.ts`
- Modify: `server/src/db/index.ts`
- Test: `server/src/__tests__/routes/models-capabilities.test.ts`

- [x] Route requests containing any image part through `routeCapabilityRequest('vision', ...)`.
- [x] Return a clear 400 for explicitly requested models that do not support vision.
- [x] Seed `vision` capability rows for enabled Google Gemini chat models.
- [x] Extend capabilities test to verify Google vision is configured when Google keys exist.

### Task 3: Google Gemini Image Transform

**Files:**
- Modify: `server/src/providers/google.ts`
- Test: `server/src/__tests__/providers/google.test.ts`

- [x] Write a provider test proving OpenAI `image_url` data URLs become Gemini `inlineData` parts.
- [x] Support `data:image/<type>;base64,...` URLs for local/private images.
- [x] Reject non-data image URLs for Google with a clear provider error in the first pass.
- [x] Keep text-only and tool-call behavior unchanged.

### Task 4: Verification

**Files:**
- Read: command output only

- [x] Run focused provider, proxy, router, and capability tests.
- [x] Run full server tests.
- [x] Run server and client builds.
- [x] Save completion to Vault with docs references and remaining image/audio next steps.
