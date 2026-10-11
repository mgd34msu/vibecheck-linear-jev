// The task standard as it lives in a Linear issue description.
//
// The tool owns a fixed set of H2 sections: goal,
// criteria, rules, accepted exceptions and the rest. Everything else in a
// description, the text before the first heading and any heading the tool does
// not know, belongs to the humans who wrote it and is carried through a
// rewrite untouched. `parseDescription` also reads descriptions people wrote
// by hand, through a table of heading aliases, so existing issues can be
// adopted. All functions are pure.

import type { AcceptedException, TaskDetails } from "../schemas.js";

/** One `Depends on` bullet: an issue identifier (or plan key) and its title. */
export interface Dependency {
  identifier: string;
  title: string;
}

/** One `Done when` checklist item. */
export interface Criterion {
  text: string;
  done: boolean;
}

/**
 * The sections the tool owns. Every field is optional: absent means "not in
 * the description". Text fields and lists that are empty render nothing.
 */
export interface TaskSections {
  goal?: string | undefined;
  report?: string | undefined;
  original_behaviour?: string | undefined;
  root_cause?: string | undefined;
  evidence?: string | undefined;
  files?: string[] | undefined;
  approach?: string | undefined;
  depends_on?: Dependency[] | undefined;
  criteria?: Criterion[] | undefined;
  rules?: string[] | undefined;
  exceptions?: AcceptedException[] | undefined;
  out_of_scope?: string[] | undefined;
}

/** A field of `TaskSections`. */
export type SectionField = keyof TaskSections;

/** What `parseDescription` found. */
export interface ParsedDescription {
  sections: TaskSections;
  /** Headings the tool does not own, in order, as written. */
  unknownHeadings: string[];
  /** Text before the first heading, trimmed. */
  preamble: string;
}

interface SectionSpec {
  field: SectionField;
  /** The canonical H2 heading. */
  heading: string;
  /** Other headings that mean the same thing, lowercase. */
  aliases: readonly string[];
}

/** The owned sections in the order they are rendered. */
const SECTION_SPECS: readonly SectionSpec[] = [
  { field: "goal", heading: "What it is", aliases: ["goal"] },
  { field: "report", heading: "Report", aliases: ["owner report"] },
  {
    field: "original_behaviour",
    heading: "Original behaviour",
    aliases: ["original-source behaviour", "original behavior"],
  },
  {
    field: "root_cause",
    heading: "Root cause",
    aliases: ["root cause(s) found", "root causes found", "root causes"],
  },
  { field: "evidence", heading: "Evidence", aliases: [] },
  {
    field: "files",
    heading: "Files, lines and call sites",
    aliases: [
      "files",
      "files and lines",
      "files, lines, call sites",
      "files and call sites",
    ],
  },
  {
    field: "approach",
    heading: "Approach",
    aliases: ["fix", "fix / approach"],
  },
  {
    field: "depends_on",
    heading: "Depends on",
    aliases: ["dependencies", "depends"],
  },
  {
    field: "criteria",
    heading: "Done when",
    aliases: ["acceptance criteria", "done criteria"],
  },
  { field: "rules", heading: "Rules", aliases: [] },
  { field: "exceptions", heading: "Accepted exceptions", aliases: [] },
  { field: "out_of_scope", heading: "Out of scope", aliases: ["non-goals"] },
];

const SECTION_ORDER = SECTION_SPECS.map((spec) => spec.field);

function normalizeHeading(heading: string): string {
  return heading
    .replace(/[*_`]/g, "")
    .trim()
    .replace(/:+$/, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const SPEC_BY_HEADING: ReadonlyMap<string, SectionSpec> = new Map(
  SECTION_SPECS.flatMap((spec) =>
    [spec.heading, ...spec.aliases].map((name): [string, SectionSpec] => [
      normalizeHeading(name),
      spec,
    ]),
  ),
);

function specForHeading(heading: string): SectionSpec | undefined {
  return SPEC_BY_HEADING.get(normalizeHeading(heading));
}

// ---------------------------------------------------------------------------
// Markdown splitting and bullets (shared with documents.ts)
// ---------------------------------------------------------------------------

/** A heading and the lines under it. `lines[0]` is the heading line itself. */
export interface MarkdownSection {
  title: string;
  lines: string[];
}

const HEADING = /^(#{2,3})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^[ \t]*(```|~~~)/;

/**
 * Splits markdown at H2 and H3 headings, ignoring `#` lines inside fenced
 * code blocks. Returns the lines before the first heading and each section.
 */
export function splitMarkdownSections(markdown: string): {
  preamble: string[];
  sections: MarkdownSection[];
} {
  const preamble: string[] = [];
  const sections: MarkdownSection[] = [];
  let fence: string | null = null;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? "";
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
    }
    const heading = fence === null ? HEADING.exec(line) : null;
    const current = sections[sections.length - 1];
    if (heading !== null) {
      sections.push({ title: (heading[2] ?? "").trim(), lines: [line] });
    } else if (current !== undefined) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  return { preamble, sections };
}

/** One bullet of a list, with its checkbox state when it had a checkbox. */
export interface BulletItem {
  text: string;
  checked: boolean | null;
}

const BULLET = /^([ \t]*)(?:[*+-]|\d+[.)])[ \t]+(?:\[([ xX])\][ \t]+)?(.*)$/;

