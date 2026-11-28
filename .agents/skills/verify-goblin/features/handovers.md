# Handovers

Use a blank `bun run try handovers` instance and its fake model, never a real
account. Create a side chat, send a message, then wait for its reply. Open the
chat title menu, choose **Convert to bot**, select all of the prefilled name
and type `Drafts`. There should be only one bot besides Little Goblin.

1. In Little Goblin, send `[handover Drafts|Draft a follow-up for the invoice question.]`.
   Its transcript shows `Handover · Little Goblin → Drafts` with the request.
2. Open Drafts. Its main chat shows the same card before `Received the
   handover.` No new side chat appears.
3. In Little Goblin, send `[handover-loop]`. The two bots pass the request back
   and forth five times. The Drafts row and the panel show one Needs you
   question. Open it; the chat says what Drafts did not send. The sixth
   attempt adds no card or model run in Little Goblin.
4. In Drafts, send `[handover Little Goblin|Continue with the approved next step.]`.
   Little Goblin receives the new request, not the stopped one. There is no
   automatic continuation of the earlier chain.

The read-only database check after these steps:
`SELECT sent, count(*) FROM handover_chains GROUP BY sent;` gives two chains
with one send, and one chain with five. `SELECT count(*) FROM wake_deliveries
WHERE state = 'settled';` gives seven. There is one `asks` row with
`operator_only = 1`. No mail or payment service is connected to the instance.
