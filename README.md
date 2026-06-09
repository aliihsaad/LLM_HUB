# LLM-Hub Pro Max

LLM-Hub Pro Max is a local OpenAI-compatible routing layer with an admin dashboard.
It unifies multiple AI providers under a single `/v1` API so your apps can switch
between models and providers without changing client code.

This project is built on the FreeLLMAPI codebase:
https://github.com/tashfeenahmed/freellmapi

## What this project does

- Single unified proxy endpoint for compatible OpenAI clients (`/v1/*`)
- Per-key encrypted storage in local SQLite (`data/freeapi.db`)
- Sticky fallback routing with cooldowns on rate limits and provider errors
- Health checks, analytics, request logs, provider ranking, and diagnostics
- Admin dashboard for keys, fallback chain, model availability, and model discovery
- Optional dashboard PIN lock for management routes and UI

## Project layout

This repo is a workspace with these packages:

- `server/` — Express API (`/v1` proxy + `/api` admin endpoints)
- `client/` — React/Vite dashboard (SPA)
- `shared/` — Shared TypeScript contracts

## Requirements

- Node.js 20+
- npm
- A valid 64-character hex `ENCRYPTION_KEY` (32 bytes, required to run)

## Install and run

Clone the source and install dependencies:

```bash
git clone <repo-url>
cd <repo-folder>
npm install
```

Create environment (`cp` on Unix/macOS, `copy` on Windows):

```bash
cp .env.example .env   # or: copy .env.example .env
```

Generate a real key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste into `.env`:

```env
ENCRYPTION_KEY=your-64-hex-chars
PORT=3001
CONTEXT7_API_KEY=optional-context7-key
```

Start both server and dashboard:

```bash
npm run dev
```

- Dashboard: `http://localhost:5173`
- Proxy base URL: `http://localhost:3001`

Build everything for production:

```bash
npm run build
```

Run server only:

```bash
npm run build -w server
node server/dist/index.js
```

## OpenAI-compatible API (`/v1`)

All application traffic uses `/v1` and includes header-based routing metadata in
responses:

- `X-Routed-Via: <platform>/<model_id>`
- `X-Fallback-Attempts: <count>` (when failover occurred)

### Core endpoints

- `GET /v1/models` — list enabled routed models
- `POST /v1/chat/completions` — streaming and non-streaming chat
- `POST /v1/embeddings` — shared embed endpoint
- `POST /v1/images/generations` — image generation
- `POST /v1/images/edits` — multipart image edit with prompt + optional mask
- `POST /v1/images/variations` — multipart variation requests
- `POST /v1/audio/speech` — text-to-speech
- `POST /v1/audio/transcriptions` — multipart ASR input + optional URL
- `POST /v1/audio/translations` — multipart translation input + optional URL
- `POST /v1/realtime/sessions` — realtime session token issuance

`POST /v1/completions` is not currently implemented.

### Example usage

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3001/v1",
    api_key="llmhub-...",
)

resp = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Summarize the benefits of local API routing."}],
)

print(resp.choices[0].message.content)
```

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer llmhub-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```

### Tool calling

Tool calling is passed through when supported by the selected capability and models.
Send standard OpenAI-style `tools` and `tool_choice` fields in chat requests.

## Admin API (`/api`)

Dashboard uses these endpoints and they are also available directly:

- `GET /api/ping` — health sanity check
- `GET /api/keys`  
  `POST /api/keys`, `PATCH /api/keys/:id`, `DELETE /api/keys/:id`
- `GET /api/models`
- `GET /api/models/providers`
- `GET /api/models/capabilities`
- `GET /api/models/categories`
- `PATCH /api/models/:id/category`
- `GET /api/fallback`
- `PUT /api/fallback`
- `POST /api/fallback/sort/:preset` (`intelligence`, `speed`, `budget`)
- `GET /api/fallback/token-usage`
- `GET /api/health`, `POST /api/health/check/:keyId`, `POST /api/health/check-all`
- `GET /api/analytics/summary?range=24h|7d|30d`
- `GET /api/analytics/usage-estimates?range=24h|7d|30d`
- `GET /api/analytics/by-model|by-platform|timeline|error-distribution|errors`
- `GET /api/logs` (+ filters: `range`, `status`, `platform`, `model`, `limit`)
- `GET /api/settings/api-key` and `POST /api/settings/api-key/regenerate`
- `GET /api/settings/context7`, `PUT /api/settings/context7`, `DELETE /api/settings/context7`
- `GET /api/model-availability`, `POST /api/model-availability/check`, `POST /api/model-availability/discover`
- `POST /api/model-sweeps`, `GET /api/model-sweeps/:id`
- `GET /api/knowledge/query`, `GET /api/knowledge/providers/:provider`, `GET /api/knowledge/search`
- `POST /api/knowledge`, `GET /api/knowledge/config`, `POST /api/knowledge/sync`

### Admin auth

Management endpoints are guarded by optional dashboard PIN mode:

- `GET /api/auth/status`
- `POST /api/auth/config` (enable/disable PIN)
- `POST /api/auth/login` / `POST /api/auth/logout`

If PIN is disabled, admin APIs are open for local-first use. If enabled, a valid
dashboard session is required.

## Supported providers

Provider catalog is defined in `server/src/providers/index.ts`:

- Google
- Groq
- Cerebras
- SambaNova
- NVIDIA NIM
- Mistral
- OpenRouter
- GitHub Models
- Cohere
- Cloudflare
- Zhipu AI
- Ollama Cloud
- Kilo Gateway
- Pollinations
- LLM7

Capability availability varies by provider and key status. The dashboard shows
live per-provider/per-capability health and configuration.

## Development

- `npm run dev` — launches both server and client in watch/dev mode
- `npm run build` — builds server and client for production
- `npm run build -w server` — server build only
- `npm run build -w client` — client build only
- `npm run test -w server` — server tests
- Client tests are not configured in `client/package.json` (no `test` script).

## Data & persistence

- Database file: `data/freeapi.db`
- Logs and request stats are stored in SQLite and exposed through `/api/logs` and `/api/analytics/*`
- Model catalog and fallback state are also stored in SQLite and migrated on startup

## Limitations

- No global multi-tenant accounts or billing management.
- No guarantee of model availability or ToS compatibility; provider free tiers change
  frequently.
- The dashboard and APIs are designed for personal/small-team self-hosted use.
- Frontend API behavior is intentionally scoped around OpenAI-compatible endpoints listed
  in `/v1`.

For model and behavior details that are still evolving, use:

- Dashboard `Model Discovery` and `Model Sweep` controls
- `/api/model-availability/discover`
- `/api/model-sweeps`

## License

This project is released under the [MIT License](LICENSE).
