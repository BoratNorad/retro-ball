# @tdf/server

The online game server (M8): plain WebSockets (`ws`) on `/ws`, a health check on `/health`.

- Rooms: private by code (`create` / `join`) or `quick` match; lifecycle lobby → draft → lineup →
  match → results, rematch = a new draft.
- The server owns every timer (`packages/shared/config/online.json`), orders every action and runs
  the referee copies of the draft (`Draft`) and the match (`OnlineMatch`, `@tdf/sim/online.ts`). Both
  browsers replay the same action log, so the three copies stay identical (checksums after every
  action; a client that disagrees asks for a resync).
- Live plays: both clients send per-tick inputs; the server confirms them in order (a side that is
  late or away gets "no input" after `fillMs`), paced by real time, and runs the play itself.
- Reconnect: the seat token (session storage in the browser) re-attaches within `forfeitSeconds`;
  the client rebuilds everything from the logs. A side that is away longer than `aiAfterSeconds` is
  played by the AI until its player returns.

Run: `pnpm dev:server` (watch) or `pnpm start:server` (`PORT`, default 2567). Tests:
`apps/server/test/server.test.ts` (two scripted clients over real sockets).
