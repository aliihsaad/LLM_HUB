# Realtime Audio Sessions Design

## Goal

Add the first useful realtime audio slice for LLM-Hub: an OpenAI-style session creation endpoint that lets a trusted client start a low-latency Gemini Live audio session without exposing a long-lived Google API key.

## Scope

This phase adds `POST /v1/realtime/sessions`. It does not add a server-side WebSocket relay, browser dashboard UI, or transcript log viewer yet. Those remain follow-up work for the realtime and logs loops.

## Provider Choice

Gemini Live is the first provider because Google documents ephemeral auth tokens for direct client WebSocket access. The server exchanges a stored Google API key for a short-lived token through the Gemini Developer API `v1alpha/auth_tokens` endpoint, then returns the constrained session details to the client.

OpenAI Realtime remains a future provider because it normally requires a paid OpenAI API key and this project is prioritizing usable free or already-configured provider paths.

## Endpoint Shape

Request:

```json
{
  "model": "auto",
  "provider": "google",
  "instructions": "You are concise.",
  "voice": "alloy",
  "response_modalities": ["AUDIO"],
  "input_audio_transcription": true,
  "output_audio_transcription": true,
  "temperature": 0.7,
  "expires_in_seconds": 1800
}
```

Response:

```json
{
  "object": "realtime.session",
  "id": "rt_...",
  "provider": "google",
  "model": "gemini-2.5-flash-native-audio-preview-12-2025",
  "expires_at": 1780000000,
  "client_secret": {
    "value": "authTokens/...",
    "expires_at": 1780000000
  },
  "connect_url": "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=authTokens%2F...",
  "config": {
    "response_modalities": ["AUDIO"],
    "input_audio_transcription": true,
    "output_audio_transcription": true
  }
}
```

## Architecture

`shared/types.ts` defines `RealtimeSessionRequest` and `RealtimeSessionResponse`. `BaseProvider` gets `createRealtimeSession`, and `GoogleProvider` implements it by creating a constrained Gemini auth token with `bidiGenerateContentSetup`.

The router adds a `realtime_audio` internal capability. `seedModelCapabilities` inserts Gemini Live model rows, marks them as visible `audio`, and marks them routable with `realtime_audio`. `/api/models/capabilities` continues to expose the public `audio` light only, so the dashboard lights up when a Google key can serve realtime audio.

## Error Handling

Explicit non-realtime models return `400 model_not_found`. Provider failures are logged in `requests` and surfaced as `502 provider_error` unless retryable, where the existing fallback/cooldown behavior is reused.

## Tests

Add route tests for successful auto-routing and explicit non-realtime rejection. Add provider tests for the Google auth token body and response normalization. Extend capability tests to prove Google audio includes realtime-capable models.
