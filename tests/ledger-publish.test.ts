import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { parsePlanDocument } from "../src/linear/documents.js";
import { MEMORY_IDS } from "../src/linear/memory.js";
import {
  acceptingProblems,
  PROJECT,
  PROJECT_KEY,
  createLedger,
  join,
  labelNames,
  publish,
  rejectsCode,
  request,
} from "./helpers.js";

const FULL = {
  project: {
    name: "vc-test-reports",
    summary: "Reports export as CSV and PDF.",
    overview: "# Reports\n\nWhere the code lives: src/reports.",
    icon: "Rocket",
    color: "#5e6ad2",
    priority: 2,
    status: "planned",
    start_date: "2026-10-01",
    start_resolution: "month",
    target_date: "2026-12-31",
    target_resolution: "quarter",
    labels: [{ name: "vc-test-reporting", color: "#30a46c" }],
  },
  policy: {
    goal: "Every report can be exported",
    rules: ["No new runtime dependencies"],
    authorizations: ["Run the test suite"],
    stop_reasons: ["The user asks to stop"],
  },
  label_groups: [
    {
      name: "vc-test-Kind",
      color: "#e5484d",
      labels: [{ name: "vc-test-Feature" }, { name: "vc-test-Defect" }],
    },
    {
      name: "vc-test-Area",
      labels: [{ name: "vc-test-Export" }, { name: "vc-test-UI" }],
    },
  ],
  labels: [{ name: "vc-test-Q1", color: "#0090ff" }],
  milestones: [
    {
      name: "Exports",
      description: "CSV and PDF export of the reports table.",
      target_date: "2026-11-15",
    },
    { code: "U", name: "Unification" },
  ],
  documents: [
    {
      title: "Architecture",
      icon: "Book",
      color: "#6e56cf",
      content: "# Architecture",
    },
  ],
  links: [{ label: "Repository", url: "https://example.com/reports" }],
  tasks: [
    {
      key: "EXPORT-CSV-1",
      title: "CSV export",
      goal: "Export the reports table as CSV with every visible column",
      criteria: [
        "every visible column is exported",
        "a test covers the export",
      ],
      rules: ["Stream rows; never load the table into memory"],
      exceptions: [
        {
          description: "labels.ts holds label text only",
          paths: ["src/labels.ts"],
          data_only: true,
        },
      ],
      files: ["src/reports/csv.ts"],
      approach: "Stream rows through the existing writer.",
      out_of_scope: ["Excel export"],
      labels: ["vc-test-Feature", "vc-test-Export", "vc-test-Q1"],
      milestone: "M1",
      priority: 2,
      estimate: 3,
      due_date: "2026-11-01",
    },
    {
      key: "EXPORT-PDF-1",
      title: "PDF export",
      goal: "Export the reports table as a paginated PDF",
      criteria: ["the PDF has every visible column"],
      depends_on: ["EXPORT-CSV-1"],
      parent: "EXPORT-CSV-1",
      labels: ["vc-test-Feature", "vc-test-UI"],
      milestone: "U",
    },
  ],
  update: { health: "onTrack", body: "Plan published." },
};

const publishResult = z.object({
  plan_revision: z.number(),
  project_url: z.string(),
  task_map: z.record(
    z.string(),
    z.object({ identifier: z.string(), url: z.string(), issue_id: z.string() }),
  ),
  completeness: z.object({
    project: z.array(z.string()).optional(),
    milestones: z.record(z.string(), z.array(z.string())).optional(),
    tasks: z.record(z.string(), z.array(z.string())).optional(),
  }),
});

