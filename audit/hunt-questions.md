# Hunt questions

For hunter agents, not the operator. Hunters answer these themselves, with
evidence. The operator only reads the findings.

Ask every question of every journey, in every hunt. Each question was
written from one real finding, but it is generic on purpose: it is not a
search area. Hunters get journeys and these questions, never past bugs.

Base questions (every journey):
- Does every kind of input arrive, intact?
- Does everything the other side returns get used, saved, and sent back when
  it's needed later?
- Does it survive a restart or resume?
- Does a failure show to the user, or is it silent?
- Would a user migrating from openclaw or hermes be surprised? Why?

When a bug is found in use, ask "which question would have caught this?" If
none would, add one here.

Catch-questions:
1. H1 — Does the journey's default configuration still work end to end on a
   fresh install today? Do all pinned external artifacts still exist?
2. H2 — When a step is interrupted intentionally (restart, stop), is the
   unfinished work findable, explainable, and resumable afterwards?
3. M1 — If the operator follows the shipped example verbatim but their real
   identity differs, does the first real action fail with a message that
   names the cause?
4. M2 — From the moment input is sent until the first visible response, is
   there any feedback at all? What is the worst-case gap?
5. M3 — Does every surface this journey renders on apply the same formatting
   rules?
6. M4 — When the user narrows or points at something (quote, selection,
   reply target), does the model see the narrowed thing or the whole parent?
7. M5 — Does every kind of reply target, including cross-chat/external ones,
   carry its context into the model's view?
8. M6 — How long can new input wait before the model sees it, worst case in
   this journey?
9. M7 — When the product discards user input or work, does the user get a
   per-item acknowledgment?
10. M8 — When the operator edits a file the docs promise is live, does the
    next turn actually reflect the edit — and do the docs match the real
    boundary?
11. M9 — Which parts of this journey live only in process memory, and what
    does the user experience after a restart?
12. M10 — Is any accepted input ever left with no owner (no turn, no notice)?
13. M11 — If a produced result is committed but its delivery is interrupted,
    who delivers it later?
14. M12 — When a background subsystem fails during this journey, is the
    failure visible on every channel it affects?
15. M13 — Does the product accept the formats its own docs claim are
    compatible — tested with real samples from the ecosystem?
16. M14 — Do the docs' safety promises hold under the default configuration,
    or only when an optional feature is enabled?
17. M15 — When the user states a durable preference, what mechanism records
    it — and is that mechanism present by default?
18. M16 — Do commands the reference agents train users to type fail loudly
    when this product doesn't support them?
19. M17 — Which failure shapes reach the designed retry/backup paths, and
    which bypass them?
20. M18 — If a worker or turn never advances, what eventually notices, and
    when?
21. M19 — Does every stored field that promises future behavior actually get
    read by a scheduler?
22. M20 — When a dependency becomes unreachable, does the UI keep claiming
    health?
23. M21 — What in this journey grows without bound, and what is the
    experience at 100× today's size?
24. L1 — Does "installed/healthy" mean the same thing to the product as it
    does to the migrating user?
25. L2 — Which features does the shipped example config accidentally disable?
26. L3 — When validation fails, does the error name the location without
    leaking content?
27. L4 — Does output splitting respect content boundaries the references
    respect?
28. L5 — When a message's origin matters (forwarded, cross-chat), does the
    model learn the origin?
29. L6 — Are any silent truncations applied between what the user sent and
    what the model sees?
30. L7 — Does an ignored user action get any visible acknowledgment?
31. L8 — When context exists but is empty-shaped (media-only parent), does
    the model still learn the fact of the reference?
32. L9 — Are engine-specific exceptions to documented behavior named where
    the behavior is documented?
33. L10 — What does the user watch disappear when the process dies mid-step?
34. L11 — Is already-produced output retrievable in-channel after an
    interruption?
35. L12 — Are command arguments parsed but unused anywhere in the product?
36. L13 — Is error detail that reaches the model also reachable by the user?
37. L14 — Do saved artifacts keep truthful names and types?
38. L15 — Do mode flags match the granularity the references offer?
39. L16 — Is notice-only recovery a ruling or an accident, and does the
    operator know which?
40. L17 — Do all surfaces of one confirmation show the same human-readable
    form?
41. L18 — Can the user tell delayed/coalesced work from on-time work?
42. L19 — Do skipped actions leave a trace on an inspectable surface?
43. L20 — When a parent scope's setting changes, are children's stamped
    copies recomputed?
44. L21 — Are enforced limits visible to the party the docs tell to react to
    them?
45. L22 — Is a deferred effect ("applies next turn") visible at switch time?
46. L23 — When an action is refused because state drifted, does the refusal
    offer the restore?
47. L24 — Do automatic adjustments to user-chosen settings explain
    themselves?
48. L25 — Does user-facing failure copy diagnose, or does it relay SDK
    internals?
49. L26 — Do notifications name their actual origin?
50. L27 — Is completion distinguished from an ended turn that asks a
    question?
51. L28 — Are steering/refusal preflight checks symmetric across all input
    verbs?