/**
 * Reads bullets (`*`, `-`, `+`, numbered, with or without a checkbox). Lines
 * that continue a bullet, or are indented under it, join its text with
 * newlines. A non-bullet paragraph separated by a blank line becomes its own
 * item.
 */
export function parseBulletItems(lines: readonly string[]): BulletItem[] {
  const items: BulletItem[] = [];
  let current: BulletItem | null = null;
  let blanks = 0;
  const flush = (): void => {
    if (current !== null) items.push({ ...current, text: current.text.trim() });
    current = null;
  };
  for (const line of lines) {
    if (line.trim() === "") {
      blanks += 1;
      continue;
    }
    const bullet = BULLET.exec(line);
    const indent = (/^[ \t]*/.exec(line) ?? [""])[0].length;
    if (bullet !== null && indent < 2) {
      flush();
      const box = bullet[2];
      current = {
        text: bullet[3] ?? "",
        checked: box === undefined ? null : box !== " ",
      };
    } else if (current !== null && (blanks === 0 || indent >= 2)) {
      current.text += `${"\n".repeat(blanks + 1)}${line.trim()}`;
    } else {
      flush();
      current = { text: line.trim(), checked: null };
    }
    blanks = 0;
  }
  flush();
  return items.filter((item) => item.text !== "");
}

/** Renders one bullet; continuation lines are indented under it. */
export function renderBullet(text: string, marker = "* "): string[] {
  const [first = "", ...rest] = text.split("\n");
  return [
    `${marker}${first}`,
    ...rest.map((line) => (line === "" ? "" : `  ${line}`)),
  ];
}

/** Renders a `* ` bullet list. */
export function renderBullets(items: readonly string[]): string[] {
  return items.flatMap((item) => renderBullet(item));
}

// ---------------------------------------------------------------------------
// Escaping field text
// ---------------------------------------------------------------------------

/**
 * A line of field text the description parser, or Linear's own Markdown,
 * would read as structure: a heading (`#` at the start or indented one to
 * three spaces), a setext underline (a line of `=` or `-`, which turns the
 * line above it into a heading), a code fence (```` ``` ```` or `~~~`,
 * indented or not), or a checkbox bullet. The leading backslashes are the
 * escapes earlier renders added.
 */
const STRUCTURE =
  "(?: {0,3}#| {0,3}(?:=+|-+)[ \\t]*$|[ \\t]*(?:```|~~~)|[ \\t]*(?:[*+-]|\\d+[.)])[ \\t]+\\[[ xX]\\])";
const STRUCTURAL = new RegExp(`^\\\\*${STRUCTURE}`, "u");
const ESCAPED_STRUCTURAL = new RegExp(`^\\\\+${STRUCTURE}`, "u");

/** Line breaks as `\n`: a CRLF field reads back the same as its LF twin. */
function lf(text: string): string {
  return text.replace(/\r\n?/gu, "\n");
}

/**
 * Field text as a description carries it: every line the parser would read
 * as a heading, a fence or a checkbox gets a leading `\` (Markdown shows the
 * line as written), so text inside a field can never end the field, open a
 * section or add a criterion. `unescapeField` undoes it.
 */
export function escapeField(text: string): string {
  return lf(text)
    .split("\n")
    .map((line) => (STRUCTURAL.test(line) ? `\\${line}` : line))
    .join("\n");
}

/** Field text as written, from what `escapeField` rendered. */
export function unescapeField(text: string): string {
  return text
    .split("\n")
    .map((line) => (ESCAPED_STRUCTURAL.test(line) ? line.slice(1) : line))
    .join("\n");
}

/** A list item starting with a checkbox (`[x] ...`), with earlier escapes. */
const LEADING_BOX = /^\\*\[[ xX]\]/u;
const ESCAPED_LEADING_BOX = /^\\+\[[ xX]\]/u;