test("plan_publish fills every field of the project, its labels, milestones, documents, issues and relations", async (t) => {
  const { board, linear } = createLedger(t);
  const session = await join(board);
  const result = publishResult.parse(
    await publish(board, session, FULL.tasks, {
      project: FULL.project,
      policy: FULL.policy,
      label_groups: FULL.label_groups,
      labels: FULL.labels,
      milestones: FULL.milestones,
      documents: FULL.documents,
      links: FULL.links,
      update: FULL.update,
    }),
  );
  assert.equal(result.plan_revision, 1);
  const [project] = await linear.projects("vc-test-reports");
  assert.ok(project !== undefined);
  assert.equal(project.icon, "Rocket");
  assert.equal(project.color, "#5e6ad2");
  assert.equal(project.description, "Reports export as CSV and PDF.");
  assert.match(project.content, /Where the code lives/u);
  assert.equal(project.priority, 2);
  assert.equal(project.startDate, "2026-10-01");
  assert.equal(project.targetDate, "2026-12-31");
  assert.equal(project.leadId, MEMORY_IDS.viewer);
  const statuses = await linear.projectStatuses();
  assert.equal(
    statuses.find((entry) => entry.id === project.statusId)?.type,
    "planned",
  );
  const projectLabels = await linear.projectLabels();
  assert.deepEqual(
    projectLabels
      .filter((label) => project.labelIds.includes(label.id))
      .map((label) => label.name),
    ["vc-test-reporting"],
  );

  const labels = await linear.labels(linear.teamId);
  const kind = labels.find((label) => label.name === "vc-test-Kind");
  assert.equal(kind?.isGroup, true);
  assert.equal(
    labels.find((label) => label.name === "vc-test-Feature")?.parentId,
    kind?.id,
  );
  assert.equal(
    labels.find((label) => label.name === "vc-test-Q1")?.parentId,
    null,
  );

  const milestones = await linear.milestones(project.id);
  assert.deepEqual(
    milestones.map((milestone) => milestone.name),
    ["M1 · Exports", "U · Unification"],
  );
  assert.equal(milestones[0]?.targetDate, "2026-11-15");

  const documents = await linear.documents(project.id);
  const titles = documents.map((document) => document.title).sort();
  assert.deepEqual(titles, [
    "Architecture",
    "vibecheck plan",
    "vibecheck policy",
  ]);
  const policy = documents.find(
    (document) => document.title === "vibecheck policy",
  );
  assert.equal(policy?.icon, "Shield");
  assert.match(
    policy?.content ?? "",
    /## Authorizations\n\n\* Run the test suite/u,
  );
  const plan = documents.find(
    (document) => document.title === "vibecheck plan",
  );
  assert.equal(plan?.icon, "Page");
  const map = parsePlanDocument(plan?.content ?? "");
  assert.equal(map?.revision, 1);
  assert.equal(
    map?.tasks["EXPORT-CSV-1"],
    result.task_map["EXPORT-CSV-1"]?.identifier,
  );
  assert.deepEqual(
    (await linear.externalLinks(project.id)).map((link) => link.url),
    ["https://example.com/reports"],
  );
  assert.equal(
    (await linear.projectUpdates(project.id))[0]?.body,
    "Plan published.",
  );

  const csvId = result.task_map["EXPORT-CSV-1"]?.identifier ?? "";
  const csv = await linear.issue(csvId);
  assert.ok(csv !== null);
  assert.equal(csv.title, "EXPORT-CSV-1: CSV export");
  assert.equal(csv.priority, 2);
  assert.equal(csv.estimate, 3);
  assert.equal(csv.dueDate, "2026-11-01");
  assert.equal(csv.assigneeId, MEMORY_IDS.viewer);
  assert.equal(csv.projectMilestoneId, milestones[0]?.id);
  for (const heading of [
    "What it is",
    "Files, lines and call sites",
    "Approach",
    "Done when",
    "Rules",
    "Accepted exceptions",
    "Out of scope",
  ])
    assert.match(csv.description, new RegExp(`## ${heading}`, "u"));
  assert.match(csv.description, /- \[ \] every visible column is exported/u);
  assert.match(
    csv.description,
    /labels\.ts holds label text only \(paths: `src\/labels\.ts`; data only\)/u,
  );
  assert.deepEqual((await labelNames(linear, csvId)).sort(), [
    "vc-test-Export",
    "vc-test-Feature",
    "vc-test-Q1",
  ]);
  const pdf = await linear.issue(
    result.task_map["EXPORT-PDF-1"]?.identifier ?? "",
  );
  assert.ok(pdf !== null);
  assert.equal(pdf.parentId, csv.id);
  assert.match(
    pdf.description,
    new RegExp(`## Depends on\\n\\n\\* ${csvId} · CSV export`, "u"),
  );
  const relations = await linear.relations(pdf.id);
  assert.deepEqual(
    relations.map((relation) => [
      relation.type,
      relation.issueId,
      relation.relatedIssueId,
    ]),
    [["blocks", csv.id, pdf.id]],
  );

  assert.equal(result.completeness.project, undefined);
  assert.deepEqual(result.completeness.milestones, {
    U: ["description", "target_date"],
  });
  assert.deepEqual(result.completeness.tasks, {
    "EXPORT-PDF-1": ["files", "approach", "priority", "estimate"],
  });
});

