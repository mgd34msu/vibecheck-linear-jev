import assert from "node:assert/strict";
import test from "node:test";
import {
  PLAN_DOCUMENT_ICON,
  PLAN_DOCUMENT_TITLE,
  POLICY_DOCUMENT_ICON,
  POLICY_DOCUMENT_TITLE,
  parsePlanDocument,
  parsePolicyDocument,
  renderPlanDocument,
  renderPolicyDocument,
  type PlanMap,
} from "../src/linear/documents.js";

test("document titles and icons", () => {
  assert.equal(POLICY_DOCUMENT_TITLE, "vibecheck policy");
  assert.equal(POLICY_DOCUMENT_ICON, "Shield");
  assert.equal(PLAN_DOCUMENT_TITLE, "vibecheck plan");
  assert.equal(PLAN_DOCUMENT_ICON, "Page");
});

test("policy round-trips", () => {
  const policy = {
    goal: "Ship the audit trail.\n\nNo regressions.",
    rules: ["Never edit generated files", "Run the tests"],
    authorizations: ["May install dev dependencies"],
    stop_reasons: ["Needs a human decision", "Credentials missing"],
  };
  const text = renderPolicyDocument(policy);
  assert.match(text, /^## Goal\n\nShip the audit trail\./);
  assert.match(
    text,
    /## Accepted reasons for stopping\n\n\* Needs a human decision/,
  );
  assert.deepEqual(parsePolicyDocument(text), policy);
});

test("policy omits empty sections and parses human edits", () => {
  assert.equal(renderPolicyDocument({}), "");
  assert.equal(renderPolicyDocument({ rules: [] }), "");
  const parsed = parsePolicyDocument(
    "Welcome.\n\n### goal:\nBe good.\n\n## RULES\n- one\n- two\n\n## Other\nignored\n",
  );
  assert.deepEqual(parsed, { goal: "Be good.", rules: ["one", "two"] });
});

const map: PlanMap = {
  revision: 7,
  tasks: { "SAVE-FATAL-5": "TA-559", "A-1": "TA-560" },
  milestones: { M1: "milestone-id" },
};

test("plan document groups by milestone and round-trips the map", () => {
  const text = renderPlanDocument(
    map,
    [
      {
        key: "SAVE-FATAL-5",
        identifier: "TA-559",
        title: "Save",
        milestone: "M1",
      },
      {
        key: "A-1",
        identifier: "TA-560",
        title: "Other",
        dependsOn: ["SAVE-FATAL-5"],
      },
    ],
    [{ code: "M1", name: "Foundations" }],
  );
  assert.match(
    text,
    /## M1 · Foundations\n\n\* SAVE-FATAL-5 · TA-559 · Save\n/,
  );
  assert.match(
    text,
    /## No milestone\n\n\* A-1 · TA-560 · Other \(depends on SAVE-FATAL-5\)\n/,
  );
  assert.match(text, /## Machine map\n\n```json\n\{"revision":7/);
  assert.deepEqual(parsePlanDocument(text), map);
});

test("plan parsing ignores human edits elsewhere", () => {
  const text = [
    "# My notes",
    "```json",
    '{"unrelated": true}',
    "```",
    "## Machine map",
    "Do not touch.",
    "```json",
    JSON.stringify(map),
    "```",
    "More prose.",
  ].join("\n");
  assert.deepEqual(parsePlanDocument(text), map);
});

test("plan parsing returns null for missing or invalid maps", () => {
  assert.equal(parsePlanDocument("no block here"), null);
  assert.equal(parsePlanDocument("```json\n{not json\n```"), null);
  assert.equal(
    parsePlanDocument(
      '## Machine map\n```json\n{"revision":"x","tasks":{},"milestones":{}}\n```',
    ),
    null,
  );
});
