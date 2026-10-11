import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import type { MemoryLinearApi } from "../src/linear/memory.js";
import {
  acceptingProblems,
  PROJECT,
  PROJECT_KEY,
  claim,
  commentBodies,
  createLedger,
  join,
  labelNames,
  rejectsCode,
  request,
  status,
  update,
} from "./helpers.js";

const WRITTEN = `Reported by the owner during a playtest.

## Goal

Save requests never exhaust the identity pool during play.

## Acceptance criteria

- [x] the pool is checked before a save
- [ ] a test covers a full session of saves

## Notes from the owner

Keep this heading exactly as it is.
`;

/** An existing project with one structured issue and one free-form issue. */
async function existingProject(linear: MemoryLinearApi) {
  const project = await linear.createProject({
    name: "vc-test-existing",
    teamIds: [linear.teamId],
    content:
      "## Goal\n\nShip the anthology\n\n## Rules\n\n* Never rewrite history\n",
  });
  const structured = await linear.createIssue({
    teamId: linear.teamId,
    projectId: project.id,
    title: "SAVE-FATAL-5: Save identity exhausted",
    description: WRITTEN,
    priority: 3,
  });
  const loose = await linear.createIssue({
    teamId: linear.teamId,
    projectId: project.id,
    title: "Menu flickers",
    description: "The menu flickers on resize.",
  });
  await linear.createMilestone({
    projectId: project.id,
    name: "Existing milestone",
  });
  return { project, structured, loose };
}

/** The fields people own, for checking nothing changed them. */
async function contentOf(linear: MemoryLinearApi, projectId: string) {
  const project = await linear.project(projectId);
  const all = [...(await linear.issues({ projectId })).nodes].sort(
    (left, right) => left.id.localeCompare(right.id),
  );
  const issues = all.map((issue) => ({
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    estimate: issue.estimate,
    parentId: issue.parentId,
    projectMilestoneId: issue.projectMilestoneId,
  }));
  return {
    project: {
      name: project?.name,
      description: project?.description,
      content: project?.content,
      icon: project?.icon,
      color: project?.color,
      priority: project?.priority,
    },
    issues,
    milestones: await linear.milestones(projectId),
    documents: await linear.documents(projectId),
    relations: await Promise.all(
      all.map((issue) => linear.relations(issue.id)),
    ),
  };
}

const adoptionSchema = z.object({
  adoption_required: z.literal(true),
  question: z.string(),
  summary: z.object({
    issue_count: z.number(),
    issues_with_criteria: z.number(),
    readable_sections: z.record(z.string(), z.number()),
    milestones: z.array(z.string()),
  }),
});

test("joining an existing project asks the adoption question first and writes nothing", async (t) => {
  const { board, linear, store } = createLedger(t);
  const { project } = await existingProject(linear);
  const before = JSON.stringify(linear.exportState());
  const answer = adoptionSchema.parse(
    await board.call("project_join", {
      project_id: PROJECT,
      request_id: request(),
      repository: "repo",
      vendor: "claude-code",
      runtime: "cli",
      external_session_id: "root",
      model: "m",
      linear_project: project.url,
    }),
  );
  assert.equal(answer.summary.issue_count, 2);
  assert.equal(answer.summary.issues_with_criteria, 1);
  assert.equal(answer.summary.readable_sections["goal"], 1);
  assert.deepEqual(answer.summary.milestones, ["Existing milestone"]);
  assert.match(answer.question, /May vibecheck update this Linear project/u);
  assert.equal(store.project(PROJECT_KEY), undefined);
  assert.equal(JSON.stringify(linear.exportState()), before);
});

