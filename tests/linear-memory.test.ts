import assert from "node:assert/strict";
import test from "node:test";
import type { LinkedPullRequest } from "../src/linear/api.js";
import { isLinearError, LinearError } from "../src/linear/errors.js";
import { isValidIcon, KNOWN_ICONS } from "../src/linear/icons.js";
import { MEMORY_IDS, MemoryLinearApi } from "../src/linear/memory.js";
import { linearContract } from "./linear-contract.js";

linearContract("memory", async () => {
  const api = new MemoryLinearApi();
  return {
    api,
    teamId: api.teamId,
    prefix: "vc-test-memory",
    deleteLabel: (id) => api.deleteLabel(id),
    deleteIssue: async () => {},
    multiSelectLabelGroups: false,
    removeLabelOrFail: (issueId, labelId) => api.removeLabel(issueId, labelId),
  };
});

async function seededProject(api: MemoryLinearApi) {
  return api.createProject({ teamIds: [api.teamId], name: "vc-test-seed" });
}

test("memory seeds team TA with Linear's default workflow and project statuses", async () => {
  const api = new MemoryLinearApi();
  assert.deepEqual(await api.teams(), [
    { id: MEMORY_IDS.team, key: "TA", name: "Example Workspace" },
  ]);
  const states = await api.workflowStates(api.teamId);
  assert.deepEqual(
    states.map((state) => [state.name, state.type]),
    [
      ["Triage", "triage"],
      ["Backlog", "backlog"],
      ["Todo", "unstarted"],
      ["In Progress", "started"],
      ["In Review", "started"],
      ["Done", "completed"],
      ["Canceled", "canceled"],
      ["Duplicate", "canceled"],
    ],
  );
  assert.equal(
    states.find((state) => state.name === "In Progress")?.position,
    2,
  );
  assert.equal(states.find((state) => state.name === "In Review")?.position, 3);
  assert.deepEqual(await api.workflowStates("another-team"), []);
  assert.deepEqual(
    (await api.projectStatuses()).map((status) => [status.name, status.type]),
    [
      ["Backlog", "backlog"],
      ["Planned", "planned"],
      ["In Progress", "started"],
      ["Completed", "completed"],
      ["Canceled", "canceled"],
    ],
  );
  const viewer = await api.viewer();
  assert.equal(viewer.id, MEMORY_IDS.viewer);
  assert.notEqual(api.humanUserId, viewer.id);
  assert.equal(api.rateLimit(), null);
});

test("memory numbers issues per team and derives url and branch name", async () => {
  const api = new MemoryLinearApi();
  const project = await seededProject(api);
  const first = await api.createIssue({
    teamId: api.teamId,
    projectId: project.id,
    title: "SAVE-FATAL-5: Save request identity exhausted!",
  });
  const second = await api.createIssue({
    teamId: api.teamId,
    projectId: project.id,
    title: "Second",
  });
  assert.equal(first.identifier, "TA-1");
  assert.equal(second.identifier, "TA-2");
  assert.equal(
    first.branchName,
    "mike/ta-1-save-fatal-5-save-request-identity-exhausted",
  );
  assert.equal(
    first.url,
    "https://linear.app/example-workspace/issue/TA-1/save-fatal-5-save-request-identity-exhausted",
  );
  assert.equal((await api.issue("ta-2"))?.id, second.id);
  assert.equal(first.stateName, "Backlog");
});

test("memory timestamps come from the injected clock", async () => {
  let now = Date.parse("2026-10-10T12:00:00.000Z");
  const api = new MemoryLinearApi({ now: () => now });
  const project = await seededProject(api);
  const issue = await api.createIssue({
    teamId: api.teamId,
    projectId: project.id,
    title: "Clocked",
  });
  assert.equal(issue.createdAt, "2026-10-10T12:00:00.000Z");
  now += 60_000;
  const comment = await api.createComment({ issueId: issue.id, body: "later" });
  assert.equal(comment.createdAt, "2026-10-10T12:01:00.000Z");
});

