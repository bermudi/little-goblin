# Rolling chat

## How to get to it

The app opens in it, at the newest roll. "Rolling chat" is also the first row
of the list, above Active. Its mark is that of any of its rolls, and it opens
the roll that has the mark ([home.md](home.md)).

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

## Starting a new roll by hand

In a roll that has messages, open the context gauge
(`.ctx-gauge > .ctx-btn`; the composer's other `.ctx-btn` is the memory
toggle). The popover's last row reads "Compact now", then "New
conversation". "New conversation" starts a fresh roll at once: the
transcript shows "— new conversation —" with "↑ Previous conversation",
the text typed but not sent comes along, and the composer has focus on
every width. The action is off while a turn runs in the conversation on
screen or in the latest roll, and in an empty roll. An ordinary chat does
not offer it. The log line is `app lane rolled` with `decidedBy: "manual"`.
