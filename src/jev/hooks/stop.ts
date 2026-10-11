// Stop hook: sends the agent back to work when its final reply puts required
// work off, skips the user's question, asks permission for something already
// authorized, claims done while its open claims show work left, or states as
// fact what the session's tool output does not show (read one prose
// sentence at a time, code blocks left out, against the session's tool
// output: the newest results of the last few turns first, then evidence
// about the claimed files, then older output, bounded; at most
// MAX_GROUNDED_SENTENCES sentences, the reply's last ones always among them).
//
// The whole hook runs on one budget: no reading of any kind starts after
// READING_START_BUDGET_MS from the hook's start, and the hook answers by
// STOP_BUDGET_MS whatever is still running, failing open with a note on
// stderr, so it ends before the client kills it (45 seconds).
//
// The standard comes from the local store (this session's open claims, the
// issues as cached from Linear, and the project's authorizations); without a
// ledger project the user's recent messages stand in. A reply that confirms a pause the user asked for is not
// checked. Blocks per user message are capped, counted from this session's
// own Stop verdicts in ledger history, so a reading that keeps disagreeing cannot hold the turn open forever.
// Blocking verdicts are queued to Linear through the outbox as comments on
// the claimed issue; a rejected done claim also queues `vc:held` (by name).

import { z } from "zod";
import { SqliteLocalStore } from "../../local/store.js";
import {
  asksPermissionBattery,
  claimGroundedBattery,
  claimsDoneBattery,
  deferralBattery,
  questionAnsweredBattery,
  userPausesBattery,
} from "../batteries.js";
import { entryFor } from "../entries.js";
import { isJudgment, runCheck, type Judgment } from "../judgment.js";
import { settleMany } from "../lib/index.js";
import { resolveContext, type LedgerContext } from "../project.js";
import { authorizationsText, exceptionsText, taskText } from "../standard.js";
import {
  joinEvidence,
  recentRequests,
  replySentences,
  type TranscriptView,
} from "../transcript.js";
import type { NewEntry, Subject } from "../../verification/store.js";
import {
  allow,
  blockStop,
  failOpen,
  hookComment,
  parsePayload,
  readHookTranscript,
  recordEntries,
  stopPayloadSchema,
  translateAntigravityStop,
  type HookDeps,
  type HookResult,
} from "./io.js";

/** Blocks allowed per user message. */
export const MAX_BLOCKS = 2;

/**
 * Prose sentences of one reply read for claim-grounded. With 16 readings at
 * once this is two rounds. A longer reply is read from its start and its
 * last GROUNDED_TAIL_SENTENCES sentences (where the final claim sits); the
 * sentences between are named as unread.
 */
export const MAX_GROUNDED_SENTENCES = 32;
export const GROUNDED_TAIL_SENTENCES = 4;

/**
 * No reading of any kind starts this long after the hook started; readings
 * not started are named in the stderr note and the reply goes unchecked on
 * them.
 */
export const READING_START_BUDGET_MS = 30_000;

/**
 * The hook answers by this long after it started, failing open if readings
 * are still running: inside the clients' 45-second hook timeout.
 */
export const STOP_BUDGET_MS = 40_000;

const blockCountSchema = z.object({ blocks: z.number() });

/** Stop blocks this session got for one user message, counted in the query so other sessions' verdicts never crowd them out. */
function blocksSoFar(
  store: SqliteLocalStore,
  sessionId: string,
  userMessage: number,
): number {
  const rows = store.verificationAccess().queryRows(
    blockCountSchema,
    `SELECT COUNT(DISTINCT created_at) AS blocks FROM verifications
     WHERE source = 'hook:stop' AND kind = 'verdict'
       AND json_extract(body, '$.external_session_id') = ?
       AND json_extract(body, '$.evidence.line') = ?
       AND json_extract(body, '$.outcome') = 'flagged'`,
    [sessionId, userMessage],
  );
  return rows[0]?.blocks ?? 0;
}

/** The sentences claim-grounded reads: all of them, or the first ones and the last GROUNDED_TAIL_SENTENCES. */
export function groundedSentences(all: readonly string[]): string[] {
  if (all.length <= MAX_GROUNDED_SENTENCES) return [...all];
  return [
    ...all.slice(0, MAX_GROUNDED_SENTENCES - GROUNDED_TAIL_SENTENCES),
    ...all.slice(-GROUNDED_TAIL_SENTENCES),
  ];
}

/** The hook's reading budget: when it started and its limits. */
interface Budget {
  readonly started: number;
  readonly now: () => number;
  readonly startMs: number;
  readonly totalMs: number;
}

