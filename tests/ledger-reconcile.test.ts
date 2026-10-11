import assert from "node:assert/strict";
import test from "node:test";
import { renderReportComment } from "../src/linear/states.js";
import {
  claim,
  commentBodies,
  createLedger,
  join,
  labelNames,
  publish,
  status,
  update,
} from "./helpers.js";

const TASKS = [
  {
    key: "CSV-1",
    title: "CSV export",
    goal: "Export the reports table as CSV with every column",
    criteria: ["every visible column is exported"],
  },
  {
    key: "PDF-1",
    title: "PDF export",
    goal: "Export the reports table as a paginated PDF document",
    criteria: ["the PDF has every visible column"],
  },
];

async function doneState(
  linear: Awaited<ReturnType<typeof createLedger>>["linear"],
) {
  const states = await linear.workflowStates(linear.teamId);
  const done = states.find((state) => state.type === "completed");
  const started = states.find((state) => state.type === "started");
  assert.ok(done !== undefined && started !== undefined);
  return { done, started };
}

test("an issue a person moves to done with no report gets a re-check, vc:unverified and a verdict comment", async (t) => {
  const { board, linear } = createLedger(t, { script: () => 0.1 });
  const root = await join(board);
  await publish(board, root, TASKS);
  await status(board);
  const issue = await linear.issue("TA-1");
  assert.ok(issue !== null);
  const { done } = await doneState(linear);
  linear.moveIssue(issue.id, done.id);
  const view = await status(board);
  assert.equal(view.tasks["CSV-1"]?.status, "complete");
  assert.equal(view.tasks["CSV-1"]?.verified, "unverified");
  const item = view.attention?.find(
    (entry) => entry.kind === "unverified_done",
  );
  assert.equal(item?.task_id, "CSV-1");
  assert.ok((await labelNames(linear, "TA-1")).includes("vc:unverified"));
  const bodies = await commentBodies(linear, "TA-1");
  assert.ok(
    bodies.some((body) =>
      body.startsWith("**vibecheck: vibecheck.claims-done review**"),
    ),
  );
  assert.equal(
    (await linear.issue("TA-1"))?.stateName,
    "Done",
    "the tool never moves it back",
  );
});

test("a re-check reads the latest report comment and fails an overclaiming one", async (t) => {
  const { board, linear, provider } = createLedger(t, {
    script: (battery) => (battery === "vibecheck.claims-done" ? 0.9 : 0.1),
  });
  const root = await join(board);
  await publish(board, root, TASKS);
  await status(board);
  const issue = await linear.issue("TA-2");
  assert.ok(issue !== null);
  await linear.createComment({
    issueId: issue.id,
    body: renderReportComment(
      { vendor: "codex", model: "m", sessionId: "s_other" },
      "Done",
      "Only half the columns are exported for now.",
    ),
  });
  const { done } = await doneState(linear);
  linear.moveIssue(issue.id, done.id);
  const view = await status(board);
  // A failed re-check holds nothing open: the task reads unverified.
  assert.equal(view.tasks["PDF-1"]?.verified, "unverified");
  assert.ok(
    view.attention?.some(
      (entry) => entry.kind === "unverified_done" && entry.task_id === "PDF-1",
    ),
  );
  const read = provider?.requests.find(
    (entry) => entry.batteryId === "vibecheck.claims-done",
  );
  assert.ok(JSON.stringify(read?.state).includes("Only half the columns"));
  assert.ok(
    (await commentBodies(linear, "TA-2")).some((body) =>
      body.startsWith("**vibecheck: vibecheck.claims-done failed**"),
    ),
  );
});

test("re-checks are bounded per run and the rest wait", async (t) => {
  const { board, linear } = createLedger(t, {
    script: () => 0.1,
    maxRechecks: 1,
  });
  const root = await join(board);
  await publish(board, root, TASKS);
  await status(board);
  const { done } = await doneState(linear);
  for (const identifier of ["TA-1", "TA-2"]) {
    const issue = await linear.issue(identifier);
    assert.ok(issue !== null);
    linear.moveIssue(issue.id, done.id);
  }
  assert.equal((await status(board)).sync.pending_rechecks, 1);
  assert.equal((await status(board)).sync.pending_rechecks, undefined);
});

test("an issue that leaves done is reported as reopened", async (t) => {
  const { board, linear } = createLedger(t, { script: () => 0.1 });
  const root = await join(board);
  await publish(board, root, TASKS);
  const claimed = await claim(board, root, "CSV-1");
  await update(board, root, claimed.work.id, {
    status: "complete",
    report: "Every visible column is exported; a test covers it.",
  });
  await status(board);
  const { started } = await doneState(linear);
  linear.moveIssue(claimed.issue.id, started.id);
  const view = await status(board);
  const item = view.attention?.find((entry) => entry.kind === "reopened");
  assert.equal(item?.task_id, "CSV-1");
  assert.equal(view.tasks["CSV-1"]?.status, "in_progress");
});

test("a person's comment on a claimed issue becomes a human_reply until the agent reports", async (t) => {
  const { board, linear } = createLedger(t);
  const root = await join(board);
  await publish(board, root, TASKS);
  const claimed = await claim(board, root, "CSV-1");
  linear.addHumanComment(
    claimed.issue.id,
    "Please also include the hidden columns.",
  );
  const view = await status(board);
  const reply = view.attention?.find((entry) => entry.kind === "human_reply");
  assert.match(reply?.reason ?? "", /hidden columns/u);
  assert.equal(reply?.task_id, "CSV-1");
  await update(board, root, claimed.work.id, {
    report: "Including hidden columns as asked.",
  });
  assert.equal(
    (await status(board)).attention?.some(
      (entry) => entry.kind === "human_reply",
    ) ?? false,
    false,
  );
});

test("an archived issue with an open claim abandons the work and is reported as removed", async (t) => {
  const { board, linear, store } = createLedger(t);
  const root = await join(board);
  await publish(board, root, TASKS);
  const claimed = await claim(board, root, "CSV-1");
  await status(board);
  linear.archiveIssue(claimed.issue.id);
  const view = await status(board);
  assert.ok(view.attention?.some((entry) => entry.kind === "removed"));
  assert.equal(view.tasks["CSV-1"], undefined);
  const key = store.allProjects()[0]?.key;
  assert.ok(key !== undefined);
  assert.equal(store.allWork(key)[0]?.status, "abandoned");
});
