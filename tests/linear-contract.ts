// Contract scenarios every LinearApi implementation must pass.
//
// Written once and registered twice: against MemoryLinearApi
// (tests/linear-memory.test.ts) and against real Linear
// (tests/linear-live.test.ts, only with VLJ_LIVE_LINEAR=1). The scenarios
// share one scratch project named with the harness prefix and delete every
// object they create when the file finishes.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import type {
  Issue,
  LinearApi,
  Project,
  ProjectStatus,
  StateType,
  WorkflowState,
} from "../src/linear/api.js";
import {
  isLabelNotOnIssue,
  isLinearError,
  removeLabelIfPresent,
  type LinearErrorKind,
} from "../src/linear/errors.js";

/** What a contract run needs from the implementation under test. */
export interface ContractHarness {
  readonly api: LinearApi;
  readonly teamId: string;
  /** Every project and label name starts with this (`vc-test-...`). */
  readonly prefix: string;
  /** Removes a label the scenarios created. */
  deleteLabel(id: string): Promise<void>;
  /** Trashes an issue the scenarios created. */
  deleteIssue(id: string): Promise<void>;
  /** Whether the workspace allows multi-select label groups. */
  readonly multiSelectLabelGroups: boolean;
  /** Removes a label with no tolerance at all, so Linear's own refusal shows. */
  removeLabelOrFail(issueId: string, labelId: string): Promise<void>;
}

export interface ContractOptions {
  /** Skip every scenario, with this reason. */
  readonly skip?: string | false;
}

