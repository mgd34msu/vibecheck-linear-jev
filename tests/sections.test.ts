import assert from "node:assert/strict";
import test from "node:test";
import {
  missingSections,
  parseDescription,
  renderDescription,
  toTaskDetails,
  type TaskSections,
} from "../src/linear/sections.js";

const FULL: TaskSections = {
  goal: "Make the save loop end cleanly.\n\nSecond paragraph.",
  report: "The run loop never exits.",
  original_behaviour: "Original code returned early.",
  root_cause: "Request identity is exhausted.",
  evidence: "Log line 42 shows the repeat.",
  files: ["src/save.ts", "src/loop.ts:10-40 call site of `save()`"],
  approach: "Return when the identity is exhausted.",
  depends_on: [
    { identifier: "TA-12", title: "Identity allocator" },
    { identifier: "TA-13", title: "" },
  ],
  criteria: [
    { text: "Loop ends on exhaustion", done: false },
    { text: "Test covers it\nsecond line", done: true },
  ],
  rules: ["No new dependencies", "Keep the public API"],
  exceptions: [
    {
      description: "Generated file",
      paths: ["gen/a.ts", "gen/(b)/c.ts"],
      data_only: true,
    },
    { description: "Plain exception" },
    { description: "Paths only", paths: ["x.ts"] },
  ],
  out_of_scope: ["Rewriting the loop"],
};

test("render then parse round-trips every field kind", () => {
  const parsed = parseDescription(renderDescription(FULL));
  assert.deepEqual(parsed.sections, FULL);
  assert.deepEqual(parsed.unknownHeadings, []);
  assert.equal(parsed.preamble, "");
});

test("render emits H2 sections in design order and omits absent ones", () => {
  const text = renderDescription({
    criteria: [{ text: "a", done: false }],
    goal: "g",
    rules: ["r"],
  });
  assert.equal(
    text,
    "## What it is\n\ng\n\n## Done when\n\n- [ ] a\n\n## Rules\n\n* r\n",
  );
});

