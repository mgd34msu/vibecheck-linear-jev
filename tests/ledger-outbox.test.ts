import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { drainOutbox } from "../src/ledger/outbox.js";
import { LinearError } from "../src/linear/errors.js";
import { MemoryLinearApi } from "../src/linear/memory.js";
import { SqliteLocalStore } from "../src/local/store.js";
import {
  PROJECT_KEY,
  claim,
  commentBodies,
  createLedger,
  detail,
  failureOf,
  join,
  labelNames,
  publish,
  status,
  update,
} from "./helpers.js";

const WRITES = new Set([
  "createComment",
  "updateComment",
  "addLabel",
  "removeLabel",
  "updateIssue",
  "createProjectUpdate",
]);

/** A view of `linear` whose writes fail as unreachable while `offline.value` is true. */
function flaky(
  linear: MemoryLinearApi,
  offline: { value: boolean },
): MemoryLinearApi {
  return new Proxy(linear, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (typeof property === "string" && WRITES.has(property))
        return (...args: unknown[]) => {
          if (offline.value)
            return Promise.reject(
              new LinearError("network", "Could not reach Linear: offline"),
            );
          return Reflect.apply(value, target, args);
        };
      return value.bind(target);
    },
  });
}

test("writes Linear refuses for being unreachable are queued, reported in sync, and sent by the next call", async (t) => {
  const linear = new MemoryLinearApi();
  const offline = { value: false };
  const { board } = createLedger(t, { linear: flaky(linear, offline) });
  const root = await join(board);
  await publish(board, root, [
    { key: "Q-1", title: "Queued task", criteria: ["works offline"] },
  ]);
  const claimed = await claim(board, root, "Q-1");
  offline.value = true;
  const progress = await update(board, root, claimed.work.id, {
    report: "Progress while Linear was unreachable.",
  });
  assert.ok(progress.sync.pending >= 2, `queued ${progress.sync.pending}`);
  offline.value = false;
  assert.equal((await status(board)).sync.pending, 0);
  assert.equal(
    (await commentBodies(linear, "TA-1")).filter((body) =>
      body.startsWith("**Progress**"),
    ).length,
    1,
  );
});

test("a completion while Linear is unreachable is a pending plan the next call finishes", async (t) => {
  const linear = new MemoryLinearApi();
  const offline = { value: false };
  const { board } = createLedger(t, { linear: flaky(linear, offline) });
  const root = await join(board);
  await publish(board, root, [
    { key: "Q-1", title: "Queued task", criteria: ["works offline"] },
  ]);
  const claimed = await claim(board, root, "Q-1");
  offline.value = true;
  const failure = await failureOf(
    update(board, root, claimed.work.id, {
      status: "complete",
      report: "Done while Linear was unreachable.",
    }),
  );
  assert.equal(failure.code, "unavailable");
  assert.equal(detail(failure, "completion"), "pending");
  assert.deepEqual(detail(failure, "steps_done"), []);
  assert.equal((await linear.issue("TA-1"))?.stateType, "started");
  assert.ok(
    !(await commentBodies(linear, "TA-1")).some((body) =>
      body.startsWith("**Done**"),
    ),
  );
  offline.value = false;
  const view = await status(board);
  assert.equal(view.sync.pending, 0);
  assert.equal(view.sync.pending_completions, undefined);
  assert.equal((await linear.issue("TA-1"))?.stateName, "Done");
  const bodies = await commentBodies(linear, "TA-1");
  assert.equal(bodies.filter((body) => body.startsWith("**Done**")).length, 1);
  assert.ok(
    bodies.some((body) => body.includes(`work ${claimed.work.id} · complete`)),
  );
});

test("resending a queued create that already landed counts as sent and does not duplicate it", async (t) => {
  const { board, linear, path } = createLedger(t);
  const root = await join(board);
  await publish(board, root, [{ key: "R-1", title: "Resend task" }]);
  const issue = await linear.issue("TA-1");
  assert.ok(issue !== null);
  const store = new SqliteLocalStore(path);
  t.after(() => store.close());
  const id = randomUUID();
  const payload = { id, issueId: issue.id, body: "queued once" };
  store.enqueue({ projectKey: null, kind: "comment", payload });
  // The first attempt reached Linear, then the process died before marking it sent.
  await linear.createComment(payload);
  const drained = await drainOutbox(store, linear);
  assert.deepEqual(drained, { sent: 1, pending: 0 });
  const again = await drainOutbox(store, linear);
  assert.deepEqual(again, { sent: 0, pending: 0 });
  assert.equal(
    (await commentBodies(linear, "TA-1")).filter(
      (body) => body === "queued once",
    ).length,
    1,
  );
});

test("draining stops at the first rate-limit error and keeps the rest in order", async (t) => {
  const { board, linear, path } = createLedger(t);
  const root = await join(board);
  await publish(board, root, [{ key: "L-1", title: "Limited task" }]);
  const issue = await linear.issue("TA-1");
  assert.ok(issue !== null);
  const store = new SqliteLocalStore(path);
  t.after(() => store.close());
  for (const body of ["first", "second", "third"])
    store.enqueue({
      projectKey: null,
      kind: "comment",
      payload: { id: randomUUID(), issueId: issue.id, body },
    });
  linear.failNext("rate_limited");
  const stopped = await drainOutbox(store, linear);
  assert.equal(stopped.sent, 0);
  assert.equal(stopped.pending, 3);
  assert.match(stopped.stopped ?? "", /rate_limited|Injected/u);
  await drainOutbox(store, linear);
  assert.deepEqual(
    (await commentBodies(linear, "TA-1")).filter((body) =>
      ["first", "second", "third"].includes(body),
    ),
    ["first", "second", "third"],
  );
});

test("defect 14: queued label rows carry the label name; the drain resolves it, creates a missing vc:* label and drops an unknown other one", async (t) => {
  const linear = new MemoryLinearApi();
  const offline = { value: false };
  const { board, store } = createLedger(t, { linear: flaky(linear, offline) });
  const root = await join(board);
  await publish(board, root, [{ key: "N-1", title: "Named labels" }]);
  const claimed = await claim(board, root, "N-1");
  offline.value = true;
  await update(board, root, claimed.work.id, {
    status: "blocked",
    blocker: "Waiting on the API owner.",
  });
  const labelRows = store
    .pending(100)
    .filter((row) => row.kind === "add_label" || row.kind === "remove_label");
  assert.ok(labelRows.length > 0);
  for (const row of labelRows) {
    assert.equal(typeof row.payload["labelName"], "string");
    assert.equal(row.payload["labelId"], undefined);
  }
  offline.value = false;
  for (const labelName of ["vc:stalled", "Not a label anywhere"])
    store.enqueue({
      projectKey: PROJECT_KEY,
      kind: "add_label",
      payload: { issueId: claimed.issue.id, labelName },
    });
  await status(board);
  assert.equal(store.pendingCount(), 0);
  const names = await labelNames(linear, claimed.issue.identifier);
  assert.ok(names.includes("vc:blocked"));
  assert.ok(names.includes("vc:stalled"), "a missing vc:* label is created");
  assert.ok(
    !(await linear.labels(linear.teamId)).some(
      (label) => label.name === "Not a label anywhere",
    ),
  );
});
