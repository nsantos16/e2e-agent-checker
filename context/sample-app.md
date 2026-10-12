# Sample web app: navigation map for verification agents

Generated from `sample-frontend/src/routeTree.gen.ts` (TanStack Router), `tests/labels/dev.labels.ts`, `tests/poms/*`, and earlier agent runs. Navigate by URL whenever a route exists. It's much cheaper than exploring the nav.

## Main routes
- Client list: `/client-list`
- Firm-wide task list: `/tasks` · firm tasks: `/firm-tasks`
- Client page: `/clients/$clientId` · client info: `/clients/$clientId/info/$tab` (notes: `/clients/$clientId/info/notes/$noteId`) · client comments: `/clients/$clientId/comments` · files: `/clients/$clientId/files`
- Close (month) for a client: `/clients/$clientId/close/$closeId` with subpages `/tasks`, `/accruals`, `/bank-feeds`, `/files`, `/metrics`, `/reporting`, `/portal/$tab`
- Practice-wide comments: `/practice/comments` · practice notes: `/practice/notes`
- Email inbox (NOT the notification inbox): `/inbox`
- Settings: `/settings/$section/$tab`. The settings modal opens from the gear button (`data-testid="setting-wheel"`). "All client settings" contains Properties and Archived clients.
- User settings: `/user-settings`
- Internal tools (allowlisted admins only): `/internal` → `/internal/ledger-inspector`, `/internal/chat-inspector`, `/internal/template-sharing`. Legacy `/ledger-inspector` and `/chat-inspector` redirect there.

## UI landmarks
- **Notification inbox / comment feed:** opened from the badge button in the top nav, to the left of the avatar. That button has no label (known testability gap). It shows "Search comments..." and All / Open / Unread tabs. "View all" opens the full inbox modal. The comment search only applies on Enter.
- **Comments on an entity:** the chat button (`data-testid="f-chat-button"`). Comment box `comment-textarea`, save `comment-save-button`, new thread `add-comment-button`, per-comment menu `comment-actions-menu` → `comment-menu-delete`.
- **Client Info modal:** opened from a client's Close page. Its tabs include Notes. Notes use a rich-text editor that auto-saves. Add notes modal: `c-add-notes-modal`.
- **Task list:** an AG Grid table. Column filters open an `.ag-popup` with an OK button. The due date quick filter is `tl-due-date-select`.
- **Client list:** columns via `cl-properties-button`, special filters via `cl-special-filters-button`.

## Test data on the dev environment for role `eugene` (eugene@example.com)
The practice has ~56 clients. **Work in client 5670 "Eugene's Excellent Eggs"**: open `/clients/5670`, which lands on its current close. Other readable clients: 5275 "Sandbox Company_CA_2", 5574 "Advanced Sandbox Company_US_3", 10026 "Adelynn's Awesome Apartments".

- The clients in the frontend suite's `tests/labels/dev.labels.ts` (8244, 14352, 7023) belong to a different CI user. Eugene gets **401** on them, and the app then redirects to `/login?sessionTimeOut=true`. A redirect to login after opening one specific client means **no access to that client**, not an expired session.
- You may **read** from these clients and **add your own** clearly named items (notes, comments), as long as you delete them afterwards. Never edit or delete items you didn't create.
- For cases that archive or otherwise change a client, create a new disposable client named `e2e-agent-<run id>` first, or report `blocked` if you can't.
