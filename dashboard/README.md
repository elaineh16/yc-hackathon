# Dashboard (owner: Person 3 — Frontend)

Build the real dashboard here with Wasp / Open SaaS (`wasp new` in this folder). Until then, the backend serves
a working fallback dashboard at `http://localhost:3001/` (`backend/public/index.html`). Steal from it freely.

## API (backend, default http://localhost:3001)

Poll `GET /api/tickets` every ~2 seconds for live updates.

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/status` | `{ ok, dryRun }` |
| GET | `/api/tickets` | Tickets, newest first, each with `contractor` and `calls[]` (oldest first) |
| GET | `/api/tickets/:id` | One ticket with `contractor` and `calls[]` |
| POST | `/api/tickets/:id/redispatch` | Restart contractor calling for a ticket |
| GET | `/api/contractors` | Contractor list |
| POST / PUT | `/api/contractors[/:id]` | Add or edit a contractor |

Ticket `status`: `new`, `dispatching`, `booked`, `confirmed`, `done`, `escalated`, `needs_human`.
Call `outcome`: `in_progress`, `ticket_created`, `accepted`, `declined`, `no_answer`, `failed`, `confirmed`,
`reschedule_requested`, `ended`.

Full types: `backend/src/types.ts`.

## Screens (from the design doc)

1. **Ticket board** — columns by status; card shows unit, category, urgency colour, time since report, slot.
2. **Ticket detail** — call timeline (intake → each contractor attempt → confirmation) with summary, outcome,
   transcript and audio.
3. **Contractors** — list by trade and priority, editable.

To get data without phones: run the backend, then `npm run simulate` in `backend/`.
