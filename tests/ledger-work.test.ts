import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { BoardError } from "../src/errors.js";
import type { Comment } from "../src/linear/api.js";
import { MemoryLinearApi } from "../src/linear/memory.js";
import {
  PROJECT,
  PROJECT_KEY,
  claim,
  commentBodies,
  createLedger,
  join,
  labelNames,
  publish,
  rejectsCode,
  request,
  status,
  update,
} from "./helpers.js";

const FORMS = {
  key: "FORMS-1",
  title: "Validate every form",
  goal: "Every form rejects empty required fields before submit",
  criteria: ["every form rejects empty required fields"],
};

/**
 * A view of `linear` whose first two `comments` reads wait for each other,
 * so two claims both see no claim before either writes one.
 */
function racing(linear: MemoryLinearApi): MemoryLinearApi {
  let waiting = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return new Proxy(linear, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property !== "comments" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (issueId: string): Promise<readonly Comment[]> => {
        const read = await target.comments(issueId);
        if (waiting < 2) {
          waiting += 1;
          if (waiting === 2) release();
          await gate;
        }
        return read;
      };
    },
  });
}

test("two machines claiming at once: the earliest claim comment wins and the other gets conflict", async (t) => {
  const shared = new MemoryLinearApi();
  const first = createLedger(t, { linear: shared });
  const root = await join(first.board);
  const published = z
    .object({ linear_project_id: z.string() })
    .parse(await publish(first.board, root, [FORMS]));
  const gated = racing(shared);
  const machineA = createLedger(t, { linear: gated });
  const machineB = createLedger(t, { linear: gated });
  const sessions: string[] = [];
  for (const [machine, vendor] of [
    [machineA, "claude-code"],
    [machineB, "codex"],
  ] satisfies [typeof machineA, string][])
    sessions.push(
      await join(machine.board, `agent-${sessions.length}`, {
        linear_project: published.linear_project_id,
        vendor,
      }),
    );
  const results = await Promise.allSettled([
    claim(machineA.board, sessions[0] ?? "", "FORMS-1"),
    claim(machineB.board, sessions[1] ?? "", "FORMS-1"),
  ]);
  const won = results.filter((result) => result.status === "fulfilled");
  const lost = results.filter((result) => result.status === "rejected");
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  const reason = lost[0]?.status === "rejected" ? lost[0].reason : undefined;
  assert.ok(reason instanceof BoardError);
  assert.equal(reason.code, "conflict");
  const winner = won[0]?.status === "fulfilled" ? won[0].value : undefined;
  assert.ok(winner !== undefined);
  assert.match(reason.message, new RegExp(winner.work.id, "u"));
  const claims = (await commentBodies(shared, winner.issue.identifier)).filter(
    (body) => body.includes("vibecheck claim · work"),
  );
  assert.equal(claims.length, 2);
  assert.match(
    claims[0] ?? "",
    new RegExp(`work ${winner.work.id} · open`, "u"),
  );
  assert.match(claims[1] ?? "", /· released \(lost claim race\)/u);
  const loserStore =
    results[0]?.status === "rejected" ? machineA.store : machineB.store;
  const loserRows = loserStore.allWork(PROJECT_KEY);
  assert.deepEqual(
    loserRows.map((row) => row.status),
    ["conflict"],
  );
  assert.ok(
    (await labelNames(shared, winner.issue.identifier)).includes("vc:claimed"),
  );
});

test("a claim adds the claim comment, vc:claimed and the agent label, moves the issue and assigns the viewer", async (t) => {
  const { board, linear } = createLedger(t);
  const root = await join(board);
  await publish(board, root, [FORMS]);
  const claimed = await claim(board, root, "FORMS-1", { paths: ["src/forms"] });
  const issue = await linear.issue(claimed.issue.identifier);
  assert.equal(issue?.stateName, "In Progress");
  assert.deepEqual(
    (await labelNames(linear, claimed.issue.identifier)).sort(),
    ["agent:claude-code", "vc:claimed"],
  );
  const [body] = await commentBodies(linear, claimed.issue.identifier);
  assert.match(body ?? "", /^\*\*Claimed\*\* by claude-code \(test-model\)/u);
  assert.match(
    body ?? "",
    /— vibecheck · claude-code · test-model · session s_/u,
  );
  const other = await join(board, "other", { parent_session_id: root });
  await rejectsCode(
    claim(board, other, "FORMS-1"),
    "conflict",
    /already claimed/u,
  );
  await rejectsCode(claim(board, other, issue?.identifier ?? ""), "conflict");
});

test("a done report that overclaims is held: the issue stays in progress with vc:held and a verdict comment", async (t) => {
  const { board, linear } = createLedger(t, {
    script: (battery) => (battery === "vibecheck.claims-done" ? 0.9 : 0.1),
  });
  const root = await join(board);
  await publish(board, root, [FORMS]);
  const claimed = await claim(board, root, "FORMS-1");
  const result = await update(board, root, claimed.work.id, {
    status: "complete",
    report: "All 14 forms have entries; 6 were reviewed and left unchanged.",
  });
  const item = result.verification?.find(
    (entry) => entry.check === "vibecheck.claims-done",
  );
  assert.equal(item?.outcome, "failed");
  assert.equal(item?.applied_status, "in_progress");
  assert.equal(result.work[0]?.status, "in_progress");
  const issue = await linear.issue(claimed.issue.identifier);
  assert.equal(issue?.stateType, "started");
  const labels = await labelNames(linear, claimed.issue.identifier);
  assert.ok(labels.includes("vc:held"));
  assert.ok(!labels.includes("vc:verified"));
  const bodies = await commentBodies(linear, claimed.issue.identifier);
  assert.ok(bodies.some((body) => body.startsWith("**Done**")));
  assert.ok(
    bodies.some((body) =>
      body.startsWith("**vibecheck: vibecheck.claims-done failed**"),
    ),
  );
  const view = await status(board);
  assert.equal(view.attention?.[0]?.kind, "held_done");
  assert.equal(view.tasks["FORMS-1"]?.verified, "held");
});

