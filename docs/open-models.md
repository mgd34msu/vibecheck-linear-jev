# Use an open Jev model

An open Jev model runs on your own machine. Every one below answers the same System One questions as hosted Jev, so vibecheck-linear-jev treats them all the same way once they are running. They differ in size, in what they need to run, and in how much of an agent's work they can read at once.

## Where to get the models

vibecheck-linear-jev has been tested with these four models. The sections below cover setting up each one:

| Model                    | Where to get it                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jev (hosted by TypeSafe) | Sign in at [console.typesafe.ai](https://console.typesafe.ai/) and follow [docs.typesafe.ai](https://docs.typesafe.ai/) to create an API key. Nothing to download                                                                                                                                                                                                                             |
| Laya                     | [huggingface.co/receptron/laya-onnx](https://huggingface.co/receptron/laya-onnx). `vibecheck-linear-jev laya install` installs its runtime, and `vibecheck-linear-jev laya serve` downloads these weights (about 1.7 GB) on first start                                                                                                                                                       |
| Jev-Style                | [huggingface.co/chaoliangUNSW/Jev-Style-0.8B-Decision-v3](https://huggingface.co/chaoliangUNSW/Jev-Style-0.8B-Decision-v3), or the GGUF build at [huggingface.co/chaoliangUNSW/Jev-Style-0.8B-Decision-v3-GGUF](https://huggingface.co/chaoliangUNSW/Jev-Style-0.8B-Decision-v3-GGUF). Download with `hf download` and serve it through [adapters/jev-style](../adapters/jev-style/README.md) |
| OpenJev with Qwen        | Server: [github.com/GitHub30/OpenJev](https://github.com/GitHub30/OpenJev). Model: [huggingface.co/Qwen/Qwen2.5-1.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct), which the server downloads when it starts                                                                                                                                                                  |

Other Jev-compatible models can work too: any server that answers the System One wire API (`POST /v1/systemone`) connects as an `openjev` source, as the Jev-Style adapter does. Only these four have been tested, so measure any other model with `vibecheck-linear-jev measure fixtures --source <id>` before relying on it.

## Choose a model

| Model                        | Maker              | Runs on                                         | Reads at most        | Best for                                                                 |
| ---------------------------- | ------------------ | ----------------------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| [Laya](#laya)                | Convai Innovations | CPU, about 2 GB of RAM                          | 512 tokens of state  | The short checks, on any machine, with nothing to set up but one command |
| [Jev-Style](#jev-style)      | chaoliangUNSW      | CPU or GPU, through Python (torch) or llama.cpp | 25,600 tokens        | The checks that read long evidence, on a modest machine                  |
| [OpenJev](#openjev-github30) | GitHub30           | A GPU running an instruct model you choose      | Depends on the model | Using a model you already have                                           |

A common setup is Laya for the short checks, Jev-Style for the evidence-heavy ones, and hosted Jev behind both as a fallback; [combine several models](#combine-several-models) shows that config.

## The same five steps for every model

1. **Get and start the model**, as its section below describes. Each one ends with a server answering on a local port.
2. **Add it to `sources`** in the config file (see [where the file is](../README.md#the-config-file)). Sources are tried in order, so put the one you want first at the top.
3. **Check that it answers:** `vibecheck-linear-jev sources --source <id>`. This sends one small reading and reports the answer time, the model name and, where the server supports it, the models it serves.
4. **Measure it against the checks:** `vibecheck-linear-jev measure fixtures --source <id> --runs 3`. The checks' thresholds were set on hosted Jev, and an open model often reads the same examples a little higher or lower. The output ends with every fixture that fails on this model.
5. **Calibrate or route.** For each check with failing fixtures, either set a threshold for this model under `checks.<check id>.sourceThresholds.<source id>` and measure again, or send that check to another source with `checks.<check id>.sources`. [Calibrate](../README.md#calibrate) explains the tools in more detail.

The config keys for every source kind are listed under [sources](../README.md#sources).

## Jev (hosted)

Jev is TypeSafe's hosted System One model, and the one the checks' built-in thresholds were set on. Nothing runs on your machine.

**You need:** a TypeSafe account. TypeSafe runs Jev in early access and lists its price as $42 per billion input tokens at the time of writing.

**Get a key:** sign in at [console.typesafe.ai](https://console.typesafe.ai/) and follow [docs.typesafe.ai](https://docs.typesafe.ai/) to create an API key.

**Connect it:** set the key in the environment Claude Code or Codex starts from:

```bash
export TYPESAFE_API_KEY="your key"
```

With no `sources` in the config, vibecheck-linear-jev uses hosted Jev with that key. To list it next to local models, add:

```jsonc
{ "kind": "typesafe", "id": "typesafe" }
```

**Check it:** `vibecheck-linear-jev sources --source typesafe` reports the answer time and the model (`jev-latest` by default).

## Laya

[Laya](https://huggingface.co/convaiinnovations/laya) is a small open model built for System One questions, released by Convai Innovations with Apache-2.0 weights. It runs on a CPU through ONNX Runtime, using [@receptron/laya](https://github.com/receptron/laya). vibecheck-linear-jev installs and serves it for you.

**You need:** npm (for the install), about 2 GB of free RAM, and about 1.7 GB of disk for the weights. The weights download on first use into `~/.cache/receptron-laya`; set `LAYA_CACHE` or the source's `load.cacheDir` to put them elsewhere.

**Install and start it:**

```bash
vibecheck-linear-jev laya install    # installs Laya and ONNX Runtime into the data folder
vibecheck-linear-jev laya serve      # loads the model and answers on 127.0.0.1:8723
```

Nothing is installed into the plugin folder. The server runs under Bun or Node.js.

**Connect it:**

```jsonc
"sources": [
  { "kind": "laya", "id": "laya", "port": 8723, "autostart": false },
  { "kind": "typesafe", "id": "typesafe" }
]
```

With `"autostart": true`, a hook or the ledger starts `laya serve` in the background when it finds Laya not running. That first reading goes to the next source while the model loads.

**What to expect:** Laya reads at most 512 tokens of state, choice options up to 192 tokens, and about 20 options per choice. A longer reading skips Laya and goes to the next source, and the skip is recorded. Laya also reads many of the checks' examples differently from hosted Jev: at the built-in thresholds, 76 of 139 fixture readings fail on it. So measure it (step 4), then either give it its own thresholds or send it only the short checks:

```jsonc
"checks": {
  "vibecheck.question-answered": { "sources": ["laya", "typesafe"] },
  "vibecheck.user-pauses": { "sources": ["laya", "typesafe"] }
}
```

## Jev-Style

[Jev-Style](https://huggingface.co/chaoliangUNSW/Jev-Style-0.8B-Decision-v3) is a family of open decision models by chaoliangUNSW (Apache-2.0). The 0.8B v3 model reads up to 25,600 tokens, enough for the checks that read long evidence. There is also a larger [2B v2 model](https://huggingface.co/chaoliangUNSW/Jev-Style-Qwen3.5-2B-Decision-v2) and GGUF and MLX builds of each.

Jev-Style ships as a Python library with no server, so this repository includes a small optional server for it in [adapters/jev-style](../adapters/jev-style/README.md). vibecheck-linear-jev never installs or starts it; you run it yourself.

**You need:** Python 3 and the Hugging Face CLI (`pip install -U huggingface_hub`). For the standard build, torch and `transformers` 5.0 or later, which the model's requirements file installs. For the GGUF build, llama.cpp instead of torch.

**Download and install it:**

```bash
hf download chaoliangUNSW/Jev-Style-0.8B-Decision-v3 --local-dir ./Jev-Style-0.8B-Decision-v3
python -m venv .venv && . .venv/bin/activate
pip install -r ./Jev-Style-0.8B-Decision-v3/requirements.txt
```

**Start the server** from this repository:

```bash
python adapters/jev-style/server.py --model-dir ./Jev-Style-0.8B-Decision-v3 --port 8766
```

For the GGUF build (from the [GGUF repository](https://huggingface.co/chaoliangUNSW/Jev-Style-0.8B-Decision-v3-GGUF), also available through LM Studio), use `--runtime gguf` and follow the adapter's README to build the scorer against llama.cpp.

**Connect it:**

```jsonc
{
  "kind": "openjev",
  "id": "jev-style",
  "baseURL": "http://127.0.0.1:8766",
  "model": "jev-style",
  "limits": { "maxStateTokens": 25600 },
}
```

**What to expect:** the adapter maps each answer from the model's library format into the System One format. Measure it (step 4) and set thresholds for it where fixtures fail.

## OpenJev (GitHub30)

[OpenJev](https://github.com/GitHub30/OpenJev) (MIT) turns an ordinary Hugging Face instruct model, such as Qwen, into a System One server. You choose the model. Its documentation suggests Qwen2.5-7B on an A100 or L4 GPU and Qwen2.5-1.5B on a T4.

**You need:** Python 3 with [uv](https://docs.astral.sh/uv/), and a GPU with CUDA PyTorch installed first. The model itself downloads from Hugging Face when the server starts.

**Install and start it:**

```bash
git clone https://github.com/GitHub30/OpenJev.git && cd OpenJev
uv venv && uv pip install -e ".[hf,server,dev]"
openjev serve --model Qwen/Qwen2.5-1.5B-Instruct --port 8000
```

**Connect it:** the server answers on `http://127.0.0.1:8000` with the model name `jev-latest`.

```jsonc
{
  "kind": "openjev",
  "id": "openjev",
  "baseURL": "http://127.0.0.1:8000",
  "model": "jev-latest",
}
```

**What to expect:** the readings come from a general-purpose instruct model, not one trained for these questions, so they can sit well away from the built-in thresholds. Measure it (step 4) before relying on it.

## Combine several models

List sources in order and route each check to the models that suit it. This config sends the short checks to Laya, the evidence-heavy checks to Jev-Style, and keeps hosted Jev as the fallback for any reading the local models skip or cannot answer:

```jsonc
"sources": [
  { "kind": "laya", "id": "laya", "port": 8723, "autostart": true },
  { "kind": "openjev", "id": "jev-style", "baseURL": "http://127.0.0.1:8766", "model": "jev-style", "limits": { "maxStateTokens": 25600 } },
  { "kind": "typesafe", "id": "typesafe" }
],
"checks": {
  "vibecheck.question-answered": { "sources": ["laya", "typesafe"] },
  "vibecheck.user-pauses": { "sources": ["laya", "typesafe"] },
  "vibecheck.claim-grounded": { "sources": ["jev-style", "typesafe"] },
  "vibecheck.claims-done": { "sources": ["jev-style", "typesafe"] }
}
```

Leave out the hosted source to run fully locally. When no listed source can answer a reading, the check lets the work go ahead and records that no reading was taken.
