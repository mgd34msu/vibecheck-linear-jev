// Regression tests for the defects a refutation review of the ledger found:
// one test (or a few) per defect, each reproducing the reviewer's probe on
// MemoryLinearApi and a temporary local store.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import { BoardError } from "../src/errors.js";
import { ProviderUnavailableError } from "../src/jev/lib/errors.js";
import { projectKeyOf, sessionIdOf, workIdOf } from "../src/ledger/access.js";
import { stableId, Writer } from "../src/ledger/context.js";
import type { WorkRow } from "../src/local/types.js";
import {
  PLAN_DOCUMENT_TITLE,
  POLICY_DOCUMENT_TITLE,
  parsePlanDocument,
} from "../src/linear/documents.js";
import type { Comment, Issue, IssueFields } from "../src/linear/api.js";
import {
  LinearError,
  isLabelNotOnIssue,
  type LinearErrorKind,
} from "../src/linear/errors.js";
import { MemoryLinearApi } from "../src/linear/memory.js";
import {
  escapeCommentText,
  parseClaimComment,
  renderClaimComment,
  renderVerdictComment,
  unescapeCommentText,
  withClaimStatus,
} from "../src/linear/states.js";
import {
  acceptingProblems,
  PROJECT,
  PROJECT_FIELDS,
  PROJECT_KEY,
  claim,
  commentBodies,
  createLedger,
  detail,
  failureOf,
  join,
  labelNames,
  publish,
  rejectsCode,
  request,
  status,
  update,
} from "./helpers.js";

/** An existing Linear project with one structured issue an owner wrote. */
async function existingProject(linear: MemoryLinearApi) {
  const project = await linear.createProject({
    name: "vc-test-existing",
    teamIds: [linear.teamId],
    content: "## Goal\n\nShip the anthology\n",
  });
  const structured = await linear.createIssue({
    teamId: linear.teamId,
    projectId: project.id,
    title: "Save identity exhausted",
    description:
      "Preamble by owner.\n\n## Goal\n\nOwner goal text.\n\n## Acceptance criteria\n\n- [x] owner criterion one\n- [ ] owner criterion two\n",
    priority: 3,
  });
  return { project, structured };
}

async function stateOf(linear: MemoryLinearApi, type: string) {
  const state = (await linear.workflowStates(linear.teamId)).find(
    (entry) => entry.type === type,
  );
  assert.ok(state !== undefined, `no ${type} state`);
  return state;
}

/** Rewrites one issue record the way a person editing Linear would. */
function editIssue(
  linear: MemoryLinearApi,
  issueId: string,
  patch: { projectId?: string; archived?: boolean },
) {
  const state = linear.exportState();
  const at = new Date(Date.parse(state.issues.at(-1)?.updatedAt ?? "") + 1);
  linear.importState({
    ...state,
    issues: state.issues.map((issue) =>
      issue.id === issueId
        ? { ...issue, ...patch, updatedAt: at.toISOString() }
        : issue,
    ),
  });
}

/** A view of `linear` whose `method` fails with `failure` while `armed.count` > 0. */
function failing(
  linear: MemoryLinearApi,
  method: string,
  failure: () => LinearError,
  armed: { count: number },
): MemoryLinearApi {
  return new Proxy(linear, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === method)
        return (...args: unknown[]) => {
          if (armed.count > 0) {
            armed.count -= 1;
            return Promise.reject(failure());
          }
          return Reflect.apply(value, target, args);
        };
      return value.bind(target);
    },
  });
}

const dryRunSchema = z.object({
  dry_run: z.literal(true),
  changes: z.array(z.object({ object: z.string(), action: z.string() })),
  skipped: z
    .array(
      z.object({
        object: z.string(),
        key: z.string(),
        field: z.string(),
      }),
    )
    .optional(),
  message: z.string(),
});

// ---------------------------------------------------------------------------
// 1. The adoption mode is recorded in Linear
// ---------------------------------------------------------------------------

test("defect 1: a second machine joining a managed project reads managed from Linear and starts with its own dry run", async (t) => {
  const shared = new MemoryLinearApi();
  const { project, structured } = await existingProject(shared);
  const a = createLedger(t, { linear: shared });
  const rootA = await join(a.board, "rootA", {
    linear_project: project.id,
    adopt: "managed",
  });
  const plan = (session: string, revision: number) => ({
    project_id: PROJECT,
    session_id: session,
    expected_revision: revision,
    project: { name: "vc-renamed-by-plan" },
    tasks: [
      {
        key: structured.identifier,
        title: "Plan title",
        goal: "PLAN GOAL overwriting owner",
        criteria: ["plan criterion"],
        priority: 1,
      },
    ],
  });
  dryRunSchema.parse(
    await acceptingProblems(a.board, "plan_publish", {
      ...plan(rootA, 0),
      request_id: request(),
    }),
  );
  await acceptingProblems(a.board, "plan_publish", {
    ...plan(rootA, 0),
    request_id: request(),
    confirm: true,
  });
  const documents = await shared.documents(project.id);
  const policy = documents.find((doc) => doc.title === POLICY_DOCUMENT_TITLE);
  assert.match(policy?.content ?? "", /^Adoption: managed/mu);
  const planDoc = documents.find((doc) => doc.title === PLAN_DOCUMENT_TITLE);
  assert.equal(parsePlanDocument(planDoc?.content ?? "")?.origin, "adopted");

  const b = createLedger(t, { linear: shared });
  const joined = await b.board.call("project_join", {
    project_id: PROJECT,
    request_id: request(),
    repository: "repo",
    vendor: "codex",
    runtime: "cli",
    external_session_id: "rootB",
    model: "m",
    linear_project: project.id,
  });
  assert.equal(joined["adoption_required"], undefined);
  const rowB = b.store.project(PROJECT_KEY);
  assert.equal(rowB?.adoption, "managed");
  const rootB = z.object({ session_id: z.string() }).parse(joined).session_id;
  const before = JSON.stringify(shared.exportState());
  const dry = dryRunSchema.parse(
    await acceptingProblems(b.board, "plan_publish", {
      ...plan(rootB, rowB?.planRevision ?? 0),
      request_id: request(),
    }),
  );
  assert.equal(dry.dry_run, true);
  assert.equal(JSON.stringify(shared.exportState()), before, "B wrote nothing");
  const issue = await shared.issue(structured.identifier);
  assert.equal(issue?.title, "Save identity exhausted");
  assert.equal(issue?.priority, 3);
  assert.equal((await shared.project(project.id))?.name, "vc-test-existing");
});

test("defect 1: a project the tool created is joined as created; one with only a plan document, or answered as_is elsewhere, asks again", async (t) => {
  const shared = new MemoryLinearApi();
  const a = createLedger(t, { linear: shared });
  const rootA = await join(a.board);
  const published = z
    .object({ linear_project_id: z.string() })
    .parse(await publish(a.board, rootA));
  const planDoc = (await shared.documents(published.linear_project_id)).find(
    (doc) => doc.title === PLAN_DOCUMENT_TITLE,
  );
  assert.equal(parsePlanDocument(planDoc?.content ?? "")?.origin, "created");
  const b = createLedger(t, { linear: shared });
  await join(b.board, "b", { linear_project: published.linear_project_id });
  assert.equal(b.store.project(PROJECT_KEY)?.adoption, "created");

  // A plan document without an origin proves nothing.
  const { project } = await existingProject(shared);
  await shared.createDocument({
    projectId: project.id,
    title: PLAN_DOCUMENT_TITLE,
    content:
      '## Machine map\n\n```json\n{"revision": 1, "tasks": {}, "milestones": {}}\n```\n',
  });
  const c = createLedger(t, { linear: shared });
  const asked = await c.board.call("project_join", {
    project_id: "other",
    request_id: request(),
    repository: "repo",
    vendor: "codex",
    runtime: "cli",
    external_session_id: "c",
    model: "m",
    linear_project: project.id,
  });
  assert.equal(asked["adoption_required"], true);

  // as_is is local only: another machine is asked again.
  const fresh = await existingProject(shared);
  const d = createLedger(t, { linear: shared });
  await join(d.board, "d", {
    project_id: "asis",
    linear_project: fresh.project.id,
    adopt: "as_is",
  });
  const e = createLedger(t, { linear: shared });
  const again = await e.board.call("project_join", {
    project_id: "asis",
    request_id: request(),
    repository: "repo",
    vendor: "codex",
    runtime: "cli",
    external_session_id: "e",
    model: "m",
    linear_project: fresh.project.id,
  });
  assert.equal(again["adoption_required"], true);
});

// ---------------------------------------------------------------------------
// 2. Verified only when claims-done passed
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("defect 2: a done update with no report completes the issue unverified even when the commit checks pass, and a flagged commit-honesty stays in attention", async (t) => {
  const { board, linear, directory } = createLedger(t, { script: () => 0.1 });
  const repository = joinPath(directory, "repo");
  mkdirSync(joinPath(repository, "src", "ledger"), { recursive: true });
  git(directory, "init", "-q", repository);
  writeFileSync(joinPath(repository, "src", "ledger", "work.ts"), "x\n");
  git(repository, "add", ".");
  git(repository, "commit", "-q", "-m", "Unrelated tidy-up");
  const commit = git(repository, "rev-parse", "HEAD");
  const root = await join(board);
  await publish(board, root);
  const claimed = await claim(board, root, "A-1", {
    checkout: repository,
    paths: ["src/ledger"],
  });
  const result = await update(board, root, claimed.work.id, {
    status: "complete",
    commit,
  });
  const outcomes = Object.fromEntries(
    (result.verification ?? []).map((item) => [item.check, item.outcome]),
  );
  assert.equal(outcomes["vibecheck.commit-paths"], "passed");
  assert.equal(outcomes["vibecheck.claims-done"], "review");
  assert.equal(result.tasks[0]?.status, "complete");
  const labels = await labelNames(linear, claimed.issue.identifier);
  assert.ok(labels.includes("vc:unverified"));
  assert.ok(!labels.includes("vc:verified"));
  assert.equal((await linear.issue(claimed.issue.id))?.stateName, "Done");
  const view = await status(board);
  assert.equal(view.tasks["A-1"]?.verified, "unverified");
  assert.ok(
    view.attention?.some(
      (item) =>
        item.kind === "flag" && item.check === "vibecheck.commit-honesty",
    ),
    "the flagged done-time check is shown",
  );
});

test("defect 2: a parent completed without a report is unverified although its children are verified", async (t) => {
  const { board, linear } = createLedger(t, { script: () => 0.1 });
  const root = await join(board);
  await publish(board, root, [
    { key: "P-1", title: "Parent", goal: "Both parts work", criteria: ["c"] },
    {
      key: "C-1",
      title: "Child",
      goal: "The child part works",
      criteria: ["the child part works"],
      parent: "P-1",
    },
  ]);
  const child = await claim(board, root, "C-1");
  await update(board, root, child.work.id, {
    status: "complete",
    report: "The child part works and is tested.",
  });
  assert.equal((await status(board)).tasks["C-1"]?.verified, "verified");
  const parent = await claim(board, root, "P-1");
  const done = await update(board, root, parent.work.id, {
    status: "complete",
  });
  assert.equal(done.tasks[0]?.status, "complete");
  assert.equal((await status(board)).tasks["P-1"]?.verified, "unverified");
  assert.ok(
    !(await labelNames(linear, parent.issue.identifier)).includes(
      "vc:verified",
    ),
  );
});

// ---------------------------------------------------------------------------
// 3. Stale claims
// ---------------------------------------------------------------------------

test("defect 3: archived claimed work is abandoned, its claim comment closed and vc:claimed removed, so the task can be claimed again", async (t) => {
  const { board, linear, store } = createLedger(t);
  const root = await join(board);
  await publish(board, root);
  const claimed = await claim(board, root, "A-1");
  await status(board);
  linear.archiveIssue(claimed.issue.id);
  await status(board);
  assert.deepEqual(
    store.allWork(PROJECT_KEY).map((work) => work.status),
    ["abandoned"],
  );
  editIssue(linear, claimed.issue.id, { archived: false });
  await status(board);
  const bodies = await commentBodies(linear, claimed.issue.identifier);
  assert.ok(
    bodies.some((body) =>
      body.includes(`vibecheck claim · work ${claimed.work.id} · abandoned`),
    ),
  );
  assert.ok(
    !(await labelNames(linear, claimed.issue.identifier)).includes(
      "vc:claimed",
    ),
  );
  const second = await join(board, "second");
  const again = await claim(board, second, "A-1");
  assert.equal(again.issue.id, claimed.issue.id);
});

test("defect 3: an open claim comment of unknown, stale work blocks with a stale_claim hint until force_release closes it", async (t) => {
  const { board, linear } = createLedger(t);
  const root = await join(board);
  await publish(board, root);
  const issue = await linear.issue("TA-1");
  assert.ok(issue !== null);
  const ghost = await linear.createComment({
    issueId: issue.id,
    body: renderClaimComment(
      { vendor: "codex", model: "m", sessionId: "s_elsewhere" },
      "w_ghost",
    ),
  });
  await assert.rejects(claim(board, root, "A-1"), (error: unknown) => {
    const parsed = z
      .object({
        code: z.literal("conflict"),
        details: z.object({
          work_id: z.literal("w_ghost"),
          stale_claim: z.literal(true),
          next_step: z.string(),
        }),
      })
      .parse(error);
    assert.match(parsed.details.next_step, /force_release/u);
    return true;
  });
  const forced = await board.call("work_claim", {
    project_id: PROJECT,
    request_id: request(),
    session_id: root,
    task_id: "A-1",
    force_release: true,
  });
  assert.ok("work" in forced);
  const bodies = await commentBodies(linear, "TA-1");
  assert.ok(
    bodies.some(
      (body) =>
        body.includes("vibecheck claim · work w_ghost · abandoned") &&
        body.startsWith(ghost.body.split("\n")[0] ?? ""),
    ),
  );
});

test("defect 3: a fresh claim comment of unknown work is a plain conflict that force_release does not override", async (t) => {
  let clock = Date.now();
  const linear = new MemoryLinearApi({ now: () => clock++ });
  const { board } = createLedger(t, { linear });
  const root = await join(board);
  await publish(board, root);
  const issue = await linear.issue("TA-1");
  assert.ok(issue !== null);
  await linear.createComment({
    issueId: issue.id,
    body: renderClaimComment(
      { vendor: "codex", model: "m", sessionId: "s_elsewhere" },
      "w_live",
    ),
  });
  await assert.rejects(
    board.call("work_claim", {
      project_id: PROJECT,
      request_id: request(),
      session_id: root,
      task_id: "A-1",
      force_release: true,
    }),
    (error: unknown) => {
      const parsed = z
        .object({
          code: z.literal("conflict"),
          details: z.object({ work_id: z.literal("w_live") }).passthrough(),
        })
        .parse(error);
      assert.equal(
        z.object({ stale_claim: z.boolean().optional() }).parse(parsed.details)
          .stale_claim,
        undefined,
      );
      return true;
    },
  );
});

test("defect 3: a claim comment left open by finished local work, or written by this machine for unrecorded work, no longer blocks", async (t) => {
  const { board, linear } = createLedger(t);
  const root = await join(board);
  await publish(board, root);
  const first = await claim(board, root, "A-1");
  await update(board, root, first.work.id, { action: "release" });
  // The release edit was lost: the comment still says open.
  const left = (await linear.comments(first.issue.id)).find((comment) =>
    comment.body.includes(`work ${first.work.id}`),
  );
  assert.ok(left !== undefined);
  await linear.updateComment(left.id, withClaimStatus(left.body, "open"));
  // And this machine's session wrote a claim it never recorded (a crash).
  await linear.createComment({
    issueId: first.issue.id,
    body: renderClaimComment(
      { vendor: "claude-code", model: "test-model", sessionId: root },
      "w_orphan",
    ),
  });
  const second = await join(board, "second");
  await claim(board, second, "A-1");
  const bodies = await commentBodies(linear, "TA-1");
  assert.ok(
    bodies.some((body) => body.includes(`work ${first.work.id} · abandoned`)),
  );
  assert.ok(bodies.some((body) => body.includes("work w_orphan · abandoned")));
});

test("defect 3: a claim row cut off before its comment id was saved is settled from Linear", async (t) => {
  const { board, linear, store } = createLedger(t);
  const root = await join(board);
  await publish(board, root);
  await status(board);
  const issue = await linear.issue("TA-1");
  const other = await linear.issue("TA-2");
  assert.ok(issue !== null && other !== null);
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = (id: string, issueId: string, identifier: string): WorkRow => ({
    id: workIdOf(id),
    projectKey: projectKeyOf(PROJECT),
    issueId,
    identifier,
    sessionId: sessionIdOf(root),
    status: "in_progress",
    blocker: null,
    location: {
      repository: null,
      checkout: null,
      branch: null,
      targetBranch: null,
      baseCommit: null,
      paths: [],
    },
    commit: null,
    integrationCommit: null,
    integrationRequired: false,
    claimCommentId: null,
    predecessorWorkId: null,
    revision: 1,
    createdAt: old,
    updatedAt: old,
  });
  store.putWork(row("w_landed", issue.id, issue.identifier));
  store.putWork(row("w_lost", other.id, other.identifier));
  const landed = await linear.createComment({
    issueId: issue.id,
    body: renderClaimComment(
      { vendor: "claude-code", model: "test-model", sessionId: root },
      "w_landed",
    ),
  });
  await status(board);
  assert.equal(store.work(workIdOf("w_landed"))?.claimCommentId, landed.id);
  assert.equal(store.work(workIdOf("w_landed"))?.status, "in_progress");
  assert.equal(store.work(workIdOf("w_lost"))?.status, "released");
});

