---
id: 0031
date: 2026-07-25
status: accepted
spine: false
---

# 0031: Telegram Surface Is Routing Identity

## Status

accepted

## Context

Goblin’s `ChatLocator` contains only `chatId` and optional `topicId`. Callers separately pass `isSupergroup`, `isGuest`, `isPrivate`, and thread facts, while some persistence code infers chat kind from the sign of `chatId`. The same locator shape can therefore mean different Telegram delivery lanes depending on facts unavailable in the value itself.

This ambiguity spreads into bindings, project settings, memory scope, schedule capture, runner tool closures, and proactive delivery. Telegram also supports topics in private conversations as well as forum supergroups, making “topic means supergroup” an invalid simplifying assumption.

The alternatives were to retain `ChatLocator` plus more flags, adopt a generic multi-channel routing key like OpenClaw, or define a complete Telegram-native routing value. Goblin is intentionally Telegram-only, so a generic channel abstraction would add vocabulary without current leverage.

## Decision

A **Surface** SHALL be Goblin’s complete Telegram routing identity. It SHALL be a discriminated value that distinguishes DM, topic (including its container kind), topicless supergroup, and guest chat without out-of-band routing flags or chat-ID-sign inference.

A canonical reversible **SurfaceId** SHALL encode a Surface for equality, persistence keys, queue keys, and logs. Surface identifies where interaction and delivery occur; it MUST NOT identify a conversation, execution environment, or model runtime.

Telegram context normalization and Telegram-specific send parameters SHALL remain in the Telegram layer. Downstream modules receive Surface and MUST NOT reconstruct Telegram chat semantics.

Surface is Telegram-native. This decision does not establish a generic transport/channel framework.

## Consequences

Bindings and settings gain stable, unambiguous keys. Private-chat topics and forum topics can share lifecycle behavior while retaining correct Telegram routing. Conversation, automation, memory, and inner-life designs can carry provenance without importing grammy context details.

Existing bindings, settings, scheduler records, queue keys, and call sites must migrate from `ChatLocator` plus flags. A persisted legacy topic with no unique container evidence cannot be safely converted: migration must fail for explicit repair rather than defaulting it to supergroup. Cross-file migration uses per-file atomic replacement plus idempotent mixed-generation recovery, not a fictional filesystem-wide transaction. Tests need complete Surface fixtures. Adding another transport in the future would require a new decision rather than pretending Surface was generic.
