import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { MemoryLinearApi } from "../src/linear/memory.js";
import { completenessProblems } from "../src/ledger/readiness.js";
import {
  PROJECT,
  claim,
  createLedger,
  join,
  publish,
  rejectsCode,
  update,
} from "./helpers.js";

const nextSchema = z.array(
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("attention"),
      attention: z.string(),
      task_id: z.string().optional(),
      work_id: z.string().optional(),
      reason: z.string(),
      entry_id: z.string(),
      do: z.string(),
    }),
    z.object({
      kind: z.literal("claim"),
      task_id: z.string(),
      identifier: z.string(),
      work_id: z.string(),
      status: z.string(),
      verified: z.string().optional(),
      blocker: z.string().optional(),
      do: z.string(),
    }),
    z.object({
      kind: z.literal("available"),
      task_id: z.string(),
      identifier: z.string(),
      title: z.string(),
      milestone: z.string().optional(),
      url: z.string(),
      do: z.string(),
    }),
    z.object({ kind: z.literal("none_available"), do: z.string() }),
  ]),
);

async function nextOf(
  board: Parameters<typeof publish>[0],
  sessionId?: string,
) {
  const result = z.looseObject({ next: nextSchema }).parse(
    await board.call("project_status", {
      project_id: PROJECT,
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
    }),
  );
  assert.equal(
    Object.keys(result)[0],
    "next",
    "project_status leads with next",
  );
  return result.next;
}

const CRITERIA = ["the part is done and tested"];
const GOAL = "Build this part of the reports page in full, with tests";

/** Milestone M1 before M2; in M1, LATE depends on EARLY. */
const PLAN = {
  milestones: [
    { code: "M1", name: "First" },
    { code: "M2", name: "Second" },
  ],
};
const TASKS = [
  {
    key: "LATER-1",
    title: "Second milestone work",
    milestone: "M2",
    goal: GOAL,
    criteria: CRITERIA,
  },
  {
    key: "LATE-1",
    title: "Waits on EARLY-1",
    milestone: "M1",
    depends_on: ["EARLY-1"],
    goal: GOAL,
    criteria: CRITERIA,
  },
  {
    key: "EARLY-1",
    title: "First milestone work",
    milestone: "M1",
    goal: GOAL,
    criteria: CRITERIA,
  },
  {
    key: "MINE-1",
    title: "Work this session claims",
    milestone: "M1",
    goal: GOAL,
    criteria: CRITERIA,
  },
];

test("next lists the session's own attention, then its claims, then the next available task in milestone order", async (t) => {
  const { board } = createLedger(t, {
    script: (battery) => (battery === "vibecheck.claims-done" ? 0.9 : 0.1),
  });
  const coordinator = await join(board);
  await publish(board, coordinator, TASKS, PLAN);
  const worker = await join(board, "worker");
  const mine = await claim(board, worker, "MINE-1");
  const held = await update(board, worker, mine.work.id, {
    status: "complete",
    report: "Half of it is done; the tests are not written.",
  });
  assert.ok(
    held.verification?.some((entry) => entry.outcome === "failed"),
    "the done report is held",
  );

  const next = await nextOf(board, worker);
  assert.deepEqual(
    next.map((item) => item.kind),
    ["attention", "claim", "available"],
  );
  const [attention, own, available] = next;
  assert.ok(attention?.kind === "attention");
  assert.equal(attention.attention, "held_done");
  assert.equal(attention.work_id, mine.work.id);
  assert.match(attention.do, /fix what the reason names/u);
  assert.ok(own?.kind === "claim");
  assert.equal(own.task_id, "MINE-1");
  assert.equal(own.status, "in_progress");
  assert.equal(own.verified, "held");
  assert.ok(available?.kind === "available");
  // M1 comes first; LATE-1 waits on EARLY-1 and MINE-1 is claimed.
  assert.equal(available.task_id, "EARLY-1");
  assert.equal(available.milestone, "M1");
  assert.equal(available.do, "claim it with work_claim");

  // The coordinator's next does not carry the worker's attention or claim.
  const theirs = await nextOf(board, coordinator);
  assert.deepEqual(
    theirs.map((item) => item.kind),
    ["available"],
  );
  // Without a session only the next available task is given.
  assert.deepEqual(
    (await nextOf(board)).map((item) => item.kind),
    ["available"],
  );
});

test("next offers a task once its dependencies are complete, and none when every task is taken", async (t) => {
  const { board } = createLedger(t, { script: () => 0.1 });
  const session = await join(board);
  await publish(board, session, TASKS.slice(1, 3), PLAN);
  const early = await claim(board, session, "EARLY-1");
  const before = await nextOf(board, session);
  assert.deepEqual(
    before.map((item) => item.kind),
    ["claim"],
    "LATE-1 waits on EARLY-1, which this session holds",
  );
  await update(board, session, early.work.id, {
    status: "complete",
    report:
      "EARLY-1 is done and tested: the part is in place and its tests pass.",
  });
  const after = await nextOf(board, session);
  const offered = after.find((item) => item.kind === "available");
  assert.ok(offered?.kind === "available");
  assert.equal(offered.task_id, "LATE-1");

  const late = await claim(board, session, "LATE-1");
  assert.ok(late.work.id.length > 0);
  const other = await join(board, "other");
  assert.deepEqual(
    (await nextOf(board, other)).map((item) => item.kind),
    ["none_available"],
  );
});

test("project_status refuses a session of another project or none", async (t) => {
  const { board } = createLedger(t, { script: () => 0.1 });
  await join(board);
  await rejectsCode(
    board.call("project_status", {
      project_id: PROJECT,
      session_id: "s_missing",
    }),
    "not_found",
  );
});

test("a machine that joined an existing project orders next by milestone too, and claims a task added after it last read the plan", async (t) => {
  const shared = new MemoryLinearApi();
  const a = createLedger(t, { linear: shared });
  const coordinator = await join(a.board);
  const published = z
    .object({ linear_project_id: z.string() })
    .parse(await publish(a.board, coordinator, TASKS, PLAN));
  const b = createLedger(t, { linear: shared });
  const other = await join(b.board, "other", {
    linear_project: published.linear_project_id,
  });
  const next = await nextOf(b.board, other);
  const available = next.find((item) => item.kind === "available");
  assert.ok(available?.kind === "available");
  // LATER-1 (M2) is listed first in the plan; M1's EARLY-1 still comes first.
  assert.equal(available.task_id, "EARLY-1");

  // A adds a task; B claims it by key without reading status first.
  await a.board.call("plan_edit", {
    project_id: PROJECT,
    request_id: "add-after-join",
    session_id: coordinator,
    expected_revision: 1,
    operations: [
      {
        op: "add_task",
        task: {
          key: "ADDED-1",
          title: "Added after the other machine joined",
          milestone: "M1",
          goal: GOAL,
          criteria: CRITERIA,
        },
      },
    ],
  });
  const claimed = await claim(b.board, other, "ADDED-1");
  assert.equal(claimed.work.task_id, "ADDED-1");
});

test("the recommended Kind and Area label groups are reported but never hold a publish", () => {
  assert.deepEqual(
    completenessProblems({ recommended: { label_groups: ["Kind", "Area"] } }),
    [],
  );
});