// ---------------------------------------------------------------------------
// 4. As-is re-checks write nothing on issues no agent claimed
// ---------------------------------------------------------------------------

test("defect 4: in as_is projects a re-check of an issue a person closed writes nothing to Linear unless an agent claimed it", async (t) => {
  const linear = new MemoryLinearApi();
  const { project, structured } = await existingProject(linear);
  const other = await linear.createIssue({
    teamId: linear.teamId,
    projectId: project.id,
    title: "Claimed then released",
    description: "## Acceptance criteria\n\n- [ ] it works\n",
  });
  const { board } = createLedger(t, { linear, script: () => 0.1 });
  const root = await join(board, "root", {
    linear_project: project.id,
    adopt: "as_is",
  });
  const claimed = await claim(board, root, other.identifier);
  await update(board, root, claimed.work.id, { action: "release" });
  await status(board);
  const done = await stateOf(linear, "completed");
  linear.moveIssue(structured.id, done.id);
  linear.moveIssue(other.id, done.id);
  const view = await status(board);
  assert.deepEqual(await labelNames(linear, structured.identifier), []);
  assert.deepEqual(await commentBodies(linear, structured.identifier), []);
  assert.ok(
    view.attention?.some(
      (item) =>
        item.kind === "unverified_done" &&
        item.task_id === structured.identifier,
    ),
    "the result is in attention",
  );
  assert.ok(
    (await labelNames(linear, other.identifier)).includes("vc:unverified"),
    "an issue an agent claimed is still labelled",
  );
});

// ---------------------------------------------------------------------------
// 5. work_update keeps Linear and the local store in step
// ---------------------------------------------------------------------------

test("defect 5 (superseded by R3-r2): completing work whose claim comment a person deleted is refused as claim_lost and moves nothing", async (t) => {
  const { board, linear, store } = createLedger(t);
  const root = await join(board);
  await publish(board, root);
  const claimed = await claim(board, root, "A-1");
  const comment = (await linear.comments(claimed.issue.id)).find((entry) =>
    entry.body.includes("vibecheck claim"),
  );
  assert.ok(comment !== undefined);
  await linear.deleteComment(comment.id);
  await rejectsCode(
    update(board, root, claimed.work.id, {
      status: "complete",
      report: "finished",
    }),
    "conflict",
    /lost its claim.*was deleted in Linear/su,
  );
  assert.deepEqual(
    store.allWork(PROJECT_KEY).map((work) => work.status),
    ["released"],
  );
  assert.equal(
    (await linear.issue(claimed.issue.id))?.stateName,
    "In Progress",
  );
  // Nobody holds it now: the next call takes vc:claimed off.
  await status(board);
  assert.ok(
    !(await labelNames(linear, claimed.issue.identifier)).includes(
      "vc:claimed",
    ),
  );
});

test("defect 5: a Linear failure that aborts a change leaves the work as it was, and a retry applies it", async (t) => {
  const real = new MemoryLinearApi();
  const armed = { count: 0 };
  const linear = failing(
    real,
    "updateIssue",
    () => new LinearError("invalid", "Injected rejection"),
    armed,
  );
  const { board, store } = createLedger(t, { linear });
  const root = await join(board);
  await publish(board, root);
  const claimed = await claim(board, root, "A-1");
  armed.count = 1;
  await rejectsCode(
    update(board, root, claimed.work.id, {
      status: "complete",
      report: "finished",
    }),
    "invalid",
  );
  assert.equal(store.work(workIdOf(claimed.work.id))?.status, "in_progress");
  const retry = await update(board, root, claimed.work.id, {
    status: "complete",
    report: "finished",
  });
  assert.equal(retry.tasks[0]?.status, "complete");
  assert.equal((await real.issue(claimed.issue.id))?.stateName, "Done");
});

test("defect 5: in a batch each change applies or fails as a unit and the result lists both", async (t) => {
  const real = new MemoryLinearApi();
  const armed = { count: 0 };
  const linear = failing(
    real,
    "updateIssue",
    () => new LinearError("invalid", "Injected rejection"),
    armed,
  );
  const { board, store } = createLedger(t, { linear });
  const root = await join(board);
  await publish(board, root, [
    { key: "A-1", title: "First", criteria: ["one"] },
    { key: "B-1", title: "Second", criteria: ["two"] },
  ]);
  const first = await claim(board, root, "A-1");
  const second = await claim(board, root, "B-1");
  armed.count = 1;
  const result = z
    .object({
      results: z.array(
        z.object({
          work_id: z.string(),
          outcome: z.string(),
          error: z.object({ code: z.string() }).optional(),
        }),
      ),
    })
    .parse(
      await board.call("work_update", {
        project_id: PROJECT,
        request_id: request(),
        session_id: root,
        updates: [
          { work_id: first.work.id, status: "complete", report: "done one" },
          { work_id: second.work.id, status: "complete", report: "done two" },
        ],
      }),
    );
  assert.deepEqual(
    result.results.map((entry) => [entry.work_id, entry.outcome]),
    [
      [first.work.id, "failed"],
      [second.work.id, "applied"],
    ],
  );
  assert.equal(result.results[0]?.error?.code, "invalid");
  assert.equal(store.work(workIdOf(first.work.id))?.status, "in_progress");
  assert.equal(store.work(workIdOf(second.work.id))?.status, "complete");
});

// ---------------------------------------------------------------------------
// 6. Claimed issues that leave the project
// ---------------------------------------------------------------------------

test("defect 6: a claimed issue moved to another project is detected, its work abandoned and its claim closed, and it is never moved", async (t) => {
  const { board, linear, store } = createLedger(t);
  const root = await join(board);
  await publish(board, root);
  const claimed = await claim(board, root, "A-1");
  await status(board);
  const other = await linear.createProject({
    name: "other-project",
    teamIds: [linear.teamId],
  });
  editIssue(linear, claimed.issue.id, { projectId: other.id });
  const view = await status(board);
  assert.ok(
    view.attention?.some(
      (item) =>
        item.kind === "removed" && /left the project/u.test(item.reason),
    ),
  );
  assert.deepEqual(
    store.allWork(PROJECT_KEY).map((work) => work.status),
    ["abandoned"],
  );
  assert.ok(
    !store
      .cachedIssues(PROJECT_KEY)
      .some((issue) => issue.id === claimed.issue.id),
  );
  assert.ok(
    (await commentBodies(linear, claimed.issue.identifier)).some((body) =>
      body.includes(`work ${claimed.work.id} · abandoned`),
    ),
  );
  await rejectsCode(
    update(board, root, claimed.work.id, {
      status: "complete",
      report: "done",
    }),
    "conflict",
  );
  const after = await linear.issue(claimed.issue.id);
  assert.equal(after?.projectId, other.id);
  assert.equal(after?.stateName, "In Progress");
});

// ---------------------------------------------------------------------------
// 7. Re-check events survive a failure
// ---------------------------------------------------------------------------

test("defect 7: a re-check that fails part-way stays queued, status reports it, and the next run completes it", async (t) => {
  const real = new MemoryLinearApi();
  const armed = { count: 0 };
  const linear = failing(
    real,
    "comments",
    () => new LinearError("network", "blip"),
    armed,
  );
  const { board, store } = createLedger(t, { linear, script: () => 0.1 });
  const root = await join(board);
  await publish(board, root);
  await status(board);
  const issue = await real.issue("TA-1");
  assert.ok(issue !== null);
  real.moveIssue(issue.id, (await stateOf(real, "completed")).id);
  armed.count = 1;
  const first = await status(board);
  assert.equal(first.sync.pending_rechecks, 1);
  assert.equal(store.events(PROJECT_KEY, { kinds: ["recheck"] }).length, 1);
  const second = await status(board);
  assert.equal(second.sync.pending_rechecks, undefined);
  assert.equal(second.tasks["A-1"]?.verified, "unverified");
  assert.ok((await labelNames(real, "TA-1")).includes("vc:unverified"));
});

// ---------------------------------------------------------------------------
// 8. Queued state moves a person overtook
// ---------------------------------------------------------------------------

test("defect 8: a pending completion is abandoned, not moved, when a person moved the issue first, and shows as skipped_move", async (t) => {
  const real = new MemoryLinearApi();
  const armed = { count: 0 };
  const linear = failing(
    real,
    "updateIssue",
    () => new LinearError("network", "blip"),
    armed,
  );
  const { board, store } = createLedger(t, { linear });
  const root = await join(board);
  await publish(board, root);
  const claimed = await claim(board, root, "A-1");
  armed.count = 1;
  const failure = await failureOf(
    update(board, root, claimed.work.id, {
      status: "complete",
      report: "finished",
    }),
  );
  assert.equal(failure.code, "unavailable");
  assert.equal(detail(failure, "completion"), "pending");
  assert.equal(
    store.pending(100).filter((row) => row.kind === "update_issue").length,
    0,
    "no state move is queued outside the plan",
  );
  real.moveIssue(claimed.issue.id, (await stateOf(real, "canceled")).id);
  const view = await status(board);
  assert.equal((await real.issue(claimed.issue.id))?.stateName, "Canceled");
  assert.equal(store.pendingCompletions(PROJECT_KEY).length, 0);
  assert.equal(store.work(workIdOf(claimed.work.id))?.status, "in_progress");
  assert.ok(view.attention?.some((item) => item.kind === "skipped_move"));
  assert.ok(
    !(await commentBodies(real, claimed.issue.identifier)).some((body) =>
      body.startsWith("**Done**"),
    ),
  );
});

// ---------------------------------------------------------------------------
// 9. Single-select group labels on existing issues
// ---------------------------------------------------------------------------

async function groupedProject(linear: MemoryLinearApi) {
  const project = await linear.createProject({
    name: "vc-test-existing",
    teamIds: [linear.teamId],
  });
  const group = await linear.createLabel({
    name: "Kind",
    color: "#123456",
    isGroup: true,
    groupType: "singleSelect",
  });
  const bug = await linear.createLabel({
    name: "Bug",
    color: "#123456",
    parentId: group.id,
  });
  const issue = await linear.createIssue({
    teamId: linear.teamId,
    projectId: project.id,
    title: "First owner issue",
    labelIds: [bug.id],
  });
  return { project, issue };
}

test("defect 9: a plan group label on an issue that has another label of the group is a set value in managed mode, shown in the dry run", async (t) => {
  const linear = new MemoryLinearApi();
  const { project, issue } = await groupedProject(linear);
  const { board, store } = createLedger(t, { linear });
  const root = await join(board, "root", {
    linear_project: project.id,
    adopt: "managed",
  });
  const plan = {
    project_id: PROJECT,
    session_id: root,
    expected_revision: 0,
    project: { name: "x", icon: "Skull" },
    label_groups: [
      { name: "Kind", labels: [{ name: "Bug" }, { name: "Feature" }] },
    ],
    tasks: [
      {
        key: "NEW-1",
        title: "A new task",
        goal: "g",
        criteria: ["c"],
        labels: ["Feature"],
      },
      {
        key: issue.identifier,
        title: "First owner issue",
        labels: ["Feature"],
      },
    ],
  };
  const dry = dryRunSchema.parse(
    await acceptingProblems(board, "plan_publish", {
      ...plan,
      request_id: request(),
    }),
  );
  assert.ok(
    dry.skipped?.some(
      (entry) =>
        entry.key === issue.identifier && entry.field === "labels:kind",
    ),
  );
  await acceptingProblems(board, "plan_publish", {
    ...plan,
    request_id: request(),
    confirm: true,
  });
  assert.deepEqual(await labelNames(linear, issue.identifier), ["Bug"]);
  assert.equal(store.project(PROJECT_KEY)?.planRevision, 1);

  // Named in overwrite, the old label of the group is replaced in one update.
  await acceptingProblems(board, "plan_publish", {
    ...plan,
    expected_revision: 1,
    request_id: request(),
    overwrite: [`tasks.${issue.identifier}.labels`],
  });
  assert.deepEqual(await labelNames(linear, issue.identifier), ["Feature"]);
});

test("defect 9: two labels of one existing Linear group on a task fail validation and nothing is written", async (t) => {
  const linear = new MemoryLinearApi();
  const kind = await linear.createLabel({
    name: "Kind",
    color: "#123456",
    isGroup: true,
    groupType: "singleSelect",
  });
  for (const name of ["Bug", "Chore"])
    await linear.createLabel({ name, color: "#123456", parentId: kind.id });
  const { board } = createLedger(t, { linear });
  const root = await join(board);
  const before = JSON.stringify(linear.exportState());
  await rejectsCode(
    publish(board, root, [
      { key: "NEW-1", title: "A new task", labels: ["Bug", "Chore"] },
    ]),
    "invalid",
    /Linear label group Kind/u,
  );
  assert.equal(JSON.stringify(linear.exportState()), before);
});

// ---------------------------------------------------------------------------
// 10. Human replies are compared with the claim's reports
// ---------------------------------------------------------------------------

test("defect 10: a person's reply is shown even when a verdict comment was posted after it", async (t) => {
  const { board, linear, store } = createLedger(t);
  const root = await join(board);
  await publish(board, root);
  const claimed = await claim(board, root, "A-1");
  await status(board);
  store.enqueue({
    projectKey: PROJECT_KEY,
    kind: "comment",
    payload: {
      id: randomUUID(),
      issueId: claimed.issue.id,
      body: renderVerdictComment(
        { vendor: "claude-code", model: "m", sessionId: root },
        "vibecheck.stop-reason",
        "flagged",
        "hook verdict",
      ),
    },
  });
  linear.addHumanComment(
    claimed.issue.id,
    "Please do NOT touch the save format.",
  );
  const view = await status(board);
  assert.ok(view.attention?.some((item) => item.kind === "human_reply"));
  assert.equal(store.events(PROJECT_KEY, { kinds: ["human_reply"] }).length, 1);
});

// ---------------------------------------------------------------------------
// 11. A claim racing a completion
// ---------------------------------------------------------------------------

test("defect 11: a claim that finds the issue closed before its state move returns task_closed and takes its comment and labels back", async (t) => {
  const shared = new MemoryLinearApi();
  const first = createLedger(t, { linear: shared });
  const root = await join(first.board);
  const published = z
    .object({ linear_project_id: z.string() })
    .parse(
      await publish(first.board, root, [
        { key: "F-1", title: "Forms", goal: "g", criteria: ["c"] },
      ]),
    );
  let gate = true;
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached: () => void = () => {};
  const reading = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gated = new Proxy(shared, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "comments")
        return async (id: string) => {
          const read: unknown = await Reflect.apply(value, target, [id]);
          if (gate) {
            gate = false;
            reached();
            await waiting;
          }
          return read;
        };
      return value.bind(target);
    },
  });
  const a = createLedger(t, { linear: shared });
  const b = createLedger(t, { linear: gated });
  const sessionA = await join(a.board, "a", {
    linear_project: published.linear_project_id,
  });
  const sessionB = await join(b.board, "b", {
    linear_project: published.linear_project_id,
    vendor: "codex",
  });
  const claimB = claim(b.board, sessionB, "F-1").then(
    () => undefined,
    (error: unknown) => error,
  );
  await reading;
  const claimA = await claim(a.board, sessionA, "F-1");
  await update(a.board, sessionA, claimA.work.id, {
    status: "complete",
    report: "done, the forms reject empty fields",
  });
  release();
  const failure = z
    .object({
      code: z.literal("conflict"),
      details: z.object({ reason: z.literal("task_closed") }),
    })
    .parse(await claimB);
  assert.equal(failure.code, "conflict");
  const issue = await shared.issue(claimA.issue.id);
  assert.equal(issue?.stateName, "Done");
  const labels = await labelNames(shared, claimA.issue.identifier);
  assert.ok(!labels.includes("vc:claimed"));
  assert.ok(!labels.includes("agent:codex"));
  assert.ok(
    !(await commentBodies(shared, claimA.issue.identifier)).some((body) =>
      /vibecheck claim · work \S+ · open/u.test(body),
    ),
  );
});

// ---------------------------------------------------------------------------
// 12. confirm needs the dry run it confirms
// ---------------------------------------------------------------------------

test("defect 12: confirm without a matching dry run returns the dry run; issue_adopt in managed mode follows the same rule", async (t) => {
  const linear = new MemoryLinearApi();
  const { project, structured } = await existingProject(linear);
  const { board } = createLedger(t, { linear });
  const root = await join(board, "root", {
    linear_project: project.id,
    adopt: "managed",
  });
  const adopt = {
    project_id: PROJECT,
    session_id: root,
    issue: structured.identifier,
    key: "SAVE-1",
  };
  const before = JSON.stringify(linear.exportState());
  const blind = dryRunSchema.parse(
    await acceptingProblems(board, "issue_adopt", {
      ...adopt,
      request_id: request(),
      confirm: true,
    }),
  );
  assert.match(blind.message, /had not been shown/u);
  assert.equal(JSON.stringify(linear.exportState()), before);
  const written = z
    .object({ written: z.literal(true), plan_revision: z.literal(1) })
    .parse(
      await acceptingProblems(board, "issue_adopt", {
        ...adopt,
        request_id: request(),
        confirm: true,
      }),
    );
  assert.equal(written.written, true);
  const planDoc = (await linear.documents(project.id)).find(
    (doc) => doc.title === PLAN_DOCUMENT_TITLE,
  );
  assert.equal(parsePlanDocument(planDoc?.content ?? "")?.origin, "adopted");
});

