---
nospec: true
id: 0035
date: 2026-07-26
status: accepted
spine: false
---

# 0035: Bounded Inner-Life Authority

## Context

Goblin's future inner life will wake without a contemporaneous user command, reflect on durable state, and may propose effects such as memory mutation or proactive contact. Reusing an unrestricted main-agent runtime would let model output choose its own authority, destination, and delivery semantics. Treating every wake as a transient scheduled prompt would meanwhile lose crash recovery and make it impossible to distinguish a reflection that ran from an effect that was durably applied.

Heartbeat may eventually become one private-wake source, but that integration was not settled. Current Surface-owned heartbeat behavior therefore remains authoritative until a separate decision changes it.

## Decision

Every inner-life wake SHALL be represented by a durable wake record with a stable identity and explicit lifecycle state. A wake kind SHALL select a code-owned, versioned capability profile before model execution. Model output MUST NOT add tools, destinations, or effects outside that profile.

Reflections MAY propose only bounded effect intents. Code SHALL validate each intent structurally and against the wake's WakeProfile and current authority before creating an effect attempt; free-form model text is not an executable effect.

Delivery and retry semantics SHALL be defined per effect kind rather than hidden behind one blanket “exactly once” claim. Each durable effect outcome SHALL make retries, deduplication, terminal failure, and pending state observable according to that effect's external boundary.

Every wake that may contact the user SHALL address one explicit home `SurfaceId`. Contact MUST NOT fall back to another Surface merely because it shares a Conversation, Execution Environment, or memory scope. If the home Surface is unavailable, policy may retain an authorized effect as pending, but it MUST NOT silently reroute it.

Proactive contact SHALL require every applicable layer of consent: deployment-wide enablement, home-Surface policy, and the wake/effect capability profile. A more permissive inner layer MUST NOT override a restrictive outer layer. Consent is checked again when a delayed contact effect is attempted.

This decision does not convert heartbeat into an inner-life wake. The `inner-life` change must preserve current heartbeat scheduling unless a later explicit decision settles that relationship.

## Consequences

Inner life gains bounded authority, durable auditability, and explicit delivery behavior rather than becoming a second unrestricted assistant loop. Wake and effect schemas, profile selection, consent resolution, home-Surface reachability, retry state, and observability need focused specs and storage design.

The model can recommend an action but cannot mint capabilities or choose an arbitrary Telegram destination. Some effects may be at-least-once with idempotency keys while others may be terminal after one external attempt; the implementation must name those differences. Heartbeat remains independent for now.
