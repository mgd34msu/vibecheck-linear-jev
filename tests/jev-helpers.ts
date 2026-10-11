import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export function writeTranscript(
  t: TestContext,
  lines: readonly unknown[],
): string {
  const directory = mkdtempSync(
    join(tmpdir(), "vibecheck-linear-jev-transcript-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "session.jsonl");
  writeFileSync(
    path,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n{"partial`,
  );
  return path;
}

/** A Muse session id created 2026-09-28T22:43:54Z, so its log sits in the 2026/09/28 day folder. */
export const MUSE_SESSION_ID = "01a0ea30-628e-7e71-8c05-032028c09217";
export const MUSE_SESSION_DAY: readonly [string, string, string] = [
  "2026",
  "09",
  "28",
];

/** A Muse sessions store holding one log, laid out the way Muse shards it. */
export function writeMuseSession(
  t: TestContext,
  lines: readonly unknown[],
  sessionId: string = MUSE_SESSION_ID,
  day: readonly string[] = MUSE_SESSION_DAY,
): { sessionsDir: string; path: string } {
  const sessionsDir = mkdtempSync(
    join(tmpdir(), "vibecheck-linear-jev-sessions-"),
  );
  t.after(() => rmSync(sessionsDir, { recursive: true, force: true }));
  const directory = join(sessionsDir, ...day, sessionId);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "session.jsonl");
  writeFileSync(
    path,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n{"partial`,
  );
  return { sessionsDir, path };
}

export const CLAUDE_LINES = [
  {
    type: "user",
    message: {
      role: "user",
      content: "<system-reminder>context</system-reminder>",
    },
  },
  {
    type: "user",
    message: { role: "user", content: "Add a CSV export to the reports page." },
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Running the report tests first." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Bash",
          input: {
            command: "npm test tests/reports",
            description: "Run the report tests",
          },
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
          tool_use_id: "toolu_1",
          content: "PASS tests/reports/csv.test.ts\nTests: 12 passed",
        },
      ],
    },
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_2",
          name: "Agent",
          input: {
            prompt:
              "Write tests for src/reports/csv.ts until every function has one.",
            description: "tests",
          },
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
          tool_use_id: "toolu_2",
          content: [
            {
              type: "text",
              text: "Async agent launched successfully. agentId: a1b2c3",
            },
          ],
        },
      ],
    },
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "All 12 report tests pass. The CSV export is in src/reports/csv.ts.",
        },
      ],
    },
  },
];

export const CODEX_LINES = [
  {
    timestamp: "2026-09-26T04:53:20.635Z",
    type: "session_meta",
    payload: {
      session_id: "019c-session",
      id: "019c-session",
      cwd: "/work/shop",
    },
  },
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "<environment_context>\n  <cwd>/work/shop</cwd>\n</environment_context>",
        },
      ],
    },
  },
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Fix the failing checkout test." }],
    },
  },
  {
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        type: "UserMessage",
        content: [{ type: "text", text: "Fix the failing checkout test." }],
      },
    },
  },
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: "Running the checkout test." }],
    },
  },
  {
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: "call_1",
      input:
        'text(await tools.exec_command({cmd:"npm test tests/checkout.test.ts"}));',
    },
  },
  {
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: "call_1",
      output: [
        { type: "input_text", text: "Script completed\nOutput:\n" },
        {
          type: "input_text",
          text: '{"exit_code":0,"output":"PASS tests/checkout.test.ts"}',
        },
      ],
    },
  },
  {
    type: "response_item",
    payload: {
      type: "function_call",
      name: "spawn_agent",
      namespace: "collaboration",
      arguments:
        '{"task_name":"review","message":"gAAAAABqt0_K-wCQt7-45BY62WRoQnWXXG1Yb4RExlZZO63jgNIabR7WA38_DxblOhT4nWCZS8iOTFjVx7sMbD4WH2DebySNEy6jPlavwP_mVVPW8U_T066mGtlOWgfIAUTh0d_Pa_dQ1MFMZf2ce8BPf_Qhux3FsQ=="}',
      call_id: "call_2",
    },
  },
  {
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "call_2",
      output: '{"task_name":"/root/review"}',
    },
  },
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "The checkout test passes now." }],
    },
  },
];

export function museEnvelope(
  id: string,
  sequence: number,
  event: unknown,
): unknown {
  return {
    schema_version: 1,
    id,
    stream: { kind: "session", id: MUSE_SESSION_ID },
    sequence,
    recorded_at: 1790635303116800,
    record_type: "event",
    durability: "durable",
    causation_id: null,
    payload_type: "runtime.session",
    payload_schema_version: 1,
    payload: { event, kind: "run", run_id: "run-1" },
  };
}