/**
 * A list item's text as its bullet carries it: `escapeField`, plus a `\`
 * before a leading `[x]` / `[ ]`, which the bullet would otherwise read as
 * its checkbox. `unescapeItem` undoes it.
 */
export function escapeItem(text: string): string {
  const escaped = escapeField(text);
  return LEADING_BOX.test(escaped) ? `\\${escaped}` : escaped;
}

/** A list item's text as written, from what `escapeItem` rendered. */
export function unescapeItem(text: string): string {
  return unescapeField(ESCAPED_LEADING_BOX.test(text) ? text.slice(1) : text);
}

/** The parenthetical markers of an accepted exception, with escapes before them. */
const EXCEPTION_MARKER = /\\*\((?:paths:|data only)/gu;

/** An exception description whose `(paths:` and `(data only` cannot be read as markers. */
function escapeMarkers(description: string): string {
  return description.replace(EXCEPTION_MARKER, (marker) => `\\${marker}`);
}

function unescapeMarkers(description: string): string {
  return description.replace(/\\(\\*\((?:paths:|data only))/gu, "$1");
}

/** The last `marker` in `text` that is not escaped with a backslash; -1 when none. */
function lastMarker(text: string, marker: string): number {
  let at = text.lastIndexOf(marker);
  while (at > 0 && text[at - 1] === "\\") at = text.lastIndexOf(marker, at - 1);
  return at;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const NOTHING = /^(?:nothing|none|n\/a|no dependencies)\.?$/i;
const DEPENDENCY =
  /^`?([A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*-\d+)`?(?![A-Za-z0-9_-])\s*(?:[·:–—-]\s*)?([\s\S]*)$/;

function parseDependency(text: string): Dependency {
  const plain = text.replace(/^\[([^\]]+)\]\([^)]*\)/, "$1");
  const match = DEPENDENCY.exec(plain);
  if (match === null) return { identifier: text, title: "" };
  return { identifier: match[1] ?? text, title: (match[2] ?? "").trim() };
}

function stripCodeSpan(text: string): string {
  const match = /^`([^`]+)`$/.exec(text);
  return match === null ? text : (match[1] ?? text);
}

/** Splits on `;` outside code spans. */
function splitOutsideCode(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inCode = false;
  for (const char of text) {
    if (char === "`") inCode = !inCode;
    if (char === ";" && !inCode) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim());
}

