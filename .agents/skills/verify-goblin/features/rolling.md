# Rolling chat

## How to get to it

Open the PWA Chats list. "Rolling chat" is the first row, above projects and
ordinary chats. Open it and send a message.

## Driving it

Send a message and wait for `verify-reply: ...`. Two messages sent inside
the one-minute quiet gap join the same conversation. To drive a roll, wait
65 seconds after the reply, then send `[new topic] ...`; the scripted
decision endpoint treats that marker as a new subject and the transcript
opens a fresh roll with a "— new conversation —" marker.
"↑ Previous conversation" opens the prior roll, and "Back to latest"
returns to the current one.

Before the first rolling send, choosing a model in the composer sets the
model for that newly minted roll, without changing app defaults. If another
tab starts the first roll before you send, the draft choice cannot change
that roll. The picker in an existing roll still changes that roll only.
Later automatic rolls use the current app defaults.

The fake decision model answers `follow_up` with 0.05 when `state.next`
contains `[new topic]`, otherwise 0.9. This affects rolling-chat routing;
ordinary chat and project behavior still use the scripted chat-completion
endpoint.
