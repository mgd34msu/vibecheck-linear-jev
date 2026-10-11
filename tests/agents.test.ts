import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findTranscripts, replyTexts } from "../src/jev/tools/agents.js";
import {
  ANTIGRAVITY_LINES,
  ANTIGRAVITY_SESSION_ID,
  MUSE_LINES,
  MUSE_SESSION_ID,
  writeAntigravityBrain,
  writeMuseSession,
  writeTranscript,
} from "./jev-helpers.js";

test("reply texts include Muse committed messages", (t) => {
  const path = writeTranscript(t, MUSE_LINES);
  assert.deepEqual(replyTexts(path), [
    { line: 2, text: "Running the report tests first." },
    {
      line: 6,
      text: "All 12 report tests pass. The CSV export is in src/reports/csv.ts.",
    },
  ]);
});

test("reply texts include Antigravity planner responses", (t) => {
  const path = writeTranscript(t, ANTIGRAVITY_LINES);
  assert.deepEqual(replyTexts(path), [
    { line: 2, text: "Running the report tests first." },
    {
      line: 6,
      text: "All 12 report tests pass. The CSV export is in src/reports/csv.ts.",
    },
  ]);
});

test("transcripts are found by file name, Muse folder name or Antigravity brain folder", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vibecheck-linear-jev-agents-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const rollup = join(directory, "019c-session.jsonl");
  writeFileSync(rollup, "{}\n");
  assert.deepEqual(findTranscripts("019c-session", [directory]), [rollup]);
  const seeded = writeMuseSession(t, MUSE_LINES);
  assert.deepEqual(findTranscripts(MUSE_SESSION_ID, [seeded.sessionsDir]), [
    seeded.path,
  ]);
  assert.deepEqual(findTranscripts("019c-session", [seeded.sessionsDir]), []);
  const brain = writeAntigravityBrain(t, ANTIGRAVITY_LINES);
  assert.deepEqual(findTranscripts(ANTIGRAVITY_SESSION_ID, [brain.brainDir]), [
    brain.path,
  ]);
  assert.deepEqual(findTranscripts("019c-session", [brain.brainDir]), []);
});
