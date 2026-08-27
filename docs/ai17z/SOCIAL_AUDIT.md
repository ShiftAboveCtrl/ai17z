# Social intelligence: audit before building

Required by §2 of the specification: classify every requested capability against
what AI17Z already has, and extend existing abstractions rather than creating
parallel ones.

## Already implemented — extend, do not rebuild

| Capability | Where it lives | Note |
| --- | --- | --- |
| Event identity and idempotency (§10) | `events (channel, account, remote_event_id)` | The anchor exists. Multi-source *discovery evidence* does not. |
| Thread history (§20) | `conversations` + `messages`, `ResolvedContext.thread` | Bounded retrieval works. No thread *state* or summary. |
| Parent context (§19) | `ResolvedContext.parentText` | Explicit already, not positional. |
| Memory, six scopes (§80) | `packages/memory`, `MEMORY_TYPES` incl. `COMMITMENT` | Write policy exists; no write *classification* taxonomy. |
| Prompt layers (§22) | `packages/prompts`, ten layers | Structured already. Needs new layers, not a new system. |
| Persona versions (§34–35) | `persona_versions`, drift requires a new version | Layering (core/belief/interest/temporary) is missing. |
| Persona sources (§36 partial) | `packages/persona`, traits with evidence | Traits are qualitative. No numeric fingerprint. |
| Executable pipeline (§96–97) | `packages/runtime/graph.ts`, `nodes.ts` | Add node kinds. The interpreter already runs the stored graph. |
| Model roles (§98 partial) | `MODEL_ROLES` = primary / fallback_1 / fallback_2 / classifier | Needs vision, transcription, critic, voice_rewrite. |
| Rate limits, serialization, burst control (§85) | cadence + `policy.rate` + account leases | Context-sensitive *timing* (§84) is missing. |
| Action provenance (§87) | `job_traces`, `actions`, versions pinned per job | Extend with social stages, not replace. |
| Approval gate (§110) | `APPROVAL_GATE` node | Quality scores are what is missing, not the gate. |
| Owner overrides (§90) | approve / reject / requeue / persona-source override | Extend to stance and relationship. |

## Partially implemented

| Capability | What exists | What is missing |
| --- | --- | --- |
| Social radar (§3–11) | One notification-style poll per account, per-account cadence and health | Independent monitors, reconciliation, per-source health |
| Memory write decision (§80) | A write policy | The classification taxonomy and noise control (§81) |
| Commitments (§33) | `COMMITMENT` memory type | Detection, follow-up dates, status |
| Timing (§84) | Cadence engine | Priority and context-sensitive delay |

## Missing entirely

Grouped by the specification's own rollout order (§112).

1. **Social radar reconciliation** (§3–11) — monitors, candidate merging, per-source health
2. **Multimodal context** (§12–21) — media inventory, images, OCR, video, GIF, quotes, links
3. **Relationship memory** (§23–26) — profiles, familiarity, callbacks
4. **Stance ledger** (§29–32) — positions, conflict, revision, predictions
5. **Intent and engagement** (§47–51) — intent taxonomy, reply value, intentional silence
6. **Voice fingerprint** (§36–39) — numeric dimensions with provenance
7. **Anti-repetition** (§57–59) — similarity against recent output
8. **Generic-AI detector** (§44–46) — phrase and structural patterns
9. **Voice compiler** (§40–43) — semantic draft to social output
10. **Social quality gate** (§63–67) — scored dimensions with policy
11. **Conversation arcs** (§60–62) — thread state, narrative memory
12. **World/entity graph** (§27–28)
13. **Content brain** (§71–76)
14. **Predictions and commitments** (§32–33)
15. **Evaluation dashboards** (§93)

## Decisions taken from this audit

**One event table.** Discovery evidence becomes a child table keyed on the
existing `events` row. No parallel event store.

**One memory system.** Relationships, stances and thread state are their own
tables because they are queried by identity rather than by relevance, but
anything retrieved *for a prompt* still flows through the memory retrieval path.

**One persona system.** The voice fingerprint is a derived artefact of a persona
version, not a second identity store.

**One pipeline.** New capabilities are node kinds in the existing graph.

**One model gateway.** New roles, not a second adapter layer.

**One prompt engine.** New layers, not a second assembler.
