# Jev-Style adapter

An optional server that lets vibecheck-linear-jev use [Jev-Style](https://huggingface.co/chaoliangUNSW/Jev-Style-0.8B-Decision-v3), an open Jev-compatible decision model (Apache-2.0, based on Qwen3.5-0.8B), as a judgment source. Jev-Style is a Python library with no server of its own; this adapter loads it once and answers the same System One wire API as the hosted service.

vibecheck-linear-jev never installs or starts this adapter, and it is not part of the plugin's build, tests or bundle. You run it yourself.

## Set it up

Download the model and install its requirements into a Python environment of your choice:

```bash
hf download chaoliangUNSW/Jev-Style-0.8B-Decision-v3 --local-dir ./Jev-Style-0.8B-Decision-v3
python -m venv .venv && . .venv/bin/activate
pip install -r ./Jev-Style-0.8B-Decision-v3/requirements.txt
```

The model folder provides the `jev_style_decision` module (it needs torch and `transformers` 5.0 or later); the server adds `--model-dir` to the Python path and imports it from there.

The GGUF builds (Q4_K_M, Q8_0 and F16, from the [GGUF repository](https://huggingface.co/chaoliangUNSW/Jev-Style-0.8B-Decision-v3-GGUF), also downloadable through LM Studio) run on llama.cpp instead of torch. That repository ships `jev_style_decision_gguf.py` with the same API and a small `jev_score.cpp` scorer to build against llama.cpp as its card describes. Start the adapter with `--runtime gguf` and `--model-dir` pointing at that folder; `--batched` scores every question in one pass over the state.

## Run it

```bash
python server.py --model-dir ./Jev-Style-0.8B-Decision-v3 --port 8766
# or, with the GGUF build:
python server.py --runtime gguf --model-dir ./Jev-Style-0.8B-Decision-v3-GGUF --port 8766
```

It listens on `127.0.0.1:8766` by default and answers:

| Request                                                 | Answer                                                |
| ------------------------------------------------------- | ----------------------------------------------------- |
| `POST /v1/systemone` with `state`, `questions`, `model` | `answers` per question, `usage.input_tokens`, `model` |
| `GET /v1/models`                                        | `{ "models": [{ "name": "jev-style", ... }] }`        |

Each question maps to one `decide_many` item. A yes/no (noul) answer is the probability of yes. A choice answer is the chosen option with a probability for every option. A score answer is the expected level, the sum of each level times its probability, with the distribution keyed by level.

## Connect vibecheck-linear-jev

Add it to the sources in `config.jsonc` as an `openjev` source. Its input limit is 25,600 tokens of state:

```jsonc
{
  "kind": "openjev",
  "id": "jev-style",
  "baseURL": "http://127.0.0.1:8766",
  "model": "jev-style",
  "limits": { "maxStateTokens": 25600 },
}
```

Then check that it answers and see how its readings sit against the fixtures:

```bash
vibecheck-linear-jev sources --source jev-style
vibecheck-linear-jev measure fixtures --source jev-style --runs 3
```
