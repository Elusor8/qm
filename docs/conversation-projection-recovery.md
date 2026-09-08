# Conversation projection capture recovery

Projection is downstream of the committed mailbox operation. Never repeat a send to repair a missing human-visible projection, and never advance progress over a missing turn.

The runtime records a capture intent before calling the remote tool, then retains its exact raw result in `agent_conversation_captures`. `conversation-capture` delivery jobs retry registration and projection enqueue after failure or restart. The original context, MCP server ID, runtime native-event ID and server mailbox/principal binding stay attached. Validation failures retain the result with a rejected state; recovery applies the same guards.

Use the existing authenticated org-admin API:

- `GET /v1/admin/conversation-captures` returns up to 32 pending capture summaries and 32 quarantine summaries, without message bodies.
- `GET /v1/admin/conversation-captures/:id` reads the retained context, binding, result and failure evidence. This is sensitive participant content and requires org-admin access.
- `POST /v1/admin/conversation-captures/:id/recover` requeues the retained authoritative result with a stable recovery key. It accepts no replacement text, binding, destination or progress. The worker still checks turn order and current destination authority. Repeating recovery does not duplicate a projection.

A missing turn whose raw capture was retained can be recovered by its capture ID, including after its original job was lost or quarantined. Later turns remain held until the missing turn projects. Malformed projection jobs move once to `conversation-projection-quarantine`; their original text and error remain in the durable delivery row. An acknowledgement failure retries the same quarantine key, preserving evidence without creating another copy. Quarantined source rows are acknowledged, not deleted.

Initial progress is provisional while calls already in flight at the first observation remain unresolved. Those calls may lower the initial baseline before any projection. Later historical observations cannot lower it. Existing progress rows retain their established baseline. Tracking is per mailbox and principal; independent participants do not share state. At most 64 unresolved captures may be registered for one mailbox/principal; new calls are refused before remote execution when this bound is reached.

There is no distributed transaction with mailboxd. If the process dies after remote commit but before raw-result persistence, the intent remains `awaiting-result`; a reported remote error remains `uncertain`. A database outage while saving the raw result has the same uncertainty window. An unresolved initial call holds initialization for the affected mailbox's initial capture cohort; do not clear it by advancing progress. The current daemon's read-only reconcile returns event IDs and a snapshot, not the missing signed body, so those facts alone cannot repair that capture. Recovery refuses records without retained authoritative results. Preserve the intent and obtain authoritative ledger evidence through a separately authorized operator recovery; do not fabricate protocol content or resubmit a mutation. This limitation is not claimed solved by the journal.

The new tables are additive durable maps, created through the existing artifact-map initialization. Captures and quarantine evidence are retained; no automatic deletion policy is introduced. Inspect storage growth during rollout. These procedures do not address Slack delivery verification-budget/give-up recovery or change search lookup limits.