test("as_is refuses plan writes and changes no project or issue content while tracking work", async (t) => {
  const { board, linear, store } = createLedger(t);
  const { project, structured, loose } = await existingProject(linear);
  const root = await join(board, "root", {
    linear_project: project.id,
    adopt: "as_is",
  });
  const before = await contentOf(linear, project.id);
  await rejectsCode(
    acceptingProblems(board, "plan_publish", {
      project_id: PROJECT,
      request_id: request(),
      session_id: root,
      expected_revision: 0,
      project: { name: "vc-test-renamed" },
      tasks: [],
    }),
    "forbidden",
    /as_is/u,
  );
  await rejectsCode(
    acceptingProblems(board, "plan_edit", {
      project_id: PROJECT,
      request_id: request(),
      session_id: root,
      expected_revision: 0,
      operations: [{ op: "set_project", project: { icon: "Skull" } }],
    }),
    "forbidden",
    /as_is/u,
  );
  const adopted = z
    .object({ written: z.boolean(), missing_sections: z.array(z.string()) })
    .parse(
      await acceptingProblems(board, "issue_adopt", {
        project_id: PROJECT,
        request_id: request(),
        session_id: root,
        issue: structured.identifier,
        key: "SAVE-FATAL-5",
      }),
    );
  assert.equal(adopted.written, false);
  assert.deepEqual(adopted.missing_sections, [
    "files",
    "approach",
    "depends_on",
  ]);
  const claimed = await claim(board, root, structured.identifier, {
    paths: ["src/save.ts"],
  });
  assert.equal(claimed.work.task_id, structured.identifier);
  await update(board, root, claimed.work.id, {
    status: "complete",
    report:
      "The pool is checked before every save; a full-session test covers it.",
  });
  const view = await status(board);
  assert.equal(view.tasks[structured.identifier]?.status, "complete");
  assert.ok(
    view.attention?.some(
      (entry) =>
        entry.kind === "missing_standard" && entry.task_id === loose.identifier,
    ),
  );
  assert.deepEqual(await contentOf(linear, project.id), before);
  const labels = await labelNames(linear, structured.identifier);
  assert.ok(labels.includes("agent:claude-code"));
  assert.ok(
    (await commentBodies(linear, structured.identifier)).some((body) =>
      body.startsWith("**Done**"),
    ),
  );
  await rejectsCode(
    board.call("project_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: root,
      body: "Should not post.",
    }),
    "forbidden",
  );
  const key = store.allProjects()[0]?.key;
  assert.ok(key !== undefined);
  assert.deepEqual(store.project(key)?.policy, {
    goal: "Ship the anthology",
    rules: ["Never rewrite history"],
  });
});

const dryRunSchema = z.object({
  dry_run: z.literal(true),
  changes: z.array(
    z.object({ object: z.string(), key: z.string(), action: z.string() }),
  ),
  skipped: z.array(
    z.object({ object: z.string(), key: z.string(), field: z.string() }),
  ),
});

