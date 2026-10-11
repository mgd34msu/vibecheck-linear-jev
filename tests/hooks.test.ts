import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { z } from "zod";
import { projectKeyOf } from "../src/ledger/access.js";
import { Board } from "../src/ledger/board.js";
import {
  acceptingProblems,
  claim as claimTask,
  createLedger,
  join as joinLedger,
  publish,
  PROJECT,
} from "./helpers.js";
import { MemoryLinearApi } from "../src/linear/memory.js";
import { SqliteLocalStore } from "../src/local/store.js";
import { detectClient } from "../src/cli.js";
import { bashGuard, unguardedDelete } from "../src/jev/hooks/bash-guard.js";
import type { HookDeps } from "../src/jev/hooks/io.js";
import { preToolHook } from "../src/jev/hooks/pretool.js";
import {
  GROUNDED_TAIL_SENTENCES,
  MAX_BLOCKS,
  MAX_GROUNDED_SENTENCES,
  READING_START_BUDGET_MS,
  sessionEndHook,
  stopHook,
} from "../src/jev/hooks/stop.js";
import {
  branchIdentifiers,
  normalizeIdentity,
  resolveContext,
} from "../src/jev/project.js";
import { holdersOf, otherWorkText } from "../src/jev/standard.js";
import type { Judgment } from "../src/jev/judgment.js";
import { ScriptedProvider, type Script } from "../src/jev/lib/index.js";
import { queryEntries, type EntryFilter } from "../src/verification/store.js";
import {
  ANTIGRAVITY_LINES,
  ANTIGRAVITY_SESSION_ID,
  CLAUDE_LINES,
  CODEX_LINES,
  MUSE_LINES,
  MUSE_SESSION_ID,
  writeAntigravityBrain,
  writeMuseSession,
  writeTranscript,
} from "./jev-helpers.js";

function judgmentOf(script: Script): {
  judgment: Judgment;
  provider: ScriptedProvider;
} {
  const provider = new ScriptedProvider(script);
  return {
    provider,
    judgment: {
      provider,
      config: {},
      thresholdsFor: () => undefined,
      sources: [],
      unusable: [],
    },
  };
}

function museSessions(t: TestContext): string {
  const sessions = mkdtempSync(
    join(tmpdir(), "vibecheck-linear-jev-muse-sessions-"),
  );
  t.after(() => rmSync(sessions, { recursive: true, force: true }));
  return sessions;
}