test("completeness names every empty fillable field, including a missing label per group", async (t) => {
  const { board } = createLedger(t);
  const session = await join(board);
  const result = publishResult.parse(
    await publish(
      board,
      session,
      [{ key: "BARE-1", title: "Bare task", labels: ["vc-test-A"] }],
      {
        label_groups: [{ name: "vc-test-G", labels: [{ name: "vc-test-A" }] }],
        milestones: [{ name: "Only" }],
      },
    ),
  );
  assert.deepEqual(result.completeness.project, [
    "icon",
    "color",
    "summary",
    "overview",
    "start_date",
    "target_date",
    "priority",
    "labels",
    "links",
  ]);
  assert.deepEqual(result.completeness.milestones, {
    M1: ["description", "target_date"],
  });
  assert.deepEqual(result.completeness.tasks, {
    "BARE-1": ["goal", "criteria", "files", "approach", "priority", "estimate"],
  });
});

test("a plan that fails validation writes nothing to Linear or the journal", async (t) => {
  const { board, linear, store } = createLedger(t);
  const session = await join(board);
  const before = JSON.stringify(linear.exportState());
  const base = { key: "T-1", title: "Task", labels: ["vc-test-K1"] };
  const groups = [
    {
      name: "vc-test-K",
      labels: [{ name: "vc-test-K1" }, { name: "vc-test-K2" }],
    },
  ];
  const attempts: [string, Record<string, unknown>, unknown[]][] = [
    [
      "icon",
      { project: { name: "vc-test-x", icon: "Map" }, label_groups: groups },
      [base],
    ],
    [
      "color",
      { project: { name: "vc-test-x", color: "red" }, label_groups: groups },
      [base],
    ],
    [
      "summary",
      {
        project: { name: "vc-test-x", summary: "x".repeat(256) },
        label_groups: groups,
      },
      [base],
    ],
    [
      "document icon",
      {
        label_groups: groups,
        documents: [{ title: "D", icon: "Gear", content: "x" }],
      },
      [base],
    ],
    [
      "cycle",
      { label_groups: groups },
      [
        { ...base, depends_on: ["T-2"] },
        {
          key: "T-2",
          title: "Two",
          labels: ["vc-test-K2"],
          depends_on: ["T-1"],
        },
      ],
    ],
    [
      "unknown reference",
      { label_groups: groups },
      [{ ...base, depends_on: ["NOPE-9"] }],
    ],
    [
      "missing group label",
      { label_groups: groups },
      [{ key: "T-1", title: "Task" }],
    ],
    [
      "two labels from one group",
      { label_groups: groups },
      [{ ...base, labels: ["vc-test-K1", "vc-test-K2"] }],
    ],
    [
      "undeclared milestone",
      { label_groups: groups },
      [{ ...base, milestone: "M9" }],
    ],
    ["duplicate key", { label_groups: groups }, [base, base]],
    [
      "unknown label",
      { label_groups: groups },
      [{ ...base, labels: ["vc-test-K1", "vc-test-nowhere"] }],
    ],
  ];
  for (const [name, extra, tasks] of attempts) {
    await assert.rejects(
      acceptingProblems(board, "plan_publish", {
        project_id: PROJECT,
        request_id: request(),
        session_id: session,
        expected_revision: 0,
        project: { name: "vc-test-x" },
        tasks,
        ...extra,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error, name);
        assert.equal(error.code, "invalid", `${name}: ${error.message}`);
        return true;
      },
      name,
    );
  }
  assert.equal(JSON.stringify(linear.exportState()), before);
  assert.equal(store.project(PROJECT_KEY)?.planRevision, 0);
});

test("the same request id returns the stored result; different input under it conflicts", async (t) => {
  const { board, linear } = createLedger(t);
  const session = await join(board);
  const body = {
    project_id: PROJECT,
    request_id: "publish-once",
    session_id: session,
    expected_revision: 0,
    project: { name: "vc-test-receipts" },
    tasks: [{ key: "R-1", title: "Receipt task" }],
  };
  const first = await acceptingProblems(board, "plan_publish", body);
  // The request that landed carries the accepted problems; its receipt
  // answers a repeat of exactly that request.
  const accepted = {
    ...body,
    accept: z.array(z.string()).parse(first["accepted"]),
  };
  const again = await board.call("plan_publish", accepted);
  assert.deepEqual(again, first);
  assert.equal((await linear.projects("vc-test-receipts")).length, 1);
  const page = await linear.issues({
    projectId: String(first["linear_project_id"]),
  });
  assert.equal(page.nodes.length, 1);
  await rejectsCode(
    board.call("plan_publish", {
      ...accepted,
      tasks: [{ key: "R-2", title: "Other" }],
    }),
    "conflict",
    /request_id/u,
  );
});