test("defect 12: a confirmed plan must be the one whose dry run was shown", async (t) => {
  const linear = new MemoryLinearApi();
  const { project } = await existingProject(linear);
  const { board } = createLedger(t, { linear });
  const root = await join(board, "root", {
    linear_project: project.id,
    adopt: "managed",
  });
  const plan = {
    project_id: PROJECT,
    session_id: root,
    expected_revision: 0,
    project: { name: "vc-test-existing", icon: "Skull" },
    tasks: [{ key: "NEW-1", title: "New", goal: "g", criteria: ["c"] }],
  };
  dryRunSchema.parse(
    await acceptingProblems(board, "plan_publish", {
      ...plan,
      request_id: request(),
    }),
  );
  const before = JSON.stringify(linear.exportState());
  const changed = dryRunSchema.parse(
    await acceptingProblems(board, "plan_publish", {
      ...plan,
      project: { ...plan.project, icon: "Rocket" },
      request_id: request(),
      confirm: true,
    }),
  );
  assert.match(changed.message, /had not been shown/u);
  assert.equal(JSON.stringify(linear.exportState()), before);
  const applied = z.object({ plan_revision: z.literal(1) }).parse(
    await acceptingProblems(board, "plan_publish", {
      ...plan,
      project: { ...plan.project, icon: "Rocket" },
      request_id: request(),
      confirm: true,
    }),
  );
  assert.equal(applied.plan_revision, 1);
  assert.equal((await linear.project(project.id))?.icon, "Rocket");
});

// ---------------------------------------------------------------------------
// 13. The reconciler cursor and managed fill-empty
// ---------------------------------------------------------------------------

test("defect 13: an update in the cursor's own millisecond is not skipped", async (t) => {
  const fixed = Date.parse("2026-03-01T00:00:00.000Z");
  const linear = new MemoryLinearApi({ now: () => fixed });
  const { board } = createLedger(t, { linear, script: () => 0.1 });
  const root = await join(board);
  await publish(board, root);
  await status(board);
  const issue = await linear.issue("TA-1");
  assert.ok(issue !== null);
  linear.moveIssue(issue.id, (await stateOf(linear, "completed")).id);
  assert.equal((await linear.issue("TA-1"))?.updatedAt, issue.updatedAt);
  const view = await status(board);
  assert.equal(view.tasks["A-1"]?.status, "complete");
  assert.equal(view.tasks["A-1"]?.verified, "unverified");
});

test("defect 13: managed mode keeps an estimate of 0 a person set", async (t) => {
  const linear = new MemoryLinearApi();
  const { project, structured } = await existingProject(linear);
  await linear.updateIssue(structured.id, { estimate: 0 });
  const { board } = createLedger(t, { linear });
  const root = await join(board, "root", {
    linear_project: project.id,
    adopt: "managed",
  });
  const plan = {
    project_id: PROJECT,
    session_id: root,
    expected_revision: 0,
    project: { name: "vc-test-existing" },
    tasks: [{ key: structured.identifier, title: "t", estimate: 3 }],
  };
  const dry = dryRunSchema.parse(
    await acceptingProblems(board, "plan_publish", {
      ...plan,
      request_id: request(),
    }),
  );
  assert.ok(
    dry.skipped?.some(
      (entry) =>
        entry.key === structured.identifier && entry.field === "estimate",
    ),
  );
  await acceptingProblems(board, "plan_publish", {
    ...plan,
    request_id: request(),
    confirm: true,
  });
  assert.equal((await linear.issue(structured.id))?.estimate, 0);
  assert.equal((await linear.issue(structured.id))?.priority, 3);
});

// ---------------------------------------------------------------------------
// 15. vc:stalled and vc:needs-user
// ---------------------------------------------------------------------------

test("defect 15: vc:stalled follows the stalled check and vc:needs-user follows blocker triage", async (t) => {
  let stuck = 0.9;
  let needs = "user";
  const { board, linear } = createLedger(t, {
    script: (battery, question) => {
      if (battery === "vibecheck.stalled")
        return question === "stuck" ? stuck : 0.1;
      if (battery === "vibecheck.blocker-triage")
        return question === "needs" ? needs : "normal";
      return 0.1;
    },
  });
  const root = await join(board);
  await publish(board, root);
  const claimed = await claim(board, root, "A-1");
  const identifier = claimed.issue.identifier;
  for (let index = 0; index < 4; index++)
    await update(board, root, claimed.work.id, {
      report: "Still fixing the same failing test.",
    });
  assert.ok((await labelNames(linear, identifier)).includes("vc:stalled"));
  stuck = 0.1;
  await update(board, root, claimed.work.id, {
    report: "The failing test passes now; moving to the next part.",
  });
  assert.ok(!(await labelNames(linear, identifier)).includes("vc:stalled"));

  await update(board, root, claimed.work.id, {
    status: "blocked",
    blocker: "Waiting for the user to choose the error wording.",
  });
  assert.ok((await labelNames(linear, identifier)).includes("vc:needs-user"));
  needs = "agent";
  await update(board, root, claimed.work.id, {
    status: "in_progress",
    blocker: null,
    report: "The wording is chosen; continuing.",
  });
  assert.ok(!(await labelNames(linear, identifier)).includes("vc:needs-user"));
});

// ---------------------------------------------------------------------------
// 16. Claim overlaps relate the two issues
// ---------------------------------------------------------------------------

test("defect 16: a flagged claim overlap relates the two issues; a flagged task duplicate does not", async (t) => {
  const { board, linear } = createLedger(t, {
    script: (battery, question) =>
      (battery === "vibecheck.claim-overlap" ||
        battery === "vibecheck.task-duplicate") &&
      question === "duplicate"
        ? 0.9
        : 0.1,
  });
  const root = await join(board);
  await publish(board, root, [
    { key: "CSV-1", title: "CSV download on the reports page" },
    { key: "EXPORT-1", title: "Export the reports table as CSV" },
  ]);
  const first = await claim(board, root, "CSV-1");
  const second = await claim(board, root, "EXPORT-1");
  assert.equal(second.verification?.[0]?.outcome, "flagged");
  const relations = await linear.relations(second.issue.id);
  assert.ok(
    relations.some(
      (relation) =>
        relation.type === "related" &&
        [relation.issueId, relation.relatedIssueId].includes(first.issue.id),
    ),
  );
  const edit = await acceptingProblems(board, "plan_edit", {
    project_id: PROJECT,
    request_id: request(),
    session_id: root,
    expected_revision: 1,
    operations: [
      {
        op: "add_task",
        task: { key: "CSV-2", title: "CSV download for the reports page" },
      },
    ],
  });
  assert.ok(JSON.stringify(edit).includes("vibecheck.task-duplicate"));
  const added = await linear.issue("TA-3");
  assert.ok(added !== null);
  assert.deepEqual(await linear.relations(added.id), []);
});

test("defect 16: claim overlaps create no relation in as_is projects", async (t) => {
  const linear = new MemoryLinearApi();
  const { project, structured } = await existingProject(linear);
  const second = await linear.createIssue({
    teamId: linear.teamId,
    projectId: project.id,
    title: "Save identity runs out",
  });
  const { board } = createLedger(t, {
    linear,
    script: (battery, question) =>
      battery === "vibecheck.claim-overlap" && question === "duplicate"
        ? 0.9
        : 0.1,
  });
  const root = await join(board, "root", {
    linear_project: project.id,
    adopt: "as_is",
  });
  await claim(board, root, structured.identifier);
  const later = await claim(board, root, second.identifier);
  assert.equal(later.verification?.[0]?.outcome, "flagged");
  assert.deepEqual(await linear.relations(second.id), []);
});

// ---------------------------------------------------------------------------
// 17. Completeness recommends Kind and Area groups
// ---------------------------------------------------------------------------

test("defect 17: completeness recommends Kind and Area label groups when the plan declares neither", async (t) => {
  const { board } = createLedger(t);
  const root = await join(board);
  const result = z
    .object({
      completeness: z.object({
        recommended: z.object({ label_groups: z.array(z.string()) }).optional(),
      }),
    })
    .parse(await publish(board, root));
  assert.deepEqual(result.completeness.recommended?.label_groups, [
    "Kind",
    "Area",
  ]);
  const second = createLedger(t);
  const other = await join(second.board);
  const grouped = z
    .object({
      completeness: z.object({ recommended: z.unknown().optional() }),
    })
    .parse(
      await publish(
        second.board,
        other,
        [{ key: "A-1", title: "Task", labels: ["Bug", "Save"] }],
        {
          label_groups: [
            { name: "kind", labels: [{ name: "Bug" }] },
            { name: "AREA", labels: [{ name: "Save" }] },
          ],
        },
      ),
    );
  assert.equal(grouped.completeness.recommended, undefined);
});

// ===========================================================================
// Second review (R2): defects a second refutation review found.
// ===========================================================================

/** MemoryLinearApi whose next state moves or comment edits can be made to fail. */
class FlakyLinear extends MemoryLinearApi {
  /** Failures for the next state moves, optionally of one issue only. */
  readonly moveFailures: { kind: LinearErrorKind; issueId?: string }[] = [];
  /** Failures for the next comment edits. */
  readonly editFailures: LinearErrorKind[] = [];

  override async updateIssue(id: string, input: IssueFields): Promise<Issue> {
    if (input.stateId !== undefined) {
      const index = this.moveFailures.findIndex(
        (failure) => failure.issueId === undefined || failure.issueId === id,
      );
      const failure = index < 0 ? undefined : this.moveFailures[index];
      if (failure !== undefined) {
        this.moveFailures.splice(index, 1);
        throw new LinearError(
          failure.kind,
          failure.kind === "invalid"
            ? "state transition not allowed by workflow"
            : "injected failure",
        );
      }
    }
    return super.updateIssue(id, input);
  }

  override async updateComment(id: string, body: string): Promise<Comment> {
    const kind = this.editFailures.shift();
    if (kind !== undefined) throw new LinearError(kind, "injected failure");
    return super.updateComment(id, body);
  }
}

/** A shared Linear clock and board clock, advanced by hand. */
function manualClock() {
  const clock = { at: Date.parse("2026-10-01T00:00:00Z") };
  return {
    clock,
    linearNow: () => clock.at++,
    boardNow: () => new Date(clock.at),
    advance: (ms: number) => {
      clock.at += ms;
    },
  };
}

const HOUR = 3_600_000;
const publishedSchema = z.object({ linear_project_id: z.string() });

/** The claim lines (`vibecheck claim · ...`) on an issue, oldest first. */
async function claimLines(
  linear: MemoryLinearApi,
  issueId: string,
): Promise<string[]> {
  return (await linear.comments(issueId)).flatMap((comment) => {
    const line = comment.body
      .split("\n")
      .find((entry) => entry.startsWith("vibecheck claim"));
    return line === undefined ? [] : [line];
  });
}

/** A claim line without its `· active <time>` part. */
function withoutActivity(line: string): string {
  return line.replace(/ · active \S+$/u, "");
}

/** Two machines on one Linear workspace, with a published plan. */
async function twoMachines(t: TestContext) {
  const time = manualClock();
  const linear = new MemoryLinearApi({ now: time.linearNow });
  const a = createLedger(t, { linear, now: time.boardNow });
  const b = createLedger(t, { linear, now: time.boardNow });
  const sessionA = await join(a.board, "a");
  const published = publishedSchema.parse(await publish(a.board, sessionA));
  const sessionB = await join(b.board, "b", {
    linear_project: published.linear_project_id,
    vendor: "codex",
  });
  return { ...time, linear, a, b, sessionA, sessionB, published };
}

const attentionSchema = z.object({
  attention: z
    .array(
      z.object({
        kind: z.string(),
        reason: z.string(),
        task_id: z.string(),
        work_id: z.string().optional(),
      }),
    )
    .optional(),
});

test("defect R2-1: replace_work_id naming another machine's live work is refused, like force_release", async (t) => {
  const { a, b, sessionA, sessionB, linear, advance } = await twoMachines(t);
  const claimed = await claim(a.board, sessionA, "A-1");
  advance(60_000);
  await rejectsCode(
    b.board.call("work_claim", {
      project_id: PROJECT,
      request_id: request(),
      session_id: sessionB,
      task_id: "A-1",
      replace_work_id: claimed.work.id,
    }),
    "conflict",
    /claude-code.*replace_work_id may name another machine's work only after/su,
  );
  assert.deepEqual(
    (await claimLines(linear, claimed.issue.id)).map(withoutActivity),
    [`vibecheck claim · work ${claimed.work.id} · open`],
  );
  assert.ok(
    !(await labelNames(linear, claimed.issue.identifier)).includes(
      "agent:codex",
    ),
  );
  // A keeps its claim and finishes the task.
  const done = await update(a.board, sessionA, claimed.work.id, {
    status: "complete",
    report: "A finished it",
  });
  assert.equal(done.tasks[0]?.status, "complete");

  // Once the claim is stale, replace_work_id may name it.
  const other = await claim(a.board, sessionA, "B-1");
  advance(25 * HOUR);
  const replaced = z.object({ work: z.object({ id: z.string() }) }).parse(
    await b.board.call("work_claim", {
      project_id: PROJECT,
      request_id: request(),
      session_id: sessionB,
      task_id: "B-1",
      replace_work_id: other.work.id,
    }),
  );
  assert.deepEqual(
    (await claimLines(linear, other.issue.id)).map(withoutActivity),
    [
      `vibecheck claim · work ${other.work.id} · released (replaced by work ${replaced.work.id})`,
      `vibecheck claim · work ${replaced.work.id} · open`,
    ],
  );
});

test("defect R2-2: a completion whose state move Linear rejects leaves the claim open; the retry posts nothing twice", async (t) => {
  const time = manualClock();
  const linear = new FlakyLinear({ now: time.linearNow });
  const a = createLedger(t, { linear, script: () => 0.1, now: time.boardNow });
  const b = createLedger(t, { linear, now: time.boardNow });
  const session = await join(a.board, "a");
  const published = publishedSchema.parse(await publish(a.board, session));
  const claimed = await claim(a.board, session, "A-1");
  linear.moveFailures.push({ kind: "invalid" });
  const retry = {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    updates: [
      {
        work_id: claimed.work.id,
        status: "complete",
        report: "Finished: the first part is done and tested.",
      },
    ],
  };
  await rejectsCode(a.board.call("work_update", retry), "invalid");
  // Nothing after the move was written: the claim is open, labels unchanged.
  assert.deepEqual(
    (await claimLines(linear, claimed.issue.id)).map(withoutActivity),
    [`vibecheck claim · work ${claimed.work.id} · open`],
  );
  assert.deepEqual(await labelNames(linear, claimed.issue.identifier), [
    "vc:claimed",
    "agent:claude-code",
  ]);
  assert.equal(a.store.work(workIdOf(claimed.work.id))?.status, "in_progress");
  // Another machine cannot take the task in the gap.
  const sessionB = await join(b.board, "b", {
    linear_project: published.linear_project_id,
    vendor: "codex",
  });
  await rejectsCode(claim(b.board, sessionB, "A-1"), "conflict");
  // The retry with the same request_id applies the change once.
  await a.board.call("work_update", retry);
  const bodies = await commentBodies(linear, claimed.issue.identifier);
  assert.equal(bodies.filter((body) => body.startsWith("**Done**")).length, 1);
  assert.equal(
    bodies.filter((body) => body.startsWith("**vibecheck: ")).length,
    1,
  );
  assert.equal((await linear.issue(claimed.issue.id))?.stateType, "completed");
  assert.deepEqual(await claimLines(linear, claimed.issue.id), [
    `vibecheck claim · work ${claimed.work.id} · complete`,
  ]);
});

test("defect R2-2: a retry after the claim comment edit failed reuses the comment ids", async (t) => {
  const linear = new FlakyLinear();
  const { board, store } = createLedger(t, { linear, script: () => 0.1 });
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  linear.editFailures.push("invalid");
  const retry = {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    updates: [
      {
        work_id: claimed.work.id,
        status: "complete",
        report: "Finished: the first part is done and tested.",
      },
    ],
  };
  await rejectsCode(board.call("work_update", retry), "invalid");
  assert.equal(store.work(workIdOf(claimed.work.id))?.status, "in_progress");
  const before = await commentBodies(linear, claimed.issue.identifier);
  assert.equal(before.filter((body) => body.startsWith("**Done**")).length, 1);
  await board.call("work_update", retry);
  const after = await commentBodies(linear, claimed.issue.identifier);
  assert.equal(after.filter((body) => body.startsWith("**Done**")).length, 1);
  assert.equal(
    after.filter((body) => body.startsWith("**vibecheck: ")).length,
    before.filter((body) => body.startsWith("**vibecheck: ")).length,
  );
  assert.equal(store.work(workIdOf(claimed.work.id))?.status, "complete");
});

