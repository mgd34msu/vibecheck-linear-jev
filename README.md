# vibecheck-linear-jev

vibecheck-linear-jev is a work ledger for Claude Code, Codex, Muse, and Antigravity agents. The record lives in Linear: the plan is a Linear project, each task is a Linear issue, and claims, reports and verdicts are issue comments and labels. Agents change task state through eleven MCP tools. A Jev-compatible judgment model then reads what they report against what was asked: a "done" report against the issue's goal and acceptance criteria, a blocker against the reasons the project accepts, a plan change against the work it replaces. Project status shows every task as reported and as verified, and leads with what needs attention.

The plugin is an MCP server, a skill that teaches agents to use it, and hooks that check the agent's own turns: briefs it sends to subagents, shell deletes it runs, and the reply it stops on.

Version 0.1.0. It runs on Bun 1.3.14 or later only, natively on Linux, macOS and Windows. Windows has not been tested yet.

It is derived from [vibecheck-jev](https://github.com/mgd34msu/vibecheck-jev), whose ledger was a local SQLite database. Here that database is replaced by Linear. Tool names and request shapes changed, and databases made by vibecheck or vibecheck-jev are not read or imported.

## Contents

- [Install](#install)
- [Connect to Linear](#connect-to-linear)
- [Choose a judgment source](#choose-a-judgment-source)
- [Use an open Jev model](#use-an-open-jev-model)
- [The config file](#the-config-file)
- [Publish a plan](#publish-a-plan)
- [Work in an existing Linear project](#work-in-an-existing-linear-project)
- [How work shows up in Linear](#how-work-shows-up-in-linear)
- [What each check does](#what-each-check-does)
- [Read verified status](#read-verified-status)
- [Calibrate](#calibrate)
- [Commands](#commands)
- [Data and the local store](#data-and-the-local-store)
- [Share the server over HTTP](#share-the-server-over-http)
- [Tools](#tools)
- [Build from source](#build-from-source)

## Install

You need Bun 1.3.14 or later on your `PATH`. Every MCP server entry and hook runs `bun <plugin folder>/runtime/vibecheck-linear-jev.mjs` directly, with no shell script in between. There is no Node.js path. The Codex hook file has separate `commandWindows` entries, but nothing has been run on Windows yet, so treat Windows as untested.

Install from GitHub, pinned to the release tag.

For Claude Code:

```bash
claude plugin marketplace add mgd34msu/vibecheck-linear-jev@v0.1.0
claude plugin install vibecheck-linear-jev@vibecheck-linear-jev
```

For Codex:

```bash
codex plugin marketplace add mgd34msu/vibecheck-linear-jev --ref v0.1.0
codex plugin add vibecheck-linear-jev@vibecheck-linear-jev
```

For Muse:

```bash
muse plugins marketplace add vibecheck-linear-jev https://github.com/mgd34msu/vibecheck-linear-jev
muse plugins install vibecheck-linear-jev@vibecheck-linear-jev
muse plugins approve vibecheck-linear-jev
```

For Antigravity, clone the repository and install its platform folder, which copies only that harness's files:

```bash
git clone --branch v0.1.0 https://github.com/mgd34msu/vibecheck-linear-jev.git
agy plugin install vibecheck-linear-jev/platforms/antigravity
```

To install from a local checkout instead, give `claude plugin marketplace add` or `codex plugin marketplace add` the checkout path in place of `mgd34msu/vibecheck-linear-jev`. Muse refuses directories that contain symlinks, such as a checkout with `node_modules`: install it from an extracted `artifacts/vibecheck-linear-jev-muse-plugin-0.1.0.zip` (made by `bun run build:release`) with `muse plugins install <directory>`, then `muse plugins approve vibecheck-linear-jev`.

Claude Code and Antigravity installs hold only their own `platforms/` folder, never the other harnesses' configs. Codex and Muse install the whole tree: Muse derives its install through the Codex marketplace catalog, so that catalog must keep pointing at the root. The folders are assembled by `build:release` from the shared sources; edit the sources, not the folders.

Reload the session after installing. The plugin registers the `vibecheck-linear-jev` MCP server, a skill, and hooks that check subagent briefs, shell deletes, and stopping replies. Codex and Muse ask you to review and trust plugin hooks before they run. Plugin startup installs nothing and writes nothing inside the plugin folder.

All four clients use the same config file and the same local store, so agents in Claude Code, Codex, Muse, and Antigravity on the same machine share one ledger view of the Linear project.

### First run

1. Install the plugin in your client.
2. Make a Linear API key available and check it: [Connect to Linear](#connect-to-linear).
3. Make a judgment source available, by default `TYPESAFE_API_KEY` for hosted Jev: [Choose a judgment source](#choose-a-judgment-source). Without one the ledger still works, but nothing is verified.
4. Add the block in [docs/agent-usage.md](docs/agent-usage.md) to the instructions file your agents read (for example `AGENTS.md` or `CLAUDE.md`), and give the agents a shared project ID and the repository identity in the task context.
5. The first agent calls `project_join` and becomes the coordinator. It publishes the plan ([Publish a plan](#publish-a-plan)) or, for a project that already exists in Linear, asks you how to treat it ([Work in an existing Linear project](#work-in-an-existing-linear-project)).

## Connect to Linear

The server writes to Linear with your own personal API key. There is no Linear app and no OAuth: every comment, label and state change appears under your Linear user, and each agent marks itself with an `agent:<vendor>` label and a footer line on its comments. The Linear MCP plugin is not used either; you can still read Linear through it or the Linear app.

### Get a personal API key

In Linear, open your account settings, find the section for API keys (under security and access) and create a personal API key. The tool writes projects, project documents, milestones, issues, issue labels, relations, comments and project updates, so the key needs write access to all of those. Linear's settings menus change over time, and this README does not know which permission options your workspace offers. Do not commit the key or put it in the config file.

### Where the tool looks for it

In order, on the first call that needs Linear:

1. The environment variable `LINEAR_API_KEY`, or the variable named by `linear.apiKeyEnv` in the config.
2. The file named by `linear.apiKeyFile`, which holds only the key. The tool prints a warning on stderr if other users can read it; run `chmod 600` on it.
3. Your interactive shell's environment, read with `$SHELL -ic` (bash when `SHELL` is unset) for at most 5 seconds. This recovers a variable you export in your shell's rc files when a harness starts the plugin without it. It is not done on Windows, so on Windows use the environment or a key file.

If none of these gives a key, the calls that need Linear fail with `unavailable` and the message lists what was tried. The key's value is never printed. Hosted Jev's key is found the same way: the variable (`TYPESAFE_API_KEY`, or `auth.apiKeyEnv`), then the source's `auth.apiKeyFile`, then the interactive shell read for that variable name. Key values are never printed.

Check the setup:

```bash
vibecheck-linear-jev linear doctor
```

It prints where the key came from, the Linear user and workspace it authenticates as, the team, the workflow states the tool will use, and the rate-limit headroom, and exits 1 on any failure. From a checkout, use `bun src/cli.ts linear doctor`; from an installed plugin, `bun <plugin folder>/runtime/vibecheck-linear-jev.mjs linear doctor`. `linear doctor` also accepts a team key as its argument when the config names none.

### Choose the team

Each project belongs to one Linear team. The tool uses, in order: the `team` field of `project_join`, `linear.team` in the config (a team key such as `TA`), or the only team the key can see. When the key sees several teams and none is named, `project_join` fails with `invalid` and lists the team keys. Set `linear.team` once and agents do not have to pass it.

### Workflow states

The tool maps its task statuses onto the team's workflow states by state type and position. `linear doctor` shows what it picked. Override any of them by state name in the config under `linear.states`.

| Task status            | Linear                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pending`              | A state of type triage, backlog or unstarted                                                                                                                 |
| `in_progress`          | The first started state by position (`linear.states.inProgress` overrides)                                                                                   |
| `blocked`              | Stays in the started state, plus the label `vc:blocked`                                                                                                      |
| `awaiting_integration` | The started state named by `linear.states.review`, else the first started state whose name contains "review"; with none, the label `vc:awaiting-integration` |
| `complete`             | The first completed state by position (`linear.states.done` overrides)                                                                                       |
| `cancelled`            | The first canceled state (`linear.states.canceled` overrides); Linear's Duplicate state also counts as canceled                                              |

## Choose a judgment source

Every check needs a judgment source: a model that answers the System One wire API (`POST /v1/systemone`) that TypeSafe's Jev defined. vibecheck-linear-jev works with four kinds:

- **An open Jev-compatible server** you run yourself, such as the Jev-Style adapter.
- **Laya**, an open-source Jev-compatible model, served locally by `vibecheck-linear-jev laya serve`.
- **Jev-Style**, an open decision model, served by the optional adapter in `adapters/jev-style`.
- **Hosted Jev** from TypeSafe, which needs an API key.

The three open kinds run on your own machine, cost nothing per reading and keep your transcripts local. [Use an open Jev model](#use-an-open-jev-model) summarizes them, and [docs/open-models.md](docs/open-models.md) walks through getting, running and connecting each one.

With no configuration, vibecheck-linear-jev uses hosted Jev with the key in `TYPESAFE_API_KEY`. Without any usable source, nothing breaks: the ledger records work as reported, like a plain ledger, and the hooks let work go ahead and print why on stderr.

### Hosted Jev

Jev is TypeSafe's hosted model and the one the built-in thresholds were set on. TypeSafe runs it in early access and lists its price as $42 per billion input tokens at the time of writing. Sign in at [console.typesafe.ai](https://console.typesafe.ai/) and follow [docs.typesafe.ai](https://docs.typesafe.ai/) to get an API key, then set it in the environment the client starts from:

```bash
export TYPESAFE_API_KEY="your key"
```

or name another variable in the config with `"auth": { "apiKeyEnv": "MY_KEY_VARIABLE" }`, or keep the key in a file (`chmod 600`) with `"auth": { "apiKeyFile": "~/.config/typesafe/key" }`. The lookup order is the variable, the file, then your interactive shell's environment. Check it with `vibecheck-linear-jev sources --source typesafe`.

### Several sources

List sources in the order they should be tried. When a source is unreachable, rate limited or times out, the next one answers the same reading, and the verdict records which source answered and which were skipped. An authentication failure or a rejected request stops there instead of moving on, since the next source would hide a misconfiguration. A reading larger than a source's input limits skips that source, and the skip is recorded.

## Use an open Jev model

An open Jev model runs on your own machine instead of TypeSafe's hosted service. It costs nothing per reading and keeps your transcripts local. Each one answers the same questions as hosted Jev, so vibecheck-linear-jev treats them all the same way once they are running.

| Model                                           | Runs on                                         | Reads at most        | Best for                                                                        |
| ----------------------------------------------- | ----------------------------------------------- | -------------------- | ------------------------------------------------------------------------------- |
| [Laya](docs/open-models.md#laya)                | CPU, about 2 GB of RAM                          | 512 tokens of state  | The short checks; vibecheck-linear-jev installs and serves it with two commands |
| [Jev-Style](docs/open-models.md#jev-style)      | CPU or GPU, through Python (torch) or llama.cpp | 25,600 tokens        | The checks that read long evidence, on a modest machine                         |
| [OpenJev](docs/open-models.md#openjev-github30) | A GPU running an instruct model you choose      | Depends on the model | Using a model you already have                                                  |

### Where to get the models

vibecheck-linear-jev has been tested with these four models. [docs/open-models.md](docs/open-models.md) covers setting up each one:

| Model                    | Where to get it                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Jev (hosted by TypeSafe) | Sign in at [console.typesafe.ai](https://console.typesafe.ai/) and follow [docs.typesafe.ai](https://docs.typesafe.ai/) to create an API key. Nothing to download                                                                                                                                                                                                                          |
| Laya                     | [huggingface.co/receptron/laya-onnx](https://huggingface.co/receptron/laya-onnx). `vibecheck-linear-jev laya install` installs its runtime, and `vibecheck-linear-jev laya serve` downloads these weights (about 1.7 GB) on first start                                                                                                                                                    |
| Jev-Style                | [huggingface.co/chaoliangUNSW/Jev-Style-0.8B-Decision-v3](https://huggingface.co/chaoliangUNSW/Jev-Style-0.8B-Decision-v3), or the GGUF build at [huggingface.co/chaoliangUNSW/Jev-Style-0.8B-Decision-v3-GGUF](https://huggingface.co/chaoliangUNSW/Jev-Style-0.8B-Decision-v3-GGUF). Download with `hf download` and serve it through [adapters/jev-style](adapters/jev-style/README.md) |
| OpenJev with Qwen        | Server: [github.com/GitHub30/OpenJev](https://github.com/GitHub30/OpenJev). Model: [huggingface.co/Qwen/Qwen2.5-1.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct), which the server downloads when it starts                                                                                                                                                               |

Other Jev-compatible models can work too: any server that answers the System One wire API (`POST /v1/systemone`) connects as an `openjev` source, as the Jev-Style adapter does. Only these four have been tested, so measure any other model with `vibecheck-linear-jev measure fixtures --source <id>` before relying on it.

The checks' thresholds were set on hosted Jev, and open models often read the same examples a little higher or lower. So after starting one, add it to `sources`, confirm it answers with `vibecheck-linear-jev sources --source <id>`, and run `vibecheck-linear-jev measure fixtures --source <id>` to see which checks need their own threshold for it or should go to another source.

[docs/open-models.md](docs/open-models.md) covers every step for each model: what it needs, how to download, install and start it, the exact config entry, server keys, what to expect from it, and a config that combines several models with hosted Jev as the fallback.

## The config file

The config file is `$XDG_CONFIG_HOME/vibecheck-linear-jev/config.jsonc`, or `~/.config/vibecheck-linear-jev/config.jsonc` when `XDG_CONFIG_HOME` is unset. Set `VIBECHECK_LINEAR_JEV_CONFIG` to use another path. `vibecheck-linear-jev config path` prints the path in use.

The file is created on the first run of the MCP server, a hook or any command, with every option present at its default and a comment above each one. It is never overwritten. `vibecheck-linear-jev config init --force` rewrites it from the template after saving the old file next to it with a timestamped `.bak` suffix, and `vibecheck-linear-jev config check` validates it. The format is JSON with `//` and `/* */` comments and trailing commas allowed.

If the file has an error, the message names the file, the key and what was expected, for example:

```
/home/you/.config/vibecheck-linear-jev/config.jsonc: checks.vibecheck.deferral.thresholds.blockAt: expected a probability from 0 to 1
```

With a broken config, the hooks let work go ahead and print that message, and the MCP server runs with ledger checks off until it is fixed.

The file has six top-level keys.

| Key       | Type                         | Default                                   | What it controls                                              |
| --------- | ---------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| `sources` | array of sources             | hosted Jev only                           | Judgment sources, tried in order                              |
| `checks`  | object, check id to settings | every check on at its built-in thresholds | Each check's switch, thresholds and routing                   |
| `ledger`  | object                       | `{ "verify": true }`                      | Whether the ledger checks what is reported to it              |
| `hooks`   | object                       | every hook on, 40-second deadlines        | The three hooks                                               |
| `data`    | object                       | `null` folder and database                | Where the local store and the Laya install live               |
| `linear`  | object                       | see below                                 | Team, where the API key comes from, state names, re-check cap |

### sources

Each source has a `kind`, an `id` you choose (used in routing and per-source thresholds), and the fields for its kind.

| Field                    | Kinds             | Type                                  | Default                                                      | Meaning                                                                                                                        |
| ------------------------ | ----------------- | ------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `kind`                   | all               | `"typesafe"`, `"openjev"` or `"laya"` | required                                                     | Which kind of source                                                                                                           |
| `id`                     | all               | letters, digits, `.`, `_`, `-`        | required                                                     | Unique name for the source                                                                                                     |
| `baseURL`                | typesafe, openjev | URL                                   | `https://api.typesafe.ai` for typesafe; required for openjev | Server root; the client posts to `/v1/systemone`                                                                               |
| `model`                  | all               | text                                  | `jev-latest` (typesafe), required (openjev), `laya` (laya)   | Model name sent with each reading                                                                                              |
| `auth.apiKey`            | typesafe, openjev | text                                  | none                                                         | Key sent as a bearer token. Prefer `apiKeyEnv` or `apiKeyFile` so keys stay out of the config                                  |
| `auth.apiKeyEnv`         | typesafe, openjev | variable name                         | `TYPESAFE_API_KEY` for typesafe                              | Environment variable holding the key                                                                                           |
| `auth.apiKeyFile`        | typesafe, openjev | path                                  | none                                                         | File holding only the key (`chmod 600`); read when the variable is unset, before the interactive shell read                    |
| `auth.headers`           | typesafe, openjev | object of text                        | none                                                         | Extra request headers, for servers that authenticate another way                                                               |
| `timeoutMs`              | all               | positive integer                      | 25000; 60000 for laya                                        | How long one attempt may take before the next source is tried                                                                  |
| `limits.maxStateTokens`  | all               | positive integer                      | none; 512 for laya                                           | Readings with a larger state skip this source                                                                                  |
| `limits.maxOptionTokens` | all               | positive integer                      | none; 192 for laya                                           | Readings with a longer choice option skip this source                                                                          |
| `limits.maxOptions`      | all               | positive integer                      | none; 20 for laya                                            | Readings with more choice options skip this source                                                                             |
| `host`, `port`           | laya              | text, 1 to 65535                      | `127.0.0.1`, `8723`                                          | Where `laya serve` listens                                                                                                     |
| `autostart`              | laya              | boolean                               | `false`                                                      | Start `laya serve` in the background when a hook or the ledger finds it not running                                            |
| `load`                   | laya              | object                                | none                                                         | Laya load options: `modelDir`, `repo`, `subfolder`, `revision`, `cacheDir`, `token`, `executionProviders`, `intraOpNumThreads` |

Token counts for limits are estimated at three characters per token, which errs toward skipping.

Example with a local server first and hosted Jev as the fallback:

```jsonc
"sources": [
  { "kind": "openjev", "id": "jev-style", "baseURL": "http://127.0.0.1:8766", "model": "jev-style" },
  { "kind": "typesafe", "id": "typesafe" }
]
```

### checks

`checks` maps a check id to its settings. Every check is listed in the generated file.

| Field              | Type                               | Default                     | Meaning                                                                                            |
| ------------------ | ---------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------- |
| `enabled`          | boolean                            | `true`                      | `false` turns the check off everywhere: the ledger and the hooks skip it and record nothing for it |
| `thresholds`       | object, name to number from 0 to 1 | the check's built-in values | Replaces the named thresholds for every source                                                     |
| `sources`          | array of source ids, or `null`     | `null`                      | The sources that answer this check, in order. `null` means every source in the `sources` order     |
| `sourceThresholds` | object, source id to thresholds    | none                        | Threshold values that apply only when that source answers, over `thresholds`                       |

Example: send the short checks to Laya and the evidence-heavy ones to hosted Jev, turn off the stall check, and make claims-done stricter only on Laya:

```jsonc
"checks": {
  "vibecheck.question-answered": { "sources": ["laya", "typesafe"] },
  "vibecheck.claim-grounded": { "sources": ["typesafe"] },
  "vibecheck.stalled": { "enabled": false },
  "vibecheck.claims-done": { "sourceThresholds": { "laya": { "blockAt": 0.5 } } }
}
```

Every threshold is a probability between 0 and 1. Each check compares a model reading against its thresholds. For a threshold that a reading must reach to block or flag (most are named `blockAt` or `flagAt`), raising it makes the check stricter about when to act, so it blocks less; lowering it makes it act on weaker readings, so it blocks more. The table in [what each check does](#what-each-check-does) says which direction each threshold moves.

For example, `"vibecheck.deferral": { "thresholds": { "blockAt": 0.75 } }` stops the Stop hook from blocking replies that only lean toward putting work off; only replies the model reads as clearly deferring (0.75 or more) are sent back.

### ledger

| Field    | Type    | Default | Meaning                                                                                                    |
| -------- | ------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `verify` | boolean | `true`  | `false` makes the ledger record work as reported, with no readings and no verification fields in responses |

### hooks

| Field               | Type              | Default | Meaning                                                                               |
| ------------------- | ----------------- | ------- | ------------------------------------------------------------------------------------- |
| `briefCheck`        | boolean           | `true`  | The brief check on subagent launches and messages                                     |
| `bashGuard`         | boolean           | `true`  | The delete guard on shell commands                                                    |
| `stop`              | boolean           | `true`  | The Stop checks on the agent's final reply                                            |
| `briefCheckSeconds` | number, up to 600 | `40`    | How long the brief check waits for its readings before letting the tool call go ahead |
| `stopSeconds`       | number, up to 600 | `40`    | How long the Stop checks wait before letting the turn end                             |

The clients stop a hook at 45 seconds (10 for the delete guard), so keep the deadlines below that. The Stop hook runs on one budget taken from `stopSeconds`: no reading of any kind (user-pauses, deferral, asks-permission, claims-done, question-answered, claim-grounded) starts after three quarters of it (30 seconds by default), and the hook answers by `stopSeconds` whatever is still running. A reading that did not start, or a hook that ran out of time, lets the turn end with a note on stderr naming what went unchecked. The Stop hook blocks a reply at most twice per user message; it counts only its own session's earlier blocks.

A hook finds its ledger project from the local store: first the session the client's session id joined, else the project registered for the working directory. The best match wins: the exact registered path, then the origin URL (scp, ssh and https spellings of one remote compare equal; a relative origin such as `../upstream` is resolved against the checkout first, and a relative registration matches nothing), then a registered directory the working directory is inside, then the same place in another worktree of the same repository. A sibling directory never matches: in a monorepo, a project registered at `/mono/pkgA` is not found from `/mono/pkgB` or from `/mono`. Ties go to the newest project.

### data

| Field      | Type           | Default                                                                                 | Meaning                                                      |
| ---------- | -------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `folder`   | path or `null` | `null`: `$XDG_DATA_HOME/vibecheck-linear-jev`, or `~/.local/share/vibecheck-linear-jev` | Where the local store and the Laya install live              |
| `database` | path or `null` | `null`: `state.sqlite3` in the data folder                                              | The local store file. `VIBECHECK_LINEAR_JEV_DB` overrides it |

### linear

| Field                   | Type                  | Default          | Meaning                                                                                                                                                       |
| ----------------------- | --------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `team`                  | team key or `null`    | `null`           | The Linear team, for example `"TA"`. `null` means the only team the key can see; with several, `project_join` asks for one                                    |
| `apiKeyEnv`             | variable name         | `LINEAR_API_KEY` | The environment variable that holds the Linear key                                                                                                            |
| `apiKeyFile`            | path or `null`        | `null`           | A file holding only the key (`chmod 600`). Read when the variable is unset                                                                                    |
| `states.inProgress`     | state name or `null`  | `null`           | The state a claimed task moves to. `null`: the first started state                                                                                            |
| `states.review`         | state name or `null`  | `null`           | The state for work awaiting integration. `null`: the first started state whose name contains "review"; with none, the label `vc:awaiting-integration` is used |
| `states.done`           | state name or `null`  | `null`           | The state for verified completion. `null`: the first completed state                                                                                          |
| `states.canceled`       | state name or `null`  | `null`           | The state for cancelled tasks. `null`: the first canceled state                                                                                               |
| `reconcile.maxRechecks` | integer from 0 to 100 | `10`             | The most done re-checks one reconciler run performs on issues people moved to done in Linear; the rest wait for the next run                                  |

The generated file lists all of these with `null` or the default. The key lookup order is under [Connect to Linear](#connect-to-linear).

## Publish a plan

The first session to join a project key is the coordinator. It publishes the plan with `plan_publish` (and changes it later with `plan_edit`). Workers claim existing tasks and report missing scope to the coordinator. A plan request is checked completely before the first write, so a request that fails validation writes nothing to Linear.

`plan_publish` creates the whole Linear project from one request. The level of detail it is meant to carry is that of a large, well-kept project: a full overview, long documents, coded milestones, label groups, and issues whose descriptions say what to change, where, how, and when it is done. The result's `completeness` lists every fillable field left empty, so the coordinator fills the gaps with `plan_edit`.

### What it fills in

| Linear object              | What the tool writes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project                    | `name` (up to 80 characters), `icon` (a known Linear icon name from `src/linear/icons.ts` or a `:shortcode:`), `color` (`#rrggbb`), the one-line `summary` as Linear's description (up to 255 characters), the `overview` as the project content (markdown, up to 200,000 characters), `priority` (0 none, 1 urgent to 4 low), `status` (`backlog`, `planned`, `started`), start and target dates with their resolution (`month`, `quarter`, `halfYear`, `year`), project labels, and the team. Lead and member are set to the key's user |
| Resources                  | External links (`label`, `url`): repository, docs, design files                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Documents                  | The plan's long material (architecture, rules, sizing, audits), each with `title`, `icon`, `color` and `content`. The overview should link to them. `vibecheck policy` and `vibecheck plan` are reserved titles                                                                                                                                                                                                                                                                                                                           |
| Milestones                 | One per phase, named `<code> · <name>`. The code defaults to `M1`, `M2`, ... by position, or the plan gives its own (`U · Unified architecture migration`). Each takes a `description` (what is in it and where it comes from) and a `target_date`                                                                                                                                                                                                                                                                                        |
| Label groups               | Single-select groups such as a kind, an area and a risk or size class. Each issue gets exactly one label from every declared group. Linear permits one label per single-select group, and multi-select groups are a workspace setting that may be off, so the tool always declares single-select ones                                                                                                                                                                                                                                     |
| Labels                     | Ungrouped labels for anything that can apply several at once (scope, platform, release). An existing label with the same name, on the team or the workspace, is reused and never duplicated                                                                                                                                                                                                                                                                                                                                               |
| Issues                     | One per task, titled `<KEY>: <title>` (for example `SAVE-FATAL-5: Save request identity exhausted ends the run loop`), with the description sections below, `priority`, `estimate`, labels, milestone, parent issue, due date, assignee (the key's user) and state backlog (canceled for a task with `status: "cancelled"`)                                                                                                                                                                                                               |
| Relations                  | A `blocks` relation from each dependency to its dependent, written beside the `Depends on` section so Linear can show what is blocked, and a `related` relation for each `supersedes`. Removing a dependency from the plan removes its `blocks` relation                                                                                                                                                                                                                                                                                  |
| Documents (policy and map) | `vibecheck policy` (icon `Shield`) holds the goal, rules, authorizations and accepted reasons for stopping. `vibecheck plan` (icon `Page`) lists the tasks by milestone, then a `Machine map` JSON block that lets a second machine rebuild the key-to-issue map                                                                                                                                                                                                                                                                          |
| Project update             | An optional update posted with the plan, with `health` (`onTrack`, `atRisk`, `offTrack`) and a body. Later updates are drafted from verified status by `project_update`                                                                                                                                                                                                                                                                                                                                                                   |

### Issue sections

The tool owns these H2 headings in an issue description, in this order. Text before the first heading and under any other heading is kept exactly as written whenever the tool rewrites a description, and a ticked `Done when` box stays ticked while its text is unchanged.

| Heading                       | Plan field           | Content                                                      |
| ----------------------------- | -------------------- | ------------------------------------------------------------ |
| `What it is`                  | `goal`               | What the task is and why                                     |
| `Report`                      | `report`             | The user's or owner's report, for bug-type tasks             |
| `Original behaviour`          | `original_behaviour` | For bug-type tasks: how it used to behave                    |
| `Root cause`                  | `root_cause`         | For bug-type tasks: the cause found                          |
| `Evidence`                    | `evidence`           | For bug-type tasks: what shows it                            |
| `Files, lines and call sites` | `files`              | Bullets, paths in code spans                                 |
| `Approach`                    | `approach`           | How to do it                                                 |
| `Depends on`                  | `depends_on`         | `* TA-12 · <title>` bullets, or `Nothing.`                   |
| `Done when`                   | `criteria`           | A `- [ ]` checklist: the acceptance criteria the checks read |
| `Rules`                       | `rules`              | Bullets: rules this task must follow                         |
| `Accepted exceptions`         | `exceptions`         | `* <description> (paths: \`a\`; data only)`                  |
| `Out of scope`                | `out_of_scope`       | Bullets                                                      |

Parsing also reads the headings people commonly write (`Goal`, `Acceptance criteria`, `Done criteria`, `Dependencies`, `Files`, `Files and lines`, `Owner report`, `Original-source behaviour`, `Root cause(s) found`, `Fix`, `Fix / approach`, `Non-goals`), in any case, as H2 or H3, with or without a trailing colon. This is how issues someone else wrote are read.

### A task and a policy

Each task can carry the standard the checks read:

```json
{
  "key": "CSV-EXPORT-1",
  "title": "CSV export for the reports page",
  "goal": "Users can download the report table as CSV",
  "criteria": [
    "every visible column is exported",
    "the file opens in a spreadsheet"
  ],
  "rules": ["keep the export under 2 seconds for 10,000 rows"],
  "files": ["`src/reports/export.ts`"],
  "approach": "Stream rows through the existing table query.",
  "depends_on": ["REPORTS-PAGE-1"],
  "exceptions": [
    {
      "description": "generated bindings need no tests",
      "paths": ["src/reports/generated.ts"],
      "data_only": true
    }
  ],
  "milestone": "M1",
  "labels": ["Feature", "Reports"],
  "priority": 2,
  "estimate": 3
}
```

and the plan can carry a project policy:

```json
"policy": {
  "goal": "Ship the reports page with CSV and PDF export",
  "rules": ["every schema change is a new migration in db/migrations/"],
  "authorizations": ["edit any file in the repository", "run the test suite and local migrations"],
  "stop_reasons": ["files under vendor/ are third-party and never edited"]
}
```

Anyone may edit the policy document and the issue descriptions in Linear. The checks read the current text, which the reconciler refreshes.

### What is checked at publish time

Before the first write: icons, colors, summary length, dates; unique task keys, milestone codes and names, label names, document titles and link URLs; every `depends_on`, `parent` and `supersedes` resolves; dependencies and parents have no cycles; each task's milestone is declared; each task has exactly one label from every declared group; a claimed task cannot be cancelled; and tasks of the previous revision cannot be dropped (cancel them instead).

After it, the model-read and code checks run over the change: brief-scope, task-duplicate, plan-coverage against the policy goal, and `plan-detail`, which flags a missing or very short goal, missing criteria, and vague wording such as "handle errors", "works properly", "as needed", "etc." and "TBD". Rewrite whatever it flags: a vague criterion gives the done check nothing to judge against.

Republishing writes only what the plan changed since its previous revision, so edits people made in Linear to other fields survive. Every created object carries a client-generated ID derived from the project and the object, so a publish retried after a failure finds what the first attempt created. Plan revisions are kept in the local store; `plan_read` reads one or compares two, and `plan_ack` records that a session reviewed a revision. Full request fields are in [docs/protocol.md](docs/protocol.md).

## Work in an existing Linear project

An agent can join a project that already exists in Linear by passing `linear_project` (its URL, slug ID or UUID) to `project_join`. A project the tool created itself carries the `vibecheck plan` document and is linked directly. For any other project the tool first needs your answer, because it does not know how much it may change.

`project_join` without `adopt` writes nothing. It returns `adoption_required: true`, a summary of the project as found (issue count, which description sections it could read, how many issues have criteria, labels, milestones, documents) and this question for the agent to put to you word for word:

> May vibecheck update this Linear project to its own format?

MCP elicitation is not implemented; the question always goes through this two-call `adoption_required` path. The agent asks you and calls `project_join` again with `adopt: "as_is"` or `adopt: "managed"`. It must not choose for you. Until you answer, the project is `pending` and every write is refused. The answer is stored on the local project row; for a managed project it is also recorded in a line above the sections of the `vibecheck policy` document. A later `project_join` with the other answer switches modes. Switching to managed starts with a dry run again; switching back stops further format edits and leaves what was already written.

### As is: use the project untouched

| The tool may                                                                                    | The tool never                                                                                             |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Post claim, report and verdict comments on issues agents claim                                  | Edit project fields, titles, descriptions, milestones, documents, existing labels or relations             |
| Create its own `vc:*` and `agent:*` labels in the workspace and add them to issues agents claim | Assign issues                                                                                              |
| Move the state of issues agents claim, finish or release                                        | Run `plan_publish`, `plan_edit` or `project_update` (refused as `forbidden`, with `details.mode: "as_is"`) |
| Read the project, its issues, comments and linked pull requests                                 | Write a description section; `issue_adopt` parses an issue and writes nothing                              |

Tasks are the existing issues, addressed by their identifiers (`TA-42`). The standard each check reads comes from whatever the description holds, through the heading aliases above. An issue with no readable `Done when` criteria is judged on its description as a whole, and status marks it `missing_standard`. The policy comes from the project overview when it has `Goal` and `Rules` sections; otherwise there is none.

The label and state writes are controlled by a source constant, `AS_IS_WRITES_LABELS_AND_STATES` in `src/ledger/access.ts` (true). It is not a config key.

### Managed: let the tool fill gaps

The first `plan_publish` or `plan_edit` after adoption returns a dry run (`dry_run: true`) listing every change per object, with old and new values, and writes nothing. The agent shows it to you; repeating the same request with `confirm: true` applies it. Later plan writes apply directly.

| The tool may                                                                                                                                                                                   | The tool never                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Fill empty project fields (icon, color, summary, dates, priority) and empty issue fields (priority, estimate, due date)                                                                        | Delete or archive anything                                                                                                               |
| Add description sections that are missing, keeping every existing line, heading and checkbox                                                                                                   | Rename issues, milestones, labels or documents (existing issue titles also stay as they are; those issues use their identifiers as keys) |
| Add `blocks` relations, including for identifiers already written under `Depends on`                                                                                                           | Overwrite a value that is already set                                                                                                    |
| Add milestones, labels and issues; add the `vibecheck policy` and `vibecheck plan` documents                                                                                                   | Change an issue's team or project, or remove a label or relation someone else set                                                        |
| Replace a set value only when the request names it in `overwrite` (for example `project.icon` or `tasks.TA-42.title`), or when the tool itself wrote the current value and the plan changed it | Move an issue's state except through claims                                                                                              |

Values that kept their old value are listed in the result's `skipped`. Managed mode keeps existing issue titles through `MANAGED_PREFIXES_EXISTING_TITLES` (false) in `src/ledger/access.ts`, also not a config key. `issue_adopt` brings one existing issue into the plan under a key and lists its missing sections.

## How work shows up in Linear

Agents change task state only through the tools, and Linear shows the result. People may read, comment and edit in Linear at any time.

### Claims

`work_claim` runs the claim protocol: one open claim per issue on this machine, decided in one SQLite transaction; then it reads the issue's comments and refuses if an open claim for other work exists. Otherwise it writes a claim comment, adds `vc:claimed` and the session's `agent:<vendor>` label, moves the issue to the in-progress state if it is not started, and assigns the key's user when the issue is unassigned (not in as-is mode). Two agents that claim at once on different machines are separated by Linear's server time: it re-reads the comments, and the earliest open claim comment (by `createdAt`, then comment ID) wins. The loser's comment becomes `released (lost claim race)`, its work is marked `conflict`, and the call returns `conflict` naming the winner. Claims do not lock checkouts or branches and do not prove an agent is still working.

### Labels

All of these are ungrouped workspace labels, created when first applied.

| Label                         | Color                | Meaning                                                                                                                                                    |
| ----------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vc:claimed`                  | `#5e6ad2`            | At least one claim comment is open. Removed when the last one closes                                                                                       |
| `vc:blocked`                  | `#e5484d`            | The claimed work reported a blocker                                                                                                                        |
| `vc:held`                     | `#f76b15`            | A done report failed a done check; the issue stays open                                                                                                    |
| `vc:verified`                 | `#30a46c`            | The done checks passed                                                                                                                                     |
| `vc:unverified`               | `#ffc53d`            | Completed without a passing verdict: no source answered, the outcome was `review`, checks were off, or the done re-check of an issue a person moved failed |
| `vc:awaiting-integration`     | `#0090ff`            | Work waiting to be integrated, on a team with no review state                                                                                              |
| `vc:stalled`, `vc:needs-user` | `#8e4ec6`, `#e93d82` | Defined, but nothing in 0.1.0 adds them; stalled claims and blockers that need the user appear in the status attention list                                |
| `agent:<vendor>`              | `#6e56cf`            | The agent that claimed the issue, for example `agent:claude-code` or `agent:codex`. Not grouped                                                            |

### Comments

Every comment the tool writes ends with the footer `— vibecheck · <vendor> · <model> · session <id>`. The tool finds its own comments by the footer and its claims by the claim line, never by author, because every writer uses your key.

| Comment | Form                                                                                                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claim   | `**Claimed** by <vendor> (<model>)`, then `vibecheck claim · work <id> · <status>`, where status is `open`, `released`, `handed off to work <id>`, `complete`, `cancelled` or `released (lost claim race)`. Release, handoff, completion and cancellation edit the status word |
| Report  | `**Progress**`, `**Blocked**`, `**Done**`, `**Released**` or `**Handoff**`, then the report text                                                                                                                                                                               |
| Verdict | `**vibecheck: <check> <outcome>**`, then the reason. Posted for `failed`, `flagged` and `review` outcomes, and once as `verified` when claims-done passes                                                                                                                      |

### Held and verified done

`work_update` to `complete` runs the done checks first (claims-done, done-admits-unfinished, commit-paths, exception-check, parent-rollup, commit-honesty). claims-done lets a report through when it openly says the task is not finished, because the Stop hook must pass an honest unfinished reply; on a completion, marking the task complete is itself the claim, so done-admits-unfinished reads the same report and holds the task when the report says part of it is not done, failing, skipped, deferred or abandoned. A completion verifies only when claims-done passes and done-admits-unfinished does not block; an unavailable reading of either leaves it unverified.

- Held: a done check failed. The issue and the work stay open and in progress, `vc:held` is added, and a verdict comment gives the reason. The agent fixes what the reason names and reports done again.
- Verified: the issue moves to the done state, `vc:verified` is added, `vc:held`, `vc:blocked` and `vc:awaiting-integration` are removed, the claim comment says `complete`, and `vc:claimed` goes if no other claim is open. If a reading was unavailable or the outcome was `review`, `vc:unverified` is added instead of `vc:verified`.

Completion, release and handoff are recorded plans: before the first Linear write the tool records the decision the checks reached and the ordered Linear steps. A failure part-way (Linear unreachable, a write refused) leaves the plan pending; the call returns the error with `completion: "pending"`, and the same plan, with the same decision, finishes on the next call, in `sync`, or when the request is repeated with the same `request_id`. Each step checks Linear first: when the claim was lost, the issue left the project, or a person moved the issue since the tool read it, the plan is abandoned and the issue is not moved; a completion whose move was skipped is not complete and keeps its claim.

### The reconciler and human replies

The reconciler runs at the start of `project_status` and `work_update`, and in `sync`. It reads the project's issues updated since its last pass, refreshes the local cache and the policy, and for each changed issue:

- An issue newly seen in a completed state with no passing done verdict gets a done re-check: claims-done and done-admits-unfinished read the issue's current standard and its latest report comment. A failed or unreadable re-check adds `vc:unverified` (removing `vc:verified`), posts a verdict comment and puts `unverified_done` in the attention list; only a re-check where both pass adds `vc:verified`. An issue a person moved to done while this machine's work held its done report is not verified: it gets `vc:unverified` and attention `held_done_moved`. In an as-is project, issues no agent claimed get no labels or comments: the result goes to the attention list only. The tool never moves an issue a person moved. At most `linear.reconcile.maxRechecks` re-checks run per call and the rest are counted in `sync.pending_rechecks`. The first sync of a project queues none.
- An issue that left a completed state is reported as `reopened`.
- An issue archived, deleted or moved out of the project while claimed has its work marked abandoned and is reported as `removed`.
- A claim comment another machine or a person closed, or deleted, releases its work here and is reported as `claim_lost`; later updates of that work are refused.
- A comment from a person on a claimed issue, after the tool's last comment, is reported as `human_reply` with the comment text, so the agent sees what people wrote. Comments do not change an issue's update time, so the reconciler reads the comments of every issue with an open claim directly. The agent's next report on the issue clears it.

There is no revert mode: edits people make in Linear are theirs to make, and the checks read the issue's current text.

### GitHub data

The tool never talks to GitHub. It reads pull requests only as Linear's GitHub integration exposes them: PRs linked to an issue appear as issue attachments, and the tool reads their branch, number, draft state, merged and closed times and merge conflicts. claims-done uses that as evidence next to the report (merged, closed without merging, open as a draft, has conflicts). CI check results are not used yet: Linear's API did not give a personal key a way to reach them when this was checked. The commit-paths check reads a recorded commit from a local checkout with `git show`.

### When Linear is unreachable

Hooks never call Linear. They write verdicts to the local store and queue verdict comments on the one issue the session has claimed. A tool whose Linear write fails because Linear is unreachable, failing or rate limited queues that write and the rest of the call's writes, and the result carries `sync: {pending: n}`. A completion, release or handoff is not queued: its recorded plan stays pending (`sync.pending_completions`) and resumes on the next call. Queued writes are sent at the start of every tool call and by `vibecheck-linear-jev sync`, oldest first, stopping at the first rate-limit, network, server or authentication failure. A queued create carries its client ID, so a resend after a crash cannot duplicate it.

## What each check does

Checks run in two places. The **ledger** reads what agents report through the tools, and issues people move to done in Linear. The **hooks** read the agent's own turns. When a reading cannot be taken because no source answers, the ledger applies the change as reported and records the reading as unavailable, and a hook lets the work go ahead with a message on stderr.

A check with a gate keeps a task open or blocks the agent. A flag is recorded and shown in status without stopping anything.

| Check                              | Reads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Runs                                                                                                                                                   | Effect                                                                       | Thresholds and what raising them does                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vibecheck.claims-done`            | A done report against the task's goal, acceptance criteria, accepted exceptions and the code checks' results, with linked pull requests as extra evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `work_update` to complete; the reconciler's re-check of issues moved to done in Linear; the Stop hook when the session has open claims; `check report` | Gate: the task stays open with the reason                                    | `blockAt` 0.6: raise to hold fewer reports (only clear overclaims)                                                                                           |
| `vibecheck.done-admits-unfinished` | A done report against the task's goal, acceptance criteria and accepted exceptions, for the report itself saying part of the task is not done, not working, failing, skipped, deferred or abandoned. Fixed failures, accepted exceptions, errors in other workers' files and optional ideas outside the criteria do not count                                                                                                                                                                                                                                                                                                                       | `work_update` to complete, beside claims-done                                                                                                          | Gate: the task stays open with the reason                                    | `blockAt` 0.6: raise to hold fewer completions (only clear admissions)                                                                                       |
| `vibecheck.brief-scope`            | A brief or plan change against this session's claimed tasks and their exceptions, plus every unclaimed plan task with its criteria (a coordinator may hand those out); the plan's unheld tasks when it claims none. The tasks other sessions or machines hold (an open claim here names its agent and session; `vc:claimed` or a started issue in the local cache with no claim here marks a claim elsewhere) and what the task records as out of scope are read as other work: a brief that names them as someone else's is not narrowing; one that drops a criterion of its own task is                                                           | Brief hook; `plan_publish` and `plan_edit`; `check brief`                                                                                              | Gate in the hook (the brief is refused); flag on plan changes                | `blockAt` 0.6: raise to refuse fewer briefs                                                                                                                  |
| `vibecheck.brief-carries-rules`    | A new subagent's brief against the project's and task's rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Brief hook on launches                                                                                                                                 | Gate                                                                         | `governedAt` 0.55: raise to act only when a rule clearly governs the work. `carriesAt` 0.5: raise to demand the rules be stated more plainly (more refusals) |
| `vibecheck.deferral`               | A reply or report for work put off to later                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Stop hook; blocked and released updates; `check message`                                                                                               | Gate in the hook; flag in the ledger                                         | `blockAt` 0.6: raise to block fewer replies                                                                                                                  |
| `vibecheck.question-answered`      | Whether the user asked a question and the reply answers it up front                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Stop hook                                                                                                                                              | Gate                                                                         | `asksAt` 0.6: raise to count fewer messages as questions. `answeredAt` 0.5: raise to demand more direct answers (more blocks)                                |
| `vibecheck.asks-permission`        | A reply asking to approve something the recorded authorizations or the user's own request already allow                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Stop hook                                                                                                                                              | Gate                                                                         | `blockAt` 0.6: raise to block fewer replies                                                                                                                  |
| `vibecheck.claim-grounded`         | Each prose sentence of a reply (fenced and indented code blocks are left out) against the session's tool output, up to 60,000 characters: first the newest tool result of each of the last four turns and the final turn's other newest results (at most six, 5,000 characters each, tail kept), then output about the claimed files, then older output newest first. Recommendations, proposals, plans, questions and requests, hypotheticals, conditionals, statements marked unverified and "still running" statements are exempt. At most 32 sentences are read, the reply's last four always among them, none started 30 seconds into the hook | Stop hook                                                                                                                                              | Gate, naming the sentence                                                    | `blockAt` 0.6: raise to block fewer sentences. `planAt` 0.5: raise to exempt fewer sentences (more blocks)                                                   |
| `vibecheck.user-pauses`            | Whether the user asked the agent to pause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Stop hook, before the others                                                                                                                           | A pause skips the other Stop checks                                          | `pausingAt` 0.6: raise to recognize fewer pauses (more replies checked)                                                                                      |
| `vibecheck.stop-reason`            | A reason for leaving work: accepted by the project, an external block, or an excuse                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Blocked and released updates; `check report`                                                                                                           | Flag; a confident excuse is flagged, a claimed rule or block asks for review | `leavesAt` 0.35: raise to treat fewer passages as leaving work. `confidenceAt` 0.4: raise to flag excuses only when the reading is surer                     |
| `vibecheck.gives-up`               | A message abandoning an item with work left                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Released updates with a report; `watch-agents`                                                                                                         | Flag                                                                         | `blockAt` 0.6: raise to flag fewer messages                                                                                                                  |
| `vibecheck.handoff-complete`       | A handoff note for open work, state, blockers and next step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `work_update` handoff                                                                                                                                  | Flag; a handoff with no note is always flagged                               | `presentAt` 0.5: raise to demand fuller notes (more flags)                                                                                                   |
| `vibecheck.stalled`                | A claim's recent reports for being stuck or abandoned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Progress reports after three earlier ones                                                                                                              | Flag in status                                                               | `flagAt` 0.6: raise to flag fewer claims                                                                                                                     |
| `vibecheck.blocker-triage`         | Who a blocker needs (the user, an agent, or something external) and how urgent it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Blocked updates                                                                                                                                        | Orders the attention list                                                    | none                                                                                                                                                         |
| `vibecheck.claim-overlap`          | Two open claims for the same or conflicting work, even on different files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `work_claim`                                                                                                                                           | Flag in status                                                               | `flagAt` 0.6: raise to flag fewer pairs                                                                                                                      |
| `vibecheck.commit-honesty`         | A commit message against the task and the files it changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Completion with a readable commit                                                                                                                      | Flag                                                                         | `matchAt` 0.4: raise to flag more mismatches. `overstatesAt` 0.6: raise to flag fewer overstatements                                                         |
| `vibecheck.task-duplicate`         | A new task against existing tasks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `plan_publish`, `plan_edit`                                                                                                                            | Flag; a large overlap asks for review                                        | `duplicateAt` 0.6 and `overlapAt` 0.7: raise to flag fewer pairs                                                                                             |
| `vibecheck.plan-coverage`          | Whether the plan's tasks would achieve the recorded plan goal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Plan changes when the policy has a goal                                                                                                                | Flag                                                                         | `coversAt` 0.5: raise to flag more plans as incomplete                                                                                                       |
| `vibecheck.plan-detail`            | A task's goal and criteria for being missing, very short or vague (code, no reading)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `plan_publish`, `plan_edit`, `issue_adopt`                                                                                                             | Flag                                                                         | none                                                                                                                                                         |
| `vibecheck.fallback-added`         | A diff for a change that silently weakens a requirement: a required dependency made optional, its failure swallowed, or a fallback hiding it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `check diff`                                                                                                                                           | Exit code 2                                                                  | `blockAt` 0.6: raise to flag fewer hunks                                                                                                                     |
| `vibecheck.commit-paths`           | Whether a recorded commit changed any claimed path (code, no reading)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Completion with a commit and a readable checkout                                                                                                       | Gate                                                                         | none                                                                                                                                                         |
| `vibecheck.exception-check`        | Whether a file recorded as data-only holds control flow (code, no reading)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Completion when the task has a data-only exception                                                                                                     | Gate                                                                         | none                                                                                                                                                         |
| `vibecheck.parent-rollup`          | Whether every child of a task verified (code, no reading)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Completion of a task with children                                                                                                                     | Gate, then claims-done reads the parent's own criteria                       | none                                                                                                                                                         |

The delete guard is not a model check: it refuses a shell `rm`, `rmdir`, `unlink` or `shred` through an unguarded `$VAR`, `${VAR}`, `$0` to `$9`, `$@` or `$*`, and asks the agent to use a literal path, or a guarded `"${VAR:?}"` inside a literal path such as `"${VAR:?}/build"`. A guarded variable that names no path segment of its own is refused too: alone (`rm -rf "${VAR:?}"`), joined to another (`"${A:?}${B:?}"`), followed by a bare `/` or `/./`, by a glob, or with a `..` segment (`"${VAR:?}/.."`). It reads the command the way the shell splits it: after `;`, `&&`, `||`, pipes and newlines; inside subshells, `$(...)`, backticks and `<(...)`; inside function bodies (`f() { ...; }`) and `case` arms; and through wrappers such as `sudo`, `env`, `xargs`, `timeout`, `nice`, `setsid`, `coproc`, `stdbuf` and `busybox`. Here-document bodies are data (an unquoted one only has its `$(...)` substitutions read), as are single-quoted and `$'...'` text; `command -v rm` runs nothing. It does not look inside `eval`, `bash -c` strings, `find -delete` or `git clean`. A command longer than 1,000,000 characters, or nested more than 64 levels deep, is not scanned: it goes ahead with a note on stderr. Turn it off with `"hooks": { "bashGuard": false }`.

Turning a check off means it never reads and records nothing. A gate that is off lets the work through as reported; turning off `vibecheck.claims-done` makes every done report complete its task, marked unverified.

Codex seals the messages its agents send each other, so the brief check cannot read Codex subagent briefs. It says so on stderr and lets them through; the Stop checks and the delete guard work the same in all four clients. Muse has no hook that holds the main turn's final reply. A subagent's reply is checked when the subagent stops and can send it back to work. The session's final reply is checked at session end and its verdicts are recorded without holding it. Antigravity stops carry no reply text, so the Stop checks read it from the conversation transcript instead.

## Read verified status

`project_status` runs the reconciler first, then begins with `next`: a short ordered list of what to do now. Pass your `session_id` and it lists the attention items about your own work, then your open claims with their status, then the next task you could claim (unclaimed, its dependencies complete, in milestone order); without one it names only the next available task. Then comes `attention` when anything needs it, listing, in this order: done reports held open (`held_done`), blockers that need the user or are urgent, `human_reply`, `reopened` and `removed` issues, stalled claims, overlapping claims, completed tasks whose done check failed or could not be read (`unverified_done`, including issues people moved to done), other flags, and open tasks with no `Done when` criteria (`missing_standard`). Each item gives the check, the reason and the history entry. At most 50 items are listed. Each task shows its Linear state, its reported status and, once a done check ran, `verified` as `verified`, `held` or `unverified`.

A mutation's response carries `verification` items for the checks it ran, including `reported_status` and `applied_status` when a done report was held. `work_history` returns, for a task, the issue's Linear comments and the `verifications` for the matched work: each verdict with its check, version, the source and model that answered, the readings, the decision and the reason, and every report the agents sent. `project_update` posts a Linear project update drafted from verified status, with health `atRisk` when a done report is held or a blocker needs the user.

## Calibrate

Checks ship with thresholds tuned on hosted Jev. Another source may read the same fixtures a little higher or lower.

- `vibecheck-linear-jev measure fixtures [--source ID] [--battery CHECK-ID] [--runs N]` repeats every fixture uncached and prints the worst margin to each fixture's bounds, marked FAIL (outside a bound) or THIN (within 0.10), then lists the fixtures that fail on that source.
- `vibecheck-linear-jev fixtures [--source ID]` runs each fixture once and exits nonzero on any failure.
- `vibecheck-linear-jev label list|mark|mark-where|mark-last` records whether live verdicts were right. Labels are history entries in the local store.
- `vibecheck-linear-jev measure live [--project ID]` shows, per check and source, how many readings flagged and how many labeled flags were right.
- `vibecheck-linear-jev measure replay [CHECK-ID] [--source ID]` re-reads every labeled verdict with the current checks and thresholds and reports precision and recall.

When a check reads a fixture wrong on your source, change that check's threshold for that source under `checks.<id>.sourceThresholds.<source id>`, run the fixtures again, and confirm with replay once you have labels.

## Commands

Every command runs through the bundled runtime: `bun runtime/vibecheck-linear-jev.mjs` in the plugin folder. From a source checkout, `bun src/cli.ts` does the same.

| Command                                                                                 | What it does                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (no command)                                                                            | Runs the MCP server: `--transport stdio\|streamable-http`, `--database`, `--host`, `--port`, `--allowed-host`, `--version`, `--help`                                                                                                           |
| `hook pretool\|bash-guard\|stop\|session-end --client claude\|codex\|muse\|antigravity` | Runs a hook on the payload on stdin (the plugin's hook files call this)                                                                                                                                                                        |
| `sources [--source ID]`                                                                 | Probes each configured source                                                                                                                                                                                                                  |
| `measure fixtures\|live\|replay`                                                        | Calibration, as above                                                                                                                                                                                                                          |
| `fixtures [--source ID]`                                                                | One pass of every fixture                                                                                                                                                                                                                      |
| `label list\|mark\|mark-where\|mark-last`                                               | Labels verdicts right or wrong                                                                                                                                                                                                                 |
| `check brief\|message\|report\|diff FILES [--project ID --task TASK]`                   | Runs a check on files; with a project and task, the standard comes from the ledger. Exit 0 clean, 2 flagged, 1 when the check could not run (no usable source, unreadable input)                                                               |
| `watch-agents --project ID [--session ID]`                                              | Reads new messages from a session's descendant agents (found through the ledger's session ancestry) for items given up; `--transcript FILE` reads given transcripts                                                                            |
| `exception-check FILE...`                                                               | Whether files hold data only                                                                                                                                                                                                                   |
| `report-of AGENT-OR-SESSION-ID [DIRECTORY]`                                             | Prints an agent's final reply from its transcript                                                                                                                                                                                              |
| `laya install\|serve`                                                                   | Installs and serves Laya                                                                                                                                                                                                                       |
| `config path\|init [--force]\|check`                                                    | Config file helpers                                                                                                                                                                                                                            |
| `linear doctor [TEAM]`                                                                  | Checks the Linear key, the user and workspace, the team, the workflow states and the rate-limit headroom; exit 1 on any failure                                                                                                                |
| `sync [--project ID]`                                                                   | Sends queued Linear writes, resumes pending completion plans, and reconciles every linked project (or one), printing counts per project. Exits 1 without a Linear key, naming where the key is looked up, or when a project fails to reconcile |

Exit codes are the same for every command: 0 on success; 1 on a failure, on a check that could not run, and on a usage error (an unknown option or argument, printed with that command's usage line); 2 only from `check` when it flagged its input. Hooks exit 0 when they allow or block, and fail open on errors (Claude Code shows exit 1 as a non-blocking error; Codex, Muse and Antigravity get exit 0 with the reason on stderr).

## Data and the local store

Linear is the record. The project, its fields, milestones and documents, every task and its description, task state, labels, relations, claim comments, report comments and verdict summaries are all in Linear, and Linear keeps their history.

A small SQLite file on each machine, `state.sqlite3`, keeps what Linear has no place for:

| Held locally         | What it is                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions             | Each agent's vendor, runtime, model, parent session, the coordinator, and which plan revision it acknowledged                                                       |
| Claims' facts        | The work record behind each claim comment: checkout, branch, paths, commit and integration commit, status. Linear decides who owns an issue                         |
| Idempotency receipts | The stored result of each mutation, kept 30 days, so a repeated `request_id` does not write twice                                                                   |
| Plan journal         | The plan revisions and the plan key to issue map. A second machine rebuilds the map from the `Machine map` block of the `vibecheck plan` document at `project_join` |
| Issue cache          | The project's issues as last read, so status and the hooks work from the cache when Linear cannot be reached                                                        |
| Outbox               | Linear writes waiting to be sent (see [How work shows up in Linear](#how-work-shows-up-in-linear))                                                                  |
| Verification history | Immutable entries: verdicts with their full readings, unavailable readings, labels, and the reports agents sent                                                     |

The file defaults to `$XDG_DATA_HOME/vibecheck-linear-jev/state.sqlite3`, or `~/.local/share/vibecheck-linear-jev/state.sqlite3`. Set `data.database` in the config, `--database` on the server, or `VIBECHECK_LINEAR_JEV_DB` in the environment to use another file; the environment variable wins. Keep it on local disk, outside plugin caches; plugin upgrades and removal do not touch it. The tool does not back it up. Losing it loses the sessions, receipts, outbox and verification history, not the Linear project.

## Share the server over HTTP

Linear is already shared between everyone who has a key to the workspace, so agents on different machines need no shared database. The HTTP transport exists for MCP clients that cannot start a local process. Run the server on the machine that holds the local store and the Linear key:

```bash
read -rsp 'Server bearer token: ' VIBECHECK_LINEAR_JEV_TOKEN; printf '\n'
export VIBECHECK_LINEAR_JEV_TOKEN
export VIBECHECK_LINEAR_JEV_PROJECTS='my-project'
bun runtime/vibecheck-linear-jev.mjs --transport streamable-http --host 127.0.0.1 --port 8765
```

Clients connect to `http://127.0.0.1:8765/mcp` with `Authorization: Bearer <token>`. The token is required even on loopback. Every client of the server writes to Linear as the one user whose key the server holds. Put remote clients behind HTTPS and pass `--allowed-host` for the public host. `VIBECHECK_LINEAR_JEV_PROJECTS` limits both transports to the listed project IDs. For other local MCP clients, [examples/mcp.json](examples/mcp.json) shows a stdio entry. Its `LINEAR_API_KEY` value is a placeholder: the key can instead come from your shell's environment or a key file (`linear.apiKeyFile`), so you can drop that line. `VIBECHECK_LINEAR_JEV_DB` is optional and defaults to `state.sqlite3` in the data folder.

## Tools

Eleven MCP tools, each taking one `request` object.

| Tool             | Purpose                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_join`   | Register or rejoin a project session with real identity and ancestry; map the key to a Linear project; ask the adoption question for an existing project |
| `plan_publish`   | Create the Linear project: fields, label groups, milestones, documents, links, tasks with goals, criteria, rules, exceptions, and the policy             |
| `plan_edit`      | Add or update tasks, milestones, documents, labels, links, project fields and policy atomically                                                          |
| `plan_read`      | Read a plan revision, or compare two                                                                                                                     |
| `plan_ack`       | Record a session's review of a plan revision                                                                                                             |
| `issue_adopt`    | Bring an existing issue into the plan under a key, reading its description through the heading aliases                                                   |
| `work_claim`     | Claim a task: claim comment, `vc:claimed`, agent label, in-progress state                                                                                |
| `work_update`    | Report progress, blockers, completion, release or handoff, with a report                                                                                 |
| `project_status` | Current state, led by `next` and what needs attention, with reported and verified status                                                                 |
| `work_history`   | Past work, the issue's comments and verification entries by task, session, path, branch or commit                                                        |
| `project_update` | Post a Linear project update, drafted from verified status when no body is given                                                                         |

The full request and response reference is [docs/protocol.md](docs/protocol.md). The skill that teaches agents the same workflow is [skills/vibecheck-linear-jev/SKILL.md](skills/vibecheck-linear-jev/SKILL.md).

## Build from source

```bash
git clone https://github.com/mgd34msu/vibecheck-linear-jev.git
cd vibecheck-linear-jev
bun install --frozen-lockfile
bun run build:release
bun run verify
```

`build:release` refreshes the bundled runtime `runtime/vibecheck-linear-jev.mjs`, which includes the TypeSafe SDK, and writes the Claude, Codex, Muse, and Antigravity plugin archives, the standalone runtime archive and `SHA256SUMS` to `artifacts/`. `verify` checks formatting, strict types, forbidden type escapes, bundle and platform-folder freshness, then runs the tests under Bun, and builds. The tests use a scripted judgment source and an in-memory Linear, and make no network calls. `bun run verify:release` checks the archives and runs each harness's MCP server and hooks under Bun, the way that harness's manifest states them.

Dependency licenses are in `runtime/THIRD-PARTY-NOTICES.txt`. vibecheck-linear-jev is released under the MIT license.