test("republishing changes only what the plan changed and keeps text people added", async (t) => {
  const { board, linear } = createLedger(t);
  const session = await join(board);
  const first = publishResult.parse(
    await publish(board, session, [
      {
        key: "K-1",
        title: "Keep task",
        goal: "Keep the goal as it is written",
        criteria: ["one"],
      },
    ]),
  );
  const identifier = first.task_map["K-1"]?.identifier ?? "";
  const issue = await linear.issue(identifier);
  assert.ok(issue !== null);
  await linear.updateIssue(issue.id, {
    title: "K-1: Keep task (renamed by a person)",
    description: `${issue.description.replace("- [ ] one", "- [x] one")}\n\n## Notes from the owner\n\nDo not touch this.\n`,
  });
  await acceptingProblems(board, "plan_publish", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    expected_revision: 1,
    project: { name: "vc-test-ledger" },
    tasks: [
      {
        key: "K-1",
        title: "Keep task",
        goal: "Keep the goal as it is written",
        criteria: ["one", "two"],
      },
    ],
  });
  const after = await linear.issue(identifier);
  assert.ok(after !== null);
  assert.equal(after.title, "K-1: Keep task (renamed by a person)");
  assert.match(after.description, /- \[x\] one\n- \[ \] two/u);
  assert.match(
    after.description,
    /## Notes from the owner\n\nDo not touch this\./u,
  );
  await rejectsCode(
    acceptingProblems(board, "plan_publish", {
      project_id: PROJECT,
      request_id: request(),
      session_id: session,
      expected_revision: 2,
      project: { name: "vc-test-ledger" },
      tasks: [],
    }),
    "invalid",
    /cannot be omitted/u,
  );
});

test("only the coordinator publishes, and plan_read and plan_ack follow the journal", async (t) => {
  const { board } = createLedger(t);
  const root = await join(board);
  const worker = await join(board, "worker", { parent_session_id: root });
  await rejectsCode(publish(board, worker), "forbidden");
  await publish(board, root);
  await acceptingProblems(board, "plan_edit", {
    project_id: PROJECT,
    request_id: request(),
    session_id: root,
    expected_revision: 1,
    operations: [
      { op: "add_task", task: { key: "C-1", title: "Third task" } },
      { op: "update_task", task_id: "B-1", title: "Second task, renamed" },
    ],
  });
  const read = z
    .object({
      plan_revision: z.number(),
      task_map: z.record(z.string(), z.object({ title: z.string() })),
    })
    .parse(await board.call("plan_read", { project_id: PROJECT, revision: 1 }));
  assert.equal(read.task_map["B-1"]?.title, "Second task");
  const diff = z
    .object({
      added: z.record(z.string(), z.unknown()),
      changed: z.record(z.string(), z.unknown()),
      removed: z.array(z.string()),
    })
    .parse(
      await board.call("plan_read", {
        project_id: PROJECT,
        revision: 2,
        compare_to: 1,
      }),
    );
  assert.deepEqual(Object.keys(diff.added), ["C-1"]);
  assert.deepEqual(Object.keys(diff.changed), ["B-1"]);
  const ack = z.object({ acknowledged_plan_revision: z.number() }).parse(
    await board.call("plan_ack", {
      project_id: PROJECT,
      request_id: request(),
      session_id: worker,
      plan_revision: 2,
    }),
  );
  assert.equal(ack.acknowledged_plan_revision, 2);
  await rejectsCode(
    board.call("plan_ack", {
      project_id: PROJECT,
      request_id: request(),
      session_id: worker,
      plan_revision: 1,
    }),
    "conflict",
  );
});

// ---------------------------------------------------------------------------
// Ruling 12: a plan is fully developed before it reaches Linear
// ---------------------------------------------------------------------------