test("defect R2-3: every work_update records claim activity, so a working claim is never force-released", async (t) => {
  const { a, b, sessionA, sessionB, linear, advance } = await twoMachines(t);
  const claimed = await claim(a.board, sessionA, "A-1");
  advance(20 * HOUR);
  await update(a.board, sessionA, claimed.work.id, {
    commit: "05baa5928c66f6050824e29c6f149125a5246ca0",
  });
  const [line] = await claimLines(linear, claimed.issue.id);
  assert.match(
    line ?? "",
    new RegExp(
      `^vibecheck claim · work ${claimed.work.id} · open · active 2026-10-01T20:`,
      "u",
    ),
  );
  const body = (await linear.comments(claimed.issue.id)).find((comment) =>
    comment.body.includes(`work ${claimed.work.id}`),
  )?.body;
  const parsed = parseClaimComment(body ?? "");
  assert.equal(parsed?.status, "open");
  // Old claim comments without the activity part still parse.
  assert.deepEqual(
    parseClaimComment(
      "**Claimed** by codex (m)\n\nvibecheck claim · work w_old · open\n\n— vibecheck · codex · m · session s_old",
    ),
    { workId: "w_old", status: "open" },
  );
  advance(5 * HOUR);
  await rejectsCode(
    b.board.call("work_claim", {
      project_id: PROJECT,
      request_id: request(),
      session_id: sessionB,
      task_id: "A-1",
      force_release: true,
    }),
    "conflict",
    /already claimed by work/u,
  );
});

test("defect R2-3: a claim another machine force-released becomes claim_lost; later updates are refused", async (t) => {
  const { a, b, sessionA, sessionB, linear, advance } = await twoMachines(t);
  const claimed = await claim(a.board, sessionA, "A-1");
  advance(25 * HOUR);
  const taken = z.object({ work: z.object({ id: z.string() }) }).parse(
    await b.board.call("work_claim", {
      project_id: PROJECT,
      request_id: request(),
      session_id: sessionB,
      task_id: "A-1",
      force_release: true,
    }),
  );
  assert.deepEqual(
    (await claimLines(linear, claimed.issue.id)).map(withoutActivity),
    [
      `vibecheck claim · work ${claimed.work.id} · abandoned (closed by work ${taken.work.id})`,
      `vibecheck claim · work ${taken.work.id} · open`,
    ],
  );
  const seen = attentionSchema.parse(
    await a.board.call("project_status", { project_id: PROJECT, full: true }),
  );
  const lost = seen.attention?.find((item) => item.kind === "claim_lost");
  assert.ok(lost !== undefined, JSON.stringify(seen.attention));
  assert.equal(lost.work_id, claimed.work.id);
  assert.match(lost.reason, new RegExp(`work ${taken.work.id} of codex`, "u"));
  assert.equal(a.store.work(workIdOf(claimed.work.id))?.status, "released");
  await assert.rejects(
    update(a.board, sessionA, claimed.work.id, {
      status: "complete",
      report: "A finished",
    }),
    (error: unknown) => {
      assert.ok(error instanceof BoardError);
      assert.equal(error.code, "conflict");
      assert.match(error.message, /lost its claim/u);
      assert.ok(
        error.details !== undefined &&
          !Array.isArray(error.details) &&
          error.details["reason"] === "claim_lost",
      );
      return true;
    },
  );
  // The issue stays with B, untouched by A.
  assert.equal((await linear.issue(claimed.issue.id))?.stateType, "started");
});

test("defect R2-4: a person's reply found during work_update is returned before it is cleared", async (t) => {
  const { board, linear, store } = createLedger(t);
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  await status(board);
  linear.addHumanComment(claimed.issue.id, "STOP: keep the save format.");
  // A change without a report leaves the reply pending in status.
  await update(board, session, claimed.work.id, {
    commit: "05baa5928c66f6050824e29c6f149125a5246ca0",
  });
  const first = attentionSchema.parse(
    await board.call("project_status", { project_id: PROJECT, full: true }),
  );
  assert.ok(first.attention?.some((item) => item.kind === "human_reply"));
  const result = attentionSchema.parse(
    await board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: session,
      updates: [{ work_id: claimed.work.id, report: "Progress: read it." }],
    }),
  );
  const reply = result.attention?.find((item) => item.kind === "human_reply");
  assert.ok(reply !== undefined, JSON.stringify(result));
  assert.match(reply.reason, /STOP: keep the save format/u);
  assert.equal(store.events(PROJECT_KEY, { kinds: ["human_reply"] }).length, 0);
});

test("defect R2-4: a work_update without a report returns a pending reply but does not clear it", async (t) => {
  const { board, linear, store } = createLedger(t);
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  await status(board);
  linear.addHumanComment(claimed.issue.id, "Please check the tests.");
  const result = attentionSchema.parse(
    await board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: session,
      updates: [
        {
          work_id: claimed.work.id,
          commit: "05baa5928c66f6050824e29c6f149125a5246ca0",
        },
      ],
    }),
  );
  assert.ok(result.attention?.some((item) => item.kind === "human_reply"));
  assert.equal(store.events(PROJECT_KEY, { kinds: ["human_reply"] }).length, 1);
});

test("defect R2-10: a queued move the drain skipped is reported by the next work_update", async (t) => {
  const linear = new FlakyLinear();
  const { board, store } = createLedger(t, { linear });
  const session = await join(board);
  await publish(board, session);
  linear.moveFailures.push({ kind: "network" });
  const claimed = await claim(board, session, "A-1");
  assert.equal(store.pendingCount() > 0, true);
  const todo = await stateOf(linear, "unstarted");
  linear.moveIssue(claimed.issue.id, todo.id);
  const result = attentionSchema.parse(
    await board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: session,
      updates: [{ work_id: claimed.work.id, report: "Progress: halfway." }],
    }),
  );
  assert.ok(
    result.attention?.some((item) => item.kind === "skipped_move"),
    JSON.stringify(result),
  );
  assert.equal((await linear.issue(claimed.issue.id))?.stateId, todo.id);
  assert.equal(
    store.events(PROJECT_KEY, { kinds: ["skipped_move"] }).length,
    0,
  );
});

test("defect R2-5: a plan label that exists in a Linear group keeps that group; managed conflicts are skipped", async (t) => {
  const linear = new MemoryLinearApi();
  const project = await linear.createProject({
    name: "case2",
    teamIds: [linear.teamId],
  });
  const area = await linear.createLabel({
    name: "Area",
    color: "#123456",
    isGroup: true,
    groupType: "singleSelect",
  });
  const bug = await linear.createLabel({
    name: "Bug",
    color: "#123456",
    parentId: area.id,
  });
  const frontend = await linear.createLabel({
    name: "Frontend",
    color: "#123456",
    parentId: area.id,
  });
  const owner = await linear.createIssue({
    teamId: linear.teamId,
    projectId: project.id,
    title: "Owner issue",
    labelIds: [frontend.id],
  });
  const { board, store } = createLedger(t, { linear });
  const session = await join(board, "root", {
    linear_project: project.id,
    adopt: "managed",
  });
  const body = {
    project_id: PROJECT,
    session_id: session,
    expected_revision: 0,
    project: { name: "case2" },
    label_groups: [
      { name: "Kind", labels: [{ name: "Bug" }, { name: "Feature" }] },
    ],
    milestones: [{ code: "M1", name: "First" }],
    tasks: [
      {
        key: "NEW-1",
        title: "new",
        goal: "g",
        criteria: ["c"],
        labels: ["Feature"],
        milestone: "M1",
      },
      { key: owner.identifier, title: "Owner issue", labels: ["Bug"] },
    ],
  };
  const dry = z
    .object({
      dry_run: z.literal(true),
      skipped: z.array(z.object({ key: z.string(), field: z.string() })),
    })
    .parse(
      await acceptingProblems(board, "plan_publish", {
        ...body,
        request_id: request(),
      }),
    );
  assert.deepEqual(dry.skipped, [
    { key: owner.identifier, field: "labels:area" },
  ]);
  await acceptingProblems(board, "plan_publish", {
    ...body,
    request_id: request(),
    confirm: true,
  });
  assert.deepEqual(await labelNames(linear, owner.identifier), ["Frontend"]);
  const labels = await linear.labels(linear.teamId);
  assert.equal(labels.find((label) => label.id === bug.id)?.parentId, area.id);
  assert.equal(store.project(PROJECT_KEY)?.planRevision, 1);
  // Two labels of one real Linear group on one task are a validation error.
  await rejectsCode(
    acceptingProblems(board, "plan_publish", {
      ...body,
      request_id: request(),
      expected_revision: 1,
      tasks: [
        {
          key: "NEW-1",
          title: "new",
          goal: "g",
          criteria: ["c"],
          labels: ["Bug", "Frontend"],
          milestone: "M1",
        },
        { key: owner.identifier, title: "Owner issue", labels: ["Feature"] },
      ],
    }),
    "invalid",
    /Linear label group Area/u,
  );
});

test("defect R2-12: a plan group named like an existing plain label is a validation error naming both", async (t) => {
  const linear = new MemoryLinearApi();
  await linear.createLabel({ name: "Kind", color: "#111111" });
  const { board } = createLedger(t, { linear });
  const session = await join(board);
  await rejectsCode(
    publish(
      board,
      session,
      [{ key: "T-1", title: "t", goal: "g", criteria: ["c"], labels: ["Bug"] }],
      {
        label_groups: [
          { name: "Kind", labels: [{ name: "Bug" }, { name: "Feature" }] },
        ],
      },
    ),
    "invalid",
    /plan label group Kind .* existing Linear label Kind, which is a plain label/u,
  );
  assert.deepEqual(await linear.projects(), []);
});

test("defect R2-6: a state move re-reads the issue: gone from the project means conflict and abandon", async (t) => {
  const { board, linear, store } = createLedger(t);
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  await status(board);
  const other = await linear.createProject({
    name: "someone-elses-project",
    teamIds: [linear.teamId],
  });
  editIssue(linear, claimed.issue.id, { projectId: other.id });
  linear.failNext("network"); // the reconcile read at the start of the call
  await rejectsCode(
    update(board, session, claimed.work.id, {
      status: "complete",
      report: "Done.",
    }),
    "conflict",
    /left the project in Linear, so it was not moved/u,
  );
  const issue = await linear.issue(claimed.issue.id);
  assert.equal(issue?.stateType, "started");
  assert.equal(issue?.projectId, other.id);
  assert.equal(store.work(workIdOf(claimed.work.id))?.status, "abandoned");
  assert.equal(store.events(PROJECT_KEY, { kinds: ["removed"] }).length, 1);
  assert.ok(
    !(await commentBodies(linear, claimed.issue.identifier)).some((body) =>
      body.startsWith("**Done**"),
    ),
  );
});

test("defect R2-6 (with R3-r9): a completion whose move a person overtook is not complete: the claim stays open and the skip is reported", async (t) => {
  const { board, linear, store } = createLedger(t);
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  await status(board);
  const todo = await stateOf(linear, "unstarted");
  linear.moveIssue(claimed.issue.id, todo.id);
  linear.failNext("network"); // the reconcile cannot refresh the cache
  const failure = await failureOf(
    update(board, session, claimed.work.id, {
      status: "complete",
      report: "Done.",
    }),
  );
  assert.equal(failure.code, "conflict");
  assert.equal(detail(failure, "reason"), "skipped_move");
  assert.equal(detail(failure, "completion"), "abandoned");
  assert.equal((await linear.issue(claimed.issue.id))?.stateId, todo.id);
  assert.equal(store.work(workIdOf(claimed.work.id))?.status, "in_progress");
  const result = attentionSchema.parse(
    await board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: session,
      updates: [{ work_id: claimed.work.id, report: "Progress: checking." }],
    }),
  );
  assert.ok(
    result.attention?.some((item) => item.kind === "skipped_move"),
    JSON.stringify(result),
  );
});

test("defect R2-7: a plan write checks expected_revision against the plan document in Linear", async (t) => {
  const { a, b, sessionA, sessionB, linear, published } = await twoMachines(t);
  const base = [
    { key: "A-1", title: "First task", goal: "g", criteria: ["c"] },
    { key: "B-1", title: "Second task" },
  ];
  await acceptingProblems(a.board, "plan_publish", {
    project_id: PROJECT,
    request_id: request(),
    session_id: sessionA,
    expected_revision: 1,
    project: PROJECT_FIELDS,
    tasks: [
      ...base,
      { key: "C-1", title: "A's task", goal: "g", criteria: ["c"] },
    ],
  });
  await rejectsCode(
    acceptingProblems(b.board, "plan_publish", {
      project_id: PROJECT,
      request_id: request(),
      session_id: sessionB,
      expected_revision: 1,
      project: PROJECT_FIELDS,
      tasks: [
        ...base,
        { key: "D-1", title: "B's task", goal: "g", criteria: ["c"] },
      ],
    }),
    "conflict",
    /plan revision 2 recorded in Linear.*plan_read/su,
  );
  assert.equal(b.store.project(PROJECT_KEY)?.planRevision, 2);
  const titles = (
    await linear.issues({ projectId: published.linear_project_id })
  ).nodes.map((issue) => issue.title);
  assert.ok(!titles.some((title) => title.startsWith("D-1")));
});

test("defect R2-8: a verified completion removes vc:held even when the cache is stale", async (t) => {
  let failing = true;
  const { board, linear } = createLedger(t, {
    script: (battery) =>
      battery === "vibecheck.claims-done" ? (failing ? 0.9 : 0.1) : 0.1,
  });
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  await update(board, session, claimed.work.id, {
    status: "complete",
    report: "Done: the first part is done and tested.",
  });
  assert.ok(
    (await labelNames(linear, claimed.issue.identifier)).includes("vc:held"),
  );
  failing = false;
  linear.failNext("network"); // the reconcile read: the cache stays stale
  await update(board, session, claimed.work.id, {
    status: "complete",
    report: "Done: the first part is done and tested; added the tests.",
  });
  const labels = await labelNames(linear, claimed.issue.identifier);
  assert.ok(labels.includes("vc:verified"), labels.join());
  assert.ok(!labels.includes("vc:held"), labels.join());
  assert.ok(!labels.includes("vc:unverified"), labels.join());
});

test("defect R2-9: an unavailable reading on a blocked update adds no vc:unverified; a verified completion clears it", async (t) => {
  let down = false;
  const { board, linear } = createLedger(t, {
    script: () => {
      if (down) throw new ProviderUnavailableError("judgment service down");
      return 0.1;
    },
  });
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  down = true;
  const blocked = await update(board, session, claimed.work.id, {
    status: "blocked",
    blocker: "waiting on the save format decision from the owner",
  });
  assert.ok(
    blocked.verification?.some((item) => item.outcome === "unavailable"),
  );
  assert.ok(
    !(await labelNames(linear, claimed.issue.identifier)).includes(
      "vc:unverified",
    ),
  );
  down = false;
  await update(board, session, claimed.work.id, { status: "in_progress" });
  await update(board, session, claimed.work.id, {
    status: "complete",
    report: "Done: the first part is done and tested.",
  });
  const labels = await labelNames(linear, claimed.issue.identifier);
  assert.ok(labels.includes("vc:verified"), labels.join());
  assert.ok(!labels.includes("vc:unverified"), labels.join());
});

test("defect R2-11: the tool's own Done move, landed by a resumed plan, is not re-checked", async (t) => {
  const linear = new FlakyLinear();
  const { board, store } = createLedger(t, { linear, script: () => 0.1 });
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  linear.moveFailures.push({ kind: "network" });
  await rejectsCode(
    update(board, session, claimed.work.id, { status: "complete" }),
    "unavailable",
  );
  await status(board);
  await status(board);
  assert.equal((await linear.issue(claimed.issue.id))?.stateType, "completed");
  const verdicts = (
    await commentBodies(linear, claimed.issue.identifier)
  ).filter((body) => body.startsWith("**vibecheck: vibecheck.claims-done"));
  assert.equal(verdicts.length, 1, verdicts.join("\n---\n"));
  assert.equal(
    store.events(PROJECT_KEY, { kinds: ["recheck"], all: true }).length,
    0,
  );
  assert.equal(store.work(workIdOf(claimed.work.id))?.status, "complete");
});

test("defect R2-13: a trashed plan or policy document is recreated with a fresh id", async (t) => {
  const { board, linear, store } = createLedger(t);
  const session = await join(board);
  const published = publishedSchema.parse(
    await publish(board, session, undefined, {
      policy: { goal: "Ship the anthology" },
    }),
  );
  const before = await linear.documents(published.linear_project_id);
  for (const document of before) linear.deleteDocument(document.id);
  await acceptingProblems(board, "plan_publish", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    expected_revision: 1,
    project: PROJECT_FIELDS,
    policy: { goal: "Ship the whole anthology" },
    tasks: [
      { key: "A-1", title: "First task", goal: "g", criteria: ["c"] },
      { key: "B-1", title: "Second task", depends_on: ["A-1"] },
    ],
  });
  const after = await linear.documents(published.linear_project_id);
  const plan = after.find((document) => document.title === PLAN_DOCUMENT_TITLE);
  const policy = after.find(
    (document) => document.title === POLICY_DOCUMENT_TITLE,
  );
  assert.ok(plan !== undefined && policy !== undefined);
  assert.ok(!before.some((document) => document.id === plan.id));
  assert.ok(!before.some((document) => document.id === policy.id));
  const row = store.project(PROJECT_KEY);
  assert.equal(row?.planDocumentId, plan.id);
  assert.equal(row?.policyDocumentId, policy.id);
  assert.equal(parsePlanDocument(plan.content)?.revision, 2);
});

