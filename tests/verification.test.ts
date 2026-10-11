import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import {
  PROJECT,
  claim,
  createLedger,
  join as joinProject,
  labelNames,
  publish,
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

test("a done report that overclaims leaves the task open with the reason visible in status and history", async (t) => {
  const { board } = createLedger(t, {
    script: (battery) => (battery === "vibecheck.claims-done" ? 0.9 : 0.1),
  });
  const session = await joinProject(board);
  await publish(board, session, [FORMS]);
  const claimed = await claim(board, session, "FORMS-1");
  const result = await update(board, session, claimed.work.id, {
    status: "complete",
    report: "All 14 forms have entries; 6 were reviewed and left unchanged.",
  });
  const item = result.verification?.find(
    (entry) => entry.check === "vibecheck.claims-done",
  );
  assert.equal(item?.outcome, "failed");
  assert.equal(item?.reported_status, "complete");
  assert.equal(item?.applied_status, "in_progress");
  const view = await status(board);
  assert.equal(view.tasks["FORMS-1"]?.status, "in_progress");
  assert.equal(view.attention?.[0]?.kind, "held_done");
  assert.equal(view.verification?.["FORMS-1"]?.verified, "held");
  const history = z
    .object({
      verifications: z.array(
        z.object({ kind: z.string(), check: z.string().optional() }),
      ),
      comments: z.array(z.object({ kind: z.string(), body: z.string() })),
    })
    .parse(
      await board.call("work_history", {
        project_id: PROJECT,
        task_id: "FORMS-1",
      }),
    );
  assert.deepEqual(
    history.verifications
      .filter((entry) => entry.check !== "vibecheck.plan-detail")
      .map((entry) => entry.kind)
      .sort(),
    // claims-done and done-admits-unfinished each read the report.
    ["report", "verdict", "verdict"],
  );
  assert.ok(
    history.comments.some(
      (comment) =>
        comment.kind === "tool" && comment.body.startsWith("**Done**"),
    ),
  );
});

test("when no source answers, the update applies as reported, is recorded unavailable and marked vc:unverified", async (t) => {
  const { board, linear } = createLedger(t, {
    script: () => 0.9,
    failures: 100,
  });
  const session = await joinProject(board);
  await publish(board, session, [FORMS]);
  const claimed = await claim(board, session, "FORMS-1");
  const result = await update(board, session, claimed.work.id, {
    status: "complete",
    report: "Done.",
  });
  assert.equal(result.tasks[0]?.status, "complete");
  assert.equal(result.verification?.[0]?.outcome, "unavailable");
  assert.ok(
    (await labelNames(linear, claimed.issue.identifier)).includes(
      "vc:unverified",
    ),
  );
  const view = await status(board);
  assert.equal(view.verification?.["FORMS-1"]?.verified, "unverified");
  assert.equal(view.attention?.[0]?.kind, "unverified_done");
});

const ADMITS = "vibecheck.done-admits-unfinished";

test("a completion whose report admits the work is unfinished is held, even when claims-done passes", async (t) => {
  const { board, linear } = createLedger(t, {
    script: (battery) => (battery === ADMITS ? 0.95 : 0.05),
  });
  const session = await joinProject(board);
  await publish(board, session, [FORMS]);
  const claimed = await claim(board, session, "FORMS-1");
  const result = await update(board, session, claimed.work.id, {
    status: "complete",
    report:
      "I did not do anything. No validation was written and the tests all fail. Giving up.",
  });
  const outcomes = Object.fromEntries(
    (result.verification ?? []).map((entry) => [entry.check, entry]),
  );
  assert.equal(outcomes["vibecheck.claims-done"]?.outcome, "passed");
  assert.equal(outcomes[ADMITS]?.outcome, "failed");
  assert.equal(outcomes[ADMITS]?.reported_status, "complete");
  assert.equal(outcomes[ADMITS]?.applied_status, "in_progress");
  assert.match(outcomes[ADMITS]?.reason ?? "", /admits 0\.95/u);
  assert.equal(result.work[0]?.status, "in_progress");
  const labels = await labelNames(linear, claimed.issue.identifier);
  assert.ok(labels.includes("vc:held"));
  assert.ok(!labels.includes("vc:verified"));
  const view = await status(board);
  assert.equal(view.tasks["FORMS-1"]?.status, "in_progress");
  assert.equal(view.verification?.["FORMS-1"]?.verified, "held");
  assert.equal(view.attention?.[0]?.kind, "held_done");
  assert.equal(view.attention?.[0]?.check, ADMITS);
});

test("an honest done report verifies when claims-done passes and done-admits-unfinished does not block", async (t) => {
  const { board, linear, provider } = createLedger(t, { script: () => 0.05 });
  const session = await joinProject(board);
  await publish(board, session, [FORMS]);
  const claimed = await claim(board, session, "FORMS-1");
  const report =
    "Every form rejects empty required fields; the form tests pass.";
  const result = await update(board, session, claimed.work.id, {
    status: "complete",
    report,
  });
  const checks = (result.verification ?? []).map((entry) => entry.check);
  assert.ok(checks.includes("vibecheck.claims-done"));
  assert.ok(checks.includes(ADMITS));
  assert.ok(
    (result.verification ?? []).every((entry) => entry.outcome === "passed"),
  );
  assert.equal(result.tasks[0]?.status, "complete");
  const asked = provider?.requests.find(
    (request) => request.batteryId === ADMITS,
  );
  assert.ok(JSON.stringify(asked?.state).includes(report));
  assert.ok(
    (await labelNames(linear, claimed.issue.identifier)).includes(
      "vc:verified",
    ),
  );
  assert.equal(
    (await status(board)).verification?.["FORMS-1"]?.verified,
    "verified",
  );
});

test("an unavailable done-admits-unfinished reading leaves the completion unverified", async (t) => {
  const { board, linear } = createLedger(t, {
    script: (battery) => {
      if (battery === ADMITS) throw new Error("admits source down");
      return 0.05;
    },
  });
  const session = await joinProject(board);
  await publish(board, session, [FORMS]);
  const claimed = await claim(board, session, "FORMS-1");
  const result = await update(board, session, claimed.work.id, {
    status: "complete",
    report: "Every form rejects empty required fields.",
  });
  const outcomes = Object.fromEntries(
    (result.verification ?? []).map((entry) => [entry.check, entry.outcome]),
  );
  assert.equal(outcomes["vibecheck.claims-done"], "passed");
  assert.equal(outcomes[ADMITS], "unavailable");
  assert.equal(result.tasks[0]?.status, "complete");
  const labels = await labelNames(linear, claimed.issue.identifier);
  assert.ok(labels.includes("vc:unverified"));
  assert.ok(!labels.includes("vc:verified"));
  const view = await status(board);
  assert.equal(view.verification?.["FORMS-1"]?.verified, "unverified");
  assert.equal(view.attention?.[0]?.kind, "unverified_done");
  assert.equal(view.attention?.[0]?.check, ADMITS);
});

test("a blocker that needs the user leads the attention list", async (t) => {
  const { board } = createLedger(t, {
    script: (battery, question) =>
      battery === "vibecheck.blocker-triage"
        ? question === "needs"
          ? "user"
          : "high"
        : 0.1,
  });
  const session = await joinProject(board);
  await publish(board, session, [FORMS]);
  const claimed = await claim(board, session, "FORMS-1");
  const result = await update(board, session, claimed.work.id, {
    status: "blocked",
    blocker: "Waiting for the user to choose the error wording.",
  });
  assert.deepEqual(result.verification?.map((entry) => entry.check).sort(), [
    "vibecheck.blocker-triage",
    "vibecheck.deferral",
    "vibecheck.stop-reason",
  ]);
  const view = await status(board);
  assert.equal(view.attention?.[0]?.kind, "blocker");
  assert.equal(view.attention?.[0]?.needs, "user");
});

test("two open claims with the same intent are flagged as an overlap", async (t) => {
  const { board } = createLedger(t, {
    script: (battery, question) =>
      battery === "vibecheck.claim-overlap" && question === "duplicate"
        ? 0.9
        : 0.1,
  });
  const session = await joinProject(board);
  await publish(board, session, [
    { key: "CSV-1", title: "CSV download on the reports page" },
    { key: "EXPORT-1", title: "Export the reports table as CSV" },
  ]);
  await claim(board, session, "CSV-1");
  const second = await claim(board, session, "EXPORT-1");
  assert.equal(second.verification?.[0]?.outcome, "flagged");
  const view = await status(board);
  assert.ok(view.attention?.some((entry) => entry.kind === "overlap"));
});

test("a plan edit that cancels accepted work is flagged, and an added duplicate task is read against the plan", async (t) => {
  const { board } = createLedger(t, {
    script: (battery, question) =>
      (battery === "vibecheck.brief-scope" && question === "lowersBar") ||
      (battery === "vibecheck.task-duplicate" && question === "duplicate")
        ? 0.9
        : 0.1,
  });
  const session = await joinProject(board);
  await publish(
    board,
    session,
    [
      {
        key: "CSV-1",
        title: "CSV export",
        criteria: ["every column is exported"],
      },
      { key: "PDF-1", title: "PDF export" },
    ],
    { policy: { goal: "Reports export as CSV and PDF" } },
  );
  const edited = z
    .object({
      verification: z.array(
        z.object({ check: z.string(), outcome: z.string() }),
      ),
    })
    .parse(
      await board.call("plan_edit", {
        project_id: PROJECT,
        request_id: request(),
        session_id: session,
        expected_revision: 1,
        operations: [
          { op: "update_task", task_id: "PDF-1", status: "cancelled" },
          {
            op: "add_task",
            task: { key: "CSV-2", title: "Export reports as CSV" },
          },
        ],
      }),
    );
  const checks = edited.verification.map(
    (entry) => `${entry.check}:${entry.outcome}`,
  );
  assert.ok(checks.includes("vibecheck.brief-scope:flagged"));
  assert.ok(checks.includes("vibecheck.task-duplicate:flagged"));
  assert.ok(
    checks.some((entry) => entry.startsWith("vibecheck.plan-coverage:")),
  );
});

test("plan-detail flags a vague goal or criterion on publish and on issue_adopt", async (t) => {
  const { board, linear } = createLedger(t, { script: () => 0.1 });
  const session = await joinProject(board);
  const published = z
    .object({
      verification: z.array(
        z.object({
          check: z.string(),
          outcome: z.string(),
          reason: z.string(),
        }),
      ),
    })
    .parse(
      await publish(board, session, [
        {
          key: "VAGUE-1",
          title: "Errors",
          goal: "Handle errors",
          criteria: ["it works properly"],
        },
        FORMS,
      ]),
    );
  const details = published.verification.filter(
    (entry) => entry.check === "vibecheck.plan-detail",
  );
  assert.deepEqual(details.map((entry) => entry.outcome).sort(), [
    "flagged",
    "passed",
  ]);
  assert.match(
    details.find((entry) => entry.outcome === "flagged")?.reason ?? "",
    /too vague/u,
  );
  const issue = await linear.issue("TA-1");
  assert.ok(issue !== null);
  const adopted = z
    .object({
      verification: z.array(
        z.object({ check: z.string(), outcome: z.string() }),
      ),
    })
    .parse(
      await board.call("issue_adopt", {
        project_id: PROJECT,
        request_id: request(),
        session_id: session,
        issue: issue.url,
        key: "VAGUE-1",
      }),
    );
  assert.equal(adopted.verification[0]?.outcome, "flagged");
});

test("a parent verifies only after its children verify and its own criteria read as met", async (t) => {
  const { board } = createLedger(t, { script: () => 0.1 });
  const session = await joinProject(board);
  await publish(board, session, [
    {
      key: "REPORTS-1",
      title: "Reports page",
      criteria: ["CSV and PDF export both work"],
    },
    { key: "CSV-1", title: "CSV export", parent: "REPORTS-1" },
  ]);
  const parent = await claim(board, session, "REPORTS-1");
  const early = await update(board, session, parent.work.id, {
    status: "complete",
    report: "Reports are done.",
  });
  const rollup = early.verification?.find(
    (entry) => entry.check === "vibecheck.parent-rollup",
  );
  assert.equal(rollup?.outcome, "failed");
  assert.match(rollup?.reason ?? "", /child tasks not verified: CSV-1/u);
  const child = await claim(board, session, "CSV-1");
  await update(board, session, child.work.id, {
    status: "complete",
    report: "CSV export works and is tested.",
  });
  const done = await update(board, session, parent.work.id, {
    status: "complete",
    report: "CSV and PDF export both work.",
  });
  assert.equal(done.tasks[0]?.status, "complete");
  assert.equal(
    (await status(board)).verification?.["REPORTS-1"]?.verified,
    "verified",
  );
});

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

test("a commit that touched none of the claimed paths, or a data-only file holding logic, holds the task open", async (t) => {
  const { board, directory } = createLedger(t, { script: () => 0.1 });
  const repository = join(directory, "repo");
  mkdirSync(join(repository, "src", "format"), { recursive: true });
  git(directory, "init", "-q", repository);
  writeFileSync(join(repository, "README.md"), "readme\n");
  git(repository, "add", "README.md");
  git(repository, "commit", "-q", "-m", "Move price formatting");
  const commit = git(repository, "rev-parse", "HEAD");
  writeFileSync(
    join(repository, "src", "format", "labels.ts"),
    "export function label(x: number) {\n  if (x > 1) return 'many';\n  for (;;) { break; }\n  return 'one';\n}\n",
  );
  const session = await joinProject(board);
  await publish(board, session, [
    {
      key: "FORMAT-1",
      title: "Move price formatting",
      exceptions: [
        {
          description: "labels.ts holds only label text",
          paths: ["src/format/labels.ts"],
          data_only: true,
        },
      ],
    },
  ]);
  const claimed = await claim(board, session, "FORMAT-1", {
    checkout: repository,
    paths: ["src/format"],
  });
  const result = await update(board, session, claimed.work.id, {
    status: "complete",
    commit,
    report: "Moved.",
  });
  const outcomes = Object.fromEntries(
    (result.verification ?? []).map((entry) => [entry.check, entry.outcome]),
  );
  assert.equal(outcomes["vibecheck.commit-paths"], "failed");
  assert.equal(outcomes["vibecheck.exception-check"], "failed");
  assert.ok("vibecheck.commit-honesty" in outcomes);
  assert.equal(result.work[0]?.status, "in_progress");
});

test("a handoff with no note and a claim that keeps reporting the same failure are flagged", async (t) => {
  const { board } = createLedger(t, {
    script: (battery, question) =>
      battery === "vibecheck.stalled" && question === "stuck" ? 0.9 : 0.1,
  });
  const session = await joinProject(board);
  await publish(board, session, [FORMS]);
  const other = await joinProject(board, "other", {
    parent_session_id: session,
  });
  const current = await claim(board, session, "FORMS-1");
  for (let index = 0; index < 4; index++) {
    const result = await update(board, session, current.work.id, {
      report: "The rounding test still fails with the same error.",
    });
    if (index === 3)
      assert.equal(result.verification?.[0]?.check, "vibecheck.stalled");
  }
  assert.ok(
    (await status(board)).attention?.some((entry) => entry.kind === "stalled"),
  );
  const handoff = z
    .object({
      verification: z.array(
        z.object({ check: z.string(), outcome: z.string() }),
      ),
    })
    .parse(
      await board.call("work_update", {
        project_id: PROJECT,
        request_id: request(),
        session_id: session,
        updates: [
          { work_id: current.work.id, action: "handoff", handoff_to: other },
        ],
      }),
    );
  assert.equal(handoff.verification[0]?.check, "vibecheck.handoff-complete");
  assert.equal(handoff.verification[0]?.outcome, "flagged");
});

test("without a verifier the ledger records work as reported, with no verification fields", async (t) => {
  const { board, linear } = createLedger(t);
  const session = await joinProject(board);
  await publish(board, session, [FORMS]);
  const claimed = await claim(board, session, "FORMS-1");
  const result = z.record(z.string(), z.unknown()).parse(
    await board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: session,
      updates: [
        { work_id: claimed.work.id, status: "complete", report: "Done." },
      ],
    }),
  );
  assert.equal("verification" in result, false);
  assert.equal(
    (await linear.issue(claimed.issue.identifier))?.stateName,
    "Done",
  );
  const view = z
    .record(z.string(), z.unknown())
    .parse(await board.call("project_status", { project_id: PROJECT }));
  // Linear's vc:unverified (the completion with checks off) is what status
  // reads; nothing was judged here.
  const attention = z
    .array(z.object({ kind: z.string(), entry_id: z.string() }))
    .optional()
    .parse(view["attention"]);
  assert.deepEqual(
    attention?.map((item) => item.kind),
    ["unverified_done"],
  );
  assert.equal(attention?.[0]?.entry_id.startsWith("issue:"), true);
  assert.equal("verification" in view, false);
});

