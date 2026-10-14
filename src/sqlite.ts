// Shared SQLite connection policy. Five stores open the one state file
// (conversation, programs, mail outbox, delegations, sandboxes) as
// separate connections in a single thread; WAL keeps readers off the
// writers, so the only lock contention is another *writer* — an
// operator's sqlite3 session, a checkpoint, a maintenance script.

// How long a write waits for a foreign write lock before SQLITE_BUSY.
// Without it bun:sqlite's default is zero and the first contended
// statement fails outright (the inbox insert that precedes a Telegram
// ack included). Kept short on purpose: a busy wait blocks the event
// loop, and a nested write across two of this process's own connections
// (always a bug) must still fail loud within seconds rather than hang.
export const SQLITE_BUSY_TIMEOUT_MS = 2_000;