test("defect R2-14: a partly failed batch keeps no receipt; its retry re-applies only what did not land", async (t) => {
  const linear = new FlakyLinear();
  const { board, store } = createLedger(t, { linear });
  const session = await join(board);
  await publish(board, session, [
    { key: "A-1", title: "First task", goal: "g", criteria: ["c"] },
    { key: "B-1", title: "Second task", goal: "g", criteria: ["c"] },
  ]);
  const first = await claim(board, session, "A-1");
  const second = await claim(board, session, "B-1");
  linear.moveFailures.push({ kind: "invalid", issueId: second.issue.id });
  const batch = {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    updates: [
      { work_id: first.work.id, status: "complete", report: "Done: first." },
      { work_id: second.work.id, status: "complete", report: "Done: second." },
    ],
  };
  const resultsSchema = z.object({
    results: z.array(z.object({ work_id: z.string(), outcome: z.string() })),
  });
  const failed = resultsSchema.parse(await board.call("work_update", batch));
  assert.deepEqual(
    failed.results.map((entry) => entry.outcome),
    ["applied", "failed"],
  );
  const retried = resultsSchema.parse(await board.call("work_update", batch));
  assert.deepEqual(retried.results, [
    { work_id: first.work.id, outcome: "applied" },
    { work_id: second.work.id, outcome: "applied" },
  ]);
  for (const claimed of [first, second]) {
    assert.equal(store.work(workIdOf(claimed.work.id))?.status, "complete");
    const reports = (
      await commentBodies(linear, claimed.issue.identifier)
    ).filter((body) => body.startsWith("**Done**"));
    assert.equal(reports.length, 1);
  }
  // Now the whole batch landed: the receipt answers a third call as is.
  assert.deepEqual(
    resultsSchema.parse(await board.call("work_update", batch)).results,
    retried.results,
  );
});

// ===========================================================================
// Third review (R3): completion as a recorded, resumable plan, and the
// defects a third refutation review and a live smoke run found.
// ===========================================================================

/** A view of `linear` where every call fails as unreachable while `offline.value`. */
function unreachable(
  linear: MemoryLinearApi,
  offline: { value: boolean },
): MemoryLinearApi {
  return new Proxy(linear, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        offline.value
          ? Promise.reject(new LinearError("network", "offline"))
          : Reflect.apply(value, target, args);
    },
  });
}

/** MemoryLinearApi whose removal of `vc:claimed` can be made to fail. */
class StickyClaimLabel extends MemoryLinearApi {
  failClaimedRemovals = 0;

  override async removeLabel(issueId: string, labelId: string): Promise<void> {
    if (this.failClaimedRemovals > 0) {
      const claimed = (await this.labels(this.teamId)).find(
        (label) => label.name === "vc:claimed",
      );
      if (claimed?.id === labelId) {
        this.failClaimedRemovals -= 1;
        throw new LinearError("invalid", "label removal refused");
      }
    }
    return super.removeLabel(issueId, labelId);
  }
}

/** MemoryLinearApi whose comment read right after a claim comment lands fails. */
class DropAfterClaim extends MemoryLinearApi {
  armed = false;
  private posted = false;

  override async createComment(input: {
    readonly id?: string;
    readonly issueId: string;
    readonly body: string;
  }): Promise<Comment> {
    if (input.body.includes("vibecheck claim")) this.posted = true;
    return super.createComment(input);
  }

  override async comments(issueId: string): Promise<readonly Comment[]> {
    if (this.armed && this.posted) {
      this.armed = false;
      throw new LinearError("network", "dropped");
    }
    return super.comments(issueId);
  }
}

const planReadSchema = z.object({
  plan_revision: z.number(),
  task_map: z.record(z.string(), z.unknown()),
});

test("defect R3-r1: a held completion a person moves to done is held_done_moved and vc:unverified, never verified", async (t) => {
  const { board, linear, store } = createLedger(t, {
    script: (battery) =>
      battery === "vibecheck.done-admits-unfinished" ? 0.95 : 0.05,
  });
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  await status(board);
  const held = await update(board, session, claimed.work.id, {
    status: "complete",
    report: "Did half. The second criterion is not done yet.",
  });
  assert.equal(held.work[0]?.status, "in_progress");
  assert.ok((await labelNames(linear, "TA-1")).includes("vc:held"));
  linear.moveIssue(claimed.issue.id, (await stateOf(linear, "completed")).id);
  const view = await status(board);
  const labels = await labelNames(linear, "TA-1");
  assert.ok(labels.includes("vc:unverified"), labels.join());
  assert.ok(!labels.includes("vc:verified"), labels.join());
  assert.equal(view.tasks["A-1"]?.status, "complete");
  assert.notEqual(view.verification?.["A-1"]?.verified, "verified");
  assert.ok(
    view.attention?.some((item) => item.kind === "held_done_moved"),
    JSON.stringify(view.attention),
  );
  assert.equal(store.work(workIdOf(claimed.work.id))?.status, "in_progress");
});

test("defect R3-r1: the re-check runs claims-done and done-admits-unfinished; a report that admits work left is never verified", async (t) => {
  const { board, linear } = createLedger(t, {
    script: (battery) =>
      battery === "vibecheck.done-admits-unfinished" ? 0.95 : 0.05,
  });
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  await update(board, session, claimed.work.id, {
    report: "Did half. The second criterion is not done yet.",
  });
  await status(board);
  linear.moveIssue(claimed.issue.id, (await stateOf(linear, "completed")).id);
  const view = await status(board);
  const labels = await labelNames(linear, "TA-1");
  assert.ok(labels.includes("vc:unverified"), labels.join());
  assert.ok(!labels.includes("vc:verified"), labels.join());
  // A failed re-check reads unverified, never held (defect R5-low).
  assert.equal(view.verification?.["A-1"]?.verified, "unverified");
  assert.ok(
    (await commentBodies(linear, "TA-1")).some((body) =>
      body.startsWith("**vibecheck: vibecheck.done-admits-unfinished failed**"),
    ),
  );
});

test("defect R3-r2: a deleted claim comment is a lost claim; an activity edit on it fails with claim_lost instead of succeeding", async (t) => {
  const { a, b, sessionA, sessionB, linear, advance } = await twoMachines(t);
  const claimed = await claim(a.board, sessionA, "A-1");
  const commentId = a.store.work(workIdOf(claimed.work.id))?.claimCommentId;
  assert.ok(commentId != null);
  await linear.deleteComment(commentId);
  advance(60_000);
  linear.failNext("network"); // the reconcile cannot run: the edit itself finds it
  await rejectsCode(
    update(a.board, sessionA, claimed.work.id, {
      report: "Progress: still on it",
    }),
    "conflict",
    /lost its claim.*was deleted in Linear/su,
  );
  assert.equal(a.store.work(workIdOf(claimed.work.id))?.status, "released");
  assert.ok(
    !(await commentBodies(linear, claimed.issue.identifier)).some((body) =>
      body.startsWith("**Progress**"),
    ),
  );
  const taken = await claim(b.board, sessionB, "A-1");
  const seen = attentionSchema.parse(
    await a.board.call("project_status", { project_id: PROJECT, full: true }),
  );
  const lost = seen.attention?.find((item) => item.kind === "claim_lost");
  assert.ok(lost !== undefined, JSON.stringify(seen.attention));
  assert.equal(lost.work_id, claimed.work.id);
  await rejectsCode(
    update(a.board, sessionA, claimed.work.id, {
      status: "complete",
      report: "A done",
    }),
    "conflict",
    /lost its claim/u,
  );
  assert.equal((await linear.issue(claimed.issue.id))?.stateType, "started");
  assert.deepEqual(
    (await claimLines(linear, claimed.issue.id)).map(withoutActivity),
    [`vibecheck claim · work ${taken.work.id} · open`],
  );
  assert.ok(
    (await labelNames(linear, claimed.issue.identifier)).includes("vc:claimed"),
  );
});

test("defect R3-r3: a release whose label removal fails stays a pending plan, is never read as claim_lost, and finishes later", async (t) => {
  const linear = new StickyClaimLabel();
  const { board, store } = createLedger(t, { linear });
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  linear.failClaimedRemovals = 3;
  const release = {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    updates: [
      { work_id: claimed.work.id, action: "release", report: "giving it back" },
    ],
  };
  const failure = await failureOf(board.call("work_update", release));
  assert.equal(failure.code, "invalid");
  assert.equal(detail(failure, "completion"), "pending");
  assert.deepEqual(
    (await claimLines(linear, claimed.issue.id)).map(withoutActivity),
    [`vibecheck claim · work ${claimed.work.id} · released`],
  );
  assert.equal(store.work(workIdOf(claimed.work.id))?.status, "in_progress");
  // The reconciler reads the released claim line as this machine's own close.
  const view = await status(board);
  assert.ok(
    !view.attention?.some((item) => item.kind === "claim_lost"),
    JSON.stringify(view.attention),
  );
  assert.equal(view.sync.pending_completions, 1);
  assert.equal(store.events(PROJECT_KEY, { kinds: ["claim_lost"] }).length, 0);
  linear.failClaimedRemovals = 0;
  const retried = z
    .object({ results: z.array(z.object({ outcome: z.string() })) })
    .parse(await board.call("work_update", release));
  assert.deepEqual(
    retried.results.map((entry) => entry.outcome),
    ["applied"],
  );
  assert.equal(store.work(workIdOf(claimed.work.id))?.status, "released");
  assert.ok(
    !(await labelNames(linear, claimed.issue.identifier)).includes(
      "vc:claimed",
    ),
  );
  assert.equal((await linear.issue(claimed.issue.id))?.stateType, "unstarted");
  assert.equal(
    (await commentBodies(linear, claimed.issue.identifier)).filter((body) =>
      body.startsWith("**Released**"),
    ).length,
    1,
  );
});

test("defect R3-r4: two coordinators publishing one revision at once are merged into the next revision, and both machines read it", async (t) => {
  const { a, b, sessionA, sessionB, linear, published } = await twoMachines(t);
  const base = [
    { key: "A-1", title: "First task", goal: "g", criteria: ["c"] },
    { key: "B-1", title: "Second task" },
  ];
  const publishAs = (ledger: typeof a, session: string, extra: string) =>
    acceptingProblems(ledger.board, "plan_publish", {
      project_id: PROJECT,
      request_id: request(),
      session_id: session,
      expected_revision: 1,
      project: PROJECT_FIELDS,
      tasks: [
        ...base,
        { key: extra, title: `${extra} task`, goal: "g", criteria: ["c"] },
      ],
    });
  const results = (
    await Promise.all([
      publishAs(a, sessionA, "C-1"),
      publishAs(b, sessionB, "D-1"),
    ])
  ).map((result) =>
    z
      .object({
        plan_revision: z.number(),
        merged_with: z
          .object({ revision: z.number(), keys: z.array(z.string()) })
          .optional(),
      })
      .parse(result),
  );
  const merged = results.find((result) => result.merged_with !== undefined);
  assert.ok(merged !== undefined, JSON.stringify(results));
  assert.equal(merged.plan_revision, 3);
  assert.equal(merged.merged_with?.revision, 2);
  const document = (await linear.documents(published.linear_project_id)).find(
    (entry) => entry.title === PLAN_DOCUMENT_TITLE,
  );
  assert.ok(document !== undefined);
  const map = parsePlanDocument(document.content);
  assert.equal(map?.revision, 3);
  assert.deepEqual(Object.keys(map?.tasks ?? {}).sort(), [
    "A-1",
    "B-1",
    "C-1",
    "D-1",
  ]);
  for (const ledger of [a, b]) {
    await status(ledger.board);
    const read = planReadSchema.parse(
      await ledger.board.call("plan_read", { project_id: PROJECT }),
    );
    assert.equal(read.plan_revision, 3);
    assert.deepEqual(Object.keys(read.task_map).sort(), [
      "A-1",
      "B-1",
      "C-1",
      "D-1",
    ]);
  }
});

test("defect R3-r4 (with R4-7): a local journal whose revision differs from Linear's map for the same revision is refreshed from Linear", async (t) => {
  const { board, linear } = createLedger(t);
  const session = await join(board);
  const published = publishedSchema.parse(await publish(board, session));
  const document = (await linear.documents(published.linear_project_id)).find(
    (entry) => entry.title === PLAN_DOCUMENT_TITLE,
  );
  assert.ok(document !== undefined);
  const map = parsePlanDocument(document.content);
  assert.ok(map !== null);
  // Another coordinator's write of revision 1 carries a key this machine
  // never had (dropping a key this machine knows is R4-7's case).
  const theirs = await linear.createIssue({
    teamId: linear.teamId,
    projectId: published.linear_project_id,
    title: "C-1: Their task",
  });
  await linear.updateDocument(document.id, {
    content: document.content.replace(
      /```json\n[\s\S]*?```/u,
      `\`\`\`json\n${JSON.stringify({ ...map, tasks: { ...map.tasks, "C-1": theirs.identifier } })}\n\`\`\``,
    ),
  });
  await status(board);
  const read = planReadSchema.parse(
    await board.call("plan_read", { project_id: PROJECT }),
  );
  assert.equal(read.plan_revision, 1);
  assert.deepEqual(Object.keys(read.task_map).sort(), ["A-1", "B-1", "C-1"]);
});

test("defect R3-r5: an offline completion never lands on another machine's claim: its plan re-checks the claim and is abandoned", async (t) => {
  const time = manualClock();
  const real = new MemoryLinearApi({ now: time.linearNow });
  const offline = { value: false };
  const a = createLedger(t, {
    linear: unreachable(real, offline),
    now: time.boardNow,
  });
  const b = createLedger(t, { linear: real, now: time.boardNow });
  const sessionA = await join(a.board, "a");
  const published = publishedSchema.parse(await publish(a.board, sessionA));
  const sessionB = await join(b.board, "b", {
    linear_project: published.linear_project_id,
    vendor: "codex",
  });
  const claimed = await claim(a.board, sessionA, "A-1");
  offline.value = true;
  const failure = await failureOf(
    update(a.board, sessionA, claimed.work.id, {
      status: "complete",
      report: "A finished",
    }),
  );
  assert.equal(failure.code, "unavailable");
  assert.equal(detail(failure, "completion"), "pending");
  assert.equal(a.store.pendingCount(), 0, "nothing is queued outside the plan");
  time.advance(25 * HOUR);
  const taken = z.object({ work: z.object({ id: z.string() }) }).parse(
    await b.board.call("work_claim", {
      project_id: PROJECT,
      request_id: request(),
      session_id: sessionB,
      task_id: "A-1",
      force_release: true,
    }),
  );
  offline.value = false;
  const view = await status(a.board);
  assert.ok(view.attention?.some((item) => item.kind === "claim_lost"));
  assert.equal((await real.issue(claimed.issue.id))?.stateType, "started");
  assert.equal(a.store.pendingCompletions(PROJECT_KEY).length, 0);
  assert.equal(a.store.work(workIdOf(claimed.work.id))?.status, "released");
  assert.deepEqual(
    (await claimLines(real, claimed.issue.id)).map(withoutActivity),
    [
      `vibecheck claim · work ${claimed.work.id} · abandoned (closed by work ${taken.work.id})`,
      `vibecheck claim · work ${taken.work.id} · open`,
    ],
  );
  assert.ok(
    !(await commentBodies(real, claimed.issue.identifier)).some((body) =>
      body.startsWith("**Done**"),
    ),
  );
});

test("defect R3-r6: retrying an offline completion queues no state move; once online the one plan finishes once", async (t) => {
  const real = new MemoryLinearApi();
  const offline = { value: false };
  const { board, store } = createLedger(t, {
    linear: unreachable(real, offline),
    script: () => 0.05,
  });
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  offline.value = true;
  const body = {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    updates: [
      {
        work_id: claimed.work.id,
        status: "complete",
        report: "All criteria met; tests pass.",
      },
    ],
  };
  for (let attempt = 0; attempt < 2; attempt++)
    await rejectsCode(board.call("work_update", body), "unavailable");
  assert.equal(store.pendingCount(), 0);
  assert.equal(store.pendingCompletions(PROJECT_KEY).length, 1);
  offline.value = false;
  await status(board);
  assert.equal((await real.issue(claimed.issue.id))?.stateType, "completed");
  assert.equal(store.work(workIdOf(claimed.work.id))?.status, "complete");
  const bodies = await commentBodies(real, claimed.issue.identifier);
  assert.equal(
    bodies.filter((entry) => entry.startsWith("**Done**")).length,
    1,
  );
  assert.deepEqual(
    (await claimLines(real, claimed.issue.id)).map(withoutActivity),
    [`vibecheck claim · work ${claimed.work.id} · complete`],
  );
});

test("defect R3-r7: a reopened issue's attention clears once a claim returned it", async (t) => {
  const { board, linear, store } = createLedger(t);
  const session = await join(board);
  await publish(board, session);
  const first = await claim(board, session, "A-1");
  await update(board, session, first.work.id, {
    status: "complete",
    report: "All criteria met.",
  });
  await status(board);
  linear.moveIssue(first.issue.id, (await stateOf(linear, "started")).id);
  const seen = await status(board);
  assert.ok(seen.attention?.some((item) => item.kind === "reopened"));
  const again = await board.call("work_claim", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    task_id: "A-1",
  });
  assert.ok(
    attentionSchema
      .parse(again)
      .attention?.some((item) => item.kind === "reopened"),
  );
  const reclaimed = z
    .object({ work: z.object({ id: z.string() }) })
    .parse(again).work;
  assert.equal(store.work(workIdOf(reclaimed.id))?.status, "in_progress");
  for (let index = 0; index < 2; index++) {
    const result = attentionSchema.parse(
      await board.call("work_update", {
        project_id: PROJECT,
        request_id: request(),
        session_id: session,
        updates: [{ work_id: reclaimed.id, report: `Progress ${index}` }],
      }),
    );
    assert.ok(
      !result.attention?.some((item) => item.kind === "reopened"),
      JSON.stringify(result.attention),
    );
  }
  assert.ok(
    !(await status(board)).attention?.some((item) => item.kind === "reopened"),
  );
});

