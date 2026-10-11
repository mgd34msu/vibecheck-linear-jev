// Ledger state rendered as the text a check reads: the plan, one task with
// its goal and acceptance criteria, accepted exceptions, rules,
// authorizations and accepted reasons for stopping. Tasks come from Linear
// issues (src/ledger/snapshot.ts); their standard is parsed from the issue
// description, so human edits in Linear are what the checks read.

import type { ProjectPolicy, TaskDetails } from "../schemas.js";

/** The parts of a task the checks name: its key, title and reported status. */
export interface StandardTask {
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly details?: TaskDetails | undefined;
  /** The issue description, read when it has no recognised sections. */
  readonly description?: string | undefined;
}

/** What a work record contributes to a check's text. */
export interface StandardWork {
  readonly status: string;
  readonly blocker: string | null;
  readonly location: { readonly paths: readonly string[] };
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

const DESCRIPTION_LIMIT = 4000;

export function taskText(task: StandardTask, details?: TaskDetails): string {
  const standard = details ?? task.details;
  const lines = [`Task ${task.key}: ${task.title}`];
  if (standard?.goal !== undefined) lines.push(`Goal: ${standard.goal}`);
  if (standard?.criteria !== undefined && standard.criteria.length > 0)
    lines.push(`Acceptance criteria:\n${bullets(standard.criteria)}`);
  if (standard?.rules !== undefined && standard.rules.length > 0)
    lines.push(`Task rules:\n${bullets(standard.rules)}`);
  if (
    standard?.goal === undefined &&
    (standard?.criteria ?? []).length === 0 &&
    task.description !== undefined &&
    task.description.trim() !== ""
  )
    lines.push(
      `Description (no recognised sections):\n${task.description.trim().slice(0, DESCRIPTION_LIMIT)}`,
    );
  return lines.join("\n");
}

/** One line per task that is not cancelled: key, status, title, goal and criteria. */
export function taskLines(tasks: Iterable<StandardTask>): string[] {
  return [...tasks]
    .filter((task) => task.status !== "cancelled")
    .map((task) => {
      const criteria =
        task.details?.criteria === undefined ||
        task.details.criteria.length === 0
          ? ""
          : ` (criteria: ${task.details.criteria.join("; ")})`;
      const goal =
        task.details?.goal === undefined ? "" : ` Goal: ${task.details.goal}`;
      return `- ${task.key} [${task.status}]: ${task.title}.${goal}${criteria}`;
    });
}

export function planText(
  tasks: Iterable<StandardTask>,
  policy: ProjectPolicy | undefined,
): string {
  const lines: string[] = [];
  if (policy?.goal !== undefined) lines.push(`Plan goal: ${policy.goal}`);
  lines.push("Tasks:", ...taskLines(tasks));
  return lines.join("\n");
}

export function exceptionsText(
  details: Iterable<TaskDetails | undefined>,
): string | undefined {
  const lines: string[] = [];
  for (const entry of details)
    for (const exception of entry?.exceptions ?? [])
      lines.push(
        `${exception.description}${exception.paths === undefined ? "" : ` (paths: ${exception.paths.join(", ")})`}`,
      );
  return lines.length === 0 ? undefined : bullets(lines);
}

export function rulesText(
  policy: ProjectPolicy | undefined,
  details: Iterable<TaskDetails | undefined>,
): string | undefined {
  const rules = [...(policy?.rules ?? [])];
  for (const entry of details) rules.push(...(entry?.rules ?? []));
  return rules.length === 0 ? undefined : bullets([...new Set(rules)]);
}

export function authorizationsText(
  policy: ProjectPolicy | undefined,
): string | undefined {
  const items = policy?.authorizations ?? [];
  return items.length === 0
    ? undefined
    : `Authorizations recorded for this project:\n${bullets(items)}`;
}

export function allowedReasonsText(
  policy: ProjectPolicy | undefined,
  details: Iterable<TaskDetails | undefined>,
): string | undefined {
  const reasons = [...(policy?.stop_reasons ?? [])];
  for (const entry of details)
    for (const exception of entry?.exceptions ?? [])
      reasons.push(`accepted exception: ${exception.description}`);
  return reasons.length === 0
    ? undefined
    : `Accepted reasons for leaving work:\n${bullets(reasons)}`;
}

export function workText(
  task: StandardTask,
  details: TaskDetails | undefined,
  work: StandardWork,
): string {
  return [
    taskText(task, details),
    `Status: ${work.status}.`,
    work.blocker === null ? "No blocker." : `Blocker: ${work.blocker}.`,
    work.location.paths.length === 0
      ? ""
      : `Paths: ${work.location.paths.join(", ")}.`,
  ]
    .filter((line) => line.length > 0)
    .join(" ");
}

/** An open claim as the brief check names it: whose it is and what it touches. */
export interface StandardClaim {
  readonly issueId: string;
  readonly status: string;
  /** Who holds it, e.g. `agent:codex (session s_1)`. */
  readonly owner: string;
  readonly paths: readonly string[];
}

/** A task as the brief check lists it among other work. */
export interface OtherTask extends StandardTask {
  readonly issueId: string;
  readonly identifier: string;
  /** Label names from the cached issue; `vc:claimed` marks a claim made anywhere. */
  readonly labels?: readonly string[] | undefined;
}

/** The label the ledger puts on an issue while any session, on any machine, holds a claim on it. */
const CLAIMED_LABEL = "vc:claimed";

/** Named when the cached issue carries vc:claimed and no claim on this machine names the holder. */
const ELSEWHERE_TEXT =
  "Claimed elsewhere: the issue carries vc:claimed in Linear and no claim on this machine names the holder";

/** Named when the issue is started in Linear and no claim on this machine holds it. */
const STARTED_TEXT =
  "Started in Linear with no claim on this machine: a session on another machine or a person holds it";

/** Task states that mean someone has started the issue. */
const STARTED = new Set(["in_progress", "blocked", "awaiting_integration"]);

/** Which tasks count as held by others. */
export interface HeldOptions {
  /**
   * Also count a task started in Linear that no claim here holds (another
   * machine's claim starts the issue), as `next` does.
   */
  readonly started?: boolean;
}

/**
 * The tasks other sessions hold, by issue id, with the text naming the
 * holder: an open claim another session on this machine holds (agent and
 * session), `vc:claimed` on the cached issue (a session on another machine),
 * or with `started` an issue started in Linear. Tasks in `own` are never
 * held by others. Read from the local cache only.
 */
export function holdersOf(
  tasks: Iterable<OtherTask>,
  claims: readonly StandardClaim[],
  own: ReadonlySet<string>,
  options: HeldOptions = {},
): Map<string, string> {
  const holders = new Map(
    claims.map((claim) => [claim.issueId, claimText(claim)]),
  );
  for (const task of tasks) {
    if (holders.has(task.issueId)) continue;
    if (task.labels?.includes(CLAIMED_LABEL) === true)
      holders.set(task.issueId, ELSEWHERE_TEXT);
    else if (options.started === true && STARTED.has(task.status))
      holders.set(task.issueId, STARTED_TEXT);
  }
  for (const id of own) holders.delete(id);
  return holders;
}

/** Tasks listed in other work at most; the rest are counted. */
const OTHER_TASK_LIMIT = 60;

function claimText(claim: StandardClaim): string {
  return `Claimed by ${claim.owner}${claim.paths.length === 0 ? "" : `; paths ${claim.paths.join(", ")}`}`;
}

/**
 * What a brief's own task does not include, for brief-scope: the plan's other
 * tasks with who holds each (`own` is the brief's tasks, by issue id), and
 * what the brief's tasks record as out of scope. A task is held when another
 * session on this machine has an open claim on it (named with its agent and
 * session) or its cached issue carries `vc:claimed` (a session elsewhere),
 * and with `started` when the issue is started in Linear (holdersOf).
 * With no tasks of its own, or with `heldOnly`, only held tasks are listed;
 * otherwise held tasks come first, then the unclaimed ones. Cancelled and
 * completed tasks are left out. Undefined when there is nothing to list.
 */
export function otherWorkText(
  tasks: Iterable<OtherTask>,
  claims: readonly StandardClaim[],
  own: ReadonlySet<string>,
  outOfScope: readonly string[] = [],
  options: HeldOptions & { readonly heldOnly?: boolean } = {},
): string | undefined {
  const all = [...tasks];
  const held = holdersOf(all, claims, own, options);
  const open = all.filter(
    (task) =>
      !own.has(task.issueId) &&
      task.status !== "cancelled" &&
      task.status !== "complete",
  );
  const heldOnly = own.size === 0 || options.heldOnly === true;
  const listed = heldOnly
    ? open.filter((task) => held.has(task.issueId))
    : open;
  const ordered = [
    ...listed.filter((task) => held.has(task.issueId)),
    ...listed.filter((task) => !held.has(task.issueId)),
  ];
  const parts: string[] = [];
  if (ordered.length > 0) {
    const lines = ordered.slice(0, OTHER_TASK_LIMIT).map((task) => {
      const name =
        task.key === task.identifier
          ? task.key
          : `${task.key} (${task.identifier})`;
      return `${name} [${task.status}]: ${task.title}. ${held.get(task.issueId) ?? "Unclaimed"}`;
    });
    if (ordered.length > OTHER_TASK_LIMIT)
      lines.push(`and ${ordered.length - OTHER_TASK_LIMIT} more`);
    parts.push(
      `${own.size === 0 ? "Tasks other sessions have claimed (not this brief's to do)" : heldOnly ? "Tasks other sessions or machines hold (not this brief's to do)" : "Other tasks in the plan and who holds them (not this brief's task)"}:\n${bullets(lines)}`,
    );
  }
  if (outOfScope.length > 0)
    parts.push(
      `Recorded as out of scope for this brief's task:\n${bullets([...new Set(outOfScope)])}`,
    );
  return parts.length === 0 ? undefined : parts.join("\n");
}

/** Open claims as the brief check names them, each with the agent label and session that hold it. */
export function standardClaims(
  work: Iterable<{
    readonly issueId: string;
    readonly sessionId: string;
    readonly status: string;
    readonly location: { readonly paths: readonly string[] };
  }>,
  sessions: Iterable<{ readonly id: string; readonly agentLabel: string }>,
): StandardClaim[] {
  const labels = new Map(
    [...sessions].map((session) => [session.id, session.agentLabel]),
  );
  return [...work].map((entry) => {
    const label = labels.get(entry.sessionId);
    return {
      issueId: entry.issueId,
      status: entry.status,
      owner:
        label === undefined
          ? `session ${entry.sessionId}`
          : `${label} (session ${entry.sessionId})`,
      paths: entry.location.paths,
    };
  });
}
