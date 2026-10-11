// Draining queued Linear writes.
//
// Hooks never call Linear; tools that could not reach it queue the rest of
// their writes. The outbox drains at the start of every tool call and in
// `sync`, oldest first. Each queued create carries its client id, so a resend
// after a crash cannot duplicate it: Linear answers a resent create with
// "Entity ... with id ... already exists.", which counts as sent. Draining
// stops at the first rate-limit, network or server failure, and at a key
// Linear refuses outright (HTTP 401 / AUTHENTICATION_ERROR); none of these
// count toward the cap. Rows of one issue are sent in order: a row Linear
// rejects (invalid, not found, or an entity-level 403 / FORBIDDEN) holds
// back only the later rows of its issue,
// and the drain goes on with other issues. Every rejection counts toward
// MAX_ATTEMPTS; a row at the cap is set aside (never sent) with attention
// `write_dropped` naming the issue, the kind of write and the last error.
//
// Label rows carry the label's name (hooks cannot look ids up): the drain
// resolves it against the team's labels and creates a missing `vc:*` or
// `agent:*` label; any other missing label is dropped. A queued state move
// carries the state the tool expected the issue to be in; when the issue is
// in another state (or left the project) by the time the move is sent, the
// move is skipped and recorded as attention `skipped_move`. A queued edit
// that records activity on a claim comment is sent only while that claim
// comment still reads open, and a queued removal of `vc:claimed` only while no
// claim comment on the issue reads open. Removing a label the issue does not
// carry counts as sent. A label row a hook queued with `skipIfCompleted` is
// not sent when the issue is completed or canceled by then (it counts as
// sent, nothing recorded). A queued move whose issue is already in the
// target state counts as delivered.

import { z } from "zod";
import type { Comment, Label, LinearApi } from "../linear/api.js";
import {
  isKeyRejected,
  isLinearError,
  removeLabelIfPresent,
} from "../linear/errors.js";
import {
  AGENT_LABEL_COLOR,
  VC_LABELS,
  isOpenClaim,
  parseClaimComment,
  withClaimActivity,
  withClaimStatus,
} from "../linear/states.js";
import type { LocalStore, OutboxRow } from "../local/types.js";
import { alreadyExists, queuedIssueOf } from "./context.js";

/** Attempts before a row Linear keeps rejecting is dropped. */
export const MAX_ATTEMPTS = 5;
/** Rows one drain looks at; the rest wait for the next drain. */
const BATCH = 500;

const commentPayload = z.object({
  id: z.string(),
  issueId: z.string(),
  body: z.string(),
});
const updateCommentPayload = z.object({
  id: z.string(),
  body: z.string(),
  issueId: z.string().optional(),
  onlyIfOpenClaim: z.boolean().optional(),
  /** The work the claim comment must still name. */
  workId: z.string().optional(),
  /** Claim activity: only the claim line is rewritten, to this time. */
  activeAt: z.string().optional(),
  /** Closing an open claim: only the claim line is rewritten, to this status. */
  closeAs: z.literal("abandoned").optional(),
});
const labelPayload = z.object({
  issueId: z.string(),
  labelId: z.string().optional(),
  labelName: z.string().optional(),
  /** Hook rows: not sent once the issue is completed or canceled. */
  skipIfCompleted: z.boolean().optional(),
});

/** Whether a hook's label row no longer applies: the issue is finished. */
async function finishedIssue(api: LinearApi, issueId: string) {
  try {
    const issue = await api.issue(issueId);
    return (
      issue === null ||
      issue.stateType === "completed" ||
      issue.stateType === "canceled"
    );
  } catch (error) {
    if (isLinearError(error, "not_found")) return true;
    throw error;
  }
}
const relationPayload = z.object({
  id: z.string(),
  type: z.enum(["related", "blocks"]),
  issueId: z.string(),
  relatedIssueId: z.string(),
});
const updateIssuePayload = z.object({
  id: z.string(),
  expectStateId: z.string().optional(),
  expectProjectId: z.string().optional(),
  input: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    stateId: z.string().optional(),
    priority: z.number().optional(),
    estimate: z.number().nullable().optional(),
    labelIds: z.array(z.string()).optional(),
    projectMilestoneId: z.string().nullable().optional(),
    parentId: z.string().nullable().optional(),
    assigneeId: z.string().nullable().optional(),
    subscriberIds: z.array(z.string()).optional(),
    dueDate: z.string().nullable().optional(),
    sortOrder: z.number().optional(),
  }),
});
const projectUpdatePayload = z.object({
  id: z.string(),
  projectId: z.string(),
  body: z.string(),
  health: z.enum(["onTrack", "atRisk", "offTrack"]).optional(),
});

