# Remote Vision Image URLs Phase 7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow OpenAI-style vision chat requests to use remote `http`/`https` image URLs, not only `data:image/...;base64,...` URLs.

**Architecture:** Keep request routing unchanged. Update the Google provider content conversion path from sync to async so remote image URLs are fetched, validated, converted to Gemini `inlineData`, and sent through the existing vision capability route.

**Tech Stack:** Node fetch, URL validation, Vitest, Google Gemini inline image data.

---

### Task 1: Tests First

**Files:**
- Modify: `server/src/__tests__/providers/google.test.ts`
- Modify: `server/src/__tests__/routes/proxy-vision.test.ts`

- [x] Add a provider test proving an HTTPS `image_url.url` is fetched and converted to Gemini inlineData.
- [x] Add provider tests proving localhost/private/non-image/redirect remote URLs are rejected.
- [x] Add a route test proving remote URL vision requests still route via the `vision` capability.
- [x] Run focused tests and verify they fail for missing implementation.

### Task 2: Remote Image Fetching

**Files:**
- Modify: `server/src/providers/google.ts`

- [x] Change Gemini message conversion helpers to async.
- [x] Keep data URL support unchanged.
- [x] Add remote image URL validation for `http`/`https` only.
- [x] Block localhost, loopback, private, link-local, and metadata hostnames/IPs.
- [x] Fetch with redirects disabled.
- [x] Enforce image content type and maximum byte size.

### Task 3: Verification And Memory

- [x] Run focused provider and route tests.
- [x] Run full server tests.
- [x] Run server and client builds.
- [x] Update README support notes.
- [x] Save Phase 7 completion to Vault.