function parseException(text: string): AcceptedException {
  const open = Math.max(
    lastMarker(text, "(paths:"),
    lastMarker(text, "(data only"),
  );
  if (open > 0 && text.endsWith(")")) {
    const description = unescapeMarkers(text.slice(0, open).trim());
    let paths: string[] | undefined;
    let dataOnly = false;
    let recognised = description !== "";
    for (const part of splitOutsideCode(text.slice(open + 1, -1))) {
      const pathsPart = /^paths:\s*([\s\S]*)$/i.exec(part);
      if (pathsPart !== null) {
        const body = pathsPart[1] ?? "";
        const spans = Array.from(
          body.matchAll(/`([^`]+)`/g),
          (m) => m[1] ?? "",
        );
        paths = spans.length > 0 ? spans : body.split(",").map((p) => p.trim());
        paths = paths.filter((path) => path !== "");
      } else if (/^data only$/i.test(part)) {
        dataOnly = true;
      } else {
        recognised = false;
      }
    }
    if (recognised) {
      const exception: AcceptedException = { description };
      if (paths !== undefined && paths.length > 0) exception.paths = paths;
      if (dataOnly) exception.data_only = true;
      return exception;
    }
  }
  return { description: unescapeMarkers(text) };
}

function applySection(
  sections: TaskSections,
  field: SectionField,
  body: readonly string[],
): void {
  const text = unescapeField(body.join("\n").trim());
  const items = (): BulletItem[] =>
    parseBulletItems(body).map((item) => ({
      ...item,
      text: unescapeItem(item.text),
    }));
  const strings = (): string[] => items().map((item) => item.text);
  switch (field) {
    case "goal":
    case "report":
    case "original_behaviour":
    case "root_cause":
    case "evidence":
    case "approach":
      if (text !== "") {
        sections[field] =
          sections[field] === undefined
            ? text
            : `${sections[field]}\n\n${text}`;
      }
      return;
    case "files": {
      // A path in a code span was escaped inside the span.
      const files = parseBulletItems(body).map((item) =>
        unescapeItem(stripCodeSpan(item.text)),
      );
      if (files.length > 0)
        sections.files = [...(sections.files ?? []), ...files];
      return;
    }
    case "rules":
    case "out_of_scope": {
      const list = strings();
      if (list.length > 0)
        sections[field] = [...(sections[field] ?? []), ...list];
      return;
    }
    case "depends_on": {
      const list = strings();
      if (list.length === 0) return;
      const none = list.length === 1 && NOTHING.test(list[0] ?? "");
      const found = none ? [] : list.map(parseDependency);
      sections.depends_on = [...(sections.depends_on ?? []), ...found];
      return;
    }
    case "criteria": {
      const found = items().map((item) => ({
        text: item.text,
        done: item.checked === true,
      }));
      if (found.length > 0)
        sections.criteria = [...(sections.criteria ?? []), ...found];
      return;
    }
    case "exceptions": {
      const found = strings().map(parseException);
      if (found.length > 0) {
        sections.exceptions = [...(sections.exceptions ?? []), ...found];
      }
      return;
    }
  }
}

/**
 * Reads a description into the tool's sections. Headings may be H2 or H3 and
 * are matched by canonical name or alias, ignoring case and a trailing colon.
 * Unknown headings are listed, not interpreted.
 */
export function parseDescription(markdown: string): ParsedDescription {
  const { preamble, sections: raw } = splitMarkdownSections(markdown);
  const sections: TaskSections = {};
  const unknownHeadings: string[] = [];
  for (const section of raw) {
    const spec = specForHeading(section.title);
    if (spec === undefined) unknownHeadings.push(section.title);
    else applySection(sections, spec.field, section.lines.slice(1));
  }
  return { sections, unknownHeadings, preamble: preamble.join("\n").trim() };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** What a rewrite does with one owned section. */
type Body =
  | { action: "keep" }
  | { action: "remove" }
  | { action: "set"; lines: string[] };

const KEEP: Body = { action: "keep" };
const REMOVE: Body = { action: "remove" };

function setOrRemove(lines: string[]): Body {
  return lines.length === 0 ? REMOVE : { action: "set", lines };
}

function textBody(value: string | undefined): Body {
  if (value === undefined) return KEEP;
  return setOrRemove(
    value.trim() === "" ? [] : escapeField(lf(value).trim()).split("\n"),
  );
}

function listBody(
  items: readonly string[] | undefined,
  render: (item: string) => string[],
): Body {
  if (items === undefined) return KEEP;
  return setOrRemove(
    items
      .map((item) => lf(item).trim())
      .filter((item) => item !== "")
      .flatMap((item) => render(escapeItem(item))),
  );
}

function renderException(exception: AcceptedException): string {
  const parts: string[] = [];
  if (exception.paths !== undefined && exception.paths.length > 0) {
    parts.push(
      `paths: ${exception.paths.map((path) => `\`${path}\``).join(", ")}`,
    );
  }
  if (exception.data_only === true) parts.push("data only");
  const suffix = parts.length === 0 ? "" : ` (${parts.join("; ")})`;
  return `${escapeItem(escapeMarkers(lf(exception.description).trim()))}${suffix}`;
}

function bodyFor(
  field: SectionField,
  sections: TaskSections,
  ticked: ReadonlySet<string>,
): Body {
  switch (field) {
    case "goal":
    case "report":
    case "original_behaviour":
    case "root_cause":
    case "evidence":
    case "approach":
      return textBody(sections[field]);
    case "files":
      return listBody(sections.files, (item) =>
        renderBullet(/[\s`]/.test(item) ? item : `\`${item}\``),
      );
    case "rules":
    case "out_of_scope":
      return listBody(sections[field], (item) => renderBullet(item));
    case "depends_on": {
      const deps = sections.depends_on;
      if (deps === undefined) return KEEP;
      if (deps.length === 0) return { action: "set", lines: ["Nothing."] };
      return {
        action: "set",
        lines: deps.flatMap((dep) =>
          renderBullet(
            dep.title === ""
              ? dep.identifier
              : `${dep.identifier} · ${dep.title}`,
          ),
        ),
      };
    }
    case "criteria": {
      const criteria = sections.criteria;
      if (criteria === undefined) return KEEP;
      return setOrRemove(
        criteria
          .filter((criterion) => criterion.text.trim() !== "")
          .flatMap((criterion) => {
            const text = lf(criterion.text).trim();
            const done = criterion.done || ticked.has(text);
            return renderBullet(escapeItem(text), done ? "- [x] " : "- [ ] ");
          }),
      );
    }
    case "exceptions": {
      const exceptions = sections.exceptions;
      if (exceptions === undefined) return KEEP;
      return setOrRemove(
        exceptions
          .filter((exception) => exception.description.trim() !== "")
          .flatMap((exception) => renderBullet(renderException(exception))),
      );
    }
  }
}

