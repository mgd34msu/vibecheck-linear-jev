// Deterministic checks over code and commits. These match fixed syntax (a
// control-flow keyword outside comments and strings, a path prefix, a git
// commit's file list), not the meaning of prose.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Control flow and function bodies: what a data-only or text-only file holds little of. */
const CONTROL =
  /\b(if|else|for|while|switch|case|try|catch|throw|await)\b|=>\s*\{|function\s+\w+\s*\(|\breturn\b/u;

/** Comments and string contents hold words like "return" that are not control flow. */
export function withoutCommentsAndStrings(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(
      /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/gu,
      "''",
    )
    .replace(/\/\/.*$/gmu, "");
}

export interface ExceptionCheck {
  readonly file: string;
  readonly lines: number;
  readonly controlLines: number;
  /** A file defining a judgment battery may carry a few branches in its decision. */
  readonly battery: boolean;
  readonly dataOnly: boolean;
}

/** Whether a file recorded as data or text only really holds no logic. */
export function checkDataOnly(file: string, text: string): ExceptionCheck {
  const lines = withoutCommentsAndStrings(text)
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const battery = /defineBattery\(/u.test(lines.join("\n"));
  const controlLines = lines.filter((line) => CONTROL.test(line)).length;
  return {
    file,
    lines: lines.length,
    controlLines,
    battery,
    dataOnly: controlLines <= (battery ? 6 : 2),
  };
}

/** Checks each readable file under a checkout; unreadable paths are skipped. */
export function checkDataOnlyPaths(
  checkout: string | null,
  paths: readonly string[],
): ExceptionCheck[] {
  const results: ExceptionCheck[] = [];
  for (const path of paths) {
    const file =
      isAbsolute(path) || checkout === null ? path : join(checkout, path);
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    results.push(checkDataOnly(path, readFileSync(file, "utf8")));
  }
  return results;
}

export interface CommitInfo {
  readonly commit: string;
  readonly message: string;
  readonly files: readonly string[];
}

/** A commit's message and changed files, read from a local checkout; undefined when unreadable. */
export function readCommit(
  checkout: string | null,
  commit: string,
): CommitInfo | undefined {
  if (checkout === null || !isAbsolute(checkout) || !existsSync(checkout))
    return undefined;
  const run = (args: string[]) =>
    spawnSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
      timeout: 5_000,
    });
  const message = run(["show", "--no-patch", "--format=%B", commit]);
  const files = run(["show", "--name-only", "--format=", commit]);
  if (message.status !== 0 || files.status !== 0) return undefined;
  return {
    commit,
    message: message.stdout.trim(),
    files: files.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  };
}

/** Whether any changed file lies at or under one of the claimed paths. */
export function touchesPaths(
  files: readonly string[],
  paths: readonly string[],
): boolean {
  return files.some((file) =>
    paths.some(
      (path) =>
        file === path ||
        file.startsWith(path.endsWith("/") ? path : `${path}/`),
    ),
  );
}
