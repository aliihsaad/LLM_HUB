# Dashboard PIN Auth Design

## Goal

Add an optional PIN gate for the LLM-Hub web dashboard when the app is exposed online, while preserving the current no-login local workflow when disabled.

## Scope

- Protect the React dashboard's management API surface only when dashboard PIN auth is enabled.
- Keep `/v1/*` on the existing unified bearer-key model. External OpenAI-compatible clients should not need a browser session.
- Store the PIN as a salted hash in SQLite settings, not as plaintext.
- Use an HTTP-only cookie session after successful PIN login.
- Add a Settings page where the owner can enable, disable, or change the PIN.

## Architecture

The backend adds `/api/auth/status`, `/api/auth/login`, `/api/auth/logout`, and `/api/auth/config`. The auth middleware runs before management API routers and only enforces when the stored dashboard PIN is enabled. `/api/auth/*` remains public enough to check status and submit a PIN.

The frontend adds an auth gate around the existing app chrome. It checks `/api/auth/status`; if PIN auth is enabled and no valid session exists, it renders a PIN login screen. Once logged in, existing dashboard pages work normally because requests include the HTTP-only cookie.

## Security

- PIN hashes use Node crypto with a random salt.
- Session cookies are HTTP-only, SameSite=Lax, path-scoped to `/`, and secure when the request is HTTPS.
- Changing or disabling the PIN rotates the session secret so old sessions stop working.
- When PIN auth is disabled, existing local-first behavior remains unchanged.

## Testing

Server route tests define the contract:

- Enabling a PIN blocks `/api/keys` without a session.
- Correct PIN login sets a cookie and allows `/api/keys`.
- Wrong PIN is rejected.
- Disabling PIN auth re-opens management APIs.
- `/v1/models` stays available without a dashboard session.