test("a plan change's brief-scope reads the claims other sessions hold as other work", async (t) => {
  const { board, provider } = createLedger(t, { script: () => 0.1 });
  const coordinator = await joinProject(board);
  await publish(board, coordinator, [
    { key: "CSV-1", title: "CSV export", criteria: ["every column"] },
    { key: "PDF-1", title: "PDF export", criteria: ["matches the page"] },
  ]);
  const worker = await joinProject(board, "worker", { vendor: "codex" });
  await claim(board, worker, "PDF-1", { paths: ["src/reports/pdf.ts"] });
  await board.call("plan_edit", {
    project_id: PROJECT,
    request_id: request(),
    session_id: coordinator,
    expected_revision: 1,
    operations: [
      {
        op: "add_task",
        task: {
          key: "CSV-2",
          title: "Escape CSV fields",
          criteria: ["every field round-trips"],
        },
      },
    ],
  });
  const scope = provider?.requests.find(
    (entry) => entry.batteryId === "vibecheck.brief-scope",
  );
  const state = z
    .object({ standard: z.string(), otherWork: z.string() })
    .parse(scope?.state);
  assert.match(state.standard, /CSV-1/u);
  assert.match(state.otherWork, /^Tasks other sessions have claimed/u);
  assert.match(
    state.otherWork,
    new RegExp(
      `PDF-1 .*Claimed by agent:codex \\(session ${worker}\\); paths src/reports/pdf\\.ts`,
      "u",
    ),
  );
  assert.doesNotMatch(state.otherWork, /CSV-1/u);
});
