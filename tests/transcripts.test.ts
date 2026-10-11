import assert from "node:assert/strict";
import { copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ANTIGRAVITY_LINES,
  ANTIGRAVITY_SESSION_ID,
  CLAUDE_LINES,
  CODEX_LINES,
  MUSE_LINES,
  MUSE_SESSION_DAY,
  MUSE_SESSION_ID,
  museEnvelope,
  writeAntigravityBrain,
  writeMuseSession,
  writeTranscript,
} from "./jev-helpers.js";
import {
  EVIDENCE_LIMIT,
  EVIDENCE_POOL,
  LEAD_LIMIT,
  LEAD_SEGMENTS,
  LEAD_TURNS,
  SEGMENT_LIMIT,
  claudeLaunchBrief,
  clipSegment,
  findAntigravityTranscript,
  findMuseSessionLog,
  isSealed,
  joinEvidence,
  readAntigravityTranscript,
  readClaudeTranscript,
  readCodexTranscript,
  readMuseTranscript,
  proseText,
  replySentences,
  type TranscriptView,
} from "../src/jev/transcript.js";

test("a Claude Code transcript yields the user's messages, the reply and the evidence", (t) => {
  const path = writeTranscript(t, CLAUDE_LINES);
  const view = readClaudeTranscript(path);
  assert.deepEqual(view.userMessages, [
    "Add a CSV export to the reports page.",
  ]);
  assert.equal(view.trigger, "user");
  assert.equal(
    view.lastReply,
    "Running the report tests first.\nAll 12 report tests pass. The CSV export is in src/reports/csv.ts.",
  );
  assert.equal(
    view.finalText,
    "All 12 report tests pass. The CSV export is in src/reports/csv.ts.",
  );
  assert.ok(
    view.evidence.some((segment) => segment.includes("Tests: 12 passed")),
  );
  assert.ok(
    view.evidence.some((segment) =>
      segment.startsWith("Command run (Run the report tests):\n$ npm test"),
    ),
  );
  assert.ok(
    view.evidence.some((segment) =>
      segment.startsWith("Instruction sent by Agent: Write tests"),
    ),
  );
  assert.equal(
    claudeLaunchBrief(path, "a1b2c3"),
    "Write tests for src/reports/csv.ts until every function has one.",
  );
});

test("a background notice starts a notification turn and a Stop-hook block resets the reply", (t) => {
  const path = writeTranscript(t, [
    ...CLAUDE_LINES,
    {
      type: "user",
      message: {
        role: "user",
        content:
          "<task-notification><status>completed</status><summary>Agent finished</summary></task-notification>",
      },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The agent finished." }],
      },
    },
  ]);
  const notice = readClaudeTranscript(path);
  assert.equal(notice.trigger, "notification");
  assert.equal(notice.lastReply, "The agent finished.");
  const blocked = writeTranscript(t, [
    ...CLAUDE_LINES,
    {
      type: "user",
      message: {
        role: "user",
        content:
          "Stop hook feedback:\nvibecheck-linear-jev: answer the question",
      },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Corrected reply." }],
      },
    },
  ]);
  assert.equal(readClaudeTranscript(blocked).lastReply, "Corrected reply.");
});

test("a Codex rollout yields the user's input from events, the reply and the evidence", (t) => {
  const path = writeTranscript(t, CODEX_LINES);
  const view = readCodexTranscript(path);
  assert.deepEqual(view.userMessages, ["Fix the failing checkout test."]);
  assert.equal(
    view.lastReply,
    "Running the checkout test.\nThe checkout test passes now.",
  );
  assert.equal(view.finalText, "The checkout test passes now.");
  assert.ok(
    view.evidence.some((segment) =>
      segment.includes("PASS tests/checkout.test.ts"),
    ),
  );
  assert.ok(view.evidence.some((segment) => segment.includes("exec_command")));
  assert.ok(
    view.evidence.every((segment) => !segment.includes("gAAAAAB")),
    "sealed briefs are not evidence",
  );
});

