# Agent instructions

The block below tells agents how to use vibecheck-linear-jev in a project. Add it to the instructions file your agents read for that project (for example `AGENTS.md` for Codex and Muse, or `CLAUDE.md` for Claude Code). Install the plugin, make a Linear API key available (`LINEAR_API_KEY`, `linear.apiKeyFile`, or your shell environment; check with `vibecheck-linear-jev linear doctor`), then give the agents the shared project ID and repository identity in the task context.

```markdown
## Shared work ledger on Linear (vibecheck-linear-jev)

Plan and track work through vibecheck-linear-jev. The plan is a Linear
project and each task is a Linear issue. Read Linear freely through any
Linear MCP server, but change task state (claims, status, blockers, done,
release, handoff) only through the vibecheck-linear-jev tools. Reports you
send are read by a judgment model against the issue's criteria, so write them
to be checked. Keep code, credentials, transcripts and large logs out.

- On your first turn, call project_join with the shared project ID,
  repository, your actual vendor/runtime session ID, model and effort. Use the
  client's own session ID; never invent one. Pass the parent's session_id when
  another agent launched you. Keep the returned session_id.
- If project_join returns adoption_required, ask the user the returned
  question word for word and call project_join again with a new request_id
  and adopt "as_is" or "managed", as the user answered. Never choose yourself.
- The coordinator owns the plan. plan_publish fills every field: project
  summary, overview, icon, color, priority, dates, label groups and labels,
  milestones, documents, links, and for each task a key, title, goal,
  checkable criteria, files, approach, dependencies, labels, priority and
  estimate, plus a policy (goal, rules, authorizations, accepted stop
  reasons). The first publish writes nothing to Linear until the plan is
  ready: when it returns ready: false, fix every listed problem (fill the
  empty fields, rewrite vague goals and criteria, split duplicate tasks) and
  send the request again, the same request_id is fine. Accept a problem by
  its id in accept only when it cannot be fixed, for example a field that
  truly has no value, or a judgment source that is unavailable. Later
  plan_edit calls apply directly; read their warnings (also posted to the
  affected Linear issues) and fix them with another plan_edit. Use
  issue_adopt to bring an existing issue into the plan under a key: keep the
  issue's own identifier or choose a plan key, and never re-key a task.
- In a managed project the first plan write returns a dry run with the same
  problems. Show it to the user and repeat with confirm: true only after they
  agree and the problems are fixed or accepted.
- Plan labels never start with vc: or agent:; those belong to vibecheck.
- Workers do not change the plan; report missing scope to the coordinator.
- Claim a task with work_claim before working on it, with the checkout,
  branch and paths you will touch. task_id is a plan key or an issue
  identifier. A conflict means another agent holds the task: do not claim it
  again.
- Report with work_update. A completion report says what was done against
  each criterion. If the result keeps the work in progress with a failed
  claims-done verification, the task is held: fix what the reason names and
  report done again. A blocker names the concrete cause. A release or handoff
  note says what is open, where it stands, what blocks it and the next step.
- Read project_status with your session_id at natural boundaries. Its next
  list says what to do now: your own attention items, your open claims, then
  the next task you could claim. Deal with attention first:
  held done reports, blockers that need the user, human_reply (a person wrote
  on your issue in Linear; answer it), reopened or removed issues, stalled or
  overlapping claims, unverified done tasks and missing standards.
- Use work_history for earlier work, comments and verdicts. Call plan_ack only
  after reviewing the complete map for that revision.
- Reuse request_id only to retry an identical request. Claims do not lock
  files or branches; verify outcomes in the repository.
```

The full request and result shapes are in [protocol.md](protocol.md).