test("memory's default clock makes every server timestamp strictly later", async () => {
  const api = new MemoryLinearApi();
  const project = await seededProject(api);
  const issue = await api.createIssue({
    teamId: api.teamId,
    projectId: project.id,
    title: "Race",
  });
  const comments = [];
  for (let index = 0; index < 5; index += 1) {
    comments.push(
      await api.createComment({ issueId: issue.id, body: `${index}` }),
    );
  }
  const times = comments.map((comment) => Date.parse(comment.createdAt));
  for (let index = 1; index < times.length; index += 1) {
    assert.ok((times[index] ?? 0) > (times[index - 1] ?? 0));
  }
});

test("memory pages issues 50 at a time by updatedAt, with cursors", async () => {
  const api = new MemoryLinearApi();
  const project = await seededProject(api);
  const other = await api.createProject({
    teamIds: [api.teamId],
    name: "other",
  });
  const created = [];
  for (let index = 0; index < 120; index += 1) {
    created.push(
      await api.createIssue({
        teamId: api.teamId,
        projectId: project.id,
        title: `Issue ${index}`,
      }),
    );
  }
  await api.createIssue({
    teamId: api.teamId,
    projectId: other.id,
    title: "elsewhere",
  });

  const seen: string[] = [];
  const sizes: number[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await api.issues({ projectId: project.id }, after);
    sizes.push(page.nodes.length);
    seen.push(...page.nodes.map((issue) => issue.id));
    if (page.next === null) break;
    after = page.next;
  }
  assert.deepEqual(sizes, [50, 50, 20]);
  assert.deepEqual(
    seen,
    created.map((issue) => issue.id),
  );

  const pivot = created[99];
  assert.ok(pivot !== undefined);
  const touched = created[3];
  assert.ok(touched !== undefined);
  await api.updateIssue(touched.id, { title: "Touched" });
  const changed = await api.issues({
    projectId: project.id,
    updatedAfter: pivot.updatedAt,
  });
  assert.deepEqual(
    changed.nodes.map((issue) => issue.title),
    [...created.slice(100).map((issue) => issue.title), "Touched"],
  );
  await assert.rejects(
    api.issues({ projectId: project.id }, "garbage"),
    (error) => isLinearError(error, "invalid"),
  );
});

test("memory hides archived issues unless asked and archives a deleted project's issues", async () => {
  const api = new MemoryLinearApi();
  const project = await seededProject(api);
  const kept = await api.createIssue({
    teamId: api.teamId,
    projectId: project.id,
    title: "kept",
  });
  const archived = await api.createIssue({
    teamId: api.teamId,
    projectId: project.id,
    title: "archived",
  });
  api.archiveIssue(archived.id);
  assert.deepEqual(
    (await api.issues({ projectId: project.id })).nodes.map(
      (issue) => issue.id,
    ),
    [kept.id],
  );
  assert.equal(
    (await api.issues({ projectId: project.id, includeArchived: true })).nodes
      .length,
    2,
  );
  await api.deleteProject(project.id);
  assert.equal(
    (await api.issues({ projectId: project.id, includeArchived: true })).nodes
      .length,
    2,
  );
  assert.equal((await api.issues({ projectId: project.id })).nodes.length, 0);
  await assert.rejects(
    api.updateProject(project.id, { name: "back" }),
    (error) => isLinearError(error, "not_found"),
  );
});

test("memory helpers act as a person: comments, reactions, moves", async () => {
  const api = new MemoryLinearApi();
  const project = await seededProject(api);
  const issue = await api.createIssue({
    teamId: api.teamId,
    projectId: project.id,
    title: "Human",
  });
  const human = api.addHumanComment(
    issue.id,
    "Please also cover the empty case.",
  );
  assert.equal(human.userId, api.humanUserId);
  api.addReaction(human.id, "thumbsup", (await api.viewer()).id);
  api.addReaction(human.id, "+1", (await api.viewer()).id);
  api.addReaction(human.id, "eyes");
  const [read] = await api.comments(issue.id);
  assert.deepEqual(read?.reactions, [
    { emoji: "+1", userId: MEMORY_IDS.viewer },
    { emoji: "eyes", userId: MEMORY_IDS.human },
  ]);

  const done = (await api.workflowStates(api.teamId)).find(
    (state) => state.type === "completed",
  );
  assert.ok(done !== undefined);
  const before = await api.issue(issue.id);
  const moved = api.moveIssue(issue.id, done.id);
  assert.equal(moved.stateType, "completed");
  assert.ok(moved.completedAt !== null);
  assert.ok(Date.parse(moved.updatedAt) > Date.parse(before?.updatedAt ?? ""));
  assert.throws(
    () => api.moveIssue(issue.id, "no-such-state"),
    (error) => isLinearError(error, "not_found"),
  );
});