/** A first publish with every fillable field and specific wording. */
function readyPlan(
  goal = "Export the reports table as CSV with every visible column",
) {
  return {
    project_id: PROJECT,
    session_id: "",
    expected_revision: 0,
    project: {
      name: "vc-test-ready",
      summary: "Reports export as CSV.",
      overview: "# Reports\n\nThe reports page and its exports.",
      icon: "Rocket",
      color: "#5e6ad2",
      priority: 2,
      start_date: "2026-10-01",
      target_date: "2026-12-31",
      labels: [{ name: "vc-test-reporting" }],
    },
    label_groups: [
      { name: "Kind", labels: [{ name: "vc-test-Feature" }] },
      { name: "Area", labels: [{ name: "vc-test-Export" }] },
    ],
    milestones: [
      {
        code: "M1",
        name: "Exports",
        description: "CSV export of the reports table.",
        target_date: "2026-11-15",
      },
    ],
    links: [{ label: "Repository", url: "https://example.com/reports" }],
    tasks: [
      {
        key: "EXPORT-CSV-1",
        title: "CSV export",
        goal,
        criteria: [
          "every visible column is exported",
          "a unit test covers the export",
        ],
        files: ["src/reports/csv.ts"],
        approach: "Stream rows through the existing writer.",
        labels: ["vc-test-Feature", "vc-test-Export"],
        milestone: "M1",
        priority: 2,
        estimate: 3,
      },
    ],
  };
}

const notReadySchema = z.object({
  ready: z.literal(false),
  plan_revision: z.literal(0),
  problems: z.array(
    z.object({ id: z.string(), check: z.string(), outcome: z.string() }),
  ),
});

test("ruling 12: an incomplete first publish writes nothing to Linear and records no revision or receipt", async (t) => {
  const { board, linear, store } = createLedger(t, { script: () => 0.05 });
  const session = await join(board);
  const before = JSON.stringify(linear.exportState());
  const args = {
    ...readyPlan(),
    session_id: session,
    request_id: "first-publish",
    project: { name: "vc-test-ready" },
  };
  const result = notReadySchema.parse(await board.call("plan_publish", args));
  const ids = result.problems.map((problem) => problem.id);
  assert.ok(ids.includes("completeness:project.icon"));
  assert.ok(ids.includes("completeness:project.summary"));
  assert.equal(JSON.stringify(linear.exportState()), before);
  assert.equal(store.project(PROJECT_KEY)?.planRevision, 0);
  // The same request_id, resent after fixing, publishes.
  const fixed = z
    .object({ ready: z.literal(true), plan_revision: z.literal(1) })
    .parse(
      await board.call("plan_publish", {
        ...readyPlan(),
        session_id: session,
        request_id: "first-publish",
      }),
    );
  assert.equal(fixed.plan_revision, 1);
  // Plan-time warnings of the first publish are never posted to Linear.
  const issue = await linear.issue("TA-1");
  assert.deepEqual((await linear.comments(issue?.id ?? "")).length, 0);
});

test("ruling 12: a vague goal blocks until fixed or accepted, and unknown ids in accept are invalid", async (t) => {
  const { board, linear } = createLedger(t, { script: () => 0.05 });
  const session = await join(board);
  const vague = { ...readyPlan("Handle errors"), session_id: session };
  const result = notReadySchema.parse(
    await board.call("plan_publish", { ...vague, request_id: request() }),
  );
  assert.deepEqual(
    result.problems.map((problem) => problem.id),
    ["vibecheck.plan-detail:tasks.EXPORT-CSV-1:flagged"],
  );
  await rejectsCode(
    board.call("plan_publish", {
      ...vague,
      request_id: request(),
      accept: ["completeness:project.nothing"],
    }),
    "invalid",
    /completeness:project\.nothing/u,
  );
  assert.equal((await linear.projects()).length, 0);
  const accepted = z
    .object({ ready: z.literal(true), accepted: z.array(z.string()) })
    .parse(
      await board.call("plan_publish", {
        ...vague,
        request_id: request(),
        accept: ["vibecheck.plan-detail:tasks.EXPORT-CSV-1:flagged"],
      }),
    );
  assert.deepEqual(accepted.accepted, [
    "vibecheck.plan-detail:tasks.EXPORT-CSV-1:flagged",
  ]);
  assert.equal((await linear.projects()).length, 1);
});

