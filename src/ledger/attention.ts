// Attention a tool result carries.
//
// What the reconciler or the outbox drain found about an issue is recorded
// as an event and shown in project_status until something answers it. A
// work_claim or work_update result lists the events of the issues it touched
// that are pending when it returns, including those found during the call
// (a reply the reconciler read, a queued move the drain skipped, a claim
// another machine closed). An event is cleared only after a result returned
// it, so the agent always sees what it answers: a reply once a report on the
// work answered it, a skipped move once a change landed on the issue (or it
// was claimed), and a lost claim, removal, reopening or held completion
// moved to done once a result showed it.

import type {
  EventKind,
  EventRow,
  LocalStore,
  ProjectKey,
} from "../local/types.js";

/** Event kinds a work_claim or work_update result reports for its issues. */
export const CALL_ATTENTION_KINDS: readonly EventKind[] = [
  "human_reply",
  "skipped_move",
  "claim_lost",
  "removed",
  "reopened",
  "held_done_moved",
];

/** One event as a tool result shows it. */
export interface EventAttention {
  readonly kind: EventKind;
  readonly reason: string;
  readonly entry_id: string;
  readonly at: string;
  readonly task_id: string;
  readonly identifier: string;
  readonly work_id?: string;
}

/** The event as an attention item; `key` is the task's plan key or identifier. */
export function eventAttention(event: EventRow, key: string): EventAttention {
  const reason = event.body["reason"];
  return {
    kind: event.kind,
    reason: typeof reason === "string" ? reason : event.kind,
    entry_id: `event:${event.id}`,
    at: event.createdAt,
    task_id: key,
    identifier: event.identifier,
    ...(event.workId === null ? {} : { work_id: event.workId }),
  };
}

/**
 * The pending events of `issueIds`, oldest first, with their attention
 * items. The caller clears the ones its result answers, and only those.
 */
export function pendingAttention(
  store: LocalStore,
  projectKey: ProjectKey,
  issueIds: ReadonlySet<string>,
  keyOf: (event: EventRow) => string,
): { readonly events: EventRow[]; readonly items: EventAttention[] } {
  const events = store
    .events(projectKey, { kinds: CALL_ATTENTION_KINDS })
    .filter((event) => issueIds.has(event.issueId));
  return {
    events,
    items: events.map((event) => eventAttention(event, keyOf(event))),
  };
}
