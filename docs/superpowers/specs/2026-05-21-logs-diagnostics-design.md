# Logs Diagnostics Design

## Goal

Add a dedicated dashboard Logs tab that turns raw request rows into useful diagnostics: recent API logs, error flags, provider rankings, and actionable recommendations.

## Scope

This phase adds a backend `/api/logs` endpoint and a frontend `/logs` page. It reuses the existing `requests`, `api_keys`, `models`, `model_capabilities`, fallback penalties, and rate-limit services. It does not change request logging schema or add persistent realtime session event logs yet.

## Backend Response

`GET /api/logs?range=24h|7d|30d&status=all|success|error&platform=google&limit=100`

Returns:

- `summary`: total requests, error count, success rate, average latency, active providers, and total tokens.
- `flags`: grouped diagnostic flags with severity, category, count, and recommendation.
- `rankings`: provider ranking scored by success rate, latency, recent volume, key health, and active fallback penalty.
- `recent`: filtered request rows with `errorCategory`, `severity`, and `suggestion`.

## Error Classification

Errors are normalized into categories:

- `rate_limit`: quota, 429, too many requests.
- `auth`: 401, invalid key, unauthorized.
- `forbidden`: 403, subscription, permission.
- `not_found`: 404 or unavailable model.
- `timeout`: timeout, aborted, connection reset/refused.
- `provider`: 5xx, unavailable, internal error.
- `routing`: exhausted models or missing keys.
- `other`: fallback category.

## Ranking

Provider score is deterministic and explainable:

`successRate * 0.55 + latencyScore * 0.20 + keyHealthScore * 0.15 + volumeScore * 0.10 - penalty`

Latency score rewards providers under 10 seconds. Key health uses enabled, non-invalid keys. Fallback penalties lower the score when a model is repeatedly rate-limited.

## Frontend

The Logs tab is dense and operational:

- Top stats for request count, success rate, errors, latency, and active providers.
- Provider rankings table with score, status, request count, success rate, latency, key health, and top flag.
- Diagnosis flags panel sorted by severity and count.
- Recent logs table with filters for range, status, and provider.

## Tests

Backend tests seed requests and keys, then verify classification, filtering, ranking, summary fields, and safe query handling.