/** A reading, or an unavailable result when the budget no longer lets one start. */
async function budgeted<R>(
  budget: Budget,
  run: () => Promise<R>,
): Promise<R | { readonly kind: "unavailable"; readonly error: string }> {
  if (budget.now() - budget.started > budget.startMs)
    return {
      kind: "unavailable",
      error: `not started; no reading starts ${budget.startMs / 1000} seconds into the hook`,
    };
  return run();
}

function claimedText(context: LedgerContext | undefined): {
  text: string | undefined;
  paths: string[];
} {
  if (context === undefined || context.claimed.length === 0)
    return { text: undefined, paths: [] };
  const parts = context.claimed.map((task) => taskText(task));
  const paths = context.openWork.flatMap((work) => [...work.location.paths]);
  return { text: parts.join("\n\n"), paths };
}

export async function stopHook(
  stdin: string,
  deps: HookDeps,
): Promise<HookResult> {
  const now = deps.now ?? Date.now;
  const budget: Budget = {
    started: now(),
    now,
    startMs: deps.stopBudget?.startMs ?? READING_START_BUDGET_MS,
    totalMs: deps.stopBudget?.totalMs ?? STOP_BUDGET_MS,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<HookResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve(
          failOpen(
            deps.client,
            "Stop",
            `the Stop checks ran past their ${budget.totalMs / 1000}-second budget; the reply was not checked`,
          ),
        ),
      budget.totalMs,
    );
  });
  try {
    return await Promise.race([stopWork(stdin, deps, budget), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopWork(
  stdin: string,
  deps: HookDeps,
  budget: Budget,
): Promise<HookResult> {
  const payload =
    deps.client === "antigravity"
      ? translateAntigravityStop(stdin)
      : parsePayload(stopPayloadSchema, stdin);
  if (typeof payload === "string")
    return failOpen(deps.client, "Stop", payload);
  const view: TranscriptView | undefined = readHookTranscript(deps, payload);
  const latest = view?.userMessages.at(-1);
  const reply = view?.lastReply ?? payload.last_assistant_message ?? undefined;
  if (latest === undefined || reply === undefined || reply.trim().length === 0)
    return allow(deps.client, "Stop");
  const userMessages = view?.userMessages ?? [];
  const sessionKey =
    payload.session_id ?? payload.child_session_id ?? "unknown";
  const store = new SqliteLocalStore(deps.databasePath);
  let blocks: number;
  let context: LedgerContext | undefined;
  try {
    blocks = blocksSoFar(store, sessionKey, userMessages.length);
    context = resolveContext(store, {
      ...(sessionKey === "unknown" ? {} : { sessionId: sessionKey }),
      ...(payload.cwd === undefined ? {} : { cwd: payload.cwd }),
    });
  } finally {
    store.close();
  }
  if (blocks >= MAX_BLOCKS) return allow(deps.client, "Stop");

  const judgment = deps.judgment();
  if (!isJudgment(judgment))
    return failOpen(
      deps.client,
      "Stop",
      `no judgment source is usable (${judgment.unusable.map((skip) => `${skip.sourceId}: ${skip.reason}`).join("; ")}); the reply was not checked`,
    );
  return checkReply(deps, judgment, context, budget, {
    sessionKey,
    latest,
    reply,
    finalText: view?.finalText,
    trigger: view?.trigger ?? "user",
    userMessages,
    evidence: view?.evidence ?? [],
    transcriptRef:
      typeof payload.transcript_path === "string"
        ? payload.transcript_path
        : deps.client === "muse" || deps.client === "antigravity"
          ? sessionKey
          : "last_assistant_message",
  });
}

const blockedSchema = z.looseObject({
  decision: z.string(),
  reason: z.string(),
});

/**
 * The SessionEnd hook: the stop checks run and the verdicts land in the
 * ledger, but the session is ending so a block becomes an advisory note.
 */
export async function sessionEndHook(
  stdin: string,
  deps: HookDeps,
): Promise<HookResult> {
  const result = await stopHook(stdin, deps);
  if (result.stdout === undefined) return result;
  let decision: unknown;
  try {
    decision = JSON.parse(result.stdout);
  } catch {
    return result;
  }
  const blocked = blockedSchema.safeParse(decision);
  if (!blocked.success || blocked.data.decision !== "block") return result;
  const notes = result.stderr ?? "";
  return {
    exitCode: 0,
    stderr: `${blocked.data.reason} Recorded in the ledger; the session is ending, so the reply was not held.\n${notes}`,
  };
}

interface ReplyInput {
  readonly sessionKey: string;
  readonly latest: string;
  readonly reply: string;
  readonly finalText: string | undefined;
  readonly trigger: "user" | "notification";
  readonly userMessages: readonly string[];
  readonly evidence: readonly string[];
  readonly transcriptRef: string;
}

async function checkReply(
  deps: HookDeps,
  judgment: Judgment,
  context: LedgerContext | undefined,
  budget: Budget,
  input: ReplyInput,
): Promise<HookResult> {
  const entries: { subject: Subject; entry: NewEntry }[] = [];
  const unavailable: string[] = [];
  const subject: Subject = {
    projectId: context?.projectId ?? null,
    sessionId: context?.session?.id ?? null,
    ...(context?.claimed.length === 1 && context.claimed[0] !== undefined
      ? {
          taskId: context.claimed[0].key,
          ...(context.openWork.length === 1 && context.openWork[0] !== undefined
            ? { workId: context.openWork[0].id }
            : {}),
        }
      : {}),
  };
  const base = {
    source: "hook:stop",
    gate: false,
    evidence: {
      kind: "reply",
      ref: input.transcriptRef,
      excerpt: input.reply.slice(0, 500),
      line: input.userMessages.length,
    },
    externalSessionId: input.sessionKey,
  };

  const pause = await budgeted(budget, () =>
    runCheck(judgment, userPausesBattery, { userMessage: input.latest }),
  );
  if (pause.kind === "verdict" && pause.run.decision.pausing) {
    const entry = entryFor(
      userPausesBattery,
      { userMessage: input.latest },
      pause,
      {
        ...base,
        reason: () => "the user asked for a pause; the reply was not checked",
      },
    );
    await recordEntries(
      deps.databasePath,
      entry === undefined ? [] : [{ subject, entry }],
    );
    return allow(deps.client, "Stop");
  }

  const requests = recentRequests(input.userMessages);
  const claimed = claimedText(context);
  const standard =
    claimed.text === undefined
      ? requests
      : `${claimed.text}\n\nThe user's recent messages:\n${requests}`;
  const recorded = authorizationsText(context?.snapshot.policy);
  const authorized = `${recorded ?? "No authorizations are recorded in the ledger."}\nThe user asked for the following in this conversation, which authorizes doing it:\n${requests}`;
  const evidence = joinEvidence(input.evidence, claimed.paths);
  const allSentences = replySentences(input.reply);
  const sentences = groundedSentences(allSentences);
  const exceptions =
    context === undefined
      ? undefined
      : exceptionsText(context.claimed.map((task) => task.details));

  const deferralInput = { standard, message: input.reply };
  const asksInput = { authorized, reply: input.reply };
  const claimsInput =
    claimed.text === undefined
      ? undefined
      : {
          task: claimed.text,
          ...(exceptions === undefined ? {} : { exceptions }),
          report: input.reply,
        };
  const [deferral, asks, claims, question, grounded] = await Promise.all([
    budgeted(budget, () => runCheck(judgment, deferralBattery, deferralInput)),
    budgeted(budget, () =>
      runCheck(judgment, asksPermissionBattery, asksInput),
    ),
    claimsInput === undefined
      ? undefined
      : budgeted(budget, () =>
          runCheck(judgment, claimsDoneBattery, claimsInput),
        ),
    input.trigger === "user" ? answered(judgment, budget, input) : undefined,
    settleMany(
      sentences,
      async (sentence) =>
        budget.now() - budget.started > budget.startMs
          ? undefined
          : runCheck(judgment, claimGroundedBattery, {
              reply: sentence,
              evidence,
            }),
      16,
    ),
  ]);

  const reasons: string[] = [];
  const add = (entry: NewEntry | undefined) => {
    if (entry !== undefined) entries.push({ subject, entry });
  };
  add(
    entryFor(deferralBattery, deferralInput, deferral, {
      ...base,
      reason: (d) => `defers ${d.defers.toFixed(2)}`,
    }),
  );
  if (deferral.kind === "unavailable")
    unavailable.push(`deferral: ${deferral.error}`);
  if (deferral.kind === "verdict" && deferral.run.decision.block)
    reasons.push(
      `the reply puts required work off to a later time (defers ${deferral.run.decision.defers.toFixed(2)}); do the work now instead of promising it`,
    );

  add(
    entryFor(asksPermissionBattery, asksInput, asks, {
      ...base,
      reason: (d) => `asks ${d.asks.toFixed(2)}`,
    }),
  );
  if (asks.kind === "unavailable")
    unavailable.push(`asks-permission: ${asks.error}`);
  if (asks.kind === "verdict" && asks.run.decision.block)
    reasons.push(
      `the reply asks the user to approve something already authorized (asks ${asks.run.decision.asks.toFixed(2)}); do it instead of offering it`,
    );

  if (claims !== undefined && claimsInput !== undefined) {
    add(
      entryFor(claimsDoneBattery, claimsInput, claims, {
        ...base,
        reason: (d) => `overclaims ${d.overclaims.toFixed(2)}`,
      }),
    );
    if (claims.kind === "unavailable")
      unavailable.push(`claims-done: ${claims.error}`);
    if (claims.kind === "verdict" && claims.run.decision.block)
      reasons.push(
        `the reply presents the claimed task as done while it shows work left (overclaims ${claims.run.decision.overclaims.toFixed(2)}); finish it or say plainly what remains`,
      );
  }

  if (question !== undefined) {
    add(
      entryFor(questionAnsweredBattery, question.input, question.result, {
        ...base,
        reason: (d) =>
          `asks ${d.asks.toFixed(2)}, answered ${d.answered.toFixed(2)}`,
      }),
    );
    if (question.result.kind === "unavailable")
      unavailable.push(`question-answered: ${question.result.error}`);
    if (
      question.result.kind === "verdict" &&
      question.result.run.decision.block
    )
      reasons.push(
        `the user asked a question the reply does not answer up front (asks ${question.result.run.decision.asks.toFixed(2)}, answered ${question.result.run.decision.answered.toFixed(2)}); answer it first`,
      );
  }

  const ungrounded: string[] = [];
  let unread = allSentences.length - sentences.length;
  grounded.forEach((settled, index) => {
    const sentence = sentences[index] ?? "";
    if (!settled.ok) {
      unavailable.push(`claim-grounded: ${String(settled.error)}`);
      return;
    }
    if (settled.value === undefined) {
      unread += 1;
      return;
    }
    add(
      entryFor(
        claimGroundedBattery,
        { reply: sentence, evidence },
        settled.value,
        { ...base, reason: (d) => `ungrounded ${d.ungrounded.toFixed(2)}` },
      ),
    );
    if (settled.value.kind === "unavailable")
      unavailable.push(`claim-grounded: ${settled.value.error}`);
    if (settled.value.kind === "verdict" && settled.value.run.decision.block)
      ungrounded.push(
        `"${sentence}" (${settled.value.run.decision.ungrounded.toFixed(2)})`,
      );
  });
  if (ungrounded.length > 0)
    reasons.push(
      `the reply states as fact what the tool output does not show: ${ungrounded.join(", ")}; verify each with a command or say it is unverified`,
    );

  // A reply claiming the claimed task done while it shows work left holds
  // the issue open in Linear too, as a failed done report does.
  const target = reasons.length > 0 ? hookComment(context) : undefined;
  const heldDone = claims?.kind === "verdict" && claims.run.decision.block;
  const recordError = await recordEntries(
    deps.databasePath,
    entries,
    target === undefined || !heldDone
      ? target
      : { ...target, labels: ["vc:held"] },
  );
  const notes = [
    ...[...new Set(unavailable)].map(
      (note) => `reading unavailable, not checked: ${note}`,
    ),
    ...(unread === 0
      ? []
      : [
          `claim-grounded read ${allSentences.length - unread} of ${allSentences.length} sentences; the rest were not checked (at most ${MAX_GROUNDED_SENTENCES}, the first and the last ${GROUNDED_TAIL_SENTENCES}, none started ${budget.startMs / 1000} seconds into the hook)`,
        ]),
    ...(recordError === undefined ? [] : [recordError]),
  ];
  if (reasons.length > 0) {
    const result = blockStop(
      deps.client,
      `vibecheck-linear-jev: ${reasons.join("; ")}.`,
    );
    return notes.length === 0
      ? result
      : { ...result, stderr: `vibecheck-linear-jev: ${notes.join("; ")}\n` };
  }
  if (unavailable.length > 0)
    return failOpen(deps.client, "Stop", notes.join("; "));
  const result = allow(deps.client, "Stop");
  return notes.length === 0
    ? result
    : { ...result, stderr: `vibecheck-linear-jev: ${notes.join("; ")}\n` };
}

/** A turn that states a lookup, runs it, then answers is answering: the whole reply and the text after the last tool result are both read, and either answering is enough. */
async function answered(judgment: Judgment, budget: Budget, input: ReplyInput) {
  const whole = { userMessage: input.latest, reply: input.reply };
  const first = await budgeted(budget, () =>
    runCheck(judgment, questionAnsweredBattery, whole),
  );
  if (
    first.kind !== "verdict" ||
    !first.run.decision.block ||
    input.finalText === undefined ||
    input.finalText === input.reply
  )
    return { input: whole, result: first };
  const final = { userMessage: input.latest, reply: input.finalText };
  return {
    input: final,
    result: await budgeted(budget, () =>
      runCheck(judgment, questionAnsweredBattery, final),
    ),
  };
}