async function rejectsWith(
  promise: Promise<unknown>,
  kind: LinearErrorKind,
  message?: RegExp,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(
      isLinearError(error),
      `expected LinearError, got ${String(error)}`,
    );
    assert.equal(error.kind, kind, `kind for "${error.message}"`);
    if (message !== undefined) assert.match(error.message, message);
    return true;
  });
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Registers the contract scenarios as top-level tests. */
export function linearContract(
  suite: string,
  setup: () => Promise<ContractHarness>,
  options: ContractOptions = {},
): void {
  const skip = options.skip ?? false;
  let harnessPromise: Promise<ContractHarness> | null = null;
  const harness = (): Promise<ContractHarness> => {
    harnessPromise ??= setup();
    return harnessPromise;
  };

  const created: {
    readonly projects: string[];
    readonly issues: string[];
    readonly labels: string[];
  } = { projects: [], issues: [], labels: [] };
  let project: Project | null = null;
  let states: readonly WorkflowState[] = [];
  const issues: Issue[] = [];

  const requireProject = (): Project => {
    assert.ok(project !== null, "the project scenario must run first");
    return project;
  };
  const stateOf = (type: WorkflowState["type"]): WorkflowState => {
    const state = states.find((candidate) => candidate.type === type);
    assert.ok(state !== undefined, `team has a ${type} state`);
    return state;
  };
  const issueAt = (index: number): Issue => {
    const issue = issues[index];
    assert.ok(issue !== undefined, `issue ${index} was created`);
    return issue;
  };

  after(async () => {
    if (harnessPromise === null) return;
    const { api, deleteIssue, deleteLabel } = await harnessPromise;
    const failures: string[] = [];
    const attempt = async (what: string, run: () => Promise<void>) => {
      try {
        await run();
      } catch (error) {
        if (!isLinearError(error, "not_found")) {
          failures.push(`${what}: ${String(error)}`);
        }
      }
    };
    for (const id of created.issues) {
      await attempt(`issue ${id}`, () => deleteIssue(id));
    }
    for (const id of created.projects) {
      await attempt(`project ${id}`, () => api.deleteProject(id));
    }
    for (const id of [...created.labels].reverse()) {
      await attempt(`label ${id}`, () => deleteLabel(id));
    }
    assert.deepEqual(failures, [], "cleanup failed; delete these by hand");
  });

  test(
    `${suite}: viewer, teams, workflow states and project statuses`,
    { skip },
    async () => {
      const { api, teamId } = await harness();
      const viewer = await api.viewer();
      assert.ok(viewer.id.length > 0);
      assert.ok(viewer.organization.urlKey.length > 0);
      const teams = await api.teams();
      assert.ok(teams.some((team) => team.id === teamId));
      states = await api.workflowStates(teamId);
      const stateTypes: readonly StateType[] = [
        "backlog",
        "unstarted",
        "started",
        "completed",
        "canceled",
      ];
      for (const type of stateTypes) {
        assert.ok(
          states.some((state) => state.type === type),
          `has ${type}`,
        );
      }
      const positions = states.map((state) => state.position);
      assert.deepEqual(
        positions,
        [...positions].sort((left, right) => left - right),
      );
      const statuses = await api.projectStatuses();
      const statusTypes: readonly ProjectStatus["type"][] = [
        "backlog",
        "planned",
        "started",
        "completed",
        "canceled",
      ];
      for (const type of statusTypes) {
        assert.ok(
          statuses.some((status) => status.type === type),
          `has ${type} status`,
        );
      }
    },
  );

  test(
    `${suite}: a project keeps its client id and every field`,
    { skip },
    async () => {
      const { api, teamId, prefix } = await harness();
      const statuses = await api.projectStatuses();
      const planned = statuses.find((status) => status.type === "planned");
      assert.ok(planned !== undefined);
      const id = randomUUID();
      created.projects.push(id);
      project = await api.createProject({
        id,
        teamIds: [teamId],
        name: `${prefix} contract`,
        icon: "Skull",
        color: "#5e6ad2",
        description: "One-line summary of the contract project.",
        content: "# Overview\n\nThe long overview lives in content.",
        statusId: planned.id,
        priority: 2,
        startDate: "2026-10-01",
        startDateResolution: "month",
        targetDate: "2026-12-31",
        targetDateResolution: "quarter",
      });
      assert.equal(project.id, id);
      assert.equal(project.icon, "Skull");
      assert.equal(project.color, "#5e6ad2");
      assert.equal(
        project.description,
        "One-line summary of the contract project.",
      );
      assert.match(project.content, /long overview/);
      assert.equal(project.statusId, planned.id);
      assert.equal(project.priority, 2);
      assert.equal(project.startDate, "2026-10-01");
      assert.equal(project.targetDate, "2026-12-31");
      assert.deepEqual(project.teamIds, [teamId]);
      assert.ok(project.slugId.length > 0);
      assert.ok(project.url.startsWith("https://linear.app/"));

      const byId = await api.project(id);
      const bySlug = await api.project(project.slugId);
      assert.equal(byId?.id, id);
      assert.equal(bySlug?.id, id);
      assert.equal(await api.project(randomUUID()), null);
      const listed = await api.projects(prefix);
      assert.ok(listed.some((candidate) => candidate.id === id));

      const updated = await api.updateProject(id, {
        icon: ":rocket:",
        priority: 3,
      });
      assert.equal(updated.icon, ":rocket:");
      assert.equal(updated.priority, 3);
      project = updated;
    },
  );

  test(
    `${suite}: project fields are validated as Linear validates them`,
    { skip },
    async () => {
      const { api, teamId, prefix } = await harness();
      const { id } = requireProject();
      await rejectsWith(
        api.updateProject(id, { description: "x".repeat(256) }),
        "invalid",
        /description must be shorter than or equal to 255 characters/,
      );
      await rejectsWith(
        api.updateProject(id, { color: "red" }),
        "invalid",
        /color must be a hexadecimal color/,
      );
      await rejectsWith(
        api.updateProject(id, { icon: "NotARealIcon123" }),
        "invalid",
        /icon is not a valid icon/,
      );
      await rejectsWith(
        api.updateProject(id, { icon: "🚀" }),
        "invalid",
        /icon/,
      );
      await rejectsWith(
        api.createProject({
          id,
          teamIds: [teamId],
          name: `${prefix} duplicate`,
        }),
        "invalid",
        /already exists/,
      );
      await rejectsWith(
        api.updateProject(id, { priority: 7 }),
        "invalid",
        /priority/,
      );
    },
  );

  test(`${suite}: milestones, documents and links`, { skip }, async () => {
    const { api } = await harness();
    const { id: projectId } = requireProject();
    const first = await api.createMilestone({
      id: randomUUID(),
      projectId,
      name: "M1 · Foundations",
      description: "What is in it.",
      targetDate: "2026-11-01",
    });
    const second = await api.createMilestone({
      projectId,
      name: "M2 · Rollout",
    });
    assert.equal(first.description, "What is in it.");
    assert.equal(first.targetDate, "2026-11-01");
    assert.equal(second.description, "");
    const milestones = await api.milestones(projectId);
    assert.deepEqual(
      milestones.map((milestone) => milestone.id),
      [first.id, second.id],
    );
    const renamed = await api.updateMilestone(second.id, {
      name: "M2 · Release",
    });
    assert.equal(renamed.name, "M2 · Release");
    await rejectsWith(
      api.createMilestone({ projectId, name: "x" }),
      "invalid",
      /name must be longer than or equal to 2 characters/,
    );

    const documentId = randomUUID();
    const document = await api.createDocument({
      id: documentId,
      projectId,
      title: "vibecheck policy",
      icon: "Shield",
      color: "#30a46c",
      content: "## Goal\n\nShip it.",
    });
    assert.equal(document.id, documentId);
    assert.equal(document.projectId, projectId);
    assert.equal(document.icon, "Shield");
    const edited = await api.updateDocument(documentId, {
      content: "## Goal\n\nShip it well.",
    });
    assert.match(edited.content, /Ship it well/);
    const documents = await api.documents(projectId);
    assert.ok(documents.some((candidate) => candidate.id === documentId));
    await rejectsWith(
      api.createDocument({ projectId, title: "bad", icon: "Map" }),
      "invalid",
      /icon is not a valid icon/,
    );

    const link = await api.createExternalLink(projectId, {
      id: randomUUID(),
      label: "Repository",
      url: "https://github.com/mgd34msu/vibecheck-linear-jev",
    });
    const links = await api.externalLinks(projectId);
    assert.deepEqual(
      links.map((candidate) => candidate.id),
      [link.id],
    );
    await rejectsWith(
      api.createExternalLink(projectId, { label: "bad", url: "not a url" }),
      "invalid",
      /link URL is not valid/,
    );
  });

  test(
    `${suite}: label groups, child labels and Linear's label rules`,
    { skip },
    async () => {
      const {
        api,
        teamId,
        prefix,
        multiSelectLabelGroups: multiSelect,
      } = await harness();
      const group = await api.createLabel({
        id: randomUUID(),
        name: `${prefix}-group`,
        color: "#6e56cf",
        isGroup: true,
      });
      created.labels.push(group.id);
      const child = await api.createLabel({
        name: `${prefix}-child`,
        color: "#5e6ad2",
        description: "A child label.",
        parentId: group.id,
      });
      created.labels.push(child.id);
      const sibling = await api.createLabel({
        name: `${prefix}-sibling`,
        parentId: group.id,
      });
      created.labels.push(sibling.id);
      assert.equal(group.isGroup, true);
      assert.equal(group.teamId, null);
      assert.equal(child.parentId, group.id);
      assert.equal(child.description, "A child label.");

      const labels = await api.labels(teamId);
      assert.ok(labels.some((label) => label.id === group.id));
      assert.ok(
        labels.some(
          (label) => label.id === child.id && label.parentId === group.id,
        ),
      );

      await rejectsWith(
        api.createLabel({ name: `${prefix}-child`, teamId }),
        "invalid",
        /already exists/,
      );
      await rejectsWith(
        api.createLabel({ name: `${prefix}-orphan`, parentId: child.id }),
        "invalid",
        /non-group parent/,
      );
      await rejectsWith(
        api.createLabel({ name: `${prefix}-colour`, color: "#12345" }),
        "invalid",
        /hexadecimal color/,
      );
      const multi = api.createLabel({
        name: `${prefix}-multi`,
        isGroup: true,
        groupType: "multiSelect",
      });
      if (multiSelect) {
        created.labels.push((await multi).id);
      } else {
        await rejectsWith(
          multi,
          "invalid",
          /Multi-select label groups are not enabled/,
        );
      }
    },
  );

  test(
    `${suite}: issues are created, read, updated and moved`,
    { skip },
    async () => {
      const { api, teamId, prefix } = await harness();
      const { id: projectId } = requireProject();
      const id = randomUUID();
      created.issues.push(id);
      const issue = await api.createIssue({
        id,
        teamId,
        projectId,
        title: "CONTRACT-1: First contract issue",
        description: "## What it is\n\nA test issue.",
        priority: 2,
        estimate: 3,
        dueDate: "2026-12-01",
      });
      issues.push(issue);
      assert.equal(issue.id, id);
      assert.match(issue.identifier, /^[A-Z]+-\d+$/);
      assert.ok(issue.branchName.includes(issue.identifier.toLowerCase()));
      assert.equal(issue.stateType, "backlog");
      assert.equal(issue.projectId, projectId);
      assert.equal(issue.estimate, 3);
      assert.equal(issue.dueDate, "2026-12-01");
      assert.equal(issue.completedAt, null);

      const second = await api.createIssue({
        teamId,
        projectId,
        title: "CONTRACT-2: Second contract issue",
      });
      created.issues.push(second.id);
      issues.push(second);
      assert.equal(second.description, "");

      assert.equal((await api.issue(issue.identifier))?.id, id);
      assert.equal((await api.issue(id))?.identifier, issue.identifier);
      assert.equal(await api.issue(randomUUID()), null);

      const started = await api.updateIssue(id, {
        stateId: stateOf("started").id,
      });
      assert.equal(started.stateType, "started");
      const done = await api.updateIssue(id, {
        stateId: stateOf("completed").id,
      });
      assert.equal(done.stateType, "completed");
      assert.ok(done.completedAt !== null);
      const reopened = await api.updateIssue(id, {
        stateId: stateOf("unstarted").id,
        estimate: null,
        dueDate: null,
      });
      assert.equal(reopened.completedAt, null);
      assert.equal(reopened.estimate, null);
      assert.equal(reopened.dueDate, null);

      await rejectsWith(
        api.updateIssue(id, { priority: 9 }),
        "invalid",
        /priority/,
      );
      await rejectsWith(
        api.createIssue({ id, teamId, projectId, title: "dup" }),
        "invalid",
        /already exists/,
      );
      await rejectsWith(
        api.createIssue({ teamId, projectId, title: "" }),
        "invalid",
        /title/,
      );

      const label = (await api.labels(teamId)).find(
        (candidate) => candidate.name === `${prefix}-child`,
      );
      assert.ok(label !== undefined, "the label scenario ran");
      await api.addLabel(id, label.id);
      assert.deepEqual((await api.issue(id))?.labelIds, [label.id]);
      const sibling = (await api.labels(teamId)).find(
        (candidate) => candidate.name === `${prefix}-sibling`,
      );
      assert.ok(sibling !== undefined);
      await rejectsWith(
        api.addLabel(id, sibling.id),
        "invalid",
        /Only one label in a group can be applied to an issue/,
      );
      await rejectsWith(
        api.updateIssue(id, { labelIds: [label.id, sibling.id] }),
        "invalid",
        /Only one label in a group/,
      );
      await api.removeLabel(id, label.id);
      assert.deepEqual((await api.issue(id))?.labelIds, []);
      // Removing a label the issue no longer carries: Linear refuses it with
      // "Label <id> is not on issue <id> and cannot be removed.", and the
      // tolerant path every ledger removal takes counts that as done.
      const { removeLabelOrFail } = await harness();
      await rejectsWith(
        removeLabelOrFail(id, label.id),
        "invalid",
        /^Label \S+ is not on issue \S+ and cannot be removed\.?$/u,
      );
      await removeLabelOrFail(id, label.id).then(
        () => assert.fail("Linear removed a label the issue does not carry"),
        (error: unknown) => assert.ok(isLabelNotOnIssue(error), String(error)),
      );
      await removeLabelIfPresent(api, id, label.id);
      assert.deepEqual((await api.issue(id))?.labelIds, []);
    },
  );

  test(
    `${suite}: issue listing filters by project and updatedAfter, oldest first`,
    { skip },
    async () => {
      const { api } = await harness();
      const { id: projectId } = requireProject();
      const first = issueAt(0);
      const second = issueAt(1);
      const page = await api.issues({ projectId });
      const ids = page.nodes.map((issue) => issue.id);
      assert.ok(ids.includes(first.id) && ids.includes(second.id));
      assert.equal(page.next, null);
      const times = page.nodes.map((issue) => Date.parse(issue.updatedAt));
      assert.deepEqual(
        times,
        [...times].sort((left, right) => left - right),
      );

      const before = await api.issue(first.id);
      assert.ok(before !== null);
      await pause(20);
      const touched = await api.updateIssue(second.id, { priority: 4 });
      const later = await api.issues({
        projectId,
        updatedAfter: before.updatedAt,
      });
      const laterIds = later.nodes.map((issue) => issue.id);
      assert.ok(laterIds.includes(touched.id));
      assert.ok(!laterIds.includes(first.id));
    },
  );

  test(
    `${suite}: relations are visible from both issues`,
    { skip },
    async () => {
      const { api } = await harness();
      const first = issueAt(0);
      const second = issueAt(1);
      const relation = await api.createRelation({
        id: randomUUID(),
        type: "blocks",
        issueId: first.id,
        relatedIssueId: second.id,
      });
      assert.equal(relation.type, "blocks");
      assert.equal(relation.issueId, first.id);
      assert.equal(relation.relatedIssueId, second.id);
      for (const issueId of [first.id, second.id]) {
        const relations = await api.relations(issueId);
        assert.deepEqual(
          relations.map((candidate) => candidate.id),
          [relation.id],
        );
      }
      await api.deleteRelation(relation.id);
      assert.deepEqual(await api.relations(first.id), []);
    },
  );

  test(
    `${suite}: comments order by server time and do not touch the issue`,
    { skip },
    async () => {
      const { api } = await harness();
      const issue = issueAt(1);
      const before = await api.issue(issue.id);
      assert.ok(before !== null);
      const viewer = await api.viewer();
      const firstId = randomUUID();
      const first = await api.createComment({
        id: firstId,
        issueId: issue.id,
        body: "first",
      });
      const second = await api.createComment({
        issueId: issue.id,
        body: "second",
      });
      assert.equal(first.id, firstId);
      assert.equal(first.userId, viewer.id);
      assert.equal(first.issueId, issue.id);
      assert.deepEqual(first.reactions, []);
      assert.ok(Date.parse(second.createdAt) > Date.parse(first.createdAt));

      const comments = await api.comments(issue.id);
      assert.deepEqual(
        comments.map((comment) => comment.id),
        [first.id, second.id],
      );
      const edited = await api.updateComment(first.id, "first, edited");
      assert.equal(edited.body, "first, edited");
      assert.equal(edited.createdAt, first.createdAt);
      await api.deleteComment(second.id);
      assert.deepEqual(
        (await api.comments(issue.id)).map((comment) => comment.id),
        [first.id],
      );
      await rejectsWith(
        api.createComment({ id: firstId, issueId: issue.id, body: "dup" }),
        "invalid",
        /already exists/,
      );
      const after = await api.issue(issue.id);
      assert.equal(
        after?.updatedAt,
        before.updatedAt,
        "comments leave updatedAt alone",
      );
    },
  );

  test(
    `${suite}: pull requests are empty without a Git link`,
    { skip },
    async () => {
      const { api } = await harness();
      assert.deepEqual(await api.pullRequests(issueAt(0).id), []);
    },
  );

  test(
    `${suite}: project updates carry health, onTrack by default`,
    { skip },
    async () => {
      const { api } = await harness();
      const { id: projectId } = requireProject();
      const risky = await api.createProjectUpdate({
        id: randomUUID(),
        projectId,
        body: "Two blockers open: TA-1, TA-2.",
        health: "atRisk",
      });
      assert.equal(risky.health, "atRisk");
      const plain = await api.createProjectUpdate({
        projectId,
        body: "All clear.",
      });
      assert.equal(plain.health, "onTrack");
      const updates = await api.projectUpdates(projectId);
      assert.deepEqual(
        updates.map((update) => update.id),
        [risky.id, plain.id],
      );
    },
  );

  test(
    `${suite}: deleting a project moves it out of reach`,
    { skip },
    async () => {
      const { api, teamId, prefix } = await harness();
      const id = randomUUID();
      created.projects.push(id);
      await api.createProject({
        id,
        teamIds: [teamId],
        name: `${prefix} doomed`,
      });
      await api.deleteProject(id);
      assert.equal(await api.project(id), null);
      assert.ok(
        !(await api.projects(prefix)).some((candidate) => candidate.id === id),
      );
    },
  );
}