test("defect R3-r8: a claim_lost event clears once a new claim on the issue returned it", async (t) => {
  const { board, linear } = createLedger(t);
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  const comment = (await linear.comments(claimed.issue.id)).find((entry) =>
    entry.body.includes("vibecheck claim"),
  );
  assert.ok(comment !== undefined);
  await linear.updateComment(
    comment.id,
    comment.body.replace(/· open.*$/mu, "· released"),
  );
  await status(board);
  const again = await board.call("work_claim", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    task_id: "A-1",
  });
  assert.ok(
    attentionSchema
      .parse(again)
      .attention?.some(
        (item) =>
          item.kind === "claim_lost" && item.work_id === claimed.work.id,
      ),
  );
  const reclaimed = z
    .object({ work: z.object({ id: z.string() }) })
    .parse(again);
  const next = attentionSchema.parse(
    await board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: session,
      updates: [{ work_id: reclaimed.work.id, report: "Progress 0" }],
    }),
  );
  assert.ok(!next.attention?.some((item) => item.kind === "claim_lost"));
  assert.ok(
    !(await status(board)).attention?.some(
      (item) => item.kind === "claim_lost",
    ),
  );
});

test("defect R3-r9: a completion whose move is skipped is not complete: claim open, no vc:verified, status not verified", async (t) => {
  const real = new MemoryLinearApi();
  const armed = { count: 0 };
  const linear = failing(
    real,
    "issues",
    () => new LinearError("rate_limited", "slow down"),
    armed,
  );
  const { board, store } = createLedger(t, { linear, script: () => 0.05 });
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  real.moveIssue(claimed.issue.id, (await stateOf(real, "unstarted")).id);
  armed.count = 1;
  const failure = await failureOf(
    update(board, session, claimed.work.id, {
      status: "complete",
      report: "All criteria met; tests pass.",
    }),
  );
  assert.equal(failure.code, "conflict");
  assert.equal(detail(failure, "reason"), "skipped_move");
  const labels = await labelNames(real, claimed.issue.identifier);
  assert.ok(!labels.includes("vc:verified"), labels.join());
  assert.ok(labels.includes("vc:claimed"), labels.join());
  assert.deepEqual(
    (await claimLines(real, claimed.issue.id)).map(withoutActivity),
    [`vibecheck claim · work ${claimed.work.id} · open`],
  );
  assert.equal(store.work(workIdOf(claimed.work.id))?.status, "in_progress");
  const view = await status(board);
  assert.equal(view.tasks["A-1"]?.status, "pending");
  assert.notEqual(view.verification?.["A-1"]?.verified, "verified");
  assert.ok(view.attention?.some((item) => item.kind === "skipped_move"));
});

test("defect R3-r10: comment ids derive from the session too, so two sessions reusing a request_id both post", async (t) => {
  const { board, linear } = createLedger(t);
  const coordinator = await join(board, "coordinator");
  await publish(board, coordinator);
  const worker = await join(board, "worker");
  const claimed = await claim(board, worker, "A-1");
  for (const [session, text] of [
    [worker, "Worker: parser done."],
    [coordinator, "Coordinator: please also cover the CLI flags."],
  ])
    await board.call("work_update", {
      project_id: PROJECT,
      request_id: "r-1",
      session_id: session,
      updates: [{ work_id: claimed.work.id, report: text }],
    });
  const reports = (await commentBodies(linear, claimed.issue.identifier))
    .filter((body) => body.startsWith("**Progress**"))
    .map((body) => body.split("\n")[2]);
  assert.deepEqual(reports, [
    "Worker: parser done.",
    "Coordinator: please also cover the CLI flags.",
  ]);
});

test("defect R3-r11: a retry with the same request_id resumes the recorded decision and never judges again", async (t) => {
  const real = new MemoryLinearApi();
  const armed = { count: 0 };
  const linear = failing(
    real,
    "addLabel",
    () => new LinearError("invalid", "label add refused"),
    armed,
  );
  let attempt = 0;
  const { board, store } = createLedger(t, {
    linear,
    script: (battery) =>
      battery === "vibecheck.claims-done"
        ? attempt === 0
          ? 0.05
          : 0.95
        : 0.05,
  });
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  const body = {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    updates: [
      {
        work_id: claimed.work.id,
        status: "complete",
        report: "All criteria met; tests pass.",
      },
    ],
  };
  armed.count = 1;
  const failure = await failureOf(board.call("work_update", body));
  assert.equal(failure.code, "invalid");
  assert.equal(detail(failure, "completion"), "pending");
  assert.deepEqual(detail(failure, "steps_done"), ["move"]);
  // The judgment would fail now; the recorded decision (verified) stands.
  attempt = 1;
  const retried = z
    .object({ tasks: z.array(z.object({ status: z.string() })) })
    .parse(await board.call("work_update", body));
  assert.equal(retried.tasks[0]?.status, "complete");
  const labels = await labelNames(real, claimed.issue.identifier);
  assert.ok(labels.includes("vc:verified"), labels.join());
  assert.ok(!labels.includes("vc:held"), labels.join());
  assert.equal(store.work(workIdOf(claimed.work.id))?.status, "complete");
  const history = z
    .object({
      verifications: z.array(
        z.object({ kind: z.string(), check: z.string().optional() }),
      ),
    })
    .parse(
      await board.call("work_history", { project_id: PROJECT, task_id: "A-1" }),
    );
  const judged = history.verifications.filter(
    (entry) => entry.check === "vibecheck.claims-done",
  );
  assert.equal(judged.length, 1, "judged once");
});

test("defect R3-r12: a claim cut off after its comment landed is closed as this machine's own release, never as claim_lost", async (t) => {
  const linear = new DropAfterClaim();
  const ledger = createLedger(t, { linear });
  const own = await join(ledger.board, "own");
  await publish(ledger.board, own);
  // The re-read of the comments after the claim comment landed fails.
  linear.armed = true;
  await rejectsCode(claim(ledger.board, own, "A-1"), "unavailable");
  const rows = ledger.store.allWork(PROJECT_KEY);
  assert.deepEqual(
    rows.map((row) => row.status),
    ["released"],
  );
  const issue = await linear.issue("TA-1");
  assert.ok(issue !== null);
  const view = await status(ledger.board);
  assert.ok(
    !view.attention?.some((item) => item.kind === "claim_lost"),
    JSON.stringify(view.attention),
  );
  assert.deepEqual((await claimLines(linear, issue.id)).map(withoutActivity), [
    `vibecheck claim · work ${rows[0]?.id ?? ""} · released`,
  ]);
  assert.ok(!(await labelNames(linear, "TA-1")).includes("vc:claimed"));
  assert.equal(ledger.store.pendingCount(), 0);
});

test("defect R3-live: Linear refuses removing a label the issue does not carry, and every ledger removal tolerates it", async (t) => {
  const { board, linear, store } = createLedger(t);
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  const label = (await linear.labels(linear.teamId)).find(
    (entry) => entry.name === "vc:claimed",
  );
  assert.ok(label !== undefined);
  await linear.removeLabel(claimed.issue.id, label.id);
  await assert.rejects(
    linear.removeLabel(claimed.issue.id, label.id),
    (error: unknown) => {
      assert.ok(isLabelNotOnIssue(error), String(error));
      assert.match(
        String(error),
        /Label \S+ is not on issue \S+ and cannot be removed\./u,
      );
      return true;
    },
  );
  await linear.addLabel(claimed.issue.id, label.id);
  // A progress update removes vc:blocked, vc:needs-user and
  // vc:awaiting-integration, which the issue never carried.
  const progress = await update(board, session, claimed.work.id, {
    status: "in_progress",
    report: "Progress without a blocker.",
  });
  assert.equal(progress.work[0]?.status, "in_progress");
  const done = await update(board, session, claimed.work.id, {
    status: "complete",
    report: "Done.",
  });
  assert.equal(done.tasks[0]?.status, "complete");
  // A queued removal of a label the issue no longer carries is sent, not retried.
  store.enqueue({
    projectKey: PROJECT_KEY,
    kind: "remove_label",
    payload: { issueId: claimed.issue.id, labelName: "vc:claimed" },
  });
  await status(board);
  assert.equal(store.pendingCount(), 0);
});

test("defect R3: activity and closing edits rewrite only the claim line, so a person's text in the claim comment survives", async (t) => {
  const { board, linear } = createLedger(t);
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  const comment = (await linear.comments(claimed.issue.id)).find((entry) =>
    entry.body.includes("vibecheck claim"),
  );
  assert.ok(comment !== undefined);
  const note = "Owner note: keep the save format.";
  await linear.updateComment(
    comment.id,
    comment.body.replace("\n\n— vibecheck", `\n\n${note}\n\n— vibecheck`),
  );
  await update(board, session, claimed.work.id, { report: "Progress." });
  const active = (await linear.comments(claimed.issue.id)).find(
    (entry) => entry.id === comment.id,
  );
  assert.ok(active?.body.includes(note));
  assert.equal(parseClaimComment(active?.body ?? "")?.status, "open");
  await update(board, session, claimed.work.id, {
    status: "complete",
    report: "Done.",
  });
  const closed = (await linear.comments(claimed.issue.id)).find(
    (entry) => entry.id === comment.id,
  );
  assert.ok(closed?.body.includes(note));
  assert.equal(parseClaimComment(closed?.body ?? "")?.status, "complete");
});

test("defect R3: a queued removal of vc:claimed is not sent while a claim comment on the issue reads open", async (t) => {
  const { board, linear, store } = createLedger(t);
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  store.enqueue({
    projectKey: PROJECT_KEY,
    kind: "remove_label",
    payload: { issueId: claimed.issue.id, labelName: "vc:claimed" },
  });
  await status(board);
  assert.equal(store.pendingCount(), 0);
  assert.ok(
    (await labelNames(linear, claimed.issue.identifier)).includes("vc:claimed"),
  );
});

test("defect R3: a claim comment carries `open · active <time>` from the moment of the claim", async (t) => {
  const now = new Date("2026-10-05T12:00:00.000Z");
  const { board, linear } = createLedger(t, { now: () => now });
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  assert.deepEqual(await claimLines(linear, claimed.issue.id), [
    `vibecheck claim · work ${claimed.work.id} · open · active ${now.toISOString()}`,
  ]);
});

// ---------------------------------------------------------------------------
// Fourth review (R4)
// ---------------------------------------------------------------------------

const network = () => new LinearError("network", "connection reset");
const rejected = () => new LinearError("invalid", "write refused");

function completeBody(
  session: string,
  workId: string,
  report = "All criteria met; tests pass.",
) {
  return {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    updates: [{ work_id: workId, status: "complete", report }],
  };
}

test("defect R4-1: a held completion repeated with a new request_id after its plan finished is applied, never judged again", async (t) => {
  const real = new MemoryLinearApi();
  const armed = { count: 0 };
  let judged = 0;
  const { board, store } = createLedger(t, {
    linear: failing(real, "createComment", network, armed),
    script: (battery) => {
      if (battery !== "vibecheck.done-admits-unfinished") return 0.05;
      judged += 1;
      // The first reading holds the report; any later one would pass it.
      return judged === 1 ? 0.95 : 0.05;
    },
  });
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  armed.count = 1;
  const failure = await failureOf(
    board.call("work_update", completeBody(session, claimed.work.id)),
  );
  assert.equal(failure.code, "unavailable");
  assert.equal(detail(failure, "completion"), "pending");
  // The same change again, with a new request_id: the drain at the start of
  // the call finishes the held plan, and the change is reported as applied.
  const again = z
    .object({
      results: z.array(z.object({ outcome: z.string() })),
      tasks: z.array(z.object({ status: z.string() })),
    })
    .parse(
      await board.call("work_update", completeBody(session, claimed.work.id)),
    );
  assert.deepEqual(
    again.results.map((entry) => entry.outcome),
    ["applied"],
  );
  assert.equal(again.tasks[0]?.status, "in_progress");
  assert.equal(judged, 1, "judged once");
  assert.deepEqual(
    store
      .completionsForWork(workIdOf(claimed.work.id))
      .map((plan) => [plan.decision, plan.state]),
    [["held", "done"]],
  );
  const bodies = await commentBodies(real, claimed.issue.identifier);
  assert.equal(bodies.filter((body) => body.startsWith("**Done**")).length, 1);
  const labels = await labelNames(real, claimed.issue.identifier);
  assert.ok(labels.includes("vc:held"), labels.join());
  assert.ok(!labels.includes("vc:verified"), labels.join());
  assert.equal((await real.issue(claimed.issue.id))?.stateType, "started");
  // A change of the work since then makes a repeat a new change again.
  await update(board, session, claimed.work.id, { report: "More work." });
  const later = await update(board, session, claimed.work.id, {
    status: "complete",
    report: "All criteria met; tests pass.",
  });
  assert.equal(later.tasks[0]?.status, "complete");
  assert.equal(judged, 2);
});

test("defect R4-2: a verified completion whose issue a person reopened after the plan's move is abandoned as reopened, never complete", async (t) => {
  const real = new MemoryLinearApi();
  const armed = { count: 0 };
  const { board, store } = createLedger(t, {
    linear: failing(real, "createComment", network, armed),
    script: () => 0.05,
  });
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  armed.count = 1;
  const failure = await failureOf(
    board.call("work_update", completeBody(session, claimed.work.id)),
  );
  assert.equal(detail(failure, "completion"), "pending");
  const done = detail(failure, "steps_done");
  assert.ok(Array.isArray(done) && done.includes("move"), String(done));
  assert.ok(Array.isArray(done) && done.includes("add_label vc:verified"));
  real.moveIssue(claimed.issue.id, (await stateOf(real, "started")).id);
  const view = await status(board);
  const reopened = (view.attention ?? []).filter(
    (item) => item.kind === "reopened",
  );
  assert.equal(reopened.length, 1, JSON.stringify(view.attention));
  assert.notEqual(view.tasks["A-1"]?.verified, "verified");
  assert.equal(view.tasks["A-1"]?.status, "in_progress");
  assert.equal(store.work(workIdOf(claimed.work.id))?.status, "in_progress");
  assert.deepEqual(
    store
      .completionsForWork(workIdOf(claimed.work.id))
      .map((plan) => plan.state),
    ["abandoned"],
  );
  const labels = await labelNames(real, claimed.issue.identifier);
  assert.ok(!labels.includes("vc:verified"), labels.join());
  assert.ok(labels.includes("vc:claimed"), labels.join());
  assert.deepEqual(
    (await claimLines(real, claimed.issue.id)).map(withoutActivity),
    [`vibecheck claim · work ${claimed.work.id} · open`],
  );
  assert.equal(view.sync.pending_rechecks, undefined);
});

test("defect R4-2: a held completion still pending while a person moves the issue to done is held_done_moved and vc:unverified", async (t) => {
  const real = new MemoryLinearApi();
  const armed = { count: 0 };
  const { board, store } = createLedger(t, {
    linear: failing(real, "createComment", network, armed),
    script: (battery) =>
      battery === "vibecheck.done-admits-unfinished" ? 0.95 : 0.05,
  });
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  await status(board);
  armed.count = 1;
  const failure = await failureOf(
    board.call(
      "work_update",
      completeBody(
        session,
        claimed.work.id,
        "Half done; second criterion not done yet.",
      ),
    ),
  );
  assert.equal(detail(failure, "completion"), "pending");
  real.moveIssue(claimed.issue.id, (await stateOf(real, "completed")).id);
  const view = await status(board);
  assert.ok(
    view.attention?.some((item) => item.kind === "held_done_moved"),
    JSON.stringify(view.attention),
  );
  assert.notEqual(view.tasks["A-1"]?.verified, "verified");
  const labels = await labelNames(real, claimed.issue.identifier);
  assert.ok(labels.includes("vc:unverified"), labels.join());
  assert.ok(!labels.includes("vc:verified"), labels.join());
  assert.equal(store.work(workIdOf(claimed.work.id))?.status, "in_progress");
  assert.equal(store.pendingCompletions(PROJECT_KEY).length, 0);
});

test("defect R4-3: a completion recorded while an earlier change's move is queued expects that move; it is never a person's move", async (t) => {
  const real = new MemoryLinearApi();
  const link = { offline: false, dropAtMove: false };
  const linear = new Proxy(real, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (link.offline)
          return Promise.reject(new LinearError("network", "offline"));
        const input: unknown = args[1];
        if (
          link.dropAtMove &&
          property === "updateIssue" &&
          typeof input === "object" &&
          input !== null &&
          "stateId" in input
        ) {
          link.offline = true;
          return Promise.reject(new LinearError("network", "dropped"));
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
  const { board, store } = createLedger(t, { linear, script: () => 0.05 });
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  link.dropAtMove = true;
  const awaiting = await update(board, session, claimed.work.id, {
    status: "awaiting_integration",
    commit: "0123456789abcdef0123456789abcdef01234567",
    location: { branch: "feat", target_branch: "main" },
    report: "PR open.",
  });
  assert.equal(awaiting.work[0]?.status, "awaiting_integration");
  const failure = await failureOf(
    board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: session,
      updates: [
        {
          work_id: claimed.work.id,
          status: "complete",
          integration_commit: "89abcdef0123456789abcdef0123456789abcdef",
          report: "Merged. All criteria met; tests pass.",
        },
      ],
    }),
  );
  assert.equal(detail(failure, "completion"), "pending");
  link.offline = false;
  link.dropAtMove = false;
  const view = await status(board);
  assert.ok(
    !view.attention?.some((item) => item.kind === "skipped_move"),
    JSON.stringify(view.attention),
  );
  assert.equal(view.tasks["A-1"]?.status, "complete");
  assert.equal(view.tasks["A-1"]?.verified, "verified");
  assert.equal(store.work(workIdOf(claimed.work.id))?.status, "complete");
  assert.equal((await real.issue(claimed.issue.id))?.stateType, "completed");
});

