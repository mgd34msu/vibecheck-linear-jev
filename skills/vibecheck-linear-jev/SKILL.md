---
name: vibecheck-linear-jev
description: Use the vibecheck-linear-jev ledger to plan coding work as a Linear project, claim and report tasks on Linear issues, and read which reports were verified by the judgment checks. Applies when the user asks for vibecheck-linear-jev, Linear-backed work tracking, or verified status; it does not inspect repository contents or schedule agents.
---

# vibecheck-linear-jev

vibecheck-linear-jev is a work ledger on Linear whose reports are checked. The plan is a Linear project; each task is an issue whose description holds its goal, acceptance criteria (`Done when`), rules and accepted exceptions. You change task state through eleven MCP tools. A Jev-compatible judgment model reads what you report against the issue: a done report against its criteria, a blocker against the reasons the project accepts, a plan change against the work it replaces. Status shows each task as reported and as verified, and leads with what needs attention.

All tools take a nested `request` object. Store metadata, reports and references, not code, credentials, transcripts or large logs.

## Linear and these tools

Read Linear freely through any Linear MCP server or the Linear app: issues, comments, documents, projects. Change task state only through these tools: claims, status, blockers, completion, release and handoff. A claim made by editing an issue directly is invisible to other agents, and an issue you move to Done yourself gets a done re-check and is flagged when it has no passing report.

## 1. Join

On the first turn, call `project_join` with the project ID and repository identity supplied for the task, and your actual vendor, runtime, external session ID, model and effort. Use the client's own session ID; the hooks find your project by it. Never invent one. Pass the immediate parent's `session_id` as `parent_session_id` when you were launched by another agent. Keep the returned `session_id`.

To work in an existing Linear project, pass `linear_project` (its URL or ID). When the result has `adoption_required: true`, stop and ask the user the returned `question` word for word. Then call `project_join` again with a new `request_id` and `adopt: "as_is"` (vibecheck changes nothing in the project except its comments, its `vc:*` and `agent:*` labels and the states of issues agents claim) or `adopt: "managed"` (vibecheck may fill gaps after showing a dry run). Never choose for the user.

## 2. Plan or adopt

Only the coordinator (the first session, or one that took over with `take_over_from`) publishes or edits the plan. Workers use existing tasks and report missing scope to the coordinator.

`plan_publish` creates the whole project. Fill every field you have content for: the project's summary (one line, at most 255 characters), overview, icon, color, priority, status, dates; label groups (each task gets one label from each group) and labels; milestones; documents for long material; links; and for every task a `key` (such as `EXPORT-CSV-1`), title, goal, checkable criteria, files, approach, dependencies, labels, priority and estimate. Give the plan a `policy`: the goal, the rules every brief must pass on, the actions agents may take without asking, and the accepted reasons for stopping. The first publish writes nothing to Linear until the plan is ready: it returns `ready: false` with `problems` (each with a stable `id`: empty fields, vague goals or criteria, duplicate tasks, coverage gaps, or a judgment source that did not answer). Iterate: fix each problem in the plan and send the request again (the same `request_id` works). Accept a problem by naming its id in `accept` only when it cannot be fixed; unknown ids are refused. Once every problem is fixed or accepted the publish writes and says `ready: true`. Later `plan_edit` calls apply directly; their `warnings` come back in the result and are posted to the affected Linear issues, so fix them with another `plan_edit`. Never give a label or group a name starting with `vc:` or `agent:`.

In a managed project the first `plan_publish` or `plan_edit` returns `dry_run: true` with every change and the same `problems`; `confirm: true` writes only once they are fixed or accepted. Show it to the user, then repeat the request with `confirm: true` and a new `request_id`. Values that are already set are listed in `skipped` and kept; to replace one, the user must agree and you name it in `overwrite`.

To use issues that already exist, call `issue_adopt` with the issue and a plan key (or the issue's own identifier; another issue's identifier is refused, and an issue already in the plan keeps its key); it reports which sections are missing. In an as-is project tasks are the existing issues, addressed by identifier.

## 3. Claim

Claim a task with `work_claim` before working on it, with the checkout, branch and paths you will touch. `task_id` is a plan key or an issue identifier (`TA-42`). A `conflict` means another agent holds it: pick other work or ask the coordinator. Do not claim it again.

## 4. Report

Report with `work_update` at blockers, handoffs, completion and integration:

- `status: "complete"` with a `report` that says what was done against each criterion. The report is checked. When the result shows the work still `in_progress` and a `failed` claims-done verification, the task is held: fix what the reason names, then report done again. A done update without a report stays unverified.
- `status: "blocked"` with a concrete `blocker`.
- `action: "release"` or `action: "handoff"` with a report saying what is open, where it stands, what blocks it and the next step.

When `sync.pending` is above zero, Linear was unreachable and the writes are queued; they are sent on the next call.

A completion, release or handoff that could not finish in Linear returns its error (often `unavailable`) with `details.completion: "pending"`. It is recorded with its verdict and finishes on the next call; to finish it now, repeat the same request with the same `request_id`. Do not report it again with new text. When the error says `claim_lost`, `task_removed`, `skipped_move` or `reopened`, the completion was abandoned and the work is not complete: stop on a lost claim, and after a `skipped_move` or `reopened` check the issue in Linear before reporting done again with a new `request_id`. A `completion_waiting` attention item names a completion Linear kept rejecting: repeat `work_update` with the `request_id` it names and the same change.

## 5. Read status

Call `project_status` with your `session_id` at natural boundaries. It leads with `next`, a short ordered list of what to do now: `attention` items about your own work, then your open `claim`s with their status, then the `available` task to claim next (unclaimed, its dependencies complete, in milestone order), each with a `do` saying the action. Work through it in that order; when it says `none_available`, ask the coordinator for work. Deal with `attention` first: `held_done` reports, blockers that need the user, `human_reply` (a person wrote on a claimed issue in Linear: read and answer it), `reopened` and `removed` issues, `claim_lost` (another machine or a person closed or deleted your claim comment: stop working on that task), `held_done_moved` (a person moved a task you were held on to done), stalled or overlapping claims, `unverified_done`, other flags, and `missing_standard` tasks with no criteria. Each task shows its reported `status` and, once a done check ran, `verified` (`verified`, `held`, `unverified`).

Use `work_history` for earlier work, the issue's comments and each verdict. Use `full: true` for every task, `include_map: true` for the task map, `plan_read` for a past revision, and `plan_ack` after reviewing a revision. `project_update` posts a Linear project update drafted from verified status.

Reuse a `request_id` only to retry an identical request.

## What the hooks check

When the plugin's hooks are on, they also check your own turns against the cached plan and your claimed issues: a brief to a subagent is read for narrowing your claimed task and for carrying the project's rules (naming another task's work as someone else's is fine; dropping a criterion of your own task is not); a shell delete through an unguarded variable is refused; and a stopping reply is read for deferred work, an unanswered question, asking permission for something already authorized, claiming done while your claims show work left, and facts the session's tool output does not show (recommendations, plans, questions, conditionals and statements you mark as unverified are not read as facts). A blocking verdict is also posted as a comment on your claimed issue. When a hook blocks, do what its reason says. When no judgment source answers, the hooks let the work go ahead and say so.