test("an older Codex rollout with user_message events and compacted history still reads", (t) => {
  const path = writeTranscript(t, [
    {
      type: "compacted",
      payload: {
        message: "",
        replacement_history: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Earlier request." }],
          },
        ],
      },
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "Now add the refund flow." },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: '{"cmd":["bash","-lc","ls src"]}',
        call_id: "c",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "c",
        output: "refunds.ts",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "agent_message",
        author: "/root/review",
        content: [
          {
            type: "input_text",
            text: "Message Type: FINAL_ANSWER\nPayload:\nok",
          },
        ],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Review agent answered." }],
      },
    },
  ]);
  const view = readCodexTranscript(path);
  assert.deepEqual(view.userMessages, [
    "Earlier request.",
    "Now add the refund flow.",
  ]);
  assert.equal(view.trigger, "notification");
  assert.ok(
    view.evidence.some((segment) => segment.includes("$ bash -lc ls src")),
  );
});

test("a Muse session log yields the user's prompts, the reply and the evidence", (t) => {
  const path = writeTranscript(t, MUSE_LINES);
  const view = readMuseTranscript(path);
  assert.deepEqual(view.userMessages, [
    "Add a CSV export to the reports page.",
  ]);
  assert.equal(view.trigger, "user");
  assert.equal(
    view.lastReply,
    "Running the report tests first.\nAll 12 report tests pass. The CSV export is in src/reports/csv.ts.",
  );
  assert.equal(
    view.finalText,
    "All 12 report tests pass. The CSV export is in src/reports/csv.ts.",
  );
  assert.ok(
    view.evidence.some((segment) => segment.includes("Tests: 12 passed")),
  );
  assert.ok(
    view.evidence.some((segment) =>
      segment.startsWith("Command run (Run the report tests):\n$ npm test"),
    ),
  );
  assert.ok(
    view.evidence.some((segment) =>
      segment.startsWith("Instruction sent by subagent_spawn: Write tests"),
    ),
  );
});

test("a Muse delivery starts a notification turn and a stop block resets the reply", (t) => {
  const notice = readMuseTranscript(
    writeTranscript(t, [
      ...MUSE_LINES,
      {
        payload: {
          kind: "run",
          event: {
            kind: "inbox_item_queued",
            source: { source: "scheduled" },
            payload: { prompt: "Nightly check-in." },
          },
        },
      },
      {
        payload: {
          kind: "run",
          event: {
            kind: "assistant_message_committed",
            text: "Checked in.",
          },
        },
      },
    ]),
  );
  assert.equal(notice.trigger, "notification");
  assert.equal(notice.lastReply, "Checked in.");
  const blocked = readMuseTranscript(
    writeTranscript(t, [
      ...MUSE_LINES,
      {
        payload: {
          kind: "run",
          event: {
            kind: "context_block_updated",
            lifecycle: "subagent_stop",
            reason: "hook:subagent_stop",
            text: "answer the question",
          },
        },
      },
      {
        payload: {
          kind: "run",
          event: {
            kind: "assistant_message_committed",
            text: "Corrected reply.",
          },
        },
      },
    ]),
  );
  assert.equal(blocked.lastReply, "Corrected reply.");
});

test("Muse session logs are found by session id in their day folder or beside their parent", (t) => {
  const seeded = writeMuseSession(t, MUSE_LINES);
  assert.equal(
    findMuseSessionLog(seeded.sessionsDir, MUSE_SESSION_ID),
    seeded.path,
  );
  const legacy = writeMuseSession(
    t,
    MUSE_LINES,
    "d00636fe-322f-49b0-bf3f-c767104e50fa",
    ["2026", "09", "27"],
  );
  assert.equal(
    findMuseSessionLog(
      legacy.sessionsDir,
      "d00636fe-322f-49b0-bf3f-c767104e50fa",
    ),
    legacy.path,
  );
  const childId = "01a0ea30-9d79-76c0-b181-63b12c20cb71";
  const parent = join(
    seeded.sessionsDir,
    ...MUSE_SESSION_DAY,
    "01a0ea30-628e-7e71-8c05-032028c09217",
    "subagent",
    childId,
  );
  mkdirSync(parent, { recursive: true });
  const child = join(parent, "session.jsonl");
  copyFileSync(seeded.path, child);
  assert.equal(findMuseSessionLog(seeded.sessionsDir, childId), child);
  assert.equal(
    findMuseSessionLog(seeded.sessionsDir, "019c-session"),
    undefined,
  );
  assert.equal(
    findMuseSessionLog(
      join(tmpdir(), "vibecheck-linear-jev-no-such-store"),
      MUSE_SESSION_ID,
    ),
    undefined,
  );
});

