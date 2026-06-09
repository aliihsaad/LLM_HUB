# Images Phase 3 Implementation Plan

**Goal:** Add an OpenAI-compatible `POST /v1/images/generations` endpoint and route it through capability-aware provider metadata.

**Architecture:** Extend shared image request/response types, add a provider `createImage` method, seed image-generation models in `model_capabilities`, and route image requests with `routeCapabilityRequest('images', ...)`. First provider is Google Gemini image generation because configured Google keys already exist in this fork.

**Docs checked:** OpenAI Images API reference, Google Gemini image generation docs, Pollinations image generation docs, Cloudflare Workers AI model catalog.

---

### Task 1: Tests First

- [x] Add route tests for `/v1/images/generations` success and non-image explicit model rejection.
- [x] Add Google provider test proving Gemini `inlineData` becomes OpenAI-compatible `b64_json`.
- [x] Extend capabilities test so Google `images` is configured when Google keys exist.

### Task 2: Types And Provider Contract

- [x] Add shared image generation request/response types.
- [x] Add `BaseProvider.createImage()` with default unsupported behavior.
- [x] Implement `GoogleProvider.createImage()` with Gemini `responseModalities: ['IMAGE']`.

### Task 3: Routing And Catalog

- [x] Add `POST /v1/images/generations` to the proxy router.
- [x] Validate OpenAI-compatible prompt, model, n, size, quality, response_format, and user fields.
- [x] Seed Google Gemini image model rows and `images` capability rows.
- [x] Keep image-generation models out of normal chat/vision routing.

### Task 4: Verification And Memory

- [x] Run focused image/provider/capability tests.
- [x] Run full server tests.
- [x] Run server and client builds.
- [x] Update README support notes.
- [x] Save Phase 3 completion to Vault.
