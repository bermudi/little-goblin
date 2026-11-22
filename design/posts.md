# Feed posts — goblin design

Issue #845. A [post](../GLOSSARY.md#post) is a short note Goblin writes
to the operator with the `post` tool. Posts show in the Activity tab of
the [Goblin panel](../GLOSSARY.md#goblin-panel).

## Rulings this lands

- Operator, 2026-11-21: feed posts are a tool Goblin calls, not a view
  that code derives from work state. This replaces the responsibilities
  feed that #844 removed.
- Operator, 2026-11-21 (#862): posts land in the Activity tab first,
  beside routine work items. A full-width feed page comes later, and
  only if posts get rich (images, tables).
- AGENTS.md: code owns the tool, its storage, delivery, logging and
  limits. When to post and what to say belong to skills and the
  operator. The tool description says what the tool does, never when to
  use it.
- Operator, 2026-11-22 (#845): no Telegram copy and no push
  notification for posts, for now. If posts get missed, that becomes
  its own issue.
- Operator, 2026-11-22 (#845): posts stay mixed by time with finished
  work in the Activity tab, with no pinned section. Activity gets a
  "See all" so older rows can be reached (#892).
- Operator, 2026-11-22 (#845): the other picks of #884 stand. Plain
  text up to 500 characters, no read state or dismiss, keep the newest
  500, posts outlive their chat, and no edit, remove or list verbs until
  a skill needs them.

## Shape

- **Tool.** `post {text}`. Plain text, 1–500 characters after trimming.
  It returns `{id, createdAt}`. Blank or overlong text fails
  validation. There is no edit, remove or list.
- **Storage.** The `posts` table in the conversation database
  ([`posts.ts`](../src/posts.ts)): id, source conversation id, text and
  time. Each insert keeps only the newest 500 posts, in the same
  transaction. The table has no foreign key: a post outlives its chat.
  `post added` logs the id, conversation and length.
- **Binding.** The tool is bound per turn to the running conversation,
  like `watch` and `program`. The model never handles conversation ids.
- **Mounting.** Always on for the operator's turns, on every channel.
  Off for guests: the policy row sets `guestChannel: false`, and the
  sandbox allowlist does not include it. The tool is not scriptable.
- **Authority.** The turn's fence checks authority right before every
  tool call, and the insert is synchronous, so nothing can change
  between the check and the write. The tool is replay-unsafe: a call
  repeated after a crash is refused, so a post is never duplicated.
- **Wire.** `GET /api/app/activity` returns the newest 20 posts, newest
  first. Each carries `conversation: {id, rolling}` when its source is
  an app conversation that still exists, else `null`.
- **Panel.** Posts join the finished rows of the Activity tab (finished
  delegations and program runs) and sort by time with them, under the
  running rows. A post row shows its full text with line breaks, then
  "post · <age>". It opens its source chat; a post from a
  [roll](../GLOSSARY.md#roll) opens the Rolling chat. A post with no app
  source (Telegram, a deleted chat) is not a button.

## Rejected alternatives

| Option | Why not |
|---|---|
| Derive the feed from work state (delegations, programs) | The operator ruled against it: that is code deciding what matters. |
| A separate feed page now | Ruled out until posts get rich (#862). |
| A separate posts route | The panel already polls `/api/app/activity` every 10 s; one more field costs no extra request. |
| Title plus body | The panel row has no place for a body. One short text fits the row and needs no detail view. |
| Markdown | Plain text is enough for a row. Rich posts are the trigger for a feed page. |
| A foreign key that sweeps posts with their chat | A post is the operator's record. Deleting a chat removes the link, not the post. |
| Push or Telegram delivery | A post is something to read when the operator looks. Ringing is what a message is for. |
| A JSONL file | Retention, newest-first reads and the source link are simple queries in SQLite, beside `watches`. |

## Ruled calls

The reversible picks of #884, as the operator ruled them on 2026-11-22
(#845):

- 500-character limit, plain text: stands.
- Keep the newest 500 posts: stands.
- No read/unread state and no dismiss: stands.
- Posts sort by time with finished work: stands, with no pinned
  section. A busy program can still push posts out of the panel's eight
  rows, so Activity has a "See all" (#892).
- No push notification and no Telegram copy: stands, for now.
- Posts survive the deletion of their chat: stands.
