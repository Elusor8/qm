# Conversation projection retention

QM keeps authoritative conversation history in the ZipViz ledger. Its local projection stores are processing state, not a second transcript.

Full event payloads in the projection outbox are retained for 14 days, matching QM's existing idempotency retention window. Cleanup runs hourly while the projection reconciler is active. Expired outbox rows become content-free evidence containing the event identity and revision; they remain unacknowledged and continue to hold ordered delivery. The latest 100 expired rows per reader audience are retained. Rejected-delivery records retain their provenance but lose message text and attachments after 14 days, and only the latest 100 rejection rows are retained at any age.

Pending open and adopt bindings older than 14 days are removed. A retained unbound outbox row remains the durable evidence and ordering hold for the unresolved event.

Gap evidence is limited to the latest 100 markers per reader audience. A marker is released only by authoritative replay of the same message or an audited administrator decision through `POST /v1/admin/conversation-projections/release` with the full audience key, message id, and reason.

Legacy capture rows are migrated into pending bindings when they contain a usable open or adopt context, then the capture, capture-mailbox, progress, and legacy queue rows are cleared transactionally and their durable-map versions advance. Repeating the cutover is safe. Conversation links remain untouched and authoritative turns and receipts remain in the ledger.

The product retention period for unresolved content-free gap and expiry evidence has not been decided. The current count bound prevents unbounded growth, but an operator-approved time limit or permanent audit-retention rule is still required.
