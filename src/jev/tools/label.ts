// label list [--project ID] [--flagged] [--unlabeled] [COUNT]
// label mark ENTRY-ID-PREFIX right|wrong [NOTE...]
// label mark-where CHECK-ID TEXT right|wrong [NOTE...]   every verdict of that check whose input contains TEXT
// label mark-last CHECK-ID SOURCE right|wrong [NOTE...]  the newest verdict of that check from that source
//
// A label records whether a verdict was right. It is a history entry on the
// same task, claim or session as the verdict; a later label corrects an
// earlier one.

import {
  appendEntry,
  labelsByVerdict,
  queryEntries,
  type Entry,
  type VerdictEntry,
} from "../../verification/store.js";
import {
  parse,
  projectOf,
  UsageError,
  withStore,
  type ToolIO,
} from "./common.js";

function verdictOf(entry: Entry): entry is VerdictEntry {
  return entry.kind === "verdict";
}

function excerpt(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 220 ? `${text.slice(0, 220)}...` : text;
}

export async function labelCommand(
  args: string[],
  io: ToolIO,
): Promise<number> {
  const [verb, ...rest] = args;
  if (verb === "list") {
    const { values, positionals } = parse(rest, {
      project: { type: "string" },
      flagged: { type: "boolean" },
      unlabeled: { type: "boolean" },
    });
    const projectId = projectOf(values.project);
    const count = Number(positionals[0] ?? 30);
    const entries = await withStore(io, (store) =>
      queryEntries(store.verificationAccess(), {
        ...(projectId === undefined ? {} : { projectId }),
        kinds: ["verdict", "label"],
        limit: 1_000_000,
      }),
    );
    const labels = labelsByVerdict(entries);
    const verdicts = entries
      .filter(verdictOf)
      .filter(
        (entry) => values.flagged !== true || entry.body.outcome !== "passed",
      )
      .filter((entry) => values.unlabeled !== true || !labels.has(entry.id))
      .slice(-count);
    for (const entry of verdicts) {
      const label = labels.get(entry.id);
      io.out(
        `${entry.id.slice(0, 14)} ${entry.created_at.slice(5, 19)} ${entry.body.source.padEnd(20)} ${entry.body.battery_id.padEnd(30)} ${entry.body.outcome.padEnd(7)} ${label === undefined ? "?" : label.right ? "right" : "WRONG"}\n    ${entry.body.reason}\n    ${excerpt(entry.body.input)}`,
      );
    }
    return 0;
  }
  if (verb !== "mark" && verb !== "mark-where" && verb !== "mark-last")
    throw new UsageError("usage: label list|mark|mark-where|mark-last ...");
  const [first, second, third, ...more] = rest;
  const verdictText = verb === "mark" ? second : third;
  const note = (verb === "mark" ? [third, ...more] : more)
    .filter((part): part is string => part !== undefined)
    .join(" ");
  if (
    first === undefined ||
    (verb !== "mark" && second === undefined) ||
    (verdictText !== "right" && verdictText !== "wrong")
  )
    throw new UsageError(
      verb === "mark"
        ? "usage: label mark ENTRY-ID-PREFIX right|wrong [NOTE]"
        : `usage: label ${verb} CHECK-ID ${verb === "mark-where" ? "TEXT" : "SOURCE"} right|wrong [NOTE]`,
    );
  const right = verdictText === "right";
  const marked = await withStore(io, (store) =>
    store.transaction(() => {
      const access = store.verificationAccess();
      let matches: VerdictEntry[];
      if (verb === "mark")
        matches = queryEntries(access, {
          kinds: ["verdict"],
          idPrefix: first,
          limit: 2,
        }).filter(verdictOf);
      else if (verb === "mark-where")
        matches = queryEntries(access, {
          kinds: ["verdict"],
          batteryId: first,
          limit: 1_000_000,
        })
          .filter(verdictOf)
          .filter(
            (entry) =>
              second !== undefined &&
              JSON.stringify(entry.body.input).includes(second),
          );
      else
        matches = queryEntries(access, {
          kinds: ["verdict"],
          batteryId: first,
          newest: true,
          limit: 1_000_000,
        })
          .filter(verdictOf)
          .filter((entry) => entry.body.source === second)
          .slice(0, 1);
      if (matches.length === 0 || (verb === "mark" && matches.length !== 1))
        throw new UsageError(`${matches.length} verdicts match ${first}`);
      for (const entry of matches)
        appendEntry(
          access,
          {
            projectId: entry.project_id,
            taskId: entry.task_id,
            workId: entry.work_id,
            sessionId: entry.session_id,
          },
          { kind: "label", body: { verdict_id: entry.id, right, note } },
        );
      return matches;
    }),
  );
  for (const entry of marked)
    io.out(
      `${entry.body.battery_id} ${entry.id.slice(0, 14)} ${entry.body.outcome} labeled ${verdictText}`,
    );
  return 0;
}
