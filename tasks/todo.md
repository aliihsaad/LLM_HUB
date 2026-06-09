# Upgrade: FreeLLMAPI → LLM-Hub Pro Max

## Overview
Transform the current **FreeLLMAPI Pro Max** into **LLM-Hub Pro Max**, a next-generation, self-managing free-LLM aggregator with a modern UI, intelligent routing, real-time provider monitoring, built-in knowledge, and a CLI package for terminal use.

## Upgrade Phases

### Phase 1: Rebranding & Foundation
- **Rename:** All package names (`freellmapi` → `llm-hub`), references in the README, logo assets, and UI strings.
- **Monorepo Update:** Add `cli/` as a new workspace alongside `server`, `shared`, and `client`.
- **Data Migration:** No breaking changes to the SQLite schema needed for the rebrand itself, but new tables will be added in later phases.

### Phase 2: Live Model Availability & Discovery
- **Goal:** Ensure the catalog is never stale; automatically detect when providers change or remove free tiers, and discover new ones.
- **Implementation:** A background service (`server/src/services/model-scout.ts`) that runs periodically.
- **Mechanism:**
  - **Provider Probing:** For each provider, it will perform a real, cheap API request to see if the model responds with a valid, free-eligible answer, or check rate-limit headers.
  - **Discovery:** For providers with list-models endpoints, query them and cross-reference with the known free models.
  - **Status Updates:** Update the `models` table in the DB with an `availability_status` (e.g., `free`, `rate_limited`, `deprecated`).
- **Dashboard:** Add a "Model Status" page showing real-time availability with visual indicators (green/orange/red dots).

### Phase 3: Intelligent Model Categorization & Router
- **Goal:** Make the router smarter than just "try the first model that isn't rate-limited."
- **Implementation:**
  - **Schema Update:** Add `category` (e.g., `best_for_chat`, `best_for_code`, `best_for_vision`, `fast`, `precise`), `capabilities` (array of strings), and `specializations` to the `models` table.
  - **Categorization Logic:** Use a combination of heuristics and manual tagging to assign categories based on model family (e.g., `codestral` → `best_for_code`, `gemini-2.5-pro` → `best_for_reasoning`).
  - **Router Update:**
    - Extend the `/v1/chat/completions` API to accept a new optional header or body parameter like `x-requested-category` or `category`.
    - The router first filters by the requested category, then applies the existing fallover logic.
    - If no category is specified, it defaults to the current behavior (highest-priority available model).
- **Dashboard:** Add a "Model Categorization" page to browse models by category and view their specific strengths. A UI for mapping temperature/prompt to categories will also be explored.

### Phase 4: Context7 Knowledge Integration
- **Goal:** Give the proxy a brain. Provide a self-updating knowledge base for provider API changes, so the system can reason about new endpoints or breaking changes.
- **Implementation:**
  - **Knowledge Base:** A new `knowledge_base` table in the DB to store structured API documentation and schemas.
  - **Context7 Integration:** A service that fetches documentation from the Context7 MCP (or a configured endpoint). It will periodically ingest provider API docs.
  - **Querying:** A new admin API endpoint `/api/v1/knowledge/query` that allows the dashboard (or the CLI) to ask questions about a provider's API (e.g., "Does Cohere still support streaming in JSON mode?").
  - **Dashboard:** A new "Knowledge Base" page with a search interface.

### Phase 5: CLI Package
- **Goal:** Build a first-class CLI for installing and managing the LLM-Hub.
- **Implementation:** A new workspace `cli/` with a `bin` entry.
- **Key Commands:**
  - `llm-hub install`: Interactive setup (creates `.env`, suggests `ENCRYPTION_KEY`, checks Node version).
  - `llm-hub start`: Launches the dashboard and proxy server.
  - `llm-hub status`: Shows the status of the server, provider health, and the number of active keys.
  - `llm-hub config`: Opens/edits the `.env` file and validates keys.
  - `llm-hub update`: Checks for new upstream versions and updates the package.
- **Packaging:** Publish to npm as `llm-hub`.

### Phase 6: Modern UI/UX Design
- **Goal:** A complete visual overhaul of the React client.
- **Implementation:**
  - **Design System:** Adopt a new dark/light theme with a fresh color palette (e.g., deep purples and electric blues for a "Pro Max" feel).
  - **Framework:** Upgrade to a modern component library or build a custom one. Keep `shadcn/ui` as the base.
  - **Key Pages:**
    - **Homepage:** A unified, data-rich dashboard instead of the current tabbed layout.
    - **Router/Playground:** A split-pane view with a better code editor and real-time output.
    - **Settings:** A card-based UI for provider keys with inline validation.
    - **New Pages:** "Model Status", "Model Categories", "Knowledge Base".
  - **Animations:** Use `framer-motion` for smooth transitions between routes and elements.

## Summary of Changes
This upgrade turns a static proxy into a dynamic, self-aware, and easy-to-use hub. It maintains the core OpenAI-compatible routing but adds layers of intelligence, monitoring, and convenience.

## Next Steps
1. Get user approval for the plan.
2. Phase 1: Start with the rebranding and monorepo restructuring.
3. Move through each phase sequentially, updating `tasks/todo.md` after each phase is completed.