test("defect R4-4: only rejections count toward the attempt cap; an offline plan resumes once Linear answers", async (t) => {
  const real = new MemoryLinearApi();
  const offline = { value: false };
  const { board, store } = createLedger(t, {
    linear: unreachable(real, offline),
    script: () => 0.05,
  });
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  offline.value = true;
  await rejectsCode(
    board.call("work_update", completeBody(session, claimed.work.id)),
    "unavailable",
  );
  for (let call = 0; call < 6; call++) await status(board);
  assert.deepEqual(
    store
      .completionsForWork(workIdOf(claimed.work.id))
      .map((plan) => plan.attempts),
    [0],
  );
  offline.value = false;
  const view = await status(board);
  assert.equal(view.sync.pending_completions, undefined);
  assert.equal(store.work(workIdOf(claimed.work.id))?.status, "complete");
  assert.equal((await real.issue(claimed.issue.id))?.stateType, "completed");
});

test("defect R4-4: a plan Linear rejected five times is completion_waiting in attention until its request is repeated", async (t) => {
  const real = new MemoryLinearApi();
  const armed = { count: 0 };
  const { board, store } = createLedger(t, {
    linear: failing(real, "addLabel", rejected, armed),
    script: () => 0.05,
  });
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  armed.count = 100;
  const body = completeBody(session, claimed.work.id);
  await rejectsCode(board.call("work_update", body), "invalid");
  const attempts = () =>
    store.completionsForWork(workIdOf(claimed.work.id))[0]?.attempts ?? 0;
  for (let call = 0; call < 10 && attempts() < 5; call++) await status(board);
  assert.equal(attempts(), 5);
  armed.count = 0;
  const waitingSchema = z.object({
    attention: z.array(
      z.object({
        kind: z.string(),
        reason: z.string(),
        work_id: z.string().optional(),
        request_id: z.string().optional(),
        last_error: z.string().optional(),
      }),
    ),
  });
  const view = waitingSchema.parse(
    await board.call("project_status", { project_id: PROJECT, full: true }),
  );
  const waiting = view.attention.find(
    (item) => item.kind === "completion_waiting",
  );
  assert.ok(waiting !== undefined, JSON.stringify(view.attention));
  assert.equal(waiting.work_id, claimed.work.id);
  assert.equal(waiting.request_id, body.request_id);
  assert.match(waiting.last_error ?? "", /write refused/u);
  assert.match(waiting.reason, new RegExp(body.request_id, "u"));
  // Not resumed automatically, even now that Linear would accept it.
  assert.equal(store.work(workIdOf(claimed.work.id))?.status, "in_progress");
  await board.call("work_update", body);
  assert.equal(store.work(workIdOf(claimed.work.id))?.status, "complete");
  const after = await status(board);
  assert.ok(
    !after.attention?.some((item) => item.kind === "completion_waiting"),
  );
});

test("defect R4-4: the reconciler never re-checks an issue whose completion plan is pending for open work here", async (t) => {
  const real = new MemoryLinearApi();
  const armed = { count: 0 };
  const { board, store } = createLedger(t, {
    linear: failing(real, "updateIssue", rejected, armed),
    script: (battery) => {
      if (battery === "vibecheck.claims-done")
        throw new ProviderUnavailableError("judge down");
      return 0.05;
    },
  });
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  await status(board);
  armed.count = 5;
  const body = completeBody(session, claimed.work.id);
  await rejectsCode(board.call("work_update", body), "invalid");
  for (let call = 0; call < 4; call++) await status(board);
  const plan = store.completionsForWork(workIdOf(claimed.work.id))[0];
  assert.equal(plan?.decision, "unverified");
  assert.equal(plan?.attempts, 5);
  real.moveIssue(claimed.issue.id, (await stateOf(real, "completed")).id);
  const view = await status(board);
  assert.equal(view.sync.pending_rechecks, 1, "the re-check waits");
  const reconciler = async () =>
    (await commentBodies(real, claimed.issue.identifier)).filter((entry) =>
      entry.includes("reconciler"),
    );
  assert.deepEqual(await reconciler(), []);
  // The repeated request finishes the plan; its own move target is reached,
  // so the waiting re-check is dropped instead of judging again.
  await board.call("work_update", body);
  const after = await status(board);
  assert.equal(after.sync.pending_rechecks, undefined);
  assert.deepEqual(await reconciler(), []);
  assert.equal(store.work(workIdOf(claimed.work.id))?.status, "complete");
  const labels = await labelNames(real, claimed.issue.identifier);
  assert.ok(labels.includes("vc:unverified"), labels.join());
});

test("defect R4-5: a passed completion the reconciler ends on a lost claim gets a review entry and never reads verified", async (t) => {
  const time = manualClock();
  const real = new MemoryLinearApi({ now: time.linearNow });
  const armed = { count: 0 };
  const a = createLedger(t, {
    linear: failing(real, "updateIssue", rejected, armed),
    now: time.boardNow,
    script: () => 0.05,
  });
  const b = createLedger(t, { linear: real, now: time.boardNow });
  const sessionA = await join(a.board, "a");
  const published = publishedSchema.parse(await publish(a.board, sessionA));
  const sessionB = await join(b.board, "b", {
    linear_project: published.linear_project_id,
    vendor: "codex",
  });
  const claimed = await claim(a.board, sessionA, "A-1");
  armed.count = 5;
  await rejectsCode(
    a.board.call("work_update", completeBody(sessionA, claimed.work.id)),
    "invalid",
  );
  for (let call = 0; call < 4; call++) await status(a.board);
  const plans = () => a.store.completionsForWork(workIdOf(claimed.work.id));
  assert.equal(plans()[0]?.decision, "verified");
  assert.equal(plans()[0]?.attempts, 5);
  time.advance(25 * HOUR);
  await b.board.call("work_claim", {
    project_id: PROJECT,
    request_id: request(),
    session_id: sessionB,
    task_id: "A-1",
    force_release: true,
  });
  const view = await status(a.board);
  assert.ok(view.attention?.some((item) => item.kind === "claim_lost"));
  assert.equal(plans()[0]?.state, "abandoned");
  assert.notEqual(view.tasks["A-1"]?.verified, "verified");
  const history = z
    .object({
      verifications: z.array(
        z.object({ check: z.string().optional(), outcome: z.string() }),
      ),
    })
    .parse(
      await a.board.call("work_history", {
        project_id: PROJECT,
        task_id: "A-1",
      }),
    );
  assert.equal(
    history.verifications.filter(
      (entry) =>
        entry.check === "vibecheck.claims-done" && entry.outcome === "review",
    ).length,
    1,
  );
});

test("defect R4-6: a handoff abandoned after its successor's claim comment landed closes that comment, so vc:claimed comes off and the task is free", async (t) => {
  const real = new MemoryLinearApi();
  const armed = { count: 0 };
  const a = createLedger(t, {
    linear: failing(real, "updateComment", network, armed),
  });
  const b = createLedger(t, { linear: real });
  const sessionA = await join(a.board, "a");
  const published = publishedSchema.parse(await publish(a.board, sessionA));
  const target = await join(a.board, "a2", { vendor: "codex" });
  const sessionB = await join(b.board, "b", {
    linear_project: published.linear_project_id,
    vendor: "gemini",
  });
  const claimed = await claim(a.board, sessionA, "A-1");
  armed.count = 1;
  const failure = await failureOf(
    a.board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: sessionA,
      updates: [
        {
          work_id: claimed.work.id,
          action: "handoff",
          handoff_to: target,
          report: "Handing off.",
        },
      ],
    }),
  );
  assert.deepEqual(detail(failure, "steps_left"), ["close_claim", "commit"]);
  assert.equal((await claimLines(real, claimed.issue.id)).length, 2);
  // A person deletes the predecessor's claim comment.
  const own = (await real.comments(claimed.issue.id)).find(
    (comment) => parseClaimComment(comment.body)?.workId === claimed.work.id,
  );
  assert.ok(own !== undefined);
  await real.deleteComment(own.id);
  const view = await status(a.board);
  assert.ok(view.attention?.some((item) => item.kind === "claim_lost"));
  await a.board.drain();
  const lines = (await claimLines(real, claimed.issue.id)).map(withoutActivity);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", / · abandoned$/u);
  assert.ok(
    !(await labelNames(real, claimed.issue.identifier)).includes("vc:claimed"),
  );
  const taken = await claim(b.board, sessionB, "A-1");
  assert.equal(taken.work.task_id, "A-1");
});

test("defect R4-7: a key Linear's map dropped is restored from this machine's journal when status refreshes the map", async (t) => {
  const { board, linear } = createLedger(t);
  const session = await join(board);
  const published = publishedSchema.parse(await publish(board, session));
  const document = (await linear.documents(published.linear_project_id)).find(
    (entry) => entry.title === PLAN_DOCUMENT_TITLE,
  );
  assert.ok(document !== undefined);
  const map = parsePlanDocument(document.content);
  assert.ok(map !== null);
  const dropped = map.tasks["B-1"];
  assert.ok(dropped !== undefined);
  const { ["B-1"]: _dropped, ...kept } = map.tasks;
  await linear.updateDocument(document.id, {
    content: document.content.replace(
      /```json\n[\s\S]*?```/u,
      `\`\`\`json\n${JSON.stringify({ ...map, tasks: kept })}\n\`\`\``,
    ),
  });
  const view = await status(board);
  assert.equal(view.plan_revision, 2);
  const read = planReadSchema.parse(
    await board.call("plan_read", { project_id: PROJECT }),
  );
  assert.equal(read.plan_revision, 2);
  assert.deepEqual(Object.keys(read.task_map).sort(), ["A-1", "B-1"]);
  const after = (await linear.documents(published.linear_project_id)).find(
    (entry) => entry.title === PLAN_DOCUMENT_TITLE,
  );
  const restored = parsePlanDocument(after?.content ?? "");
  assert.equal(restored?.revision, 2);
  assert.equal(restored?.tasks["B-1"], dropped, "the same issue as before");
  // Nothing missing: a later status writes no new revision.
  assert.equal((await status(board)).plan_revision, 2);
});

test("defect R4-7: every plan write merges back a tool-created plan issue its map misses, and returns merged_with", async (t) => {
  const { board, linear } = createLedger(t);
  const session = await join(board);
  const published = publishedSchema.parse(await publish(board, session));
  // Another coordinator's publish created Z-1, and its map was overwritten.
  await linear.createIssue({
    id: stableId(published.linear_project_id, "issue", "Z-1"),
    teamId: linear.teamId,
    projectId: published.linear_project_id,
    title: "Z-1: Their task",
  });
  // A look-alike the tool did not create stays out.
  await linear.createIssue({
    teamId: linear.teamId,
    projectId: published.linear_project_id,
    title: "Y-1: A person's issue",
  });
  const result = z
    .object({
      plan_revision: z.number(),
      merged_with: z
        .object({ revision: z.number(), keys: z.array(z.string()) })
        .optional(),
      task_map: z.record(z.string(), z.unknown()),
    })
    .parse(await publish(board, session, undefined, { expected_revision: 1 }));
  assert.equal(result.plan_revision, 3);
  assert.deepEqual(result.merged_with, { revision: 2, keys: ["Z-1"] });
  assert.deepEqual(Object.keys(result.task_map).sort(), ["A-1", "B-1", "Z-1"]);
});

// ---------------------------------------------------------------------------
// Fifth review
// ---------------------------------------------------------------------------

const ADMITS = "vibecheck.done-admits-unfinished";
const DONE_REPORT = "All criteria met; the first part is done and tested.";

/** Two machines with their own judgment scripts on one Linear workspace. */
async function judgedMachines(
  t: TestContext,
  scriptA: ((battery: string) => number) | undefined,
  scriptB: ((battery: string) => number) | undefined,
) {
  const time = manualClock();
  const linear = new MemoryLinearApi({ now: time.linearNow });
  const a = createLedger(t, {
    linear,
    now: time.boardNow,
    ...(scriptA === undefined ? {} : { script: scriptA }),
  });
  const b = createLedger(t, {
    linear,
    now: time.boardNow,
    ...(scriptB === undefined ? {} : { script: scriptB }),
  });
  const sessionA = await join(a.board, "a");
  const published = publishedSchema.parse(await publish(a.board, sessionA));
  const sessionB = await join(b.board, "b", {
    linear_project: published.linear_project_id,
    vendor: "codex",
  });
  await status(b.board);
  return { ...time, linear, a, b, sessionA, sessionB, published };
}

test("defect R5-H1: a verified completion is not judged again by a machine with another judgment", async (t) => {
  const { linear, a, b, sessionA, advance } = await judgedMachines(
    t,
    () => 0.05,
    () => 0.95,
  );
  const claimed = await claim(a.board, sessionA, "A-1");
  advance(2000);
  await update(a.board, sessionA, claimed.work.id, {
    status: "complete",
    report: DONE_REPORT,
  });
  const before = await commentBodies(linear, "TA-1");
  advance(2000);
  const view = await status(b.board);
  assert.deepEqual((await labelNames(linear, "TA-1")).sort(), [
    "agent:claude-code",
    "vc:verified",
  ]);
  assert.deepEqual(await commentBodies(linear, "TA-1"), before);
  // B reads the verdict from Linear's labels.
  assert.equal(view.tasks["A-1"]?.verified, "verified");
  assert.equal((await status(a.board)).tasks["A-1"]?.verified, "verified");
});

test("defect R5-H1: a machine with checks off writes nothing for a re-check, and a verdict comment after the completion counts as judged", async (t) => {
  const { linear, a, b, advance } = await judgedMachines(
    t,
    () => 0.05,
    undefined,
  );
  // A person moves A-1 to done; no tool verdict exists anywhere.
  const done = await stateOf(linear, "completed");
  advance(2000);
  linear.moveIssue((await linear.issue("TA-1"))?.id ?? "", done.id);
  advance(2000);
  const viewB = await status(b.board);
  assert.deepEqual(await labelNames(linear, "TA-1"), []);
  assert.deepEqual(await commentBodies(linear, "TA-1"), []);
  assert.equal(viewB.tasks["A-1"]?.verified, "unverified", "B's local entry");
  // B-1: a verdict comment posted after its completion means some machine
  // judged it; A does not judge it again.
  const issue = await linear.issue("TA-2");
  assert.ok(issue !== null);
  linear.moveIssue(issue.id, done.id);
  advance(1000);
  await linear.createComment({
    issueId: issue.id,
    body: renderVerdictComment(
      { vendor: "codex", model: "m", sessionId: "s_other" },
      "vibecheck.claims-done",
      "review",
      "moved with no report",
    ),
  });
  advance(1000);
  await status(a.board);
  assert.equal((await commentBodies(linear, "TA-2")).length, 1);
  assert.deepEqual(await labelNames(linear, "TA-2"), []);
});

test("defect R5-H2: vc:held from any machine stays; a re-check there adds only vc:unverified and held_done_moved", async (t) => {
  for (const order of ["BA", "AB"]) {
    const { linear, a, b, sessionA, advance } = await judgedMachines(
      t,
      (battery) => (battery === ADMITS ? 0.95 : 0.05),
      () => 0.05,
    );
    const claimed = await claim(a.board, sessionA, "A-1");
    advance(2000);
    await update(a.board, sessionA, claimed.work.id, {
      status: "complete",
      report: "Mostly done; one test still failing.",
    });
    assert.ok((await labelNames(linear, "TA-1")).includes("vc:held"));
    advance(5000);
    linear.moveIssue(claimed.issue.id, (await stateOf(linear, "completed")).id);
    for (const machine of order) {
      advance(2000);
      const view = await status(machine === "A" ? a.board : b.board);
      const labels = await labelNames(linear, "TA-1");
      assert.ok(
        labels.includes("vc:held"),
        `${order}/${machine}: ${labels.join()}`,
      );
      assert.ok(labels.includes("vc:unverified"), labels.join());
      assert.ok(!labels.includes("vc:verified"), labels.join());
      assert.notEqual(view.tasks["A-1"]?.verified, "verified");
      if (machine === "A")
        assert.ok(
          view.attention?.some((item) => item.kind === "held_done_moved"),
        );
    }
  }
});