function deps(
  t: TestContext,
  client: "claude" | "codex" | "muse" | "antigravity",
  script: Script | undefined,
  sessionsDir?: string,
  antigravityBrain?: string,
) {
  const directory = mkdtempSync(join(tmpdir(), "vibecheck-linear-jev-hooks-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "ledger.sqlite3");
  const opened = script === undefined ? undefined : judgmentOf(script);
  const value: HookDeps = {
    client,
    databasePath,
    ...(client === "muse"
      ? { sessionsDir: sessionsDir ?? museSessions(t) }
      : {}),
    ...(client === "antigravity" && antigravityBrain !== undefined
      ? { antigravityBrain }
      : {}),
    judgment: () =>
      opened?.judgment ?? {
        unusable: [{ sourceId: "typesafe", reason: "no API key" }],
      },
  };
  return { deps: value, databasePath, provider: opened?.provider };
}

const has = (state: unknown, text: string) =>
  JSON.stringify(state).includes(text);

/** Verification entries in the hook's local store. */
function readEntries(databasePath: string, filter: EntryFilter) {
  const store = new SqliteLocalStore(databasePath);
  try {
    return queryEntries(store.verificationAccess(), filter);
  } finally {
    store.close();
  }
}

/** Outbox rows the hooks queued. */
function queued(databasePath: string) {
  const store = new SqliteLocalStore(databasePath);
  try {
    return store.pending(100);
  } finally {
    store.close();
  }
}

async function seedLedger(databasePath: string, externalSessionId: string) {
  const store = new SqliteLocalStore(databasePath);
  const board = new Board({ store, linear: new MemoryLinearApi() });
  try {
    const joined = z.object({ session_id: z.string() }).parse(
      await board.call("project_join", {
        project_id: "shop",
        request_id: "join",
        repository: "https://example.com/team/shop.git",
        vendor: "test",
        runtime: "test",
        external_session_id: externalSessionId,
        model: "m",
      }),
    );
    await acceptingProblems(board, "plan_publish", {
      project_id: "shop",
      request_id: "plan",
      session_id: joined.session_id,
      expected_revision: 0,
      project: { name: "vc-test-shop" },
      tasks: [
        {
          key: "csv-export",
          title: "CSV export for the reports page",
          criteria: ["every visible column is exported"],
        },
        { key: "pdf-export", title: "PDF export for the reports page" },
      ],
      policy: {
        rules: ["Every schema change is a new migration in db/migrations/"],
      },
    });
    const claim = z
      .object({
        work: z.object({ id: z.string() }),
        issue: z.object({ id: z.string() }),
      })
      .parse(
        await board.call("work_claim", {
          project_id: "shop",
          request_id: "claim",
          session_id: joined.session_id,
          task_id: "csv-export",
          location: { paths: ["src/reports/csv.ts"] },
        }),
      );
    return {
      session: joined.session_id,
      work: claim.work,
      issueId: claim.issue.id,
    };
  } finally {
    store.close();
  }
}

const claudePreTool = (
  transcript: string | null,
  toolInput: object,
  tool = "Agent",
) => ({
  session_id: "claude-session",
  transcript_path: transcript,
  cwd: "/nonexistent/work",
  permission_mode: "default",
  hook_event_name: "PreToolUse",
  tool_name: tool,
  tool_input: toolInput,
  tool_use_id: "toolu_9",
});

const codexCommon = {
  session_id: "019c-session",
  turn_id: "turn-1",
  cwd: "/nonexistent/work",
  model: "model",
  permission_mode: "default",
};

const museCommon = {
  session_id: MUSE_SESSION_ID,
  turn_id: "turn-1",
  cwd: "/nonexistent/work",
  model: "model",
  model_provider: "meta",
  permission_mode: "default",
  transcript_path: null,
};

const antigravityCommon = {
  conversationId: ANTIGRAVITY_SESSION_ID,
  workspacePaths: ["/nonexistent/work"],
};

test("the delete guard refuses deletes through unguarded variables and nothing else", () => {
  const refused = [
    "rm -rf $TARGET",
    'rm -rf "$TARGET/build"',
    'rm -rf "${TARGET}/build"',
    "cd /tmp && rm -f $FILE",
    "sudo rm -rf $HOME/cache",
    "for f in *.log; do rm $f; done",
    "find . -name '*.tmp' | xargs rm -f $EXTRA",
    "unlink $LINK",
  ];
  const allowed = [
    'rm -rf "${TARGET:?}/build"',
    "rm -rf /tmp/literal/path",
    "echo 'rm -rf $NOT_A_COMMAND'",
    "rmdir build",
    "ls $HOME",
  ];
  for (const command of refused)
    assert.notEqual(unguardedDelete(command), undefined, command);
  for (const command of allowed)
    assert.equal(unguardedDelete(command), undefined, command);
  const denied = bashGuard(
    JSON.stringify({
      ...codexCommon,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "c",
      tool_input: { command: "rm -rf $X" },
      transcript_path: null,
    }),
    "codex",
  );
  assert.match(denied.stdout ?? "", /"permissionDecision":"deny"/u);
  assert.equal(bashGuard("not json", "claude").exitCode, 0);
});

test("the client is read from the payload: turn_id and toolCall shapes", () => {
  assert.equal(
    detectClient(JSON.stringify({ turn_id: "t" }), "claude"),
    "codex",
  );
  assert.equal(
    detectClient(JSON.stringify({ session_id: "s" }), "claude"),
    "claude",
  );
  assert.equal(detectClient("not json", "codex"), "codex");
  assert.equal(detectClient(JSON.stringify({ turn_id: "t" }), "muse"), "muse");
  assert.equal(detectClient("not json", "muse"), "muse");
  assert.equal(detectClient("{}", "antigravity"), "antigravity");
  assert.equal(
    detectClient(
      JSON.stringify({
        toolCall: { name: "run_command" },
        conversationId: "c",
      }),
      "claude",
    ),
    "antigravity",
  );
});

test("a Claude brief that narrows the plan is denied and the verdict lands in the ledger", async (t) => {
  const setup = deps(t, "claude", (battery, question, state) =>
    battery === "vibecheck.brief-scope" &&
    question === "lowersBar" &&
    has(state, "half")
      ? 0.9
      : 0.1,
  );
  await seedLedger(setup.databasePath, "claude-session");
  const transcript = writeTranscript(t, CLAUDE_LINES);
  const result = await preToolHook(
    JSON.stringify(
      claudePreTool(transcript, {
        prompt: "Build the CSV export, but only half of the columns.",
      }),
    ),
    setup.deps,
  );
  assert.equal(result.exitCode, 0);
  const output = z
    .object({
      hookSpecificOutput: z.object({
        permissionDecision: z.literal("deny"),
        permissionDecisionReason: z.string(),
      }),
    })
    .parse(JSON.parse(result.stdout ?? ""));
  assert.match(
    output.hookSpecificOutput.permissionDecisionReason,
    /brief-scope/u,
  );
  const request = setup.provider?.requests.find(
    (entry) => entry.batteryId === "vibecheck.brief-scope",
  );
  assert.ok(
    request !== undefined &&
      has(request.state, "csv-export") &&
      has(request.state, "every visible column is exported"),
  );
  const entries = readEntries(setup.databasePath, { projectId: "shop" });
  assert.ok(
    entries.some(
      (entry) =>
        entry.kind === "verdict" &&
        entry.body.battery_id === "vibecheck.brief-scope" &&
        entry.body.outcome === "failed",
    ),
  );
});

test("a new worker's brief that leaves out a governing project rule is denied", async (t) => {
  const setup = deps(t, "claude", (battery, question) =>
    battery === "vibecheck.brief-carries-rules"
      ? question === "governed"
        ? 0.9
        : 0.1
      : 0.1,
  );
  await seedLedger(setup.databasePath, "claude-session");
  const result = await preToolHook(
    JSON.stringify(
      claudePreTool(null, { prompt: "Add a phone column to the users table." }),
    ),
    setup.deps,
  );
  assert.match(result.stdout ?? "", /brief-carries-rules[^"]*migration/u);
});

test("a Codex brief is read from spawn_agent; a sealed one is skipped with a note", async (t) => {
  const setup = deps(t, "codex", () => 0.1);
  const transcript = writeTranscript(t, CODEX_LINES);
  const readable = await preToolHook(
    JSON.stringify({
      ...codexCommon,
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      tool_use_id: "c",
      transcript_path: transcript,
      tool_input: {
        task_name: "tests",
        message: "Fix the failing checkout test and run the suite.",
      },
    }),
    setup.deps,
  );
  assert.deepEqual(readable, { exitCode: 0 });
  const brief = setup.provider?.requests.find(
    (entry) => entry.batteryId === "vibecheck.brief-scope",
  );
  assert.ok(
    brief !== undefined && has(brief.state, "Fix the failing checkout test."),
    "the user's request stands in without a ledger project",
  );
  const sealed = await preToolHook(
    JSON.stringify({
      ...codexCommon,
      hook_event_name: "PreToolUse",
      tool_name: "send_message",
      tool_use_id: "c",
      transcript_path: transcript,
      tool_input: {
        target: "tests",
        message:
          "gAAAAABqt0_ODGHbVZbAj5zGQeN09pc4lICnmLguoGN2cJ21EuzKMDzzuonT6hiiokHFV2eN60tGPV75uod3is9zxNmUxVN1Kflo7SsBQvuDbzE_HyEqyQuNOVFWg7bJEHDUTLVAvMl2",
      },
    }),
    setup.deps,
  );
  assert.equal(sealed.exitCode, 0);
  assert.match(sealed.stderr ?? "", /sealed/u);
});

test("Codex collaboration tool namespaces reach the brief judgment", async (t) => {
  const transcript = writeTranscript(t, CODEX_LINES);
  for (const prefix of ["collaboration.", "functions.collaboration."]) {
    for (const name of [
      "spawn_agent",
      "send_message",
      "followup_task",
      "send_input",
    ]) {
      const setup = deps(t, "codex", () => 0.1);
      const result = await preToolHook(
        JSON.stringify({
          ...codexCommon,
          hook_event_name: "PreToolUse",
          tool_name: `${prefix}${name}`,
          tool_use_id: "namespaced-brief",
          transcript_path: transcript,
          tool_input: {
            target: "tests",
            task_name: "tests",
            message: "Fix the failing checkout test and run the suite.",
          },
        }),
        setup.deps,
      );
      assert.deepEqual(result, { exitCode: 0 });
      assert.ok(
        setup.provider?.requests.some(
          (entry) => entry.batteryId === "vibecheck.brief-scope",
        ),
        `${prefix}${name} must be judged`,
      );
    }
  }
});

test("hooks fail open with a message when no judgment source is usable", async (t) => {
  const claude = deps(t, "claude", undefined);
  const transcript = writeTranscript(t, CLAUDE_LINES);
  const brief = await preToolHook(
    JSON.stringify(claudePreTool(transcript, { prompt: "Do half." })),
    claude.deps,
  );
  assert.equal(brief.exitCode, 1);
  assert.match(brief.stderr ?? "", /no judgment source is usable/u);
  assert.equal(brief.stdout, undefined);
  const codex = deps(t, "codex", undefined);
  const codexTranscript = writeTranscript(t, CODEX_LINES);
  const stop = await stopHook(
    JSON.stringify({
      ...codexCommon,
      hook_event_name: "Stop",
      stop_hook_active: false,
      transcript_path: codexTranscript,
      last_assistant_message: "The checkout test passes now.",
    }),
    codex.deps,
  );
  assert.deepEqual(
    { stdout: stop.stdout, exitCode: stop.exitCode },
    { stdout: "{}", exitCode: 0 },
  );
  assert.match(stop.stderr ?? "", /not checked/u);
});

test("the Stop check blocks an ungrounded sentence by name, then stops blocking after the cap", async (t) => {
  const setup = deps(t, "claude", (battery, question, state) =>
    battery === "vibecheck.claim-grounded" &&
    question === "ungrounded" &&
    has(state, "CSV export is in")
      ? 0.9
      : 0.1,
  );
  const transcript = writeTranscript(t, CLAUDE_LINES);
  const payload = JSON.stringify({
    session_id: "claude-stop",
    transcript_path: transcript,
    cwd: "/nonexistent",
    hook_event_name: "Stop",
    stop_hook_active: false,
  });
  for (let block = 0; block < MAX_BLOCKS; block++) {
    const result = await stopHook(payload, setup.deps);
    const output = z
      .object({ decision: z.literal("block"), reason: z.string() })
      .parse(JSON.parse(result.stdout ?? ""));
    assert.match(
      output.reason,
      /"The CSV export is in src\/reports\/csv\.ts\." \(0\.90\)/u,
    );
  }
  assert.deepEqual(await stopHook(payload, setup.deps), { exitCode: 0 });
});

test("a reply confirming a pause the user asked for is not checked", async (t) => {
  const setup = deps(t, "codex", (battery) =>
    battery === "vibecheck.user-pauses" ? 0.95 : 0.95,
  );
  const transcript = writeTranscript(t, [
    ...CODEX_LINES,
    {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "pause until tomorrow morning",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Pausing until tomorrow morning." },
        ],
      },
    },
  ]);
  const result = await stopHook(
    JSON.stringify({
      ...codexCommon,
      hook_event_name: "Stop",
      stop_hook_active: false,
      transcript_path: transcript,
      last_assistant_message: "Pausing until tomorrow morning.",
    }),
    setup.deps,
  );
  assert.deepEqual(result, { stdout: "{}", exitCode: 0 });
  assert.deepEqual(
    setup.provider?.requests.map((entry) => entry.batteryId),
    ["vibecheck.user-pauses"],
  );
});

test("a stopping reply is judged against the session's open claims in the ledger", async (t) => {
  const setup = deps(t, "codex", (battery, question) =>
    battery === "vibecheck.claims-done" &&
    (question === "isFinal" || question === "overclaims")
      ? 0.9
      : 0.1,
  );
  await seedLedger(setup.databasePath, "019c-session");
  const transcript = writeTranscript(t, CODEX_LINES);
  const result = await stopHook(
    JSON.stringify({
      ...codexCommon,
      hook_event_name: "Stop",
      stop_hook_active: false,
      transcript_path: transcript,
      last_assistant_message: "The checkout test passes now.",
    }),
    setup.deps,
  );
  const output = z
    .object({ decision: z.literal("block"), reason: z.string() })
    .parse(JSON.parse(result.stdout ?? ""));
  assert.match(output.reason, /claimed task as done/u);
  const claims = setup.provider?.requests.find(
    (entry) => entry.batteryId === "vibecheck.claims-done",
  );
  assert.ok(
    claims !== undefined &&
      has(claims.state, "every visible column is exported"),
  );
  const grounded = setup.provider?.requests.find(
    (entry) => entry.batteryId === "vibecheck.claim-grounded",
  );
  assert.ok(
    grounded !== undefined &&
      has(grounded.state, "PASS tests/checkout.test.ts"),
  );
});

test("a Muse spawn brief that narrows the plan is denied and the verdict lands in the ledger", async (t) => {
  const seeded = writeMuseSession(t, MUSE_LINES);
  const setup = deps(
    t,
    "muse",
    (battery, question, state) =>
      battery === "vibecheck.brief-scope" &&
      question === "lowersBar" &&
      has(state, "half")
        ? 0.9
        : 0.1,
    seeded.sessionsDir,
  );
  await seedLedger(setup.databasePath, MUSE_SESSION_ID);
  const result = await preToolHook(
    JSON.stringify({
      ...museCommon,
      transcript_path: seeded.path,
      hook_event_name: "PreToolUse",
      tool_name: "subagent_spawn",
      tool_use_id: "call_1",
      tool_input: {
        command_id: "csv",
        objective: "Build the CSV export, but only half of the columns.",
        role: "csv",
      },
    }),
    setup.deps,
  );
  assert.equal(result.exitCode, 0);
  const output = z
    .object({
      hookSpecificOutput: z.object({
        permissionDecision: z.literal("deny"),
        permissionDecisionReason: z.string(),
      }),
    })
    .parse(JSON.parse(result.stdout ?? ""));
  assert.match(
    output.hookSpecificOutput.permissionDecisionReason,
    /brief-scope/u,
  );
  const entries = readEntries(setup.databasePath, { projectId: "shop" });
  assert.ok(
    entries.some(
      (entry) =>
        entry.kind === "verdict" &&
        entry.body.battery_id === "vibecheck.brief-scope" &&
        entry.body.outcome === "failed",
    ),
  );
});

test("a Muse message to a worker is judged against the session log's requests", async (t) => {
  const seeded = writeMuseSession(t, MUSE_LINES);
  const setup = deps(t, "muse", () => 0.1, seeded.sessionsDir);
  const result = await preToolHook(
    JSON.stringify({
      ...museCommon,
      hook_event_name: "PreToolUse",
      tool_name: "subagent_send_message",
      tool_use_id: "call_2",
      tool_input: {
        subagent_id: "sub-1",
        message: "Fix the failing checkout test and run the suite.",
      },
    }),
    setup.deps,
  );
  assert.deepEqual(result, { exitCode: 0 });
  const brief = setup.provider?.requests.find(
    (entry) => entry.batteryId === "vibecheck.brief-scope",
  );
  assert.ok(
    brief !== undefined &&
      has(brief.state, "Add a CSV export to the reports page."),
    "the session log's requests stand in without a ledger project",
  );
});

test("a Muse shell delete through an unguarded variable is refused", () => {
  const denied = bashGuard(
    JSON.stringify({
      ...museCommon,
      hook_event_name: "PreToolUse",
      tool_name: "bash",
      tool_use_id: "call_3",
      tool_input: {
        command: "rm -rf $X",
        description: "clean",
        workdir: "/tmp",
      },
    }),
    "muse",
  );
  assert.match(denied.stdout ?? "", /"permissionDecision":"deny"/u);
  const allowed = bashGuard(
    JSON.stringify({
      ...museCommon,
      hook_event_name: "PreToolUse",
      tool_name: "read_file",
      tool_use_id: "call_4",
      tool_input: { path: "/tmp/x" },
    }),
    "muse",
  );
  assert.deepEqual(allowed, { exitCode: 0 });
});

test("a Muse subagent reply stating what the tools did not show is blocked by name", async (t) => {
  const seeded = writeMuseSession(t, MUSE_LINES);
  const setup = deps(
    t,
    "muse",
    (battery, question, state) =>
      battery === "vibecheck.claim-grounded" &&
      question === "ungrounded" &&
      has(state, "CSV export is in")
        ? 0.9
        : 0.1,
    seeded.sessionsDir,
  );
  const result = await stopHook(
    JSON.stringify({
      ...museCommon,
      hook_event_name: "SubagentStop",
      stop_hook_active: false,
      child_session_id: MUSE_SESSION_ID,
      subagent_id: "sub-1",
    }),
    setup.deps,
  );
  const output = z
    .object({ decision: z.literal("block"), reason: z.string() })
    .parse(JSON.parse(result.stdout ?? ""));
  assert.match(
    output.reason,
    /"The CSV export is in src\/reports\/csv\.ts\." \(0\.90\)/u,
  );
});

test("a Muse session end records the verdict without holding the reply", async (t) => {
  const seeded = writeMuseSession(t, MUSE_LINES);
  const setup = deps(
    t,
    "muse",
    (battery, question, state) =>
      battery === "vibecheck.claim-grounded" &&
      question === "ungrounded" &&
      has(state, "CSV export is in")
        ? 0.9
        : 0.1,
    seeded.sessionsDir,
  );
  const result = await sessionEndHook(
    JSON.stringify({
      session_id: MUSE_SESSION_ID,
      cwd: "/nonexistent/work",
      transcript_path: null,
      hook_event_name: "SessionEnd",
      model: "model",
      model_provider: "meta",
      permission_mode: "default",
      reason: "other",
    }),
    setup.deps,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, undefined);
  assert.match(result.stderr ?? "", /not held/u);
  const entries = readEntries(setup.databasePath, {});
  assert.ok(
    entries.some(
      (entry) =>
        entry.kind === "verdict" &&
        entry.body.battery_id === "vibecheck.claim-grounded",
    ),
  );
});

test("an Antigravity shell delete through an unguarded variable is refused with a flat decision", () => {
  const denied = bashGuard(
    JSON.stringify({
      ...antigravityCommon,
      stepIdx: 1,
      toolCall: {
        name: "run_command",
        args: { CommandLine: "rm -rf $X" },
      },
    }),
    "antigravity",
  );
  const output = z
    .object({ decision: z.literal("deny"), reason: z.string() })
    .parse(JSON.parse(denied.stdout ?? ""));
  assert.match(output.reason, /unguarded variable/u);
  const allowed = bashGuard(
    JSON.stringify({
      ...antigravityCommon,
      stepIdx: 2,
      toolCall: {
        name: "run_command",
        args: { CommandLine: 'rm -rf "${X:?}/build"' },
      },
    }),
    "antigravity",
  );
  assert.deepEqual(allowed, {
    stdout: JSON.stringify({ decision: "allow" }),
    exitCode: 0,
  });
});

test("an Antigravity spawn brief that narrows the plan is denied", async (t) => {
  const setup = deps(t, "antigravity", (battery, question, state) =>
    battery === "vibecheck.brief-scope" &&
    question === "lowersBar" &&
    has(state, "half")
      ? 0.9
      : 0.1,
  );
  await seedLedger(setup.databasePath, ANTIGRAVITY_SESSION_ID);
  const result = await preToolHook(
    JSON.stringify({
      ...antigravityCommon,
      stepIdx: 3,
      toolCall: {
        name: "invoke_subagent",
        args: {
          Subagents: [
            {
              Prompt: "Build the CSV export, but only half of the columns.",
            },
          ],
        },
      },
    }),
    setup.deps,
  );
  assert.equal(result.exitCode, 0);
  const output = z
    .object({ decision: z.literal("deny"), reason: z.string() })
    .parse(JSON.parse(result.stdout ?? ""));
  assert.match(output.reason, /brief-scope/u);
});

test("an Antigravity worker message is judged against the brain transcript's requests", async (t) => {
  const seeded = writeAntigravityBrain(t, ANTIGRAVITY_LINES);
  const setup = deps(t, "antigravity", () => 0.1, undefined, seeded.brainDir);
  const result = await preToolHook(
    JSON.stringify({
      ...antigravityCommon,
      stepIdx: 4,
      toolCall: {
        name: "send_message",
        args: {
          Message: "Fix the failing checkout test and run the suite.",
          Recipient: "parent",
        },
      },
    }),
    setup.deps,
  );
  assert.deepEqual(result, {
    stdout: JSON.stringify({ decision: "allow" }),
    exitCode: 0,
  });
  const brief = setup.provider?.requests.find(
    (entry) => entry.batteryId === "vibecheck.brief-scope",
  );
  assert.ok(
    brief !== undefined &&
      has(brief.state, "Add a CSV export to the reports page."),
    "the brain transcript's requests stand in without a ledger project",
  );
});

test("an Antigravity manage_task that is not worker input is allowed without judgment", async (t) => {
  const setup = deps(t, "antigravity", () => 0.1);
  const result = await preToolHook(
    JSON.stringify({
      ...antigravityCommon,
      stepIdx: 5,
      toolCall: {
        name: "manage_task",
        args: { Action: "create", TaskId: "task-1" },
      },
    }),
    setup.deps,
  );
  assert.deepEqual(result, {
    stdout: JSON.stringify({ decision: "allow" }),
    exitCode: 0,
  });
  assert.equal(setup.provider?.requests.length ?? 0, 0);
});

test("an Antigravity stopping reply is judged against the session's open claims", async (t) => {
  const setup = deps(t, "antigravity", (battery, question) =>
    battery === "vibecheck.claims-done" &&
    (question === "isFinal" || question === "overclaims")
      ? 0.9
      : 0.1,
  );
  await seedLedger(setup.databasePath, ANTIGRAVITY_SESSION_ID);
  const transcript = writeTranscript(t, ANTIGRAVITY_LINES);
  const result = await stopHook(
    JSON.stringify({
      ...antigravityCommon,
      transcriptPath: transcript,
      executionNum: 1,
      terminationReason: "NO_TOOL_CALL",
      fullyIdle: true,
    }),
    setup.deps,
  );
  const output = z
    .object({ decision: z.literal("continue"), reason: z.string() })
    .parse(JSON.parse(result.stdout ?? ""));
  assert.match(output.reason, /claimed task as done/u);
  const claims = setup.provider?.requests.find(
    (entry) => entry.batteryId === "vibecheck.claims-done",
  );
  assert.ok(
    claims !== undefined &&
      has(claims.state, "every visible column is exported"),
  );
  const grounded = setup.provider?.requests.find(
    (entry) => entry.batteryId === "vibecheck.claim-grounded",
  );
  assert.ok(
    grounded !== undefined &&
      has(grounded.state, "PASS tests/reports/csv.test.ts"),
  );
});

test("a blocking hook queues its verdict as a comment on the claimed issue for the outbox", async (t) => {
  const setup = deps(t, "claude", (battery, question, state) =>
    battery === "vibecheck.brief-scope" &&
    question === "lowersBar" &&
    has(state, "half")
      ? 0.9
      : 0.1,
  );
  const seeded = await seedLedger(setup.databasePath, "claude-session");
  const result = await preToolHook(
    JSON.stringify(
      claudePreTool(null, {
        prompt: "Build the CSV export, but only half of the columns.",
      }),
    ),
    setup.deps,
  );
  assert.match(result.stdout ?? "", /"permissionDecision":"deny"/u);
  const rows = queued(setup.databasePath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "comment");
  assert.equal(rows[0]?.payload["issueId"], seeded.issueId);
  assert.match(
    String(rows[0]?.payload["body"]),
    /^\*\*vibecheck: vibecheck\.brief-scope failed\*\*/u,
  );
});

test("defect 14: a stop reply claiming the claimed task done while work is left queues vc:held by name, never calling Linear", async (t) => {
  const setup = deps(t, "codex", (battery, question) =>
    battery === "vibecheck.claims-done" &&
    (question === "isFinal" || question === "overclaims")
      ? 0.9
      : 0.1,
  );
  const seeded = await seedLedger(setup.databasePath, "019c-session");
  const transcript = writeTranscript(t, CODEX_LINES);
  await stopHook(
    JSON.stringify({
      ...codexCommon,
      hook_event_name: "Stop",
      stop_hook_active: false,
      transcript_path: transcript,
      last_assistant_message: "The checkout test passes now.",
    }),
    setup.deps,
  );
  const labels = queued(setup.databasePath).filter(
    (row) => row.kind === "add_label",
  );
  assert.deepEqual(
    labels.map((row) => row.payload),
    [{ issueId: seeded.issueId, labelName: "vc:held", skipIfCompleted: true }],
  );
  assert.ok(
    queued(setup.databasePath).some((row) => row.kind === "comment"),
    "the verdict comment is queued with it",
  );
});

test("branch names carry issue identifiers, and a branch selects its issue in the repository's project when no session matches", async (t) => {
  assert.deepEqual(branchIdentifiers("mike/ta-42-save-fatal"), ["TA-42"]);
  assert.deepEqual(branchIdentifiers("feature/TA-7"), ["TA-7"]);
  assert.deepEqual(branchIdentifiers("main"), []);
  const setup = deps(t, "claude", () => 0.1);
  await seedLedger(setup.databasePath, "someone-else");
  const repository = mkdtempSync(
    join(tmpdir(), "vibecheck-linear-jev-branch-"),
  );
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const run = (...args: string[]) =>
    spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" });
  assert.equal(run("init", "-q", "-b", "mike/ta-1-csv-export").status, 0);
  // The ledger registered https://example.com/team/shop.git; the checkout's
  // origin is the scp spelling of the same remote.
  assert.equal(
    run("remote", "add", "origin", "git@example.com:team/shop").status,
    0,
  );
  const store = new SqliteLocalStore(setup.databasePath);
  try {
    const context = resolveContext(store, {
      sessionId: "nobody",
      cwd: repository,
    });
    assert.equal(context?.claimed[0]?.key, "csv-export");
    assert.equal(context?.session, undefined);
    assert.ok(context?.snapshot.policy?.rules?.[0]?.includes("db/migrations/"));
  } finally {
    store.close();
  }
});

/** A git checkout in a temporary directory, on `branch`, with an optional origin. */
function checkout(
  t: TestContext,
  branch: string,
  origin?: string,
): { path: string; git: (...args: string[]) => string } {
  const path = mkdtempSync(join(tmpdir(), "vibecheck-linear-jev-repo-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", path, ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", branch);
  if (origin !== undefined) git("remote", "add", "origin", origin);
  return { path, git };
}

/** Projects in one local store and one fake Linear team, so issue identifiers are distinct across them. */
async function ledgerOf(databasePath: string) {
  const store = new SqliteLocalStore(databasePath);
  const board = new Board({ store, linear: new MemoryLinearApi() });
  let request = 0;
  const id = () => `r-${request++}`;
  const join = async (project: string, repository: string, external: string) =>
    z.object({ session_id: z.string() }).parse(
      await board.call("project_join", {
        project_id: project,
        request_id: id(),
        repository,
        vendor: "test",
        runtime: "test",
        external_session_id: external,
        model: "m",
      }),
    ).session_id;
  return {
    store,
    join,
    async plan(project: string, session: string, keys: string[]) {
      await acceptingProblems(board, "plan_publish", {
        project_id: project,
        request_id: id(),
        session_id: session,
        expected_revision: 0,
        project: { name: `vc-test-${project}` },
        tasks: keys.map((key) => ({
          key,
          title: `${project} ${key}`,
          criteria: ["it works"],
        })),
      });
    },
    async claim(project: string, session: string, task: string) {
      await board.call("work_claim", {
        project_id: project,
        request_id: id(),
        session_id: session,
        task_id: task,
        location: {},
      });
    },
    identifier(project: string, key: string): string {
      const plan = store.cachedIssues(projectKeyOf(project));
      const found = plan.find((issue) =>
        issue.title.endsWith(`${project} ${key}`),
      );
      assert.ok(found !== undefined, `${project} ${key} is cached`);
      return found.identifier;
    },
    close: () => store.close(),
  };
}

test("M6: a session id that joined several projects resolves to the project at the hook's working directory, else the newest", async (t) => {
  const setup = deps(t, "claude", () => 0.1);
  const alpha = checkout(t, "main", "git@example.com:team/alpha.git");
  const beta = checkout(t, "main");
  const elsewhere = checkout(t, "main");
  const ledger = await ledgerOf(setup.databasePath);
  try {
    const first = await ledger.join(
      "alpha",
      "https://example.com/team/alpha",
      "ext-1",
    );
    await ledger.plan("alpha", first, ["A-1"]);
    await ledger.claim("alpha", first, "A-1");
    await new Promise((done) => setTimeout(done, 5));
    const second = await ledger.join("beta", beta.path, "ext-1");
    await ledger.plan("beta", second, ["B-1"]);

    const atAlpha = resolveContext(ledger.store, {
      sessionId: "ext-1",
      cwd: alpha.path,
    });
    assert.equal(atAlpha?.projectId, "alpha");
    assert.equal(atAlpha?.session?.id, first);
    assert.deepEqual(
      atAlpha?.claimed.map((task) => task.key),
      ["A-1"],
      "the hook evaluates alpha's claims",
    );
    const atBeta = resolveContext(ledger.store, {
      sessionId: "ext-1",
      cwd: join(beta.path, "."),
    });
    assert.equal(atBeta?.projectId, "beta");
    assert.equal(atBeta?.session?.id, second);
    assert.equal(
      resolveContext(ledger.store, { sessionId: "ext-1", cwd: elsewhere.path })
        ?.session?.id,
      second,
      "no project matches: the newest session",
    );
    assert.equal(
      resolveContext(ledger.store, { sessionId: "ext-1" })?.session?.id,
      second,
    );
  } finally {
    ledger.close();
  }
});

test("repository identities: remote spellings compare equal, and linked worktrees match their main checkout", async (t) => {
  for (const spelling of [
    "git@github.com:org/beta.git",
    "git@github.com:org/beta",
    "ssh://git@github.com/org/beta.git",
    "ssh://git@GitHub.com:22/org/beta",
    "https://github.com/org/beta.git",
    "https://github.com/org/beta/",
    "http://user@github.com/org/beta",
    "git://github.com/org/beta.git",
  ])
    assert.equal(
      normalizeIdentity(spelling),
      "remote:github.com/org/beta",
      spelling,
    );
  assert.notEqual(
    normalizeIdentity("git@github.com:org/beta.git"),
    normalizeIdentity("git@github.com:org/gamma.git"),
  );
  assert.equal(normalizeIdentity("/tmp/x/"), normalizeIdentity("/tmp/x"));

  const setup = deps(t, "claude", () => 0.1);
  const main = checkout(t, "main");
  main.git(
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=test",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "start",
  );
  const linked = join(
    mkdtempSync(join(tmpdir(), "vibecheck-linear-jev-wt-")),
    "linked",
  );
  t.after(() => rmSync(dirname(linked), { recursive: true, force: true }));
  main.git("worktree", "add", "-q", linked, "-b", "side");
  mkdirSync(join(linked, "src", "deep"), { recursive: true });

  const ledger = await ledgerOf(setup.databasePath);
  try {
    await ledger.join("joined-in-main", main.path, "s-main");
    await new Promise((done) => setTimeout(done, 5));
    assert.equal(
      resolveContext(ledger.store, { cwd: join(linked, "src", "deep") })
        ?.projectId,
      "joined-in-main",
      "a linked worktree matches the project joined from the main checkout",
    );
    await ledger.join("joined-in-worktree", linked, "s-linked");
    const fromMain = resolveContext(ledger.store, { cwd: main.path });
    assert.equal(
      fromMain?.projectId,
      "joined-in-main",
      "the exact registered path beats a newer project joined from a linked worktree",
    );
    assert.equal(
      resolveContext(ledger.store, { cwd: join(linked, "src") })?.projectId,
      "joined-in-worktree",
      "inside the linked worktree its own project wins",
    );
    await ledger.join("joined-elsewhere", "/nonexistent/x", "s-x");
    const thirdWorktree = join(dirname(linked), "third");
    main.git("worktree", "add", "-q", thirdWorktree, "-b", "third");
    assert.equal(
      resolveContext(ledger.store, { cwd: thirdWorktree })?.projectId,
      "joined-in-worktree",
      "another worktree matches through the main checkout, newest first",
    );
  } finally {
    ledger.close();
  }
});

test("a branch identifier binds only to a task of the project the repository resolved, never another project's", async (t) => {
  const setup = deps(t, "claude", () => 0.1);
  const alphaRepo = checkout(t, "main", "git@example.com:team/alpha.git");
  const ledger = await ledgerOf(setup.databasePath);
  try {
    const a = await ledger.join("alpha", "https://example.com/team/alpha", "a");
    await ledger.plan("alpha", a, ["A-1"]);
    const b = await ledger.join("beta", "https://example.com/team/beta", "b");
    await ledger.plan("beta", b, ["B-1"]);
    const alphaIssue = ledger.identifier("alpha", "A-1").toLowerCase();
    const betaIssue = ledger.identifier("beta", "B-1").toLowerCase();

    alphaRepo.git("symbolic-ref", "HEAD", `refs/heads/mike/${betaIssue}-fix`);
    const crossed = resolveContext(ledger.store, { cwd: alphaRepo.path });
    assert.equal(crossed?.projectId, "alpha");
    assert.deepEqual(crossed?.claimed, [], "beta's issue is not alpha's task");

    alphaRepo.git("symbolic-ref", "HEAD", `refs/heads/mike/${alphaIssue}-fix`);
    const own = resolveContext(ledger.store, { cwd: alphaRepo.path });
    assert.equal(own?.projectId, "alpha");
    assert.deepEqual(
      own?.claimed.map((task) => task.key),
      ["A-1"],
    );

    const unrelated = checkout(t, `feature/${alphaIssue}-x`);
    assert.equal(
      resolveContext(ledger.store, { cwd: unrelated.path }),
      undefined,
      "a branch alone never selects a project",
    );
  } finally {
    ledger.close();
  }
});

test("one stop's verdicts share one timestamp, so the cap allows exactly MAX_BLOCKS blocks per user message", async (t) => {
  // Every check flags, so one stop writes many flagged entries (deferral,
  // asks-permission and one per sentence).
  const setup = deps(t, "claude", (battery) =>
    battery === "vibecheck.user-pauses" ? 0.01 : 0.9,
  );
  const transcript = writeTranscript(t, CLAUDE_LINES);
  const payload = (active: boolean) =>
    JSON.stringify({
      session_id: "claude-cap",
      transcript_path: transcript,
      cwd: "/nonexistent",
      hook_event_name: "Stop",
      stop_hook_active: active,
    });
  const decisions: string[] = [];
  for (let stop = 0; stop < MAX_BLOCKS + 2; stop++) {
    const result = await stopHook(payload(stop > 0), setup.deps);
    decisions.push(
      result.stdout?.includes('"block"') === true ? "block" : "allow",
    );
    if (stop === 0) {
      const flagged = readEntries(setup.databasePath, {
        source: "hook:stop",
        kinds: ["verdict"],
      }).filter(
        (entry) => entry.kind === "verdict" && entry.body.outcome === "flagged",
      );
      assert.ok(flagged.length > 1, "one block writes several flagged entries");
      assert.equal(
        new Set(flagged.map((entry) => entry.created_at)).size,
        1,
        "they share one timestamp",
      );
    }
  }
  assert.deepEqual(decisions, [
    ...Array.from({ length: MAX_BLOCKS }, () => "block"),
    "allow",
    "allow",
  ]);
});

/** CLAUDE_LINES followed by later turns with no tool output, ending on `reply`. */
function laterClaudeTurns(turns: number, reply: string): unknown[] {
  const lines: unknown[] = [...CLAUDE_LINES];
  for (let index = 0; index < turns; index++)
    lines.push(
      {
        type: "user",
        message: { role: "user", content: `Next question ${index}?` },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: index === turns - 1 ? reply : `Answer ${index}.`,
            },
          ],
        },
      },
    );
  return lines;
}

const claudeStop = (transcript: string, session = "claude-stop") =>
  JSON.stringify({
    session_id: session,
    transcript_path: transcript,
    cwd: "/nonexistent",
    hook_event_name: "Stop",
    stop_hook_active: false,
  });

test("claim-grounded reads tool output from earlier turns of the session", async (t) => {
  const setup = deps(t, "claude", (battery, question, state) =>
    battery === "vibecheck.claim-grounded" && question === "ungrounded"
      ? has(state, "Tests: 12 passed")
        ? 0.1
        : 0.9
      : 0.1,
  );
  const transcript = writeTranscript(
    t,
    laterClaudeTurns(5, "All 12 report tests pass."),
  );
  const result = await stopHook(claudeStop(transcript), setup.deps);
  assert.deepEqual(result, { exitCode: 0 });
  const grounded = setup.provider?.requests.filter(
    (entry) => entry.batteryId === "vibecheck.claim-grounded",
  );
  assert.equal(grounded?.length, 1);
  assert.ok(has(grounded?.[0]?.state, "Tests: 12 passed"));
});

test("questions, plans and other non-assertions are exempt; a flat claim beside them is blocked by name", async (t) => {
  const setup = deps(t, "claude", (battery, question, state) => {
    if (battery !== "vibecheck.claim-grounded") return 0.1;
    if (question === "ungrounded") return 0.9;
    if (question === "notAssertion")
      return has(state, "Should I") || has(state, "I'll") ? 0.85 : 0.1;
    return 0.1;
  });
  const transcript = writeTranscript(
    t,
    laterClaudeTurns(
      1,
      "The CI runner is on an older Node. I'll pin the version next. Should I also update the lockfile?",
    ),
  );
  const result = await stopHook(claudeStop(transcript), setup.deps);
  const output = z
    .object({ decision: z.literal("block"), reason: z.string() })
    .parse(JSON.parse(result.stdout ?? ""));
  assert.match(
    output.reason,
    /"The CI runner is on an older Node\." \(0\.90\)/u,
  );
  assert.doesNotMatch(output.reason, /Should I|I'll pin/u);
});

test("claim-grounded reads at most MAX_GROUNDED_SENTENCES sentences and says how many it skipped", async (t) => {
  const setup = deps(t, "claude", () => 0.1);
  const count = MAX_GROUNDED_SENTENCES + 5;
  const reply = Array.from(
    { length: count },
    (_, index) => `Step ${index} is done.`,
  ).join(" ");
  const transcript = writeTranscript(t, laterClaudeTurns(1, reply));
  const result = await stopHook(claudeStop(transcript), setup.deps);
  assert.equal(result.stdout, undefined, "nothing is blocked");
  assert.equal(
    setup.provider?.requests.filter(
      (entry) => entry.batteryId === "vibecheck.claim-grounded",
    ).length,
    MAX_GROUNDED_SENTENCES,
  );
  assert.match(
    result.stderr ?? "",
    new RegExp(`read ${MAX_GROUNDED_SENTENCES} of ${count} sentences`, "u"),
  );
});

test("no reading of any kind starts after the hook's start budget; the hook fails open naming them", async (t) => {
  const setup = deps(t, "claude", () => 0.1);
  let calls = 0;
  // The hook reads the clock when it starts and before the user-pauses
  // reading; every later reading would start past the budget.
  const clock = () => (++calls <= 2 ? 0 : READING_START_BUDGET_MS + 1);
  const transcript = writeTranscript(
    t,
    laterClaudeTurns(
      1,
      "One is done. Two is done. Three is done. Four is done.",
    ),
  );
  const result = await stopHook(claudeStop(transcript), {
    ...setup.deps,
    now: clock,
  });
  assert.equal(result.stdout, undefined, "nothing is blocked");
  assert.equal(result.exitCode, 1, "Claude Code shows the note: fail open");
  assert.deepEqual(
    [...new Set(setup.provider?.requests.map((entry) => entry.batteryId))],
    ["vibecheck.user-pauses"],
  );
  const stderr = result.stderr ?? "";
  for (const reading of ["deferral", "asks-permission", "question-answered"])
    assert.match(
      stderr,
      new RegExp(`${reading}: not started; no reading starts 30 seconds`, "u"),
    );
  assert.match(stderr, /read 0 of 4 sentences/u);
});

test("the Stop hook answers inside its total budget, failing open, while readings still run", async (t) => {
  class SlowProvider extends ScriptedProvider {
    override async evaluate(
      request: Parameters<ScriptedProvider["evaluate"]>[0],
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return super.evaluate(request);
    }
  }
  const provider = new SlowProvider(() => 0.1);
  const setup = deps(t, "claude", () => 0.1);
  const transcript = writeTranscript(
    t,
    laterClaudeTurns(1, "The export works. Is it done?"),
  );
  const started = Date.now();
  const result = await stopHook(claudeStop(transcript), {
    ...setup.deps,
    judgment: () => ({
      provider,
      config: {},
      thresholdsFor: () => undefined,
      sources: [],
      unusable: [],
    }),
    stopBudget: { startMs: 100, totalMs: 300 },
  });
  assert.ok(Date.now() - started < 1_000, "answered on the budget");
  assert.equal(result.stdout, undefined);
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr ?? "",
    /the Stop checks ran past their 0\.3-second budget; the reply was not checked/u,
  );
});

/**
 * Three tasks; `claude-session` claims csv-export and a Codex session claims
 * pdf-export. `alsoJoin` joins one more session that claims nothing.
 */
async function seedTwoClaims(databasePath: string, alsoJoin?: string) {
  const store = new SqliteLocalStore(databasePath);
  const board = new Board({ store, linear: new MemoryLinearApi() });
  const joinAs = async (external: string, vendor: string) =>
    z.object({ session_id: z.string() }).parse(
      await board.call("project_join", {
        project_id: "shop",
        request_id: `join-${external}`,
        repository: "https://example.com/team/shop.git",
        vendor,
        runtime: vendor,
        external_session_id: external,
        model: "m",
      }),
    ).session_id;
  try {
    const own = await joinAs("claude-session", "claude-code");
    await acceptingProblems(board, "plan_publish", {
      project_id: "shop",
      request_id: "plan",
      session_id: own,
      expected_revision: 0,
      project: { name: "vc-test-shop" },
      policy: { goal: "Ship the reports page with CSV and PDF export." },
      tasks: [
        {
          key: "csv-export",
          title: "CSV export for the reports page",
          criteria: ["every visible column is exported"],
          out_of_scope: ["scheduled exports"],
        },
        {
          key: "pdf-export",
          title: "PDF export for the reports page",
          criteria: ["the PDF matches the page layout"],
        },
        {
          key: "email-digest",
          title: "Weekly email digest",
          criteria: ["the digest is sent every Monday"],
        },
      ],
    });
    await board.call("work_claim", {
      project_id: "shop",
      request_id: "claim-csv",
      session_id: own,
      task_id: "csv-export",
      location: { paths: ["src/reports/csv.ts"] },
    });
    const other = await joinAs("codex-session", "codex");
    await board.call("work_claim", {
      project_id: "shop",
      request_id: "claim-pdf",
      session_id: other,
      task_id: "pdf-export",
      location: { paths: ["src/reports/pdf.ts"] },
    });
    if (alsoJoin !== undefined) await joinAs(alsoJoin, "muse");
    return { own, other };
  } finally {
    store.close();
  }
}

const briefState = z.object({
  standard: z.string(),
  otherWork: z.string(),
  acceptedExceptions: z.string(),
  brief: z.string(),
});

test("brief-scope reads the claimed task and the unclaimed tasks as the standard, and only the tasks others hold as other work", async (t) => {
  const setup = deps(t, "claude", () => 0.1);
  const seeded = await seedTwoClaims(setup.databasePath);
  const transcript = writeTranscript(t, CLAUDE_LINES);
  const result = await preToolHook(
    JSON.stringify(
      claudePreTool(transcript, {
        prompt:
          "Build the CSV export with every visible column. pdf-export belongs to the Codex agent; do not edit src/reports/pdf.ts.",
      }),
    ),
    setup.deps,
  );
  assert.equal(result.stdout, undefined, "the brief is allowed");
  const request = setup.provider?.requests.find(
    (entry) => entry.batteryId === "vibecheck.brief-scope",
  );
  const state = briefState.parse(request?.state);
  assert.match(state.standard, /This session's claimed tasks/u);
  assert.match(state.standard, /every visible column is exported/u);
  assert.match(state.standard, /Plan goal: Ship the reports page/u);
  // An unclaimed task is the coordinator's to hand out, with its criteria.
  assert.match(
    state.standard,
    /Unclaimed tasks in the plan, which a brief that hands one out must carry in full:\n- email-digest \[pending\]: Weekly email digest\./u,
  );
  assert.doesNotMatch(state.standard, /pdf-export/u);
  assert.match(
    state.otherWork,
    new RegExp(
      `pdf-export \\([A-Z]+-\\d+\\) \\[in_progress\\]: PDF export for the reports page\\. Claimed by agent:codex \\(session ${seeded.other}\\); paths src/reports/pdf\\.ts`,
      "u",
    ),
  );
  assert.match(state.otherWork, /^Tasks other sessions or machines hold/u);
  assert.doesNotMatch(state.otherWork, /email-digest|Unclaimed/u);
  assert.match(
    state.otherWork,
    /Recorded as out of scope for this brief's task:\n- scheduled exports/u,
  );
});

test("with no claims of its own a session's brief answers to the whole plan, with the claims others hold as other work", async (t) => {
  const setup = deps(t, "claude", () => 0.1);
  const seeded = await seedTwoClaims(setup.databasePath, "third-session");
  const transcript = writeTranscript(t, CLAUDE_LINES);
  await preToolHook(
    JSON.stringify({
      ...claudePreTool(transcript, {
        prompt: "Build the weekly email digest and its tests.",
      }),
      session_id: "third-session",
    }),
    setup.deps,
  );
  const state = briefState.parse(
    setup.provider?.requests.find(
      (entry) => entry.batteryId === "vibecheck.brief-scope",
    )?.state,
  );
  assert.match(state.standard, /^Plan goal: Ship the reports page/u);
  assert.match(state.standard, /email-digest/u);
  assert.match(state.otherWork, /^Tasks other sessions have claimed/u);
  assert.match(
    state.otherWork,
    new RegExp(`Claimed by agent:codex \\(session ${seeded.other}\\)`, "u"),
  );
  assert.match(
    state.otherWork,
    new RegExp(`Claimed by agent:claude-code \\(session ${seeded.own}\\)`, "u"),
  );
  assert.doesNotMatch(state.otherWork, /email-digest/u);
});

test("a task another machine claimed reads as held elsewhere in brief-scope, from the local cache alone", async (t) => {
  const linear = new MemoryLinearApi();
  const machineA = createLedger(t, { linear });
  const coordinator = await joinLedger(machineA.board, "coordinator");
  const published = z.object({ linear_project_id: z.string() }).parse(
    await publish(machineA.board, coordinator, [
      {
        key: "CSV",
        title: "CSV export",
        goal: "CSV export of every visible column",
        criteria: ["every visible column is exported"],
      },
      {
        key: "PDF",
        title: "PDF export",
        criteria: ["the PDF has every column"],
      },
      { key: "DIG", title: "Email digest", criteria: ["digest sends weekly"] },
    ]),
  );
  const machineB = createLedger(t, { linear });
  const remote = await joinLedger(machineB.board, "remote", {
    linear_project: published.linear_project_id,
    vendor: "codex",
  });
  await claimTask(machineB.board, remote, "PDF", {
    paths: ["src/reports/pdf.ts"],
  });
  await claimTask(machineA.board, coordinator, "CSV");
  // The coordinator's status refresh caches the started PDF issue.
  await machineA.board.call("project_status", { project_id: PROJECT });
  const { judgment, provider } = judgmentOf(() => 0.1);
  await preToolHook(
    JSON.stringify({
      session_id: "coordinator",
      cwd: "/nonexistent",
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { prompt: "Build the CSV export and the email digest." },
    }),
    { client: "claude", databasePath: machineA.path, judgment: () => judgment },
  );
  const state = briefState.parse(
    provider.requests.find(
      (entry) => entry.batteryId === "vibecheck.brief-scope",
    )?.state,
  );
  assert.match(state.standard, /every visible column is exported/u);
  assert.match(
    state.standard,
    /Unclaimed tasks in the plan[^\n]*\n- DIG \[pending\]: Email digest\. \(criteria: digest sends weekly\)/u,
  );
  assert.doesNotMatch(state.standard, /PDF/u);
  assert.match(
    state.otherWork,
    /^Tasks other sessions or machines hold \(not this brief's to do\):\n- PDF \([A-Z]+-\d+\) \[in_progress\]: PDF export\. Claimed elsewhere: the issue carries vc:claimed in Linear/u,
  );
  assert.doesNotMatch(state.otherWork, /DIG|Unclaimed/u);
});

test("brief-scope's other work names vc:claimed on a cached issue as a claim elsewhere, and a local claim's holder", () => {
  const task = (issueId: string, status: string, labels: string[] = []) => ({
    key: issueId,
    title: `Title ${issueId}`,
    status,
    issueId,
    identifier: `TA-${issueId}`,
    labels,
  });
  const tasks = [
    task("own", "in_progress", ["vc:claimed"]),
    task("remote", "pending", ["vc:claimed"]),
    task("local", "in_progress", ["vc:claimed"]),
    task("free", "pending"),
  ];
  const claims = [
    {
      issueId: "local",
      status: "in_progress",
      owner: "agent:codex (session s_2)",
      paths: [],
    },
  ];
  const holders = holdersOf(tasks, claims, new Set(["own"]));
  assert.deepEqual([...holders.keys()].sort(), ["local", "remote"]);
  assert.equal(
    otherWorkText(tasks, claims, new Set(["own"]), [], { heldOnly: true }),
    "Tasks other sessions or machines hold (not this brief's to do):\n- remote (TA-remote) [pending]: Title remote. Claimed elsewhere: the issue carries vc:claimed in Linear and no claim on this machine names the holder\n- local (TA-local) [in_progress]: Title local. Claimed by agent:codex (session s_2)",
  );
});

test("the Stop block cap counts this session's blocks however many verdicts other sessions recorded since", async (t) => {
  const flagging = deps(t, "claude", (battery) =>
    battery === "vibecheck.user-pauses" ? 0.01 : 0.9,
  );
  const passing = {
    ...flagging.deps,
    judgment: () => judgmentOf(() => 0.01).judgment,
  };
  const ours = writeTranscript(
    t,
    laterClaudeTurns(1, "The bug is fixed. Tests pass."),
  );
  const many = writeTranscript(
    t,
    laterClaudeTurns(
      1,
      Array.from({ length: 32 }, (_, index) => `Fact ${index} holds.`).join(
        " ",
      ),
    ),
  );
  const decide = async (
    session: string,
    transcript: string,
    hookDeps: HookDeps,
  ) =>
    (
      await stopHook(claudeStop(transcript, session), hookDeps)
    ).stdout?.includes('"block"') === true
      ? "block"
      : "allow";
  assert.equal(await decide("ours", ours, flagging.deps), "block");
  assert.equal(await decide("ours", ours, flagging.deps), "block");
  assert.equal(await decide("ours", ours, flagging.deps), "allow");
  // More than 500 verdicts of other sessions land after ours.
  for (let index = 0; index < 16; index++)
    await decide(`other-${index}`, many, passing);
  assert.equal(await decide("ours", ours, flagging.deps), "allow");
});

test("claim-grounded skips code blocks and always reads the reply's last sentences", async (t) => {
  const setup = deps(t, "claude", () => 0.1);
  const code = Array.from(
    { length: 40 },
    (_, index) => `const value${index} = compute(${index}); // Step ${index}.`,
  ).join("\n");
  const prose = Array.from(
    { length: MAX_GROUNDED_SENTENCES + 3 },
    (_, index) => `Point ${index} holds.`,
  ).join(" ");
  const reply = `Here is the change.\n\n\`\`\`ts\n${code}\n\`\`\`\n\n${prose}\n\nAll 12 tests pass.`;
  const transcript = writeTranscript(t, laterClaudeTurns(1, reply));
  const result = await stopHook(claudeStop(transcript), setup.deps);
  const read = (setup.provider?.requests ?? [])
    .filter((entry) => entry.batteryId === "vibecheck.claim-grounded")
    .map((entry) => JSON.stringify(entry.state));
  assert.equal(read.length, MAX_GROUNDED_SENTENCES);
  assert.ok(!read.some((state) => state.includes("const value")));
  assert.ok(read.some((state) => state.includes("All 12 tests pass.")));
  assert.equal(GROUNDED_TAIL_SENTENCES, 4);
  assert.match(
    result.stderr ?? "",
    new RegExp(
      `read ${MAX_GROUNDED_SENTENCES} of ${MAX_GROUNDED_SENTENCES + 5} sentences`,
      "u",
    ),
  );
});

test("repository resolution prefers an exact path, never matches a sibling package, and resolves relative origins", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "vibecheck-linear-jev-resolve-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) =>
    spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  const mono = join(base, "mono");
  mkdirSync(join(mono, "pkgA", "src"), { recursive: true });
  mkdirSync(join(mono, "pkgB"), { recursive: true });
  git(mono, "init", "-q");
  const store = new SqliteLocalStore(join(base, "ledger.sqlite3"));
  t.after(() => store.close());
  const board = new Board({ store, linear: new MemoryLinearApi() });
  let joins = 0;
  const register = async (project: string, repository: string) => {
    await board.call("project_join", {
      project_id: project,
      request_id: `join-${joins++}`,
      repository,
      vendor: "test",
      runtime: "test",
      external_session_id: `session-${project}`,
      model: "m",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  await register("pkgb", join(mono, "pkgB"));
  await register("pkga", join(mono, "pkgA"));
  const at = (cwd: string) => resolveContext(store, { cwd })?.projectId;
  assert.equal(at(join(mono, "pkgB")), projectKeyOf("pkgb"));
  assert.equal(at(join(mono, "pkgA")), projectKeyOf("pkga"));
  assert.equal(at(join(mono, "pkgA", "src")), projectKeyOf("pkga"));
  assert.equal(at(mono), undefined, "a parent is not a registered package");

  const repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(
    repo,
    "-c",
    "user.email=a@b",
    "-c",
    "user.name=a",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "x",
  );
  const linked = join(base, "linked");
  git(repo, "worktree", "add", "-q", linked, "-b", "side");
  await register("exact", repo);
  await register("viaworktree", linked);
  assert.equal(
    at(repo),
    projectKeyOf("exact"),
    "the exact path beats a newer worktree match",
  );
  assert.equal(at(linked), projectKeyOf("viaworktree"));

  const unrelated = join(base, "unrelated");
  mkdirSync(unrelated);
  git(unrelated, "init", "-q");
  git(unrelated, "remote", "add", "origin", "../upstream");
  await register("relative", "../upstream");
  assert.equal(
    at(unrelated),
    undefined,
    "a relative registration matches nothing",
  );
  await register("upstream", join(base, "upstream"));
  assert.equal(
    at(unrelated),
    projectKeyOf("upstream"),
    "the relative origin resolves against the checkout",
  );
});