interface Piece {
  /** The owned field this piece holds, or null for text the tool does not own. */
  field: SectionField | null;
  lines: string[];
  /** Rendered by the tool in this call rather than carried over. */
  rendered: boolean;
}

function renderedPiece(spec: SectionSpec, lines: string[]): Piece {
  return {
    field: spec.field,
    lines: [`## ${spec.heading}`, "", ...lines, ""],
    rendered: true,
  };
}

/**
 * Renders the owned sections as H2 sections in design order. With `previous`,
 * rewrites that description instead: text the tool does not own stays exactly
 * where it was, owned sections are replaced when `sections` provides them
 * (an empty string or empty list removes the section, `undefined` keeps it),
 * and new sections are placed beside their neighbours in design order.
 * `Depends on` with an empty list renders `Nothing.`. A criterion whose text
 * is ticked in `previous` stays ticked.
 */
export function renderDescription(
  sections: TaskSections,
  previous?: string,
): string {
  const { preamble, sections: raw } = splitMarkdownSections(previous ?? "");
  const ticked = new Set(
    (parseDescription(previous ?? "").sections.criteria ?? [])
      .filter((criterion) => criterion.done)
      .map((criterion) => criterion.text),
  );
  const bodies = new Map<SectionField, Body>(
    SECTION_ORDER.map((field) => [field, bodyFor(field, sections, ticked)]),
  );
  const pieces: Piece[] = [];
  if (preamble.some((line) => line.trim() !== "")) {
    pieces.push({ field: null, lines: preamble, rendered: false });
  }
  const handled = new Set<SectionField>();
  for (const section of raw) {
    const spec = specForHeading(section.title);
    const body = spec === undefined ? KEEP : (bodies.get(spec.field) ?? KEEP);
    if (spec === undefined || body.action === "keep") {
      pieces.push({
        field: spec?.field ?? null,
        lines: section.lines,
        rendered: false,
      });
    } else if (!handled.has(spec.field) && body.action === "set") {
      pieces.push(renderedPiece(spec, body.lines));
    }
    if (spec !== undefined && body.action !== "keep") handled.add(spec.field);
  }
  for (const spec of SECTION_SPECS) {
    const body = bodies.get(spec.field);
    if (
      body === undefined ||
      body.action !== "set" ||
      handled.has(spec.field)
    ) {
      continue;
    }
    const rank = SECTION_ORDER.indexOf(spec.field);
    const rankOf = (piece: Piece): number =>
      piece.field === null ? -1 : SECTION_ORDER.indexOf(piece.field);
    let at = pieces.length;
    const before = pieces
      .map(rankOf)
      .reduce((last, r, i) => (r >= 0 && r < rank ? i : last), -1);
    if (before >= 0) at = before + 1;
    else {
      const after = pieces.findIndex((piece) => rankOf(piece) > rank);
      if (after >= 0) at = after;
    }
    pieces.splice(at, 0, renderedPiece(spec, body.lines));
  }
  const out: string[] = [];
  for (const piece of pieces) {
    const last = out[out.length - 1];
    if (piece.rendered && last !== undefined && last !== "") out.push("");
    out.push(...piece.lines);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Checks over sections
// ---------------------------------------------------------------------------

function isEmpty(value: string | readonly unknown[] | undefined): boolean {
  if (value === undefined) return true;
  return typeof value === "string" ? value.trim() === "" : value.length === 0;
}

/**
 * Names of the required (`goal`, `criteria`) and recommended (`files`,
 * `approach`, `depends_on`) fields that are empty. `depends_on` counts as
 * filled when it is an empty list, which renders `Nothing.`.
 */
export function missingSections(sections: TaskSections): string[] {
  const missing: string[] = [];
  if (isEmpty(sections.goal)) missing.push("goal");
  if (isEmpty(sections.criteria)) missing.push("criteria");
  if (isEmpty(sections.files)) missing.push("files");
  if (isEmpty(sections.approach)) missing.push("approach");
  if (sections.depends_on === undefined) missing.push("depends_on");
  return missing;
}

/** The standard the done checks read: goal, criteria text, rules, exceptions. */
export function toTaskDetails(sections: TaskSections): TaskDetails {
  const details: TaskDetails = {};
  if (sections.goal !== undefined && sections.goal.trim() !== "") {
    details.goal = sections.goal;
  }
  if (sections.criteria !== undefined) {
    details.criteria = sections.criteria.map((criterion) => criterion.text);
  }
  if (sections.rules !== undefined) details.rules = [...sections.rules];
  if (sections.exceptions !== undefined)
    details.exceptions = [...sections.exceptions];
  return details;
}
