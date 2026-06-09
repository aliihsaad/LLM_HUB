# Audio Transcription Phase 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI-compatible request-based `/v1/audio/transcriptions` and `/v1/audio/translations`.

**Architecture:** Reuse the existing `audio` capability but route speech synthesis, transcription, and translation through provider methods. Parse multipart bodies at the route layer, keep file/url fields typed, and forward requests to OpenAI-compatible audio providers such as Groq.

**Tech Stack:** Express raw body parser, TypeScript, Zod-style route validation, OpenAI-compatible multipart forwarding, Vitest.

---

### Task 1: Tests First

**Files:**
- Create: `server/src/__tests__/routes/audio-transcription.test.ts`
- Modify: `server/src/__tests__/providers/openai-compat.test.ts`
- Modify: `server/src/__tests__/routes/models-capabilities.test.ts`

- [x] Add a route test proving `POST /v1/audio/transcriptions` accepts multipart upload, routes via `audio`, and returns JSON.
- [x] Add a route test proving `POST /v1/audio/translations` accepts multipart upload, routes via `audio`, and returns JSON.
- [x] Add a route test rejecting an explicit non-audio model with `model_not_found`.
- [x] Add a provider test proving OpenAI-compatible transcription forwards multipart fields and file bytes.
- [x] Add a provider test proving translation forwards to `/audio/translations`.
- [x] Add a capabilities test proving Groq transcription models are listed under `audio`.
- [x] Run focused tests and verify they fail for missing implementation.

### Task 2: Shared Types And Provider Contract

**Files:**
- Modify: `shared/types.ts`
- Modify: `server/src/providers/base.ts`

- [x] Add typed audio file and transcription request/response shapes.
- [x] Add `BaseProvider.transcribeAudio()` default unsupported method.
- [x] Add `BaseProvider.translateAudio()` default unsupported method.

### Task 3: Multipart Parsing And Routes

**Files:**
- Modify: `server/src/routes/proxy.ts`

- [x] Add route-level raw parsing for multipart audio endpoints.
- [x] Parse text fields, repeated `timestamp_granularities[]`, and one uploaded `file` part.
- [x] Support `url` field as an alternative to `file`.
- [x] Validate `model`, `language`, `prompt`, `response_format`, `temperature`, and timestamp granularities.
- [x] Route transcription and translation through capability-aware routing.
- [x] Return JSON/text/srt/vtt content types according to provider response.

### Task 4: Provider Forwarding And Catalog

**Files:**
- Modify: `server/src/providers/openai-compat.ts`
- Modify: `server/src/db/index.ts`

- [x] Forward transcription multipart requests to `${baseUrl}/audio/transcriptions`.
- [x] Forward translation multipart requests to `${baseUrl}/audio/translations`.
- [x] Preserve provider response content type and routed metadata.
- [x] Seed Groq `whisper-large-v3-turbo` and `whisper-large-v3` as audio-capable models.

### Task 5: Verification And Memory

- [x] Run focused route/provider/capability tests.
- [x] Run full server tests.
- [x] Run server and client builds.
- [x] Update README support notes.
- [x] Save Phase 5 completion to Vault.