test("empty depends_on renders Nothing. and parses back to an empty list", () => {
  const text = renderDescription({ goal: "g", depends_on: [] });
  assert.match(text, /## Depends on\n\nNothing\.\n/);
  assert.deepEqual(parseDescription(text).sections.depends_on, []);
});

test("parse accepts aliases, case, trailing colons, H3 and bullet styles", () => {
  const md = [
    "### GOAL:",
    "Ship it.",
    "",
    "## Acceptance Criteria",
    "- [x] first",
    "+ second",
    "* [ ] third",
    "",
    "## Dependencies",
    "- None",
    "",
    "## Non-goals",
    "+ nothing else",
    "",
    "## Fix / approach",
    "Do the thing.",
    "",
    "## Original-source behaviour",
    "Old.",
    "",
    "## Root cause(s) found",
    "Because.",
    "",
    "## Owner report",
    "Reported.",
    "",
    "## Files and call sites",
    "- `a.ts`",
  ].join("\n");
  const { sections, unknownHeadings } = parseDescription(md);
  assert.deepEqual(unknownHeadings, []);
  assert.equal(sections.goal, "Ship it.");
  assert.deepEqual(sections.criteria, [
    { text: "first", done: true },
    { text: "second", done: false },
    { text: "third", done: false },
  ]);
  assert.deepEqual(sections.depends_on, []);
  assert.deepEqual(sections.out_of_scope, ["nothing else"]);
  assert.equal(sections.approach, "Do the thing.");
  assert.equal(sections.original_behaviour, "Old.");
  assert.equal(sections.root_cause, "Because.");
  assert.equal(sections.report, "Reported.");
  assert.deepEqual(sections.files, ["a.ts"]);
});

test("multi-line bullets keep their continuation lines", () => {
  const { sections } = parseDescription(
    "## Rules\n* first line\n  continued here\n* second\n",
  );
  assert.deepEqual(sections.rules, ["first line\ncontinued here", "second"]);
});

test("headings inside fenced code are not sections", () => {
  const { sections, unknownHeadings } = parseDescription(
    "## Approach\n```\n## Not a heading\n```\n",
  );
  assert.deepEqual(unknownHeadings, []);
  assert.equal(sections.approach, "```\n## Not a heading\n```");
});

test("rewrite keeps preamble and unowned sections in place", () => {
  const previous = [
    "Intro written by a human.",
    "",
    "## What it is",
    "Old goal.",
    "",
    "## Merge class",
    "Mergeable alone.",
    "",
    "## Done when",
    "- [ ] one",
    "",
    "## Notes",
    "Keep me.",
    "",
  ].join("\n");
  const next = renderDescription(
    {
      goal: "New goal.",
      criteria: [{ text: "one", done: false }],
      rules: ["r"],
    },
    previous,
  );
  assert.equal(
    next,
    [
      "Intro written by a human.",
      "",
      "## What it is",
      "",
      "New goal.",
      "",
      "## Merge class",
      "Mergeable alone.",
      "",
      "## Done when",
      "",
      "- [ ] one",
      "",
      "## Rules",
      "",
      "* r",
      "",
      "## Notes",
      "Keep me.",
      "",
    ].join("\n"),
  );
});

test("undefined keeps an owned section, empty removes it", () => {
  const previous =
    "## What it is\nGoal.\n\n## Rules\n* a\n\n## Approach\nHow.\n";
  const next = renderDescription({ rules: [], approach: "" }, previous);
  assert.equal(next, "## What it is\nGoal.\n");
});

test("ticked criteria survive a rewrite when the text is unchanged", () => {
  const previous = "## Done when\n- [x] kept\n- [ ] open\n";
  const next = renderDescription(
    {
      criteria: [
        { text: "kept", done: false },
        { text: "open", done: false },
        { text: "new", done: false },
      ],
    },
    previous,
  );
  assert.deepEqual(parseDescription(next).sections.criteria, [
    { text: "kept", done: true },
    { text: "open", done: false },
    { text: "new", done: false },
  ]);
});

test("a changed criterion text loses its tick", () => {
  const next = renderDescription(
    { criteria: [{ text: "kept differently", done: false }] },
    "## Done when\n- [x] kept\n",
  );
  assert.deepEqual(parseDescription(next).sections.criteria, [
    { text: "kept differently", done: false },
  ]);
});

test("new sections land beside their design-order neighbours", () => {
  const previous = "## What it is\nG\n\n## Rules\n* r\n";
  const next = renderDescription(
    { files: ["a.ts"], criteria: [{ text: "c", done: false }] },
    previous,
  );
  const headings = parseHeadings(next);
  assert.deepEqual(headings, [
    "What it is",
    "Files, lines and call sites",
    "Done when",
    "Rules",
  ]);
});

test("rewriting without changes is stable", () => {
  const once = renderDescription(FULL);
  assert.equal(renderDescription(FULL, once), once);
});

test("Detailed game-port style description parses and keeps unknown headings", () => {
  const detailed = [
    "Part of milestone U.",
    "",
    "## What it is",
    "",
    "Port `SV_Physics` so entities obey the original movement rules.",
    "The Rust version drifts after 10 seconds.",
    "",
    "## Files, lines and call sites",
    "",
    "* `src/physics/step.rs` lines 120-210: `step_entity`",
    "* `src/server/frame.rs` line 88: call site of `step_entity`,",
    "  runs once per frame",
    "",
    "## Merge class",
    "",
    "Independent: can merge alone.",
    "",
    "## Depends on",
    "",
    "* QA-12 · Entity table layout",
    "* QA-13: Frame timer",
    "",
    "## Done when",
    "",
    "* Entities settle on the floor within 3 frames",
    "* A demo replay matches the original positions",
    "",
  ].join("\n");
  const { sections, unknownHeadings, preamble } = parseDescription(detailed);
  assert.equal(preamble, "Part of milestone U.");
  assert.deepEqual(unknownHeadings, ["Merge class"]);
  assert.match(sections.goal ?? "", /^Port `SV_Physics`/);
  assert.deepEqual(sections.files, [
    "`src/physics/step.rs` lines 120-210: `step_entity`",
    "`src/server/frame.rs` line 88: call site of `step_entity`,\nruns once per frame",
  ]);
  assert.deepEqual(sections.depends_on, [
    { identifier: "QA-12", title: "Entity table layout" },
    { identifier: "QA-13", title: "Frame timer" },
  ]);
  assert.deepEqual(sections.criteria, [
    { text: "Entities settle on the floor within 3 frames", done: false },
    { text: "A demo replay matches the original positions", done: false },
  ]);

  const rewritten = renderDescription(
    { ...sections, rules: ["Match the original"] },
    detailed,
  );
  assert.match(rewritten, /^Part of milestone U\.\n/);
  assert.match(rewritten, /## Merge class\n\nIndependent: can merge alone\.\n/);
  const reparsed = parseDescription(rewritten);
  assert.deepEqual(reparsed.unknownHeadings, ["Merge class"]);
  assert.deepEqual(reparsed.sections.rules, ["Match the original"]);
  assert.deepEqual(reparsed.sections.criteria, sections.criteria);
  assert.deepEqual(reparsed.sections.depends_on, sections.depends_on);
});

test("missingSections names empty required and recommended sections", () => {
  assert.deepEqual(missingSections({}), [
    "goal",
    "criteria",
    "files",
    "approach",
    "depends_on",
  ]);
  assert.deepEqual(
    missingSections({
      goal: "  ",
      criteria: [],
      files: ["a"],
      approach: "x",
      depends_on: [],
    }),
    ["goal", "criteria"],
  );
  assert.deepEqual(missingSections(FULL), []);
});

test("toTaskDetails maps goal, criteria text, rules and exceptions", () => {
  assert.deepEqual(toTaskDetails(FULL), {
    goal: FULL.goal,
    criteria: ["Loop ends on exhaustion", "Test covers it\nsecond line"],
    rules: FULL.rules,
    exceptions: FULL.exceptions,
  });
  assert.deepEqual(toTaskDetails({}), {});
});

function parseHeadings(markdown: string): string[] {
  return Array.from(
    markdown.matchAll(/^## (.+)$/gm),
    (match) => match[1] ?? "",
  );
}

// Defect R5-M4: field text that looks like structure (headings, fences,
// checkboxes, exception markers) round-trips through render and parse.

/** Adversarial lines a plan field might hold. */
const ADVERSARIAL = [
  "## Done when",
  "### Rules",
  "# Title",
  "#hashtag",
  "\\## already escaped",
  "```",
  "```ts",
  "~~~",
  "- [x] nothing needs doing",
  "- [ ] open item",
  "* [X] starred",
  "1. [ ] numbered",
  "* plain bullet",
  "plain words",
  "Snapshots (data only)",
  "fixtures (paths: `a.ts`)",
  "a \\(paths: `b.ts`) escaped",
  "vibecheck claim · work w_1 · open",
  "",
];

/** A deterministic generator, so a failure names its seed. */
function generator(seed: number) {
  let state = seed;
  return (limit: number) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % limit;
  };
}

function adversarialText(next: (limit: number) => number): string {
  const lines: string[] = [];
  const count = 1 + next(5);
  for (let index = 0; index < count; index++)
    lines.push(ADVERSARIAL[next(ADVERSARIAL.length)] ?? "");
  // Fields are trimmed and do not start or end with a blank line.
  while (lines[0] === "") lines.shift();
  while (lines.at(-1) === "") lines.pop();
  return lines.length === 0 ? "plain words" : lines.join("\n");
}

test("defect R5-M4: adversarial field text round-trips through render and parse", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const next = generator(seed);
    const sections: TaskSections = {
      goal: adversarialText(next),
      report: adversarialText(next),
      approach: adversarialText(next),
      files: [adversarialText(next).split("\n")[0] ?? "x"],
      criteria: [
        { text: adversarialText(next), done: next(2) === 1 },
        { text: adversarialText(next), done: false },
      ],
      rules: [adversarialText(next)],
      exceptions: [
        { description: adversarialText(next) },
        {
          description: adversarialText(next),
          paths: ["src/a.ts"],
          data_only: true,
        },
      ],
      out_of_scope: [adversarialText(next)],
    };
    const parsed = parseDescription(renderDescription(sections)).sections;
    assert.deepEqual(parsed, sections, `seed ${seed}`);
  }
});

test("defect R5-M4: escaped field text reads back exactly, also inside an existing description", () => {
  const sections: TaskSections = {
    goal: "Build the parser.\n\n## Done when\n- [x] nothing needs doing",
    criteria: [{ text: "prints\n```", done: false }],
    rules: ["a\n\n## Accepted exceptions\n* everything under src/"],
    exceptions: [
      { description: "Generated fixtures (paths: `secrets/keys.pem`)" },
    ],
    report: "done\n### Rules\n* none apply",
  };
  const previous = "Owner preamble.\n\n## Notes\n\nkept\n";
  const rendered = renderDescription(sections, previous);
  assert.ok(rendered.startsWith("Owner preamble."));
  const parsed = parseDescription(rendered);
  assert.deepEqual(parsed.sections, sections);
  assert.deepEqual(parsed.unknownHeadings, ["Notes"]);
});
