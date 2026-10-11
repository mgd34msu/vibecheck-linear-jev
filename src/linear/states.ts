// Linear workflow states, the tool's own labels, and the comment formats.
//
// Maps a team's workflow onto the six task statuses the ledger reports
//, names the labels the tool creates, and renders
// and parses the comments it writes (section 8). Parsers find tool comments by
// their text, never by author, because every writer uses the same API key.
// All functions are pure.

import type { Issue, WorkflowState } from "./api.js";
import type { TaskState } from "../schemas.js";

// ---------------------------------------------------------------------------
// Workflow states
// ---------------------------------------------------------------------------

/** Workflow state names from `linear.states` config; null or absent = default. */
export interface StateOverrides {
  inProgress?: string | null | undefined;
  review?: string | null | undefined;
  done?: string | null | undefined;
  canceled?: string | null | undefined;
}

/** The workflow states the tool moves issues between. */
export interface ResolvedStates {
  inProgress: WorkflowState;
  /** The state for work awaiting integration; null when the team has none. */
  review: WorkflowState | null;
  done: WorkflowState;
  canceled: WorkflowState;
}

function byPosition(states: readonly WorkflowState[]): WorkflowState[] {
  return [...states].sort(
    (a, b) => a.position - b.position || a.id.localeCompare(b.id),
  );
}

function pickState(
  states: readonly WorkflowState[],
  type: WorkflowState["type"],
  override: string | null | undefined,
  setting: string,
): WorkflowState {
  const ofType = byPosition(states.filter((state) => state.type === type));
  if (override !== undefined && override !== null && override !== "") {
    const wanted = override.trim().toLowerCase();
    const named = ofType.find((state) => state.name.toLowerCase() === wanted);
    if (named === undefined) {
      const names = ofType.map((state) => state.name).join(", ") || "none";
      throw new Error(
        `linear.states.${setting} names "${override}", but the team has no ${type} state with that name (${type} states: ${names}).`,
      );
    }
    return named;
  }
  const first = ofType[0];
  if (first === undefined) {
    throw new Error(
      `The team's workflow has no ${type} state, so ${setting} cannot be resolved.`,
    );
  }
  return first;
}

/**
 * Picks the workflow states : the first state of
 * each type by position, or the one named in `overrides`. The review state is
 * the named override or the first started state, other than the in-progress
 * one, whose name contains "review"; null when there is none.
 * @throws Error when a required type has no state or an override names a
 *   state that does not exist.
 */
export function resolveStates(
  states: readonly WorkflowState[],
  overrides: StateOverrides = {},
): ResolvedStates {
  const inProgress = pickState(
    states,
    "started",
    overrides.inProgress,
    "inProgress",
  );
  const done = pickState(states, "completed", overrides.done, "done");
  const canceled = pickState(
    states,
    "canceled",
    overrides.canceled,
    "canceled",
  );
  let review: WorkflowState | null;
  if (
    overrides.review !== undefined &&
    overrides.review !== null &&
    overrides.review !== ""
  ) {
    review = pickState(states, "started", overrides.review, "review");
  } else {
    review =
      byPosition(states).find(
        (state) =>
          state.type === "started" &&
          state.id !== inProgress.id &&
          state.name.toLowerCase().includes("review"),
      ) ?? null;
  }
  return { inProgress, review, done, canceled };
}

/**
 * The tool's status for an issue. Terminal state types win; a started issue
 * is blocked with `vc:blocked`, awaiting integration when it sits in the
 * review state or carries `vc:awaiting-integration`, otherwise in progress.
 */