/** Labels the drain may create when a queued row names one that is missing. */
function creatableColor(name: string): string | undefined {
  const own = VC_LABELS.find((label) => label.name === name);
  if (own !== undefined) return own.color;
  return name.startsWith("agent:") ? AGENT_LABEL_COLOR : undefined;
}

/** The label a queued label row names; undefined when it is gone and may not be created. */
async function labelFor(
  store: LocalStore,
  api: LinearApi,
  row: OutboxRow,
  payload: z.infer<typeof labelPayload>,
  create: boolean,
): Promise<Pick<Label, "id"> | undefined> {
  if (payload.labelName === undefined)
    return payload.labelId === undefined ? undefined : { id: payload.labelId };
  const project =
    row.projectKey === null ? undefined : store.project(row.projectKey);
  if (project === undefined) return undefined;
  const lower = payload.labelName.toLowerCase();
  const found = (await api.labels(project.teamId)).find(
    (label) => label.name.toLowerCase() === lower,
  );
  if (found !== undefined || !create) return found;
  const color = creatableColor(payload.labelName);
  if (color === undefined) return undefined;
  return api.createLabel({
    name: payload.labelName,
    color,
    description: "Set by vibecheck-linear-jev.",
  });
}

async function send(
  store: LocalStore,
  api: LinearApi,
  row: OutboxRow,
): Promise<void> {
  switch (row.kind) {
    case "comment": {
      await api.createComment(commentPayload.parse(row.payload));
      return;
    }
    case "update_comment": {
      const payload = updateCommentPayload.parse(row.payload);
      // Claim activity: sent only while the claim comment still reads open
      // (and names its work), rewriting only the claim line.
      let body = payload.body;
      if (payload.onlyIfOpenClaim === true && payload.issueId !== undefined) {
        let comments: readonly Comment[];
        try {
          comments = await api.comments(payload.issueId);
        } catch (error) {
          if (isLinearError(error, "not_found")) return;
          throw error;
        }
        const current = comments.find((comment) => comment.id === payload.id);
        if (current === undefined || !isOpenClaim(current.body)) return;
        if (
          payload.workId !== undefined &&
          parseClaimComment(current.body)?.workId !== payload.workId
        )
          return;
        if (payload.activeAt !== undefined)
          body = withClaimActivity(current.body, payload.activeAt);
        if (payload.closeAs !== undefined)
          body = withClaimStatus(current.body, payload.closeAs);
      }
      try {
        await api.updateComment(payload.id, body);
      } catch (error) {
        // A person deleted the comment: nothing is left to edit.
        if (!isLinearError(error, "not_found")) throw error;
      }
      return;
    }
    case "add_label": {
      const payload = labelPayload.parse(row.payload);
      if (
        payload.skipIfCompleted === true &&
        (await finishedIssue(api, payload.issueId))
      )
        return;
      const label = await labelFor(store, api, row, payload, true);
      if (label !== undefined) await api.addLabel(payload.issueId, label.id);
      return;
    }
    case "remove_label": {
      const payload = labelPayload.parse(row.payload);
      if (
        payload.skipIfCompleted === true &&
        (await finishedIssue(api, payload.issueId))
      )
        return;
      // vc:claimed comes off only while no claim comment on the issue is open.
      if (payload.labelName?.toLowerCase() === "vc:claimed") {
        let comments: readonly Comment[];
        try {
          comments = await api.comments(payload.issueId);
        } catch (error) {
          if (isLinearError(error, "not_found")) return;
          throw error;
        }
        if (comments.some((comment) => isOpenClaim(comment.body))) return;
      }
      const label = await labelFor(store, api, row, payload, false);
      if (label !== undefined)
        await removeLabelIfPresent(api, payload.issueId, label.id);
      return;
    }
    case "update_issue": {
      const payload = updateIssuePayload.parse(row.payload);
      if (
        payload.expectStateId !== undefined ||
        payload.expectProjectId !== undefined
      ) {
        const issue = await api.issue(payload.id);
        if (issue === null) return;
        // Already where the move takes it (an earlier send landed though
        // its answer was lost): delivered.
        if (
          payload.input.stateId !== undefined &&
          issue.stateId === payload.input.stateId &&
          (payload.expectProjectId === undefined ||
            issue.projectId === payload.expectProjectId)
        )
          return;
        const moved =
          payload.expectStateId !== undefined &&
          issue.stateId !== payload.expectStateId;
        const left =
          payload.expectProjectId !== undefined &&
          issue.projectId !== payload.expectProjectId;
        if (moved || left) {
          if (row.projectKey !== null) {
            // The tool's own expected arrival will not happen now.
            for (const event of store.events(row.projectKey, {
              kinds: ["expected_move"],
            }))
              if (event.issueId === issue.id) store.clearEvent(event.id);
            store.addEvent({
              projectKey: row.projectKey,
              kind: "skipped_move",
              issueId: issue.id,
              identifier: issue.identifier,
              workId: null,
              dedupe: `skipped_move:${row.id}`,
              body: {
                reason: left
                  ? `a queued state move of ${issue.identifier} was not sent: the issue left the project before Linear could be reached`
                  : `a queued state move of ${issue.identifier} was not sent: it is now in ${issue.stateName}, changed in Linear before the move could be sent`,
              },
            });
          }
          return;
        }
      }
      const input = Object.fromEntries(
        Object.entries(payload.input).filter(
          ([, value]) => value !== undefined,
        ),
      );
      await api.updateIssue(payload.id, input);
      return;
    }
    case "relation": {
      await api.createRelation(relationPayload.parse(row.payload));
      return;
    }
    case "project_update": {
      const payload = projectUpdatePayload.parse(row.payload);
      await api.createProjectUpdate({
        id: payload.id,
        projectId: payload.projectId,
        body: payload.body,
        ...(payload.health === undefined ? {} : { health: payload.health }),
      });
      return;
    }
  }
}

