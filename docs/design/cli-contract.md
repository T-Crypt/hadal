# CLI contract (parity with tab protocol)

Actions and routes, verified against `src/server/http/api.ts` and `conversation-routes.ts`.

- Sign in: `GET /api/me`
- List sessions: `GET /api/sessions`
- Create session: `POST /api/sessions` with `client` field
- Events stream: `GET /api/events`
- Poll: `GET /api/poll`
- Switch: `POST /api/switch`
- Submit: `POST /api/c/:id/submit`
- View: `GET /api/c/:id`
- Configure: `POST /api/c/:id/configure`
- Approvals: `POST /api/approvals/:id`
- Fork: `POST /api/c/:id/fork`