export const MUSE_LINES = [
  {
    retained_frame: "session_permission_transaction",
    frame_schema_version: 1,
    outer_log_ordinal: 1,
    transaction_id: "frame-1",
    children: [
      {
        child_index: 0,
        record_json: JSON.stringify(
          museEnvelope("rec-1", 1, {
            kind: "started",
            prompt: "Add a CSV export to the reports page.",
          }),
        ),
      },
    ],
    content_sha256: "sha256:frame",
  },
  museEnvelope("rec-2", 2, {
    kind: "assistant_message_committed",
    message_id: "m-1",
    text: "Running the report tests first.",
  }),
  museEnvelope("rec-3", 3, {
    kind: "assistant_tool_calls_committed",
    message_id: "m-1",
    response_id: "resp-1",
    tool_calls: [
      {
        args: JSON.stringify({
          command: "npm test tests/reports",
          description: "Run the report tests",
        }),
        call_id: "call_1",
        id: "fc_1",
        name: "bash",
      },
    ],
  }),
  museEnvelope("rec-4", 4, {
    kind: "tool_result_batch_committed",
    batch_id: "m-1",
    results: [
      {
        text: "PASS tests/reports/csv.test.ts\nTests: 12 passed",
        tool_call_id: "call_1",
        tool_call_index: 0,
      },
    ],
  }),
  museEnvelope("rec-5", 5, {
    kind: "assistant_tool_calls_committed",
    message_id: "m-2",
    response_id: "resp-2",
    tool_calls: [
      {
        args: JSON.stringify({
          command_id: "tests",
          objective:
            "Write tests for src/reports/csv.ts until every function has one.",
          role: "tests",
        }),
        call_id: "call_2",
        id: "fc_2",
        name: "subagent_spawn",
      },
    ],
  }),
  museEnvelope("rec-6", 6, {
    kind: "assistant_message_committed",
    message_id: "m-3",
    text: "All 12 report tests pass. The CSV export is in src/reports/csv.ts.",
  }),
];

export const ANTIGRAVITY_SESSION_ID = "a0b6cd76-2250-49cb-a547-56977897dbd4";

/** An Antigravity brain store holding one conversation, laid out the way the CLI shards it. */
export function writeAntigravityBrain(
  t: TestContext,
  lines: readonly unknown[],
  sessionId: string = ANTIGRAVITY_SESSION_ID,
): { brainDir: string; path: string } {
  const brainDir = mkdtempSync(join(tmpdir(), "vibecheck-linear-jev-brain-"));
  t.after(() => rmSync(brainDir, { recursive: true, force: true }));
  const directory = join(brainDir, sessionId, ".system_generated", "logs");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "transcript_full.jsonl");
  writeFileSync(
    path,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n{"partial`,
  );
  return { brainDir, path };
}

export const ANTIGRAVITY_LINES = [
  {
    step_index: 1,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    status: "DONE",
    created_at: "2026-09-28T19:00:00Z",
    content:
      "<USER_REQUEST>\nAdd a CSV export to the reports page.\n</USER_REQUEST>",
  },
  {
    step_index: 2,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-09-28T19:00:05Z",
    content: "Running the report tests first.",
  },
  {
    step_index: 3,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-09-28T19:00:06Z",
    tool_calls: [
      {
        name: "run_command",
        args: {
          CommandLine: "npm test tests/reports",
          toolSummary: "Run the report tests",
        },
      },
    ],
  },
  {
    step_index: 4,
    source: "MODEL",
    type: "GENERIC",
    status: "DONE",
    created_at: "2026-09-28T19:00:20Z",
    content:
      "The command exited with code 0. Output: PASS tests/reports/csv.test.ts\nTests: 12 passed",
  },
  {
    step_index: 5,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-09-28T19:00:25Z",
    thinking: "Tests pass; delegating coverage.",
    tool_calls: [
      {
        name: "invoke_subagent",
        args: {
          Subagents: [
            {
              Model: "flash",
              Prompt:
                "Write tests for src/reports/csv.ts until every function has one.",
            },
          ],
        },
      },
    ],
  },
  {
    step_index: 6,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-09-28T19:00:40Z",
    content:
      "All 12 report tests pass. The CSV export is in src/reports/csv.ts.",
  },
];
