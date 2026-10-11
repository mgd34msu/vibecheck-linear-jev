// Report text sent with work updates, kept as history so later checks (a
// stalled claim, a contradiction, a receipt) can read what each agent said.

import type { WorkRow } from "../local/types.js";
import type { WorkChange } from "../schemas.js";
import type { SqlAccess } from "../sqlite.js";
import { appendEntry } from "./store.js";

/** Records one change's report, if it carries one, against the work as it stands after the change. */
export function recordReport(
  access: SqlAccess,
  taskKey: string,
  work: WorkRow,
  change: WorkChange,
  sessionId: string,
): void {
  const report = change.report;
  if (report === undefined) return;
  appendEntry(
    access,
    {
      projectId: work.projectKey,
      taskId: taskKey,
      workId: work.id,
      sessionId,
    },
    {
      kind: "report",
      body: {
        action: change.action ?? "progress",
        status: work.status,
        report,
        ...(work.blocker === null ? {} : { blocker: work.blocker }),
      },
    },
  );
}