test("a supported done report moves the issue to done with vc:verified and one verified comment", async (t) => {
  const { board, linear, provider } = createLedger(t, { script: () => 0.1 });
  const root = await join(board);
  await publish(board, root, [FORMS]);
  const claimed = await claim(board, root, "FORMS-1");
  const result = await update(board, root, claimed.work.id, {
    status: "complete",
    report: "All 14 forms reject empty required fields; tests cover each.",
  });
  assert.equal(result.work[0]?.status, "complete");
  assert.equal(result.tasks[0]?.status, "complete");
  const issue = await linear.issue(claimed.issue.identifier);
  assert.equal(issue?.stateName, "Done");
  const labels = await labelNames(linear, claimed.issue.identifier);
  assert.ok(labels.includes("vc:verified"));
  assert.ok(!labels.includes("vc:claimed"));
  const bodies = await commentBodies(linear, claimed.issue.identifier);
  assert.equal(
    bodies.filter((body) =>
      body.startsWith("**vibecheck: vibecheck.claims-done verified**"),
    ).length,
    1,
  );
  assert.match(bodies[0] ?? "", /· complete\n/u);
  const read = provider?.requests.find(
    (entry) => entry.batteryId === "vibecheck.claims-done",
  );
  assert.ok(
    JSON.stringify(read?.state).includes(
      "every form rejects empty required fields",
    ),
  );
  assert.equal(
    (await status(board)).verification?.["FORMS-1"]?.verified,
    "verified",
  );
});

test("linked pull requests reach the done check as evidence; without them the input is unchanged", async (t) => {
  const { board, linear, provider } = createLedger(t, { script: () => 0.1 });
  const root = await join(board);
  await publish(board, root, [
    FORMS,
    { ...FORMS, key: "FORMS-2", title: "Second forms task" },
  ]);
  const withPr = await claim(board, root, "FORMS-1");
  linear.setPullRequests(withPr.issue.id, [
    {
      url: "https://github.com/example/app/pull/12",
      title: "Validate forms",
      source: "github",
      number: 12,
      branch: "mike/ta-1-forms",
      draft: false,
      createdAt: "2026-10-01T00:00:00Z",
      closedAt: null,
      mergedAt: null,
      hasConflicts: true,
    },
  ]);
  await update(board, root, withPr.work.id, {
    status: "complete",
    report: "Done.",
  });
  const without = await claim(board, root, "FORMS-2");
  await update(board, root, without.work.id, {
    status: "complete",
    report: "Done.",
  });
  const reads = (provider?.requests ?? []).filter(
    (entry) => entry.batteryId === "vibecheck.claims-done",
  );
  assert.equal(reads.length >= 2, true);
  const states = reads.map((entry) => JSON.stringify(entry.state));
  assert.ok(
    states.some(
      (state) =>
        state.includes("Pull request #12") && state.includes("merge conflicts"),
    ),
  );
  assert.ok(states.some((state) => !state.includes("Pull request")));
});

test("blocked, release and handoff update labels, states and claim comments", async (t) => {
  const { board, linear } = createLedger(t);
  const root = await join(board);
  const helper = await join(board, "helper", { parent_session_id: root });
  await publish(board, root, [FORMS]);
  const claimed = await claim(board, root, "FORMS-1");
  await rejectsCode(
    update(board, root, claimed.work.id, { status: "blocked" }),
    "invalid",
    /blocker/u,
  );
  await update(board, root, claimed.work.id, {
    status: "blocked",
    blocker: "Waiting for the user to choose the error wording.",
  });
  assert.ok(
    (await labelNames(linear, claimed.issue.identifier)).includes("vc:blocked"),
  );
  assert.equal((await status(board)).tasks["FORMS-1"]?.status, "blocked");
  const handed = z
    .object({
      work: z.array(
        z.object({
          id: z.string(),
          session_id: z.string(),
          status: z.string(),
        }),
      ),
    })
    .parse(
      await board.call("work_update", {
        project_id: PROJECT,
        request_id: request(),
        session_id: root,
        updates: [
          {
            work_id: claimed.work.id,
            action: "handoff",
            handoff_to: helper,
            report:
              "Open: wording. State: validation done. Next: apply wording.",
          },
        ],
      }),
    );
  const successor = handed.work.find((work) => work.session_id === helper);
  assert.ok(successor !== undefined);
  const bodies = await commentBodies(linear, claimed.issue.identifier);
  assert.ok(
    bodies.some((body) => body.includes(`handed off to work ${successor.id}`)),
  );
  assert.ok(
    bodies.some((body) => body.includes(`work ${successor.id} · open`)),
  );
  await update(board, helper, successor.id, {
    action: "release",
    report: "Released for now.",
  });
  const issue = await linear.issue(claimed.issue.identifier);
  assert.equal(issue?.stateType, "unstarted");
  const labels = await labelNames(linear, claimed.issue.identifier);
  assert.ok(!labels.includes("vc:claimed"));
  assert.ok(!labels.includes("vc:blocked"));
  await rejectsCode(
    update(board, helper, successor.id, { status: "in_progress" }),
    "conflict",
  );
});
