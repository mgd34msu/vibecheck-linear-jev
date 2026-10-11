import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowState } from "../src/linear/api.js";
import {
  VC_LABELS,
  agentLabelName,
  isOpenClaim,
  isToolComment,
  parseClaimComment,
  renderClaimComment,
  renderFooter,
  renderReportComment,
  renderVerdictComment,
  resolveStates,
  taskStatusOf,
  withClaimStatus,
} from "../src/linear/states.js";

function state(
  id: string,
  name: string,
  type: WorkflowState["type"],
  position: number,
): WorkflowState {
  return { id, name, type, position };
}

const STATES: WorkflowState[] = [
  state("done", "Done", "completed", 4),
  state("review", "In Review", "started", 3),
  state("prog", "In Progress", "started", 2),
  state("todo", "Todo", "unstarted", 1),
  state("back", "Backlog", "backlog", 0),
  state("cancel", "Canceled", "canceled", 6),
  state("dup", "Duplicate", "canceled", 7),
];

test("resolveStates picks the first state of each type by position", () => {
  const resolved = resolveStates(STATES, {});
  assert.equal(resolved.inProgress.id, "prog");
  assert.equal(resolved.review?.id, "review");
  assert.equal(resolved.done.id, "done");
  assert.equal(resolved.canceled.id, "cancel");
});

test("resolveStates honours name overrides, case-insensitively", () => {
  const resolved = resolveStates(STATES, {
    inProgress: "in review",
    review: "In Progress",
    canceled: "duplicate",
    done: null,
  });
  assert.equal(resolved.inProgress.id, "review");
  assert.equal(resolved.review?.id, "prog");
  assert.equal(resolved.canceled.id, "dup");
  assert.equal(resolved.done.id, "done");
});

test("review is null when no started state mentions review", () => {
  const resolved = resolveStates(
    STATES.filter((s) => s.id !== "review"),
    {},
  );
  assert.equal(resolved.review, null);
});

test("review default never equals the in-progress state", () => {
  const resolved = resolveStates(
    STATES.filter((s) => s.id !== "prog"),
    {},
  );
  assert.equal(resolved.inProgress.id, "review");
  assert.equal(resolved.review, null);
});

test("resolveStates throws clearly for missing types and unknown names", () => {
  assert.throws(
    () =>
      resolveStates(
        STATES.filter((s) => s.type !== "completed"),
        {},
      ),
    /no completed state/,
  );
  assert.throws(
    () =>
      resolveStates(
        STATES.filter((s) => s.type !== "canceled"),
        {},
      ),
    /no canceled state/,
  );
  assert.throws(
    () => resolveStates(STATES, { done: "Shipped" }),
    /linear\.states\.done names "Shipped"/,
  );
});

test("taskStatusOf maps state types and labels", () => {
  const resolved = resolveStates(STATES, {});
  const none = new Set<string>();
  const status = (
    stateId: string,
    stateType: WorkflowState["type"],
    labels = none,
  ) => taskStatusOf({ stateId, stateType }, labels, resolved);
  assert.equal(status("back", "backlog"), "pending");
  assert.equal(status("todo", "unstarted"), "pending");
  assert.equal(status("x", "triage"), "pending");
  assert.equal(status("prog", "started"), "in_progress");
  assert.equal(status("prog", "started", new Set(["vc:blocked"])), "blocked");
  assert.equal(status("review", "started"), "awaiting_integration");
  assert.equal(
    status("prog", "started", new Set(["vc:awaiting-integration"])),
    "awaiting_integration",
  );
  assert.equal(status("done", "completed"), "complete");
  assert.equal(status("cancel", "canceled"), "cancelled");
});

test("taskStatusOf without a review state uses the label", () => {
  const resolved = resolveStates(
    STATES.filter((s) => s.id !== "review"),
    {},
  );
  assert.equal(
    taskStatusOf(
      { stateId: "prog", stateType: "started" },
      new Set(["vc:awaiting-integration"]),
      resolved,
    ),
    "awaiting_integration",
  );
});

test("VC_LABELS match the design", () => {
  assert.deepEqual(
    VC_LABELS.map((l) => `${l.name} ${l.color}`),
    [
      "vc:claimed #5e6ad2",
      "vc:blocked #e5484d",
      "vc:held #f76b15",
      "vc:unverified #ffc53d",
      "vc:verified #30a46c",
      "vc:stalled #8e4ec6",
      "vc:needs-user #e93d82",
      "vc:awaiting-integration #0090ff",
    ],
  );
});

test("agentLabelName lowercases and replaces other characters", () => {
  assert.equal(agentLabelName("Claude-Code"), "agent:claude-code");
  assert.equal(agentLabelName("Codex CLI_2"), "agent:codex-cli-2");
});

const author = { vendor: "claude-code", model: "opus", sessionId: "s-1" };

test("footer and tool comment detection", () => {
  assert.equal(
    renderFooter(author),
    "— vibecheck · claude-code · opus · session s-1",
  );
  assert.equal(
    isToolComment(`**Progress**\n\nhello\n\n${renderFooter(author)}\n`),
    true,
  );
  // A tool comment starts with one of the tool's headers (defect R6-L9).
  assert.equal(isToolComment(`hello\n\n${renderFooter(author)}\n`), false);
  assert.equal(isToolComment("a human wrote this"), false);
  assert.equal(isToolComment(`${renderFooter(author)}\nmore text`), false);
});

test("claim comments render, parse and change status", () => {
  const body = renderClaimComment(author, "work-9");
  assert.equal(
    body,
    "**Claimed** by claude-code (opus)\n\nvibecheck claim · work work-9 · open\n\n— vibecheck · claude-code · opus · session s-1",
  );
  assert.deepEqual(parseClaimComment(body), {
    workId: "work-9",
    status: "open",
  });
  assert.equal(isOpenClaim(body), true);
  const closed = withClaimStatus(body, "handed off to work w-2");
  assert.deepEqual(parseClaimComment(closed), {
    workId: "work-9",
    status: "handed off to work w-2",
  });
  assert.equal(isOpenClaim(closed), false);
  assert.equal(isToolComment(closed), true);
  assert.equal(parseClaimComment("**Done**\n\ntext"), null);
  assert.equal(
    parseClaimComment(
      renderClaimComment(author, "w", "released (lost claim race)"),
    )?.status,
    "released (lost claim race)",
  );
});

test("report and verdict comments", () => {
  assert.equal(
    renderReportComment(author, "Done", "Finished it.\n"),
    "**Done**\n\nFinished it.\n\n— vibecheck · claude-code · opus · session s-1",
  );
  const verdict = renderVerdictComment(
    author,
    "claims-done",
    "failed",
    "No commit.",
  );
  assert.equal(
    verdict,
    "**vibecheck: claims-done failed**\n\nNo commit.\n\n— vibecheck · claude-code · opus · session s-1",
  );
  assert.equal(isToolComment(verdict), true);
});
