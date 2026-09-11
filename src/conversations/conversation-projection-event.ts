export interface ConversationProjectionEvent {
  event_id: string;
  projection_revision: number;
  source: "zipviz-signed-v3";
  authoritative: true;
  mailbox: string;
  conversation_id: string;
  turn: number;
  side: "us" | "them";
  from: string;
  to: string;
  msg_id: string;
  body: string;
  body_trust: "own" | "counterparty-untrusted";
  ledger_status: string;
  signed: {
    envelope_v: 3;
    signature: string;
    timestamp: string;
    expires_at: string;
    reply_to: string | null;
    intent: string;
    state: string;
    goal_ref: string;
    authority_claim: string | null;
    acting_for_claim: string | null;
    reply_by: string | null;
    wake: unknown | null;
    outcome_code: string | null;
    human_summary: string | null;
  };
  receipt: {
    present: boolean;
    status: string | null;
    received_at: string | null;
    signed_receipt: Record<string, unknown> | null;
  };
  timing: Record<string, string | null>;
  correlation: {
    adapter_kind: string;
    adapter_instance: string;
    external_scope: string;
    external_conversation_ref: string;
    external_event_id: string | null;
    disposition: string | null;
  };
}
