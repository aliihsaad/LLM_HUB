# Audio Speech Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI-compatible `POST /v1/audio/speech` text-to-speech routing.

**Architecture:** Reuse capability routing with the existing `audio` capability. Add a provider `createSpeech` contract that returns audio bytes plus content type, seed Gemini TTS models as audio-capable, and implement Google Gemini TTS as the first provider. Gemini returns PCM audio, so the route returns WAV by default for playable OpenAI-compatible binary output.

**Tech Stack:** Express, Zod, better-sqlite3, Vitest, TypeScript, Google Gemini TTS `generateContent`.

---

### Task 1: Tests First

**Files:**
- Create: `server/src/__tests__/routes/audio-speech.test.ts`
- Modify: `server/src/__tests__/providers/google.test.ts`
- Modify: `server/src/__tests__/routes/models-capabilities.test.ts`

- [x] Add a route test proving `POST /v1/audio/speech` returns binary WAV audio and `X-Routed-Via`.
- [x] Add a route test rejecting an explicit non-audio model with `model_not_found`.
- [x] Add a Google provider test proving Gemini PCM `inlineData` becomes WAV bytes.
- [x] Add a capabilities test proving Google `audio` is configured when Google keys exist.

### Task 2: Shared Types And Provider Contract

**Files:**
- Modify: `shared/types.ts`
- Modify: `server/src/providers/base.ts`

- [x] Add `SpeechRequest` with OpenAI-style `model`, `input`, `voice`, `response_format`, `speed`, `instructions`, and `user`.
- [x] Add `SpeechResult` with `data`, `contentType`, `format`, and `_routed_via`.
- [x] Add `BaseProvider.createSpeech()` default unsupported method.

### Task 3: Gemini TTS Provider

**Files:**
- Modify: `server/src/providers/google.ts`

- [x] Map OpenAI common voices to Gemini prebuilt voices.
- [x] Send Gemini TTS request with `responseModalities: ['AUDIO']` and `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`.
- [x] Decode Gemini audio `inlineData`.
- [x] Wrap PCM output in a WAV header for `response_format: 'wav'` or default.

### Task 4: Route And Catalog

**Files:**
- Modify: `server/src/routes/proxy.ts`
- Modify: `server/src/db/index.ts`

- [x] Add Zod validation for `/v1/audio/speech`.
- [x] Add explicit model validation against `audio` capability.
- [x] Route through `routeCapabilityRequest('audio', ...)`.
- [x] Return binary audio with `Content-Type`, `X-Routed-Via`, and fallback headers.
- [x] Seed `gemini-2.5-flash-preview-tts` as an audio-capable model and keep TTS rows out of chat/vision routing.

### Task 5: Verification And Memory

- [x] Run focused provider, speech route, and capability tests.
- [x] Run full server tests.
- [x] Run server and client builds.
- [x] Update README support notes.
- [x] Save Phase 4 completion to Vault.
