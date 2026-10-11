// check brief   STANDARD-FILE BRIEF-FILE      brief-scope
// check message STANDARD-FILE MESSAGE-FILE    deferral
// check report  TASK-FILE REPORT-FILE         claims-done on the whole report, stop-reason on each passage
// check diff    [DIFF-FILE]                   fallback-added on every changed hunk (stdin when omitted)
//
// With --project ID --task TASK-ID the standard or task comes from the
// ledger instead of a file, together with the task's accepted exceptions,
// the project's accepted reasons for stopping and, for a brief, the plan's
// other tasks with who holds each; the one file argument is then
// the brief, message or report. "-" reads stdin. Exit 0 clean, 2 flagged,
// 1 when no source could read it (the check does not pass).

import { readFileSync } from "node:fs";
import { OPEN_WORK, projectKeyOf } from "../../ledger/access.js";
import { findTask, localSnapshot } from "../../ledger/snapshot.js";
import {
  briefScopeBattery,
  claimsDoneBattery,
  deferralBattery,
  fallbackAddedBattery,
  splitHunk,
  stopReasonBattery,
} from "../batteries.js";
import { runCheck } from "../judgment.js";
import { settleMany } from "../lib/index.js";
import {
  allowedReasonsText,
  exceptionsText,
  otherWorkText,
  planText,
  standardClaims,
  taskText,
} from "../standard.js";
import {
  fixed,
  judgmentOf,
  parse,
  projectOf,
  UsageError,
  withStore,
  type ToolIO,
} from "./common.js";

function read(path: string | undefined): string {
  return readFileSync(path === undefined || path === "-" ? 0 : path, "utf8");
}

/** Hunks of a unified diff that add lines; text without hunk headers is one change. */
export function addedHunks(text: string): string[] {
  if (!text.includes("\n@@") && !text.startsWith("@@")) return [text];
  return text
    .split(/\n(?=@@)/u)
    .filter((hunk) => hunk.startsWith("@@") && /\n\+(?!\+\+)/u.test(hunk));
}

/**
 * A report cut into passages for stop-reason. Markdown headings and bold
 * lead lines set the section each passage sits under; bullets under the same
 * section are read together with the line that introduces them.
 */
export function reportPassages(
  report: string,
): { passage: string; section?: string }[] {
  let top: string | undefined;
  let section: string | undefined;
  const units: { passage: string; section?: string }[] = [];
  for (const raw of report
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)) {
    const heading =
      /^#{1,6}\s+(.*)$/u.exec(raw)?.[1] ?? /^\*\*([^*]+)\*\*/u.exec(raw)?.[1];
    const sub = /^[-*]\s+\*\*([^*]+)\*\*:?\s*$/u.exec(raw)?.[1];
    if (heading !== undefined) {
      top = heading;
      section = heading;
    } else if (sub !== undefined)
      section = top === undefined ? sub : `${top} / ${sub}`;
    const bullet = /^[-*]\s+/u.test(raw);
    const last = units.at(-1);
    if (bullet && last !== undefined && last.section === section)
      last.passage = `${last.passage}\n${raw}`;
    else
      units.push({
        passage: raw,
        ...(section === undefined ? {} : { section }),
      });
  }
  return units;
}

async function ledgerStandard(
  io: ToolIO,
  project: string,
  task: string | undefined,
) {
  const projectId = projectOf(project);
  if (projectId === undefined) throw new UsageError("--project is required");
  return withStore(io, (store) => {
    const row = store.project(projectKeyOf(projectId));
    if (row === undefined)
      throw new UsageError(`no project ${projectId} on this machine`);
    const snapshot = localSnapshot(store, row);
    const claims = standardClaims(
      snapshot.openWork.filter((work) => OPEN_WORK.has(work.status)),
      store.sessions(row.key),
    );
    if (task === undefined)
      return {
        standard: planText(snapshot.tasks, snapshot.policy),
        otherWork: otherWorkText(snapshot.tasks, claims, new Set()),
        policy: snapshot.policy,
        record: undefined,
      };
    const record = findTask(snapshot, task);
    if (record === undefined)
      throw new UsageError(`no task ${task} in project ${projectId}`);
    return {
      standard: taskText(record),
      otherWork: otherWorkText(
        snapshot.tasks,
        claims.filter((claim) => claim.issueId !== record.issueId),
        new Set([record.issueId]),
        record.sections.out_of_scope ?? [],
      ),
      policy: snapshot.policy,
      record,
    };
  });
}

