// Finds the ledger project, session and claimed tasks a hook runs in, from
// the local store and its issue cache only (hooks never call Linear):
//
//   1. a session joined with the client's session id. When that id joined
//      several projects, the session whose project's repository identities
//      match the working directory wins; only when none match is it the
//      newest. Its project and its open claims;
//   2. else a project whose repository identities match the working
//      directory, best match first: the exact registered path; the origin
//      URL (`git@host:o/r.git`, `ssh://git@host/o/r` and `https://host/o/r`
//      compare equal; a relative origin is resolved against the checkout
//      first, and a relative registration matches nothing); a registered
//      directory the working directory is inside (the deepest first); then
//      the same place in another worktree of the same repository (a linked
//      worktree matches the checkout it belongs to, `pkgA` in one worktree
//      matches `pkgA` in another). A sibling directory never matches: a
//      project registered at /mono/pkgA is not found from /mono/pkgB or
//      /mono. Ties go to the newest project;
//   3. within the project step 2 found, a git branch whose name carries one
//      of its issue identifiers (Linear's branch names do, e.g.
//      `mike/ta-42-save-fatal`) makes that issue the claimed task. A branch
//      never selects a project on its own.
//
// Returns the snapshot the checks read: the plan's tasks, the policy and the
// claimed tasks with their standard.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  LocalStore,
  ProjectKey,
  ProjectRow,
  SessionRow,
  WorkRow,
} from "../local/types.js";
import { OPEN_WORK } from "../ledger/access.js";
import {
  localSnapshot,
  type Snapshot,
  type TaskView,
} from "../ledger/snapshot.js";

export interface LedgerContext {
  readonly projectId: ProjectKey;
  readonly project: ProjectRow;
  readonly session: SessionRow | undefined;
  readonly snapshot: Snapshot;
  /** This session's open claims. */
  readonly openWork: readonly WorkRow[];
  /** The tasks this session works on: its claims, or the branch's issue. */
  readonly claimed: readonly TaskView[];
  /** The project's sessions, which name who holds the other open claims. */
  readonly sessions: readonly SessionRow[];
}

function git(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 3_000,
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** A path, resolved and with symbolic links followed when it exists here. */
function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * One spelling of a repository identity: a remote as `remote:host/owner/repo`
 * (lower-case host, no user, port, `.git` or trailing slash), whichever of
 * the scp, ssh, git or http forms it was written in; a local path as its
 * canonical absolute path.
 */
export function normalizeIdentity(identity: string): string {
  const value = identity.trim();
  const remote = (host: string, path: string) =>
    `remote:${host.toLowerCase()}/${path
      .replace(/^\/+|\/+$/gu, "")
      .replace(/\.git$/u, "")
      .replace(/\/+$/u, "")}`;
  const url = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(value);
  if (url !== null && url[1]?.toLowerCase() !== "file") {
    try {
      const parsed = new URL(value);
      return remote(parsed.hostname, decodeURIComponent(parsed.pathname));
    } catch {
      return value;
    }
  }
  if (url !== null) {
    try {
      return canonicalPath(new URL(value).pathname);
    } catch {
      return value;
    }
  }
  const scp = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/\/)(.+)$/u.exec(value);
  if (scp !== null && !isAbsolute(value))
    return remote(scp[1] ?? "", scp[2] ?? "");
  return isAbsolute(value) ? canonicalPath(value) : value;
}

/** Where a directory sits in git: its checkout's top level and main worktree (the directory its common git directory belongs to). */
interface Checkout {
  readonly top: string;
  readonly main: string;
}

function checkoutOf(path: string): Checkout | undefined {
  const out = git(path, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
    "--show-toplevel",
  ]);
  const [common, top] = (out ?? "").split("\n");
  if (common === undefined || common === "" || top === undefined || top === "")
    return undefined;
  return {
    top: canonicalPath(top),
    main: canonicalPath(basename(common) === ".git" ? dirname(common) : common),
  };
}

/** A working directory as resolution reads it. */
interface Place {
  readonly path: string;
  readonly checkout: Checkout | undefined;
  /** The origin URL normalized; a relative one resolved against the checkout. */
  readonly origin: string | undefined;
}

function placeOf(cwd: string): Place {
  const path = canonicalPath(cwd);
  const checkout = checkoutOf(cwd);
  const url = git(cwd, ["config", "--get", "remote.origin.url"]);
  let origin: string | undefined;
  if (url !== undefined && url !== "") {
    const normalized = normalizeIdentity(url);
    origin =
      normalized.startsWith("remote:") || isAbsolute(normalized)
        ? normalized
        : canonicalPath(resolve(checkout?.top ?? path, url));
  }
  return { path, checkout, origin };
}

/** The identities a working directory may have been registered under, normalized. */
export function repositoryIdentities(cwd: string): string[] {
  const place = placeOf(cwd);
  const identities = new Set<string>([place.path]);
  if (place.checkout !== undefined) {
    identities.add(place.checkout.top);
    identities.add(place.checkout.main);
  }
  if (place.origin !== undefined) identities.add(place.origin);
  return [...identities];
}