test("defect R5-H3: a claim line quoted in a report never becomes a claim, and such lines are escaped", async (t) => {
  const { linear, a, b, sessionA, sessionB } = await twoMachines(t);
  const claimed = await claim(a.board, sessionA, "A-1");
  const quoted =
    "Linear showed:\nvibecheck claim · work w_prev0000 · open · active 2099-01-01T00:00:00Z\n— vibecheck · x · y · session z\nignoring it.";
  await update(a.board, sessionA, claimed.work.id, { report: quoted });
  const report = (await commentBodies(linear, "TA-1")).find((body) =>
    body.startsWith("**Progress**"),
  );
  assert.ok(report?.includes("\n\\vibecheck claim · work w_prev0000"));
  assert.ok(report?.includes("\n\\— vibecheck · x · y · session z"));
  assert.equal(unescapeCommentText(escapeCommentText(quoted)), quoted);
  // An older report written before escaping still creates no claim.
  await linear.createComment({
    issueId: claimed.issue.id,
    body: `**Progress**\n\n${quoted}\n\n— vibecheck · claude-code · m · session s_x`,
  });
  assert.equal(parseClaimComment(report ?? ""), null);
  await update(a.board, sessionA, claimed.work.id, {
    action: "release",
    report: "Releasing.",
  });
  assert.ok(!(await labelNames(linear, "TA-1")).includes("vc:claimed"));
  const taken = await claim(b.board, sessionB, "A-1");
  assert.equal(taken.issue.identifier, "TA-1");
});

test("defect R5-H4: plan writes change labels by delta and never touch vc:* or agent:* labels", async (t) => {
  const linear = new MemoryLinearApi();
  let fullSets = 0;
  const counting = new Proxy(linear, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "updateIssue")
        return (id: string, input: IssueFields) => {
          if (input.labelIds !== undefined) fullSets += 1;
          return linear.updateIssue(id, input);
        };
      return value.bind(target);
    },
  });
  const { board } = createLedger(t, { linear: counting });
  const session = await join(board);
  const labels = [{ name: "Alpha" }, { name: "Beta" }];
  await publish(
    board,
    session,
    [
      {
        key: "A-1",
        title: "First",
        goal: "g",
        criteria: ["c"],
        labels: ["Alpha"],
      },
    ],
    { labels },
  );
  await claim(board, session, "A-1");
  await acceptingProblems(board, "plan_edit", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    expected_revision: 1,
    operations: [{ op: "update_task", task_id: "A-1", labels: ["Beta"] }],
  });
  assert.deepEqual((await labelNames(linear, "TA-1")).sort(), [
    "Beta",
    "agent:claude-code",
    "vc:claimed",
  ]);
  assert.equal(fullSets, 0, "no full labelIds set was sent");
});

test("defect R5-H5/M9: a refused queued row holds back only its issue, counts toward the cap and is set aside with write_dropped", async (t) => {
  const linear = new MemoryLinearApi();
  let refuse = "";
  const guarded = new Proxy(linear, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "createComment")
        return (input: { issueId: string; body: string; id?: string }) =>
          input.issueId === refuse
            ? Promise.reject(
                new LinearError("auth", "You do not have permission"),
              )
            : linear.createComment(input);
      return value.bind(target);
    },
  });
  const { board, store } = createLedger(t, { linear: guarded });
  const session = await join(board);
  await publish(board, session);
  const first = await claim(board, session, "A-1");
  const second = await claim(board, session, "B-1");
  refuse = first.issue.id;
  store.enqueue({
    projectKey: PROJECT_KEY,
    kind: "comment",
    payload: { id: randomUUID(), issueId: first.issue.id, body: "queued" },
  });
  store.enqueue({
    projectKey: PROJECT_KEY,
    kind: "add_label",
    payload: { issueId: first.issue.id, labelName: "vc:stalled" },
  });
  // Another issue's work goes on while A-1's rows wait.
  await update(board, session, second.work.id, { report: "Halfway there." });
  assert.ok(
    (await commentBodies(linear, "TA-2")).some((body) =>
      body.startsWith("**Progress**"),
    ),
  );
  assert.ok(!(await labelNames(linear, "TA-1")).includes("vc:stalled"));
  for (let call = 0; call < 5; call++) await status(board);
  const view = await status(board);
  const dropped = view.attention?.find((item) => item.kind === "write_dropped");
  assert.ok(dropped !== undefined);
  assert.match(dropped.reason, /comment.*TA-1.*You do not have permission/u);
  // Set aside at the cap: the later row of the issue goes out.
  assert.ok((await labelNames(linear, "TA-1")).includes("vc:stalled"));
  assert.equal(store.pendingCount(), 0);
});

test("defect R5-H6/M2/M3: issue_adopt keys and identifier keys in any case", async (t) => {
  const { board, linear } = createLedger(t);
  const { project } = await existingProject(linear);
  const second = await linear.createIssue({
    teamId: linear.teamId,
    projectId: project.id,
    title: "Second",
    description: "## Goal\n\nDo it\n\n## Done when\n\n- [ ] it is done\n",
  });
  const session = await join(board, "root", {
    linear_project: project.id,
    adopt: "managed",
  });
  const adopt = async (issue: string, key: string) => {
    const args = { project_id: PROJECT, session_id: session, issue, key };
    await acceptingProblems(board, "issue_adopt", {
      ...args,
      request_id: request(),
    });
    return acceptingProblems(board, "issue_adopt", {
      ...args,
      request_id: request(),
      confirm: true,
    });
  };
  // Another issue's identifier as a key: refused.
  await rejectsCode(adopt(second.identifier, "TA-1"), "invalid", /TA-2/u);
  // Its own identifier in another case: the identifier.
  const own = z
    .object({ task: z.object({ key: z.string() }) })
    .parse(await adopt(second.identifier, "ta-2"));
  assert.equal(own.task.key, "TA-2");
  // A keyed issue is never re-keyed.
  await rejectsCode(adopt(second.identifier, "RENAMED"), "conflict", /TA-2/u);
  // A lowercase identifier key in a managed publish is that issue.
  const published = z
    .object({
      task_map: z.record(z.string(), z.object({ identifier: z.string() })),
    })
    .parse(
      await acceptingProblems(board, "plan_publish", {
        project_id: PROJECT,
        request_id: request(),
        session_id: session,
        expected_revision: 1,
        project: { name: "vc-test-existing" },
        tasks: [
          { key: "TA-2", title: "Second" },
          { key: "ta-1", title: "Save identity exhausted", goal: "g" },
        ],
        confirm: true,
      }),
    );
  assert.equal(published.task_map["TA-1"]?.identifier, "TA-1");
  assert.equal(
    (await linear.issues({ projectId: project.id })).nodes.length,
    2,
    "no new issue",
  );
});

test("defect R5-H7: vc:* and agent:* names are reserved in plans, and status reads blocked from the tool's own work", async (t) => {
  const { board, linear } = createLedger(t);
  const session = await join(board);
  for (const extra of [
    { labels: [{ name: "vc:verified" }] },
    { labels: [{ name: "Agent:Codex" }] },
    { label_groups: [{ name: "VC:Kind", labels: [{ name: "Bug" }] }] },
  ])
    await rejectsCode(
      publish(board, session, undefined, extra),
      "invalid",
      /reserved/u,
    );
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  const blocked = await linear.createLabel({
    name: "vc:blocked",
    color: "#e5484d",
  });
  await linear.addLabel(claimed.issue.id, blocked.id);
  assert.equal((await status(board)).tasks["A-1"]?.status, "in_progress");
});

test("defect R5-M1: a call never overtakes older queued rows of its issue, label creation queues in an outage, and hook rows skip a finished issue", async (t) => {
  const linear = new MemoryLinearApi();
  const armed = { count: 0 };
  const flaky = failing(
    linear,
    "createLabel",
    () => new LinearError("network", "offline"),
    armed,
  );
  const { board, store } = createLedger(t, {
    linear: flaky,
    script: () => 0.05,
  });
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  // vc:blocked does not exist yet; creating it fails mid-call: queued.
  armed.count = 1;
  const result = await update(board, session, claimed.work.id, {
    status: "blocked",
    blocker: "Waiting on the API key from ops.",
  });
  assert.equal(result.work[0]?.status, "blocked");
  assert.ok(store.pendingCount() > 0);
  // The next call's drain creates the label and adds it.
  const issueId = claimed.issue.id;
  await status(board);
  assert.ok((await labelNames(linear, "TA-1")).includes("vc:blocked"));
  await update(board, session, claimed.work.id, {
    status: "in_progress",
    report: "Got the key.",
  });
  await status(board);
  assert.ok(!(await labelNames(linear, "TA-1")).includes("vc:blocked"));
  // A hook row marked skipIfCompleted is not sent once the issue is done.
  linear.moveIssue(issueId, (await stateOf(linear, "completed")).id);
  store.enqueue({
    projectKey: PROJECT_KEY,
    kind: "add_label",
    payload: { issueId, labelName: "vc:held", skipIfCompleted: true },
  });
  await status(board);
  assert.ok(!(await labelNames(linear, "TA-1")).includes("vc:held"));
  assert.equal(store.pendingCount(), 0);
});

test("defect R5-M1: with an older row of the issue queued, a progress change queues its writes behind it", async (t) => {
  const { board, store, linear } = createLedger(t);
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  // An older row of the issue waits in the queue (its drain stopped).
  store.enqueue({
    projectKey: PROJECT_KEY,
    kind: "add_label",
    payload: { issueId: claimed.issue.id, labelName: "vc:stalled" },
  });
  const writer = new Writer(store, linear, PROJECT_KEY);
  assert.equal(writer.behindQueue(claimed.issue.id), true);
  await writer.comment(claimed.issue.id, "after the queued row");
  assert.equal(writer.queued, 1);
  assert.equal(
    (await commentBodies(linear, "TA-1")).includes("after the queued row"),
    false,
  );
  await status(board);
  assert.ok(
    (await commentBodies(linear, "TA-1")).includes("after the queued row"),
  );
  assert.ok((await labelNames(linear, "TA-1")).includes("vc:stalled"));
});

test("defect R5-M5: report text is trimmed and whitespace-only text is no report", async (t) => {
  const { board, linear } = createLedger(t, { script: () => 0.05 });
  const session = await join(board);
  await publish(board, session);
  const claimed = await claim(board, session, "A-1");
  const result = await update(board, session, claimed.work.id, {
    status: "complete",
    report: "  \n\n  ",
  });
  assert.equal(
    result.verification?.find((item) => item.check === "vibecheck.claims-done")
      ?.outcome,
    "review",
  );
  assert.ok((await labelNames(linear, "TA-1")).includes("vc:unverified"));
  assert.ok(
    !(await commentBodies(linear, "TA-1")).some((body) =>
      body.startsWith("**Done**"),
    ),
  );
});

test("defect R5-M8: a queued move whose issue already reached its target counts as delivered", async (t) => {
  const { board, store, linear } = createLedger(t);
  const session = await join(board);
  await publish(board, session);
  const issue = await linear.issue("TA-1");
  assert.ok(issue !== null);
  const started = await stateOf(linear, "started");
  linear.moveIssue(issue.id, started.id);
  store.enqueue({
    projectKey: PROJECT_KEY,
    kind: "update_issue",
    payload: {
      id: issue.id,
      input: { stateId: started.id },
      expectStateId: issue.stateId,
    },
  });
  const view = await status(board);
  assert.ok(!view.attention?.some((item) => item.kind === "skipped_move"));
  assert.equal(store.pendingCount(), 0);
});

test("defect R5-low: completion requests, titles and summaries are checked as Linear counts them", async (t) => {
  const { board, linear } = createLedger(t);
  const session = await join(board);
  await rejectsCode(
    publish(board, session, undefined, {
      project: { name: "p", summary: "🚀".repeat(200) },
    }),
    "invalid",
  );
  assert.equal((await linear.projects()).length, 0, "nothing written");
  await publish(board, session, [
    { key: "A-1", title: "  First\n task  ", goal: "g", criteria: ["c"] },
  ]);
  assert.equal((await linear.issue("TA-1"))?.title, "A-1: First task");
  const claimed = await claim(board, session, "A-1");
  await rejectsCode(
    board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: session,
      updates: [
        {
          work_id: claimed.work.id,
          status: "complete",
          report: "Done.",
          blocker: "still waiting",
        },
      ],
    }),
    "invalid",
  );
});

test("defect R5-low: a child session repeating its parent's finished completion is forbidden", async (t) => {
  const { board } = createLedger(t);
  const parent = await join(board);
  await publish(board, parent);
  const child = await join(board, "child", { parent_session_id: parent });
  const claimed = await claim(board, parent, "A-1");
  const change = {
    work_id: claimed.work.id,
    status: "complete",
    report: "Done.",
  };
  await board.call("work_update", {
    project_id: PROJECT,
    request_id: request(),
    session_id: parent,
    updates: [change],
  });
  await rejectsCode(
    board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: child,
      updates: [change],
    }),
    "forbidden",
  );
});

test("defect R5-low: retrying a partly failed batch with other content for the failed change is a conflict", async (t) => {
  const linear = new MemoryLinearApi();
  let refuse = "";
  const guarded = new Proxy(linear, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "createComment")
        return (input: { issueId: string; body: string; id?: string }) =>
          input.issueId === refuse
            ? Promise.reject(new LinearError("invalid", "comment refused"))
            : linear.createComment(input);
      return value.bind(target);
    },
  });
  const { board } = createLedger(t, { linear: guarded });
  const session = await join(board);
  await publish(board, session);
  const first = await claim(board, session, "A-1");
  const second = await claim(board, session, "B-1");
  refuse = second.issue.id;
  const requestId = request();
  const call = (secondReport: string) =>
    board.call("work_update", {
      project_id: PROJECT,
      request_id: requestId,
      session_id: session,
      updates: [
        { work_id: first.work.id, report: "Progress on A." },
        { work_id: second.work.id, report: secondReport },
      ],
    });
  const partial = z
    .object({ results: z.array(z.object({ outcome: z.string() })) })
    .parse(await call("Progress on B."));
  assert.deepEqual(
    partial.results.map((entry) => entry.outcome),
    ["applied", "failed"],
  );
  await rejectsCode(call("Something else on B."), "conflict", /request_id/u);
  refuse = "";
  const retried = z
    .object({ results: z.array(z.object({ outcome: z.string() })) })
    .parse(await call("Progress on B."));
  assert.deepEqual(
    retried.results.map((entry) => entry.outcome),
    ["applied", "applied"],
  );
});

test("defect R5-low: in created mode a dropped milestone, priority, estimate and parent are cleared", async (t) => {
  const { board, linear } = createLedger(t);
  const session = await join(board);
  await publish(
    board,
    session,
    [
      {
        key: "A-1",
        title: "t",
        goal: "g",
        criteria: ["c"],
        milestone: "M1",
        priority: 2,
        estimate: 3,
      },
      {
        key: "B-1",
        title: "u",
        goal: "g",
        criteria: ["c"],
        parent: "A-1",
        milestone: "M1",
      },
    ],
    { milestones: [{ code: "M1", name: "One" }] },
  );
  await publish(
    board,
    session,
    [
      { key: "A-1", title: "t", goal: "g", criteria: ["c"] },
      { key: "B-1", title: "u", goal: "g", criteria: ["c"] },
    ],
    { expected_revision: 1 },
  );
  const a = await linear.issue("TA-1");
  const b = await linear.issue("TA-2");
  assert.equal(a?.projectMilestoneId, null);
  assert.equal(a?.priority, 0);
  assert.equal(a?.estimate, null);
  assert.equal(b?.parentId, null);
});

test("defect R5-low: issue_adopt merges another coordinator's map written at the same revision", async (t) => {
  const linear = new MemoryLinearApi();
  const race = { theirs: "" };
  const racing = new Proxy(linear, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "updateDocument")
        return async (id: string, input: { content?: string }) => {
          const written = await linear.updateDocument(id, input);
          const map = parsePlanDocument(input.content ?? "");
          // Right after this machine writes revision 2, another
          // coordinator's revision 2 lands without ADOPTED, with THEIRS.
          if (race.theirs !== "" && map !== null && map.revision === 2) {
            const { ["ADOPTED"]: _ours, ...rest } = map.tasks;
            const theirs = { ...map, tasks: { ...rest, THEIRS: race.theirs } };
            race.theirs = "";
            await linear.updateDocument(id, {
              content: (input.content ?? "").replace(
                /```json\n[\s\S]*?```/u,
                `\`\`\`json\n${JSON.stringify(theirs)}\n\`\`\``,
              ),
            });
          }
          return written;
        };
      return value.bind(target);
    },
  });
  const { board } = createLedger(t, { linear: racing });
  const session = await join(board);
  const published = publishedSchema.parse(await publish(board, session));
  const extra = await linear.createIssue({
    teamId: linear.teamId,
    projectId: published.linear_project_id,
    title: "A person's issue",
    description: "## Goal\n\nDo it\n\n## Done when\n\n- [ ] it is done\n",
  });
  const other = await linear.createIssue({
    teamId: linear.teamId,
    projectId: published.linear_project_id,
    title: "Their task",
  });
  race.theirs = other.identifier;
  const result = z
    .object({
      plan_revision: z.number(),
      merged_with: z.object({
        revision: z.number(),
        keys: z.array(z.string()),
      }),
    })
    .parse(
      await board.call("issue_adopt", {
        project_id: PROJECT,
        request_id: request(),
        session_id: session,
        issue: extra.identifier,
        key: "ADOPTED",
      }),
    );
  assert.equal(result.plan_revision, 3);
  assert.deepEqual(result.merged_with, { revision: 2, keys: ["THEIRS"] });
  const document = (await linear.documents(published.linear_project_id)).find(
    (entry) => entry.title === PLAN_DOCUMENT_TITLE,
  );
  const map = parsePlanDocument(document?.content ?? "");
  assert.equal(map?.tasks["ADOPTED"], extra.identifier);
  assert.equal(map?.tasks["THEIRS"], other.identifier);
});