test("an Antigravity transcript yields the request, the reply and the evidence", (t) => {
  const path = writeTranscript(t, ANTIGRAVITY_LINES);
  const view = readAntigravityTranscript(path);
  assert.deepEqual(view.userMessages, [
    "Add a CSV export to the reports page.",
  ]);
  assert.equal(view.trigger, "user");
  assert.equal(
    view.lastReply,
    "Running the report tests first.\nAll 12 report tests pass. The CSV export is in src/reports/csv.ts.",
  );
  assert.equal(
    view.finalText,
    "All 12 report tests pass. The CSV export is in src/reports/csv.ts.",
  );
  assert.ok(
    view.evidence.some((segment) => segment.includes("Tests: 12 passed")),
  );
  assert.ok(
    view.evidence.some((segment) =>
      segment.startsWith("Command run (Run the report tests):\n$ npm test"),
    ),
  );
  assert.ok(
    view.evidence.some((segment) =>
      segment.startsWith("Instruction sent by invoke_subagent: Write tests"),
    ),
  );
  assert.ok(
    view.evidence.every((segment) => !segment.includes("delegating coverage")),
    "reasoning is never evidence",
  );
  assert.ok(!view.lastReply.includes("delegating coverage"));
});

test("a compact Antigravity transcript with encoded values reads the same", (t) => {
  const path = writeTranscript(t, [
    {
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-09-28T19:00:06Z",
      tool_calls: [
        {
          name: "run_command",
          args: { CommandLine: '"npm test"', toolSummary: '"tests"' },
        },
      ],
    },
    {
      step_index: 2,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-09-28T19:00:25Z",
      tool_calls: [
        {
          name: "invoke_subagent",
          args: {
            Subagents: JSON.stringify([{ Prompt: "Write the tests." }]),
          },
        },
      ],
    },
  ]);
  const view = readAntigravityTranscript(path);
  assert.ok(
    view.evidence.some((segment) =>
      segment.startsWith("Command run (tests):\n$ npm test"),
    ),
  );
  assert.ok(
    view.evidence.some((segment) =>
      segment.startsWith(
        "Instruction sent by invoke_subagent: Write the tests.",
      ),
    ),
  );
});

test("Antigravity transcripts are found by conversation id in the brain store", (t) => {
  const seeded = writeAntigravityBrain(t, ANTIGRAVITY_LINES);
  assert.equal(
    findAntigravityTranscript(seeded.brainDir, ANTIGRAVITY_SESSION_ID),
    seeded.path,
  );
  assert.equal(
    findAntigravityTranscript(seeded.brainDir, "019c-session"),
    undefined,
  );
  assert.equal(
    findAntigravityTranscript(
      join(tmpdir(), "vibecheck-linear-jev-no-such-brain"),
      ANTIGRAVITY_SESSION_ID,
    ),
    undefined,
  );
});

test("sealed Codex messages are recognized; readable briefs are not", () => {
  assert.equal(
    isSealed(
      "gAAAAABqt0_ODGHbVZbAj5zGQeN09pc4lICnmLguoGN2cJ21EuzKMDzzuonT6hiiokHFV2eN60tGPV75uod3is9zxNmUxVN1Kflo7SsBQvuDbzE_HyEqyQuNOVFWg7bJEHDUTLVAvMl2",
    ),
    true,
  );
  assert.equal(isSealed("Write tests for the export."), false);
});

test("replies split into sentences; evidence leads with the newest results, then claimed files", () => {
  assert.deepEqual(
    replySentences(
      "## Summary\nAll tests pass. The export works.\n- Added csv.ts\n---",
    ),
    ["Summary", "All tests pass.", "The export works.", "Added csv.ts"],
  );
  const joined = joinEvidence(
    ["newest output", "other output", "edited src/reports/csv.ts", "more"],
    ["src/reports/csv.ts"],
    EVIDENCE_LIMIT,
    1,
  );
  assert.equal(
    joined,
    "newest output\n---\nedited src/reports/csv.ts\n---\nother output\n---\nmore",
  );
  assert.equal(joinEvidence(["abcdef"], [], 3), "abc");
});