export function taskStatusOf(
  issue: Pick<Issue, "stateId" | "stateType">,
  labelNames: ReadonlySet<string>,
  resolved: Pick<ResolvedStates, "review">,
): TaskState {
  switch (issue.stateType) {
    case "canceled":
      return "cancelled";
    case "completed":
      return "complete";
    case "started":
      if (labelNames.has("vc:blocked")) return "blocked";
      if (
        (resolved.review !== null && issue.stateId === resolved.review.id) ||
        labelNames.has("vc:awaiting-integration")
      ) {
        return "awaiting_integration";
      }
      return "in_progress";
    case "triage":
    case "backlog":
    case "unstarted":
      return "pending";
  }
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Color of every agent label. */
export const AGENT_LABEL_COLOR = "#6e56cf";

/** One of the `vc:*` label names. */
export type VcLabelName =
  | "vc:claimed"
  | "vc:blocked"
  | "vc:held"
  | "vc:unverified"
  | "vc:verified"
  | "vc:stalled"
  | "vc:needs-user"
  | "vc:awaiting-integration";

/** The tool's own labels with their colors. */
export const VC_LABELS: readonly { name: VcLabelName; color: string }[] = [
  { name: "vc:claimed", color: "#5e6ad2" },
  { name: "vc:blocked", color: "#e5484d" },
  { name: "vc:held", color: "#f76b15" },
  { name: "vc:unverified", color: "#ffc53d" },
  { name: "vc:verified", color: "#30a46c" },
  { name: "vc:stalled", color: "#8e4ec6" },
  { name: "vc:needs-user", color: "#e93d82" },
  { name: "vc:awaiting-integration", color: "#0090ff" },
];

/**
 * Whether a label or group name is reserved for the tool: `vc:*` and
 * `agent:*`, in any case. Plans may neither declare nor apply them.
 */
export function isReservedLabel(name: string): boolean {
  return /^(?:vc|agent):/iu.test(name.trim());
}

/** The agent label for a vendor: `agent:` plus the lowercased name with every character outside a-z, 0-9 and `-` replaced by `-`. */
export function agentLabelName(vendor: string): string {
  return `agent:${vendor.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/** Who is writing a comment. */
export interface CommentAuthor {
  vendor: string;
  model: string;
  sessionId: string;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The footer line every tool comment ends with. */
export function renderFooter(author: CommentAuthor): string {
  return `— vibecheck · ${oneLine(author.vendor)} · ${oneLine(author.model)} · session ${oneLine(author.sessionId)}`;
}

const FOOTER_LINE = /^— vibecheck · .+ · .+ · session .+$/;

/**
 * The first line of every comment the tool writes: a claim
 * (`**Claimed** by …`), a report (`**Done**`, `**Progress**`, …) or a
 * verdict (`**vibecheck: <check> <outcome>**`).
 */
const TOOL_HEADER =
  /^(?:\*\*Claimed\*\* by .+|\*\*(?:Done|Progress|Blocked|Released|Handoff)\*\*|\*\*vibecheck: .+\*\*)$/u;

/**
 * True when the comment is the tool's: its first line is one of the tool's
 * headers and its last non-empty line is a tool footer. A person's reply
 * that ends with a pasted footer is not.
 */
export function isToolComment(body: string): boolean {
  const lines = body.trim().split(/\r?\n/);
  return (
    TOOL_HEADER.test((lines[0] ?? "").trim()) &&
    FOOTER_LINE.test((lines[lines.length - 1] ?? "").trim())
  );
}

const FOOTER_PARTS = /^— vibecheck · (.+) · (.+) · session (.+)$/;

/** The author a tool comment's footer names; null for any other comment. */
export function commentAuthor(body: string): CommentAuthor | null {
  const lines = body.trimEnd().split(/\r?\n/);
  const match = FOOTER_PARTS.exec((lines[lines.length - 1] ?? "").trim());
  if (match === null) return null;
  return {
    vendor: match[1] ?? "",
    model: match[2] ?? "",
    sessionId: match[3] ?? "",
  };
}

/**
 * Claim comment status: `open`, or the word it was closed with. Another
 * machine closing a claim names its own work (`released (replaced by work
 * <id>)`, `abandoned (closed by work <id>)`); older comments carry the bare
 * word.
 */
export type ClaimStatus =
  | "open"
  | "released"
  | "complete"
  | "cancelled"
  | "abandoned"
  | "released (lost claim race)"
  | `released (replaced by work ${string})`
  | `abandoned (closed by work ${string})`
  | `handed off to work ${string}`;

/** The claim line: `vibecheck claim · work <id> · <status>`, plus `· active <time>` while open. */
function claimLine(workId: string, status: string, activeAt?: string): string {
  return status === "open" && activeAt !== undefined
    ? `vibecheck claim · work ${workId} · open · active ${activeAt}`
    : `vibecheck claim · work ${workId} · ${status}`;
}

/**
 * Claim comment, `**Claimed** by <vendor> (<model>)` plus the claim line and
 * footer. An open claim may carry the time of its last tool activity.
 */
export function renderClaimComment(
  author: CommentAuthor,
  workId: string,
  status: ClaimStatus = "open",
  activeAt?: string,
): string {
  return [
    `**Claimed** by ${oneLine(author.vendor)} (${oneLine(author.model)})`,
    "",
    claimLine(workId, status, activeAt),
    "",
    renderFooter(author),
  ].join("\n");
}

const CLAIM_LINE = /^vibecheck claim · work (\S+) · (.+?)\s*$/m;
const ACTIVE_SUFFIX = /^(.*?) · active (\S+)$/u;
const CLAIM_HEADING = /^\*\*Claimed\*\* by .+$/u;

/**
 * Whether a comment has the claim comment's shape: its first line is
 * `**Claimed** by …` and its last non-empty line is a tool footer. Report,
 * verdict and other comments never do, so a claim line quoted in their text
 * is never read as a claim.
 */
function hasClaimShape(body: string): boolean {
  const first = body.replace(/\r\n?/gu, "\n").split("\n")[0] ?? "";
  return CLAIM_HEADING.test(first.trim()) && isToolComment(body);
}

/**
 * Reads the work ID and status from a claim comment, and the last activity
 * time an open claim records (`· open · active <time>`); null for anything
 * else, including any comment that is not in the claim comment format (first
 * line `**Claimed** by …`, the claim line, the tool footer last). Comments
 * without the activity part parse as before.
 */
export function parseClaimComment(
  body: string,
): { workId: string; status: string; activeAt?: string } | null {
  if (!hasClaimShape(body)) return null;
  const match = CLAIM_LINE.exec(body);
  if (match === null) return null;
  const workId = match[1] ?? "";
  const rest = match[2] ?? "";
  const active = ACTIVE_SUFFIX.exec(rest);
  if (active === null) return { workId, status: rest };
  return { workId, status: active[1] ?? "", activeAt: active[2] ?? "" };
}

/** True when the claim comment's status is `open`. */
export function isOpenClaim(body: string): boolean {
  return parseClaimComment(body)?.status === "open";
}

/** The claim comment body with its status word replaced; the body unchanged when it is not a claim comment. */
export function withClaimStatus(body: string, status: ClaimStatus): string {
  return body.replace(CLAIM_LINE, (_line, workId: string) =>
    claimLine(workId, status),
  );
}

/**
 * An open claim comment's body with its last activity set to `at`; the body
 * unchanged when it is not an open claim comment.
 */
export function withClaimActivity(body: string, at: string): string {
  if (!isOpenClaim(body)) return body;
  return body.replace(CLAIM_LINE, (_line, workId: string) =>
    claimLine(workId, "open", at),
  );
}

/** Kinds of report comment. */
export type ReportKind =
  "Progress" | "Blocked" | "Done" | "Released" | "Handoff";

const REPORT_HEADING = /^\*\*(Done|Progress|Blocked|Released|Handoff)\*\*\s*$/;

/** True for a report comment the tool wrote (`**Done**`, `**Progress**`, ...). */
export function isReportComment(body: string): boolean {
  return (
    isToolComment(body) && REPORT_HEADING.test(body.split(/\r?\n/)[0] ?? "")
  );
}

/**
 * A line of user text that a parser could take for a claim line or a tool
 * footer, after any backslashes that escape it.
 */
const TOOL_LINE = /^\\*(?:vibecheck claim · |— vibecheck · )/u;

/**
 * User text as a tool comment carries it: every line that reads like a claim
 * line or a tool footer is escaped with a leading `\` (Markdown shows the
 * line as written), so no line of a report, verdict reason or other text can
 * be read as a claim or a footer. `unescapeCommentText` undoes it.
 */
export function escapeCommentText(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => {
      const start = line.length - line.trimStart().length;
      return TOOL_LINE.test(line.trimStart())
        ? `${line.slice(0, start)}\\${line.slice(start)}`
        : line;
    })
    .join("\n");
}

/** The user text `escapeCommentText` escaped, as written. */
export function unescapeCommentText(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const start = line.length - line.trimStart().length;
      const rest = line.slice(start);
      return /^\\+(?:vibecheck claim · |— vibecheck · )/u.test(rest)
        ? `${line.slice(0, start)}${rest.slice(1)}`
        : line;
    })
    .join("\n");
}

/** Report comment: bold kind, the report text (escaped), footer. */
export function renderReportComment(
  author: CommentAuthor,
  kind: ReportKind,
  text: string,
): string {
  return [
    `**${kind}**`,
    "",
    escapeCommentText(text.trim()),
    "",
    renderFooter(author),
  ].join("\n");
}

/** Verdict comment: `**vibecheck: <check> <outcome>**`, the reason (escaped), footer. */
export function renderVerdictComment(
  author: CommentAuthor,
  check: string,
  outcome: string,
  reason: string,
): string {
  return [
    `**vibecheck: ${oneLine(check)} ${oneLine(outcome)}**`,
    "",
    escapeCommentText(reason.trim()),
    "",
    renderFooter(author),
  ].join("\n");
}