test("ruling 12: an unavailable judgment source blocks the first publish until its problems are accepted", async (t) => {
  for (const { options, unavailable } of [
    { options: { script: () => 0.05, failures: 1_000 }, unavailable: true },
    { options: {}, unavailable: false },
  ]) {
    const { board, linear } = createLedger(t, options);
    const session = await join(board);
    const plan = {
      ...readyPlan(),
      session_id: session,
      tasks: [
        ...readyPlan().tasks,
        {
          ...readyPlan().tasks[0],
          key: "EXPORT-CSV-2",
          title: "CSV export again",
        },
      ],
    };
    const result = notReadySchema.parse(
      await board.call("plan_publish", { ...plan, request_id: request() }),
    );
    assert.ok(result.problems.length > 0);
    assert.ok(
      result.problems.every((problem) => problem.outcome === "unavailable"),
      JSON.stringify(result.problems),
    );
    if (!unavailable)
      assert.deepEqual(
        result.problems.map((problem) => problem.id),
        ["judgment:unavailable"],
      );
    assert.equal((await linear.projects()).length, 0);
    await board.call("plan_publish", {
      ...plan,
      request_id: request(),
      accept: result.problems.map((problem) => problem.id),
    });
    assert.equal((await linear.projects()).length, 1);
  }
});

test("ruling 12: with the checks turned off in config, a complete first publish is not held for a judgment that will never come", async (t) => {
  const { board, linear } = createLedger(t, { checksOff: true });
  const session = await join(board);
  const result = await board.call("plan_publish", {
    ...readyPlan(),
    session_id: session,
    request_id: request(),
  });
  assert.notEqual(result["ready"], false, JSON.stringify(result));
  assert.equal((await linear.projects()).length, 1);
});

test("ruling 12: managed dry runs list the problems; later edits are not gated and post their warnings once", async (t) => {
  const { board, linear } = createLedger(t, { script: () => 0.05 });
  const session = await join(board);
  await board.call("plan_publish", {
    ...readyPlan(),
    session_id: session,
    request_id: request(),
  });
  const edit = (goal: string) =>
    board.call("plan_edit", {
      project_id: PROJECT,
      request_id: request(),
      session_id: session,
      expected_revision: 1,
      operations: [
        {
          op: "add_task",
          task: {
            key: "EXPORT-PDF-1",
            title: "PDF export",
            goal,
            labels: ["vc-test-Feature", "vc-test-Export"],
          },
        },
      ],
    });
  const edited = z
    .object({
      plan_revision: z.literal(2),
      warnings: z.array(z.object({ id: z.string() })),
    })
    .parse(await edit("Handle errors"));
  assert.ok(
    edited.warnings.some(
      (warning) =>
        warning.id === "vibecheck.plan-detail:tasks.EXPORT-PDF-1:flagged",
    ),
  );
  const posted = async () =>
    (await linear.comments((await linear.issue("TA-2"))?.id ?? "")).filter(
      (comment) =>
        comment.body.startsWith("**vibecheck: vibecheck.plan-detail"),
    ).length;
  assert.equal(await posted(), 1);
  // An unchanged task's warning is not posted twice.
  await board.call("plan_edit", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    expected_revision: 2,
    operations: [{ op: "update_task", task_id: "EXPORT-CSV-1", priority: 1 }],
  });
  assert.equal(await posted(), 1);
});

test("ruling 12: a managed first write shows its problems in the dry run and confirm needs them fixed or accepted", async (t) => {
  const { board, linear } = createLedger(t, { script: () => 0.05 });
  const project = await linear.createProject({
    name: "vc-test-ready",
    teamIds: [linear.teamId],
  });
  const session = await join(board, "root", {
    linear_project: project.id,
    adopt: "managed",
  });
  const plan = { ...readyPlan("Handle errors"), session_id: session };
  const dry = z
    .object({
      dry_run: z.literal(true),
      ready: z.literal(false),
      problems: z.array(z.object({ id: z.string() })),
    })
    .parse(
      await board.call("plan_publish", { ...plan, request_id: request() }),
    );
  const ids = dry.problems.map((problem) => problem.id);
  notReadySchema.parse(
    await board.call("plan_publish", {
      ...plan,
      request_id: request(),
      confirm: true,
    }),
  );
  const done = z
    .object({ plan_revision: z.literal(1), ready: z.literal(true) })
    .parse(
      await board.call("plan_publish", {
        ...plan,
        request_id: request(),
        confirm: true,
        accept: ids,
      }),
    );
  assert.equal(done.plan_revision, 1);
});