/** Whether `path` is `parent` or inside it. */
function within(path: string, parent: string): boolean {
  return (
    path === parent ||
    path.startsWith(parent.endsWith(sep) ? parent : parent + sep)
  );
}

/**
 * How well one registered identity matches a place: 4 the exact path, 3 the
 * origin, 2 a directory the place is inside (deeper scores higher), 1 the
 * same place in another worktree of the repository, 0 no match.
 */
function matchScore(
  registered: string,
  place: Place,
  checkoutAt: (path: string) => Checkout | undefined,
): number {
  const identity = normalizeIdentity(registered);
  if (identity.startsWith("remote:")) return identity === place.origin ? 3 : 0;
  // A relative registration has no base to resolve against.
  if (!isAbsolute(identity)) return 0;
  if (identity === place.path) return 4;
  if (identity === place.origin) return 3;
  if (within(place.path, identity)) return 2 + identity.length / 1e6;
  const here = place.checkout;
  if (here === undefined) return 0;
  const there = checkoutAt(identity);
  if (there === undefined || there.main !== here.main) return 0;
  const offset = relative(there.top, identity);
  if (offset.startsWith("..")) return 0;
  return offset === "" || within(relative(here.top, place.path), offset)
    ? 1
    : 0;
}

/** The projects whose repository identities match a working directory, best match first, then newest. */
function projectsAt(store: LocalStore, cwd: string): ProjectRow[] {
  const place = placeOf(cwd);
  const checkouts = new Map<string, Checkout | undefined>();
  const checkoutAt = (path: string) => {
    if (!checkouts.has(path))
      checkouts.set(path, existsSync(path) ? checkoutOf(path) : undefined);
    return checkouts.get(path);
  };
  return store
    .allProjects()
    .map((project, order) => ({
      project,
      order,
      score: Math.max(
        0,
        ...project.repositories.map((registered) =>
          matchScore(registered, place, checkoutAt),
        ),
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .map((entry) => entry.project);
}

/** Issue identifiers a branch name carries, upper-cased (`mike/ta-42-x` gives TA-42). */
export function branchIdentifiers(branch: string): string[] {
  return [
    ...branch.matchAll(
      /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,9}-\d+)(?![0-9])/gu,
    ),
  ].map((match) => (match[1] ?? "").toUpperCase());
}

function contextFor(
  store: LocalStore,
  project: ProjectRow,
  session: SessionRow | undefined,
  branchIssue: string | undefined,
): LedgerContext {
  const snapshot = localSnapshot(store, project);
  const openWork =
    session === undefined
      ? []
      : store
          .workForSession(session.id)
          .filter((work) => OPEN_WORK.has(work.status));
  const claimedIds = new Set(openWork.map((work) => work.issueId));
  if (branchIssue !== undefined) claimedIds.add(branchIssue);
  return {
    projectId: project.key,
    project,
    session,
    snapshot,
    openWork,
    claimed: snapshot.tasks.filter((task) => claimedIds.has(task.issueId)),
    sessions: store.sessions(project.key),
  };
}

/**
 * The session a client's session id names. An id that joined several
 * projects resolves to its newest session in a project at this working
 * directory, else to its newest session anywhere.
 */
function sessionFor(
  store: LocalStore,
  externalSessionId: string,
  projects: readonly ProjectRow[],
): SessionRow | undefined {
  const newest = store.sessionByExternalId(externalSessionId);
  if (
    newest === undefined ||
    projects.length === 0 ||
    projects.some((project) => project.key === newest.projectKey)
  )
    return newest;
  const here = projects
    .flatMap((project) => store.sessions(project.key))
    .filter((session) => session.externalSessionId === externalSessionId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return here[0] ?? newest;
}

/** The ledger context of a hook, or undefined when the session is in no known project. */
export function resolveContext(
  store: LocalStore,
  hook: { readonly sessionId?: string; readonly cwd?: string },
): LedgerContext | undefined {
  const projects = hook.cwd === undefined ? [] : projectsAt(store, hook.cwd);
  if (hook.sessionId !== undefined) {
    const session = sessionFor(store, hook.sessionId, projects);
    const project =
      session === undefined ? undefined : store.project(session.projectKey);
    if (session !== undefined && project !== undefined)
      return contextFor(store, project, session, undefined);
  }
  if (hook.cwd === undefined) return undefined;
  const branch = git(hook.cwd, ["branch", "--show-current"]);
  if (branch !== undefined)
    for (const identifier of branchIdentifiers(branch))
      for (const project of projects) {
        const issue = store
          .cachedIssues(project.key)
          .find((entry) => entry.identifier.toUpperCase() === identifier);
        if (issue !== undefined)
          return contextFor(store, project, undefined, issue.id);
      }
  const project = projects[0];
  return project === undefined
    ? undefined
    : contextFor(store, project, undefined, undefined);
}