export interface DrainResult {
  readonly sent: number;
  readonly pending: number;
  /** Why draining stopped early, when it did. */
  readonly stopped?: string;
  /** Issues whose rows wait behind a rejected row. */
  readonly held?: readonly string[];
}

/**
 * A row set aside at the cap: attention `write_dropped` names the issue, the
 * kind of write and Linear's last answer.
 */
function dropRow(store: LocalStore, row: OutboxRow, message: string): void {
  store.markSent(row.id);
  if (row.projectKey === null) return;
  const issueId = queuedIssueOf(row) ?? "";
  const identifier =
    store.cachedIssues(row.projectKey).find((issue) => issue.id === issueId)
      ?.identifier ?? (issueId === "" ? "the project" : issueId);
  const label = row.payload["labelName"];
  const what = typeof label === "string" ? `${row.kind} ${label}` : row.kind;
  store.addEvent({
    projectKey: row.projectKey,
    kind: "write_dropped",
    issueId,
    identifier,
    workId: null,
    dedupe: `write_dropped:${row.id}`,
    body: {
      reason: `a queued Linear write (${what}) for ${identifier} was set aside after Linear rejected it ${MAX_ATTEMPTS} times; last error: ${message}. Make the change in Linear by hand if it is still wanted`,
      write: row.kind,
      lastError: message,
    },
  });
}

/**
 * Sends queued writes oldest first, one issue's rows in order, until the
 * queue is empty or Linear stops answering. A rejected row holds back the
 * later rows of its issue for this drain; `held` names those issues.
 */
export async function drainOutbox(
  store: LocalStore,
  api: LinearApi,
  /** Only this issue's rows (a completion plan sends them before its own writes). */
  onlyIssue?: string,
): Promise<DrainResult> {
  let sent = 0;
  const held = new Set<string>();
  for (const row of store.pending(BATCH)) {
    const issueId = queuedIssueOf(row);
    if (onlyIssue !== undefined && issueId !== onlyIssue) continue;
    if (issueId !== undefined && held.has(issueId)) continue;
    try {
      await send(store, api, row);
      store.markSent(row.id);
      sent += 1;
    } catch (error) {
      if (alreadyExists(error)) {
        store.markSent(row.id);
        sent += 1;
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      // Unreachable, failing, rate limited or a refused key: says nothing
      // about the row, so it stops the drain and never counts.
      if (
        isLinearError(error, "rate_limited", "network", "server") ||
        isKeyRejected(error)
      )
        return {
          sent,
          pending: store.pendingCount(),
          stopped: message,
          ...(held.size === 0 ? {} : { held: [...held] }),
        };
      // A rejection of this row (an entity-level 403 among them) counts.
      store.markFailed(row.id, message);
      if (row.attempts + 1 >= MAX_ATTEMPTS) dropRow(store, row, message);
      else if (issueId !== undefined) held.add(issueId);
    }
  }
  return {
    sent,
    pending: store.pendingCount(),
    ...(held.size === 0 ? {} : { held: [...held] }),
  };
}