test("memory pull requests come from setPullRequests", async () => {
  const api = new MemoryLinearApi();
  const project = await seededProject(api);
  const issue = await api.createIssue({
    teamId: api.teamId,
    projectId: project.id,
    title: "PR",
  });
  const pr: LinkedPullRequest = {
    url: "https://github.com/example/app/pull/48",
    title: "P03.01: storage checks",
    source: "github",
    number: 48,
    branch: "mike/ta-1-pr",
    draft: false,
    createdAt: "2026-10-10T22:58:55.000Z",
    closedAt: null,
    mergedAt: "2026-10-11T09:00:00.000Z",
    hasConflicts: false,
  };
  api.setPullRequests(issue.id, [pr]);
  assert.deepEqual(await api.pullRequests(issue.id), [pr]);
  api.setPullRequests(issue.id, []);
  assert.deepEqual(await api.pullRequests(issue.id), []);
});

test("memory failNext throws one queued LinearError per call", async () => {
  const api = new MemoryLinearApi();
  api.failNext("rate_limited");
  api.failNext("network", { message: "socket hang up" });
  await assert.rejects(api.viewer(), (error: unknown) => {
    assert.ok(error instanceof LinearError);
    assert.equal(error.kind, "rate_limited");
    assert.equal(error.retryAfterMs, 1000);
    return true;
  });
  await assert.rejects(api.teams(), (error: unknown) => {
    assert.ok(isLinearError(error, "network"));
    assert.equal(error.message, "socket hang up");
    return true;
  });
  assert.equal((await api.viewer()).id, MEMORY_IDS.viewer);
});

test("memory validates references and keeps client ids", async () => {
  const api = new MemoryLinearApi();
  const project = await seededProject(api);
  await assert.rejects(
    api.createIssue({
      teamId: api.teamId,
      projectId: project.id,
      title: "x",
      stateId: "nope",
    }),
    (error) => isLinearError(error, "not_found"),
  );
  await assert.rejects(
    api.createIssue({ teamId: "nope", projectId: project.id, title: "x" }),
    (error) => isLinearError(error, "not_found"),
  );
  await assert.rejects(
    api.createProject({ teamIds: [], name: "teamless" }),
    (error) => isLinearError(error, "invalid"),
  );
  await assert.rejects(
    api.createIssue({
      teamId: api.teamId,
      projectId: project.id,
      title: "x",
      estimate: 1.5,
    }),
    (error) => isLinearError(error, "invalid"),
  );
  const exact = await api.createProject({
    id: "11111111-2222-4333-8444-555555555555",
    teamIds: [api.teamId],
    name: "exact",
    description: "x".repeat(255),
  });
  assert.equal(exact.id, "11111111-2222-4333-8444-555555555555");
  assert.equal(exact.description.length, 255);
});

test("icons: known names and shortcodes pass; raw emoji and unknown names fail", () => {
  for (const name of ["Skull", "Rocket", "Book", "Shield", "World", "Page"]) {
    assert.ok(isValidIcon(name), name);
  }
  assert.ok(isValidIcon(":rocket:"));
  assert.ok(isValidIcon(":+1:"));
  for (const name of [
    "🚀",
    "NotARealIcon123",
    "Map",
    "Document",
    "rocket",
    ":Rocket",
    "",
  ]) {
    assert.ok(!isValidIcon(name), name);
  }
  assert.ok(KNOWN_ICONS.size >= 40);
});

test("memory allows several labels from a multi-select group when the workspace does", async () => {
  const api = new MemoryLinearApi({ multiSelectLabelGroups: true });
  const project = await seededProject(api);
  const group = await api.createLabel({
    name: "vibecheck",
    isGroup: true,
    groupType: "multiSelect",
  });
  const claimed = await api.createLabel({
    name: "vc:claimed",
    parentId: group.id,
  });
  const verified = await api.createLabel({
    name: "vc:verified",
    parentId: group.id,
  });
  const issue = await api.createIssue({
    teamId: api.teamId,
    projectId: project.id,
    title: "Both",
    labelIds: [claimed.id, verified.id],
  });
  assert.deepEqual(issue.labelIds, [claimed.id, verified.id]);
});
