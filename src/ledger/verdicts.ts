// One verdict rule on every machine: a task's
// verdict is the latest verdict recorded for its latest completion, whichever
// machine recorded it.
//
// Linear carries the shared evidence: the tool's verdict labels (`vc:verified`,
// `vc:unverified`, `vc:held`), which the tool clears when an issue leaves a
// completed state or a new claim starts on it, and its verdict comments with
// their createdAt (the re-check reads those). This machine's own done entries
// count only while they belong to the current completion. Local entries and
// Linear's timestamps come from different clocks, so "belongs" is decided by
// order on this machine: a verdict floor per issue (a verification seq) is
// set whenever this machine sees the completion change under it (the issue
// leaves a completed state, reaches one by someone else's move, or a new
// claim starts here) or sees a verdict label the local entries do not
// explain (another machine judged since). Entries at or below the floor are
// history; above it they are the latest verdict this machine knows.

import { randomUUID } from "node:crypto";
import type { LocalStore, ProjectKey } from "../local/types.js";
import { latestDoneOutcome } from "../verification/ledger.js";
import { queryEntries } from "../verification/store.js";

/** Why a floor was set, for the event body. */
export type FloorReason =
  "left_completed" | "completed_elsewhere" | "claimed" | "label_verdict";

/** Moves an issue's verdict floor to the newest local verification entry. */
export function setVerdictFloor(
  store: LocalStore,
  projectKey: ProjectKey,
  issueId: string,
  identifier: string,
  reason: FloorReason,
): void {
  const seq =
    queryEntries(store.verificationAccess(), {
      projectId: projectKey,
      newest: true,
      limit: 1,
    })[0]?.seq ?? 0;
  for (const event of store.events(projectKey, { kinds: ["verdict_floor"] }))
    if (event.issueId === issueId) store.clearEvent(event.id);
  store.addEvent({
    projectKey,
    kind: "verdict_floor",
    issueId,
    identifier,
    workId: null,
    dedupe: `verdict_floor:${issueId}:${randomUUID()}`,
    body: { seq, reason },
  });
}

/** Each issue's verdict floor (a verification seq), by issue id. */
export function verdictFloors(
  store: LocalStore,
  projectKey: ProjectKey,
): Map<string, number> {
  const floors = new Map<string, number>();
  for (const event of store.events(projectKey, { kinds: ["verdict_floor"] })) {
    const seq = event.body["seq"];
    if (typeof seq === "number") floors.set(event.issueId, seq);
  }
  return floors;
}

/** The latest local done outcome above the issue's verdict floor. */
export function currentDoneOutcome(
  store: LocalStore,
  projectKey: ProjectKey,
  issueId: string,
  taskIds: readonly string[],
): "verified" | "held" | "unverified" | undefined {
  return latestDoneOutcome(
    store.verificationAccess(),
    projectKey,
    taskIds,
    verdictFloors(store, projectKey).get(issueId),
  );
}
