# Image Edits Variations Phase 6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI-compatible `POST /v1/images/edits` and `POST /v1/images/variations`.

**Architecture:** Reuse the existing image capability catalog and add internal endpoint-specific image capabilities so generation, edits, and variations can route independently. Parse multipart image uploads at the route layer and send text-plus-image prompts to Google Gemini image models using inline image data.

**Tech Stack:** Express raw multipart parsing, TypeScript, Vitest, Google Gemini `generateContent` with image inlineData and `responseModalities: ['IMAGE']`.

---

### Task 1: Tests First

**Files:**
- Modify: `server/src/__tests__/routes/images.test.ts`
- Modify: `server/src/__tests__/providers/google.test.ts`

- [x] Add a route test proving `POST /v1/images/edits` accepts multipart `image`, `prompt`, and returns OpenAI-compatible image data.
- [x] Add a route test proving repeated multipart `image` fields are forwarded to Gemini edit content.
- [x] Add a route test proving `POST /v1/images/variations` accepts multipart `image` and uses the image variation route.
- [x] Add a route test rejecting an explicit non-image-edit model with `model_not_found`.
- [x] Add Google provider tests proving image edit/variation requests include text plus inline image data.
- [x] Run focused tests and verify they fail for missing implementation.

### Task 2: Shared Types And Provider Contract

**Files:**
- Modify: `shared/types.ts`
- Modify: `server/src/providers/base.ts`

- [x] Add `ImageFileUpload`, `ImageEditRequest`, and `ImageVariationRequest` types.
- [x] Add `BaseProvider.editImage()` default unsupported method.
- [x] Add `BaseProvider.createImageVariation()` default unsupported method.

### Task 3: Multipart Image Routes

**Files:**
- Modify: `server/src/routes/proxy.ts`

- [x] Rename the multipart raw parser for reuse across audio and images.
- [x] Add image multipart parsing for `image`, repeated `image`, optional `mask`, `prompt`, `model`, `n`, `size`, `response_format`, and `user`.
- [x] Add `/v1/images/edits` with explicit model validation against image edit support.
- [x] Add `/v1/images/variations` with explicit model validation against image variation support.
- [x] Return OpenAI-compatible image response JSON with routing headers.

### Task 4: Gemini Provider And Catalog

**Files:**
- Modify: `server/src/providers/google.ts`
- Modify: `server/src/db/index.ts`
- Modify: `server/src/services/router.ts`

- [x] Implement `GoogleProvider.editImage()` using prompt plus inline image parts.
- [x] Implement `GoogleProvider.createImageVariation()` using a default variation prompt plus inline image part.
- [x] Add internal `image_generation`, `image_edit`, and `image_variation` model capabilities.
- [x] Keep the dashboard grouped under the existing `images` capability.

### Task 5: Verification And Memory

- [x] Run focused image route/provider tests.
- [x] Run full server tests.
- [x] Run server and client builds.
- [x] Update README support notes.
- [x] Save Phase 6 completion to Vault.