test("fenced and indented code blocks are not sentences; the prose after them is", () => {
  const block = Array.from(
    { length: 40 },
    (_, index) => `const a${index} = ${index}; // Done. Next.`,
  ).join("\n");
  const reply = `I changed the parser.\n\n\`\`\`ts\n${block}\n\`\`\`\n\nThe old form still reads:\n\n    ls -l x. Then y.\n    echo done\n\n- A list item.\n    continued here.\n\n~~~\ntilde fenced. Code.\n~~~\nAll 12 tests pass.`;
  assert.deepEqual(replySentences(reply), [
    "I changed the parser.",
    "The old form still reads:",
    "A list item.",
    "continued here.",
    "All 12 tests pass.",
  ]);
  // An unclosed fence runs to the end, as Markdown renders it.
  assert.equal(proseText("Before.\n```\ncode. More."), "Before.");
});

test("the newest tool result of each recent turn leads the reading, even when claimed paths crowd the pool", (t) => {
  const lines: unknown[] = [];
  for (let turn = 0; turn < 8; turn++)
    lines.push(
      { type: "user", message: { role: "user", content: `step ${turn}` } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `r${turn}`,
              name: "Read",
              input: { file_path: "src/reports/csv.ts" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: `r${turn}`,
              content: `src/reports/csv.ts contents v${turn}\n${"code line\n".repeat(1000)}`,
            },
          ],
        },
      },
    );
  lines.push(
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "test",
            name: "Bash",
            input: { command: "bun test", description: "Run tests" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "test",
            content: "LATEST RUN: 12 pass, 0 fail",
          },
        ],
      },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "All 12 tests pass." }],
      },
    },
  );
  const view = readClaudeTranscript(writeTranscript(t, lines));
  // The final turn's result, then the newest result of the turns before.
  assert.equal(view.evidence[0], "LATEST RUN: 12 pass, 0 fail");
  for (let back = 1; back < LEAD_TURNS; back++)
    assert.ok(
      (view.evidence[back] ?? "").startsWith(
        `src/reports/csv.ts contents v${8 - back}`,
      ),
    );
  for (const paths of [["src/reports/csv.ts"], []]) {
    const reading = joinEvidence(view.evidence, paths);
    assert.ok(reading.startsWith("LATEST RUN: 12 pass, 0 fail\n---\n"));
    assert.ok(reading.length <= EVIDENCE_LIMIT);
    // Each lead is clipped, its tail kept.
    assert.ok(reading.includes("src/reports/csv.ts contents v7"));
    assert.ok(
      reading.indexOf("contents v6") - reading.indexOf("contents v7") <
        LEAD_LIMIT + 100,
    );
  }
  assert.ok(LEAD_SEGMENTS >= LEAD_TURNS);
});

/** Later turns of a conversation with no tool output: user message, then reply. */
function laterTurns(
  turns: number,
  user: (index: number) => unknown,
  reply: (index: number) => unknown,
): unknown[] {
  return Array.from({ length: turns }, (_, index) => [
    user(index),
    reply(index),
  ]).flat();
}

