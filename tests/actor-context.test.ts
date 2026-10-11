import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  PROJECT,
  PROJECT_KEY,
  createLedger,
  join,
  publish,
  rejectsCode,
  request,
} from "./helpers.js";

const joinedSchema = z.object({
  session_id: z.string(),
  coordinator: z.boolean(),
  coordinator_session_id: z.string(),
  agent_label: z.string(),
});

function joinRequest(name: string, extra: Record<string, unknown> = {}) {
  return {
    project_id: PROJECT,
    request_id: request(),
    repository: "repo",
    vendor: "Claude Code",
    runtime: "cli",
    external_session_id: name,
    model: "test-model",
    ...extra,
  };
}

test("rejoining keeps the session and refreshes model and effort; identity and ancestry stay fixed", async (t) => {
  const { board, store } = createLedger(t);
  const first = joinedSchema.parse(
    await board.call("project_join", joinRequest("root")),
  );
  assert.equal(first.coordinator, true);
  assert.equal(first.agent_label, "agent:claude-code");
  const again = joinedSchema.parse(
    await board.call(
      "project_join",
      joinRequest("root", { model: "newer", effort: "max" }),
    ),
  );
  assert.equal(again.session_id, first.session_id);
  const session = store
    .sessions(PROJECT_KEY)
    .find((entry) => entry.externalSessionId === "root");
  assert.equal(session?.model, "newer");
  assert.equal(session?.effort, "max");
  const child = joinedSchema.parse(
    await board.call(
      "project_join",
      joinRequest("child", { parent_session_id: first.session_id }),
    ),
  );
  assert.equal(child.coordinator, false);
  await rejectsCode(
    board.call("project_join", joinRequest("child")),
    "conflict",
    /parent cannot change/u,
  );
  await rejectsCode(
    board.call(
      "project_join",
      joinRequest("orphan", { parent_session_id: "s_missing" }),
    ),
    "not_found",
  );
});

test("the first session must be a root, and a takeover must name the current coordinator", async (t) => {
  const { board } = createLedger(t);
  await rejectsCode(
    board.call(
      "project_join",
      joinRequest("first", { parent_session_id: "s_none" }),
    ),
    "not_found",
  );
  const root = joinedSchema.parse(
    await board.call("project_join", joinRequest("root")),
  );
  const other = joinedSchema.parse(
    await board.call("project_join", joinRequest("other")),
  );
  assert.equal(other.coordinator, false);
  await rejectsCode(
    board.call(
      "project_join",
      joinRequest("other", { take_over_from: other.session_id }),
    ),
    "conflict",
  );
  const took = joinedSchema.parse(
    await board.call(
      "project_join",
      joinRequest("other", { take_over_from: root.session_id }),
    ),
  );
  assert.equal(took.coordinator, true);
  await rejectsCode(publish(board, root.session_id), "forbidden");
});

test("a session acts only inside its own project", async (t) => {
  const { board } = createLedger(t);
  const session = await join(board);
  await board.call("project_join", {
    ...joinRequest("elsewhere"),
    project_id: "other-project",
  });
  await rejectsCode(
    board.call("plan_ack", {
      project_id: "other-project",
      request_id: request(),
      session_id: session,
      plan_revision: 0,
    }),
    "forbidden",
  );
  await rejectsCode(
    board.call("plan_ack", {
      project_id: "never-joined",
      request_id: request(),
      session_id: session,
      plan_revision: 0,
    }),
    "not_found",
  );
});

test("receipts are scoped to the session: another session may reuse a request id", async (t) => {
  const { board } = createLedger(t);
  const root = await join(board);
  const other = await join(board, "other", { parent_session_id: root });
  const ack = (session: string) =>
    board.call("plan_ack", {
      project_id: PROJECT,
      request_id: "shared-id",
      session_id: session,
      plan_revision: 0,
    });
  const first = z.object({ session_id: z.string() }).parse(await ack(root));
  const second = z.object({ session_id: z.string() }).parse(await ack(other));
  assert.equal(first.session_id, root);
  assert.equal(second.session_id, other);
});