export async function checkCommand(
  args: string[],
  io: ToolIO,
): Promise<number> {
  const [verb, ...rest] = args;
  const { values, positionals } = parse(rest, {
    project: { type: "string" },
    task: { type: "string" },
    source: { type: "string" },
  });
  const judgment = judgmentOf(
    io,
    values.source === undefined ? {} : { onlySource: values.source },
  );
  const fromLedger =
    values.project === undefined
      ? undefined
      : await ledgerStandard(io, values.project, values.task);
  const [first, second] = positionals;
  const standardText = () => fromLedger?.standard ?? read(first);
  const subjectText = () =>
    fromLedger === undefined ? read(second) : read(first);
  const taskDetails = [fromLedger?.record?.details];
  let flagged = false;
  let unread = false;

  if (verb === "brief") {
    const exceptions = exceptionsText(taskDetails);
    const otherWork = fromLedger?.otherWork;
    const input = {
      standard: standardText(),
      ...(otherWork === undefined ? {} : { otherWork }),
      ...(exceptions === undefined ? {} : { exceptions }),
      brief: subjectText(),
    };
    const result = await runCheck(judgment, briefScopeBattery, input);
    if (result.kind !== "verdict")
      return report(
        io,
        result.kind === "unavailable" ? result.error : "check is turned off",
      );
    flagged = result.run.decision.block;
    io.out(
      `brief-scope narrows=${fixed(result.run.decision.narrows)} defers=${fixed(result.run.decision.defers)}${flagged ? "  FLAGGED" : ""}`,
    );
  } else if (verb === "message") {
    const result = await runCheck(judgment, deferralBattery, {
      standard: standardText(),
      message: subjectText(),
    });
    if (result.kind !== "verdict")
      return report(
        io,
        result.kind === "unavailable" ? result.error : "check is turned off",
      );
    flagged = result.run.decision.block;
    io.out(
      `deferral defers=${fixed(result.run.decision.defers)}${flagged ? "  FLAGGED" : ""}`,
    );
  } else if (verb === "report") {
    const task = standardText();
    const text = subjectText();
    const exceptions = exceptionsText(taskDetails);
    const claims = await runCheck(judgment, claimsDoneBattery, {
      task,
      ...(exceptions === undefined ? {} : { exceptions }),
      report: text,
    });
    if (claims.kind === "verdict") {
      flagged = claims.run.decision.block;
      io.out(
        `claims-done overclaims=${fixed(claims.run.decision.overclaims)}${flagged ? "  FLAGGED" : ""}`,
      );
    } else if (claims.kind === "unavailable") {
      unread = true;
      io.out(`UNREAD claims-done: ${claims.error}`);
    }
    const allowed = allowedReasonsText(fromLedger?.policy, taskDetails);
    const passages = reportPassages(text);
    const runs = await settleMany(
      passages,
      (unit) =>
        runCheck(judgment, stopReasonBattery, {
          ...unit,
          ...(allowed === undefined ? {} : { allowed }),
        }),
      16,
    );
    runs.forEach((settled, index) => {
      const passage = passages[index]?.passage ?? "";
      if (!settled.ok || settled.value.kind === "unavailable") {
        unread = true;
        io.out(
          `UNREAD ${passage}: ${settled.ok && settled.value.kind === "unavailable" ? settled.value.error : String(settled.ok ? "" : settled.error)}`,
        );
        return;
      }
      if (settled.value.kind !== "verdict") return;
      const decision = settled.value.run.decision;
      if (decision.block) {
        flagged = true;
        io.out(`EXCUSE ${fixed(decision.confidence)}: ${passage}`);
      } else if (decision.review) {
        flagged = true;
        io.out(
          `REVIEW ${decision.kind} ${fixed(decision.confidence)}: ${passage}`,
        );
      }
    });
    io.out(`stop-reason: ${passages.length} passages read`);
  } else if (verb === "diff") {
    const hunks = addedHunks(read(first)).filter(
      (hunk) => splitHunk(hunk).added.trim().length > 0,
    );
    const runs = await settleMany(
      hunks,
      (hunk) => runCheck(judgment, fallbackAddedBattery, splitHunk(hunk)),
      16,
    );
    runs.forEach((settled, index) => {
      if (!settled.ok || settled.value.kind === "unavailable") {
        unread = true;
        io.out(`UNREAD hunk ${index}`);
        return;
      }
      if (
        settled.value.kind === "verdict" &&
        settled.value.run.decision.block
      ) {
        flagged = true;
        io.out(
          `WEAKENS ${fixed(settled.value.run.decision.weakens)}:\n${hunks[index] ?? ""}\n`,
        );
      }
    });
    io.out(`fallback-added: ${hunks.length} hunks read`);
  } else throw new UsageError("usage: check brief|message|report|diff ...");
  if (unread) return 1;
  return flagged ? 2 : 0;
}

function report(io: ToolIO, error: string): number {
  io.err(`judgment unavailable: ${error}`);
  return 1;
}