test("managed mode shows a dry run, then fills gaps and keeps every existing line on confirm", async (t) => {
  const { board, linear } = createLedger(t);
  const { project, structured } = await existingProject(linear);
  const root = await join(board, "root", {
    linear_project: project.id,
    adopt: "managed",
  });
  const plan = {
    project_id: PROJECT,
    session_id: root,
    expected_revision: 0,
    project: {
      name: "vc-test-rename-attempt",
      icon: "Skull",
      color: "#5e6ad2",
      summary: "One line.",
    },
    policy: { goal: "Ship the anthology", rules: ["Never rewrite history"] },
    milestones: [
      {
        code: "M0",
        name: "Owner defects",
        description: "Defects found in playtests.",
      },
    ],
    tasks: [
      {
        key: structured.identifier,
        title: "Save identity exhausted",
        goal: "A different goal the owner did not write",
        criteria: [
          "the pool is checked before a save",
          "a test covers a full session of saves",
        ],
        files: ["src/save/identity.ts"],
        approach: "Check the pool before each save.",
        milestone: "M0",
        priority: 1,
        estimate: 3,
      },
      {
        key: "SAVE-FATAL-6",
        title: "Save slot overflow",
        goal: "Saving to a full slot list never crashes the game",
        criteria: ["a full slot list shows an error instead of crashing"],
        depends_on: [structured.identifier],
        milestone: "M0",
      },
    ],
  };
  const before = JSON.stringify(linear.exportState());
  const dry = dryRunSchema.parse(
    await acceptingProblems(board, "plan_publish", {
      ...plan,
      request_id: request(),
    }),
  );
  assert.equal(
    JSON.stringify(linear.exportState()),
    before,
    "a dry run writes nothing",
  );
  assert.ok(
    dry.changes.some(
      (change) => change.object === "issue" && change.action === "create",
    ),
  );
  assert.ok(
    dry.changes.some(
      (change) => change.object === "milestone" && change.key === "M0",
    ),
  );
  const skipped = dry.skipped.map(
    (entry) => `${entry.object}.${entry.key}.${entry.field}`,
  );
  assert.ok(skipped.includes("project.vc-test-existing.name"));
  assert.ok(skipped.includes(`tasks.${structured.identifier}.goal`));
  assert.ok(skipped.includes(`tasks.${structured.identifier}.priority`));

  // The confirmed request must be the one whose dry run was shown.
  const withOverwrite = {
    ...plan,
    overwrite: [`tasks.${structured.identifier}.priority`],
  };
  dryRunSchema.parse(
    await acceptingProblems(board, "plan_publish", {
      ...withOverwrite,
      request_id: request(),
    }),
  );
  await acceptingProblems(board, "plan_publish", {
    ...withOverwrite,
    request_id: request(),
    confirm: true,
  });
  const after = await linear.project(project.id);
  assert.equal(
    after?.name,
    "vc-test-existing",
    "never renamed without overwrite",
  );
  assert.equal(after?.icon, "Skull", "empty icon filled");
  assert.equal(after?.description, "One line.");
  const issue = await linear.issue(structured.identifier);
  assert.ok(issue !== null);
  assert.equal(
    issue.title,
    "SAVE-FATAL-5: Save identity exhausted",
    "existing title kept",
  );
  assert.equal(issue.priority, 1, "overwritten because named in overwrite");
  assert.equal(issue.estimate, 3, "empty estimate filled");
  for (const line of [
    "Reported by the owner during a playtest.",
    "## Goal\n\nSave requests never exhaust the identity pool during play.",
    "- [x] the pool is checked before a save",
    "## Notes from the owner\n\nKeep this heading exactly as it is.",
    "## Files, lines and call sites",
    "## Approach\n\nCheck the pool before each save.",
  ])
    assert.ok(issue.description.includes(line), `kept or added: ${line}`);
  assert.ok(!issue.description.includes("A different goal"));
  const titles = (await linear.documents(project.id))
    .map((document) => document.title)
    .sort();
  assert.deepEqual(titles, ["vibecheck plan", "vibecheck policy"]);
  const milestones = (await linear.milestones(project.id)).map(
    (milestone) => milestone.name,
  );
  assert.deepEqual(milestones.sort(), [
    "Existing milestone",
    "M0 · Owner defects",
  ]);
  const created = (await linear.issues({ projectId: project.id })).nodes.find(
    (entry) => entry.title.startsWith("SAVE-FATAL-6: "),
  );
  assert.ok(created !== undefined);
  const relations = await linear.relations(created.id);
  assert.deepEqual(
    relations.map((relation) => relation.type),
    ["blocks"],
  );
  const edited = z.object({ plan_revision: z.number() }).parse(
    await acceptingProblems(board, "plan_edit", {
      project_id: PROJECT,
      request_id: request(),
      session_id: root,
      expected_revision: 1,
      operations: [{ op: "set_project", project: { priority: 2 } }],
    }),
  );
  assert.equal(
    edited.plan_revision,
    2,
    "after the first confirmed write, edits apply directly",
  );
});

test("switching an as_is project to managed is a join with adopt managed", async (t) => {
  const { board, linear, store } = createLedger(t);
  const { project } = await existingProject(linear);
  const root = await join(board, "root", {
    linear_project: project.id,
    adopt: "as_is",
  });
  await join(board, "root", { adopt: "managed" });
  const key = store.allProjects()[0]?.key;
  assert.ok(key !== undefined);
  assert.equal(store.project(key)?.adoption, "managed");
  const dry = dryRunSchema.parse(
    await acceptingProblems(board, "plan_edit", {
      project_id: PROJECT,
      request_id: request(),
      session_id: root,
      expected_revision: 0,
      operations: [{ op: "set_project", project: { icon: "Book" } }],
    }),
  );
  assert.ok(dry.changes.some((change) => change.object === "project"));
});