test("evidence spans the whole session in all four harnesses, newest first", (t) => {
  const turns = 6;
  const claude = readClaudeTranscript(
    writeTranscript(t, [
      ...CLAUDE_LINES,
      ...laterTurns(
        turns,
        (index) => ({
          type: "user",
          message: { role: "user", content: `Question ${index}?` },
        }),
        (index) => ({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Answer ${index}.` }],
          },
        }),
      ),
    ]),
  );
  const codex = readCodexTranscript(
    writeTranscript(t, [
      ...CODEX_LINES,
      ...laterTurns(
        turns,
        (index) => ({
          type: "event_msg",
          payload: { type: "user_message", message: `Question ${index}?` },
        }),
        (index) => ({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: `Answer ${index}.` }],
          },
        }),
      ),
    ]),
  );
  const muse = readMuseTranscript(
    writeMuseSession(t, [
      ...MUSE_LINES,
      ...laterTurns(
        turns,
        (index) =>
          museEnvelope(`rec-u${index}`, 100 + 2 * index, {
            kind: "started",
            prompt: `Question ${index}?`,
          }),
        (index) =>
          museEnvelope(`rec-a${index}`, 101 + 2 * index, {
            kind: "assistant_message_committed",
            message_id: `m-a${index}`,
            text: `Answer ${index}.`,
          }),
      ),
    ]).path,
  );
  const antigravity = readAntigravityTranscript(
    writeAntigravityBrain(t, [
      ...ANTIGRAVITY_LINES,
      ...laterTurns(
        turns,
        (index) => ({
          step_index: 100 + 2 * index,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          created_at: "2026-09-28T20:00:00Z",
          content: `<USER_REQUEST>\nQuestion ${index}?\n</USER_REQUEST>`,
        }),
        (index) => ({
          step_index: 101 + 2 * index,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: "2026-09-28T20:00:05Z",
          content: `Answer ${index}.`,
        }),
      ),
    ]).path,
  );
  const views: [string, TranscriptView, string][] = [
    ["claude", claude, "Tests: 12 passed"],
    ["codex", codex, "PASS tests/checkout.test.ts"],
    ["muse", muse, "Tests: 12 passed"],
    ["antigravity", antigravity, "Tests: 12 passed"],
  ];
  for (const [client, view, shown] of views) {
    assert.equal(view.userMessages.at(-1), `Question ${turns - 1}?`, client);
    assert.equal(view.lastReply, `Answer ${turns - 1}.`, client);
    assert.ok(
      view.evidence.some((segment) => segment.includes(shown)),
      `${client}: output from ${turns} turns back is evidence`,
    );
  }
  // Newest first: the launch notice comes after the test output in Claude
  // Code's first turn, so it leads.
  assert.match(claude.evidence[0] ?? "", /Async agent launched/u);
});

test("evidence is bounded: long outputs keep head and tail, the oldest fall out", (t) => {
  const long = `HEAD ${"x".repeat(SEGMENT_LIMIT * 2)} TAIL`;
  assert.equal(clipSegment("short"), "short");
  const clipped = clipSegment(long);
  assert.ok(clipped.length < SEGMENT_LIMIT + 100);
  assert.ok(clipped.startsWith("HEAD "));
  assert.ok(clipped.endsWith(" TAIL"));
  assert.match(clipped, /characters clipped/u);

  const turns = Math.ceil((EVIDENCE_POOL / SEGMENT_LIMIT) * 2);
  const lines: unknown[] = [
    {
      type: "user",
      message: { role: "user", content: "Start." },
    },
  ];
  for (let index = 0; index < turns; index++)
    lines.push(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `toolu_${index}`,
              name: "Read",
              input: { file_path: `/f${index}` },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: `toolu_${index}`,
              content: `output ${index} ${"y".repeat(SEGMENT_LIMIT)}`,
            },
          ],
        },
      },
    );
  lines.push({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
  });
  const view = readClaudeTranscript(writeTranscript(t, lines));
  const kept = view.evidence.reduce((sum, segment) => sum + segment.length, 0);
  assert.ok(kept <= EVIDENCE_POOL + SEGMENT_LIMIT + 100, `kept ${kept}`);
  assert.match(
    view.evidence[0] ?? "",
    new RegExp(`^output ${turns - 1} `, "u"),
  );
  assert.ok(
    !view.evidence.some((segment) => segment.startsWith("output 0 ")),
    "the oldest output falls out of the pool",
  );
  assert.ok(joinEvidence(view.evidence).length <= EVIDENCE_LIMIT);
  // A claimed file named in an old segment still in the pool moves ahead
  // of every other segment but the leading newest results.
  const named = view.evidence.at(-1) ?? "";
  const index = /^output (\d+) /u.exec(named)?.[1] ?? "";
  const joined = joinEvidence(view.evidence, [`output ${index} `]);
  assert.ok(joined.startsWith(`output ${turns - 1} `));
  const at = joined.indexOf(`output ${index} `);
  assert.ok(at > 0);
  const newestOther = joined.indexOf(`output ${turns - 1 - LEAD_SEGMENTS} `);
  assert.ok(newestOther === -1 || at < newestOther);
});
