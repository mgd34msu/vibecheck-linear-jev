"""Serve Jev-Style over the System One wire API that vibecheck-linear-jev speaks.

This adapter is optional and runs outside vibecheck-linear-jev: the plugin never
installs or starts it, and it is not part of the build, the tests or the
bundle. It loads a JevStyleDecision model once and answers

  POST /v1/systemone   {"state": ..., "questions": {...}, "model": ...}
  GET  /v1/models      {"models": [{"name", "description", "release_date"}]}

mapping each request to decide_many and each result back to the wire shape:
a noul answer is P(true); a choice answer is the chosen option with a
probability per option; a score answer is the expected level (the sum of
level times probability) with the distribution keyed by level.

Usage:
  python server.py --model-dir ./Jev-Style-0.8B-Decision-v3 [--host 127.0.0.1] [--port 8766]
  python server.py --runtime gguf --model-dir ./Jev-Style-0.8B-Decision-v3-GGUF [--port 8766]

The transformers runtime imports jev_style_decision from the model folder;
the GGUF runtime imports jev_style_decision_gguf from the GGUF folder. Both
expose decide_many with the same arguments and result fields.
"""

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import importlib
import sys

TYPE_CODES = {"noul": "noul", "choice": "choice", "score": "score"}


def as_text(value):
    """Instructions and criteria may be text or JSON; the model reads text."""
    if value is None:
        return ""
    return value if isinstance(value, str) else json.dumps(value)


def option_names(criteria):
    if isinstance(criteria, dict):
        return list(criteria.keys())
    return [str(item) for item in criteria or []]


def to_item(question):
    kind = TYPE_CODES[question["type"]]
    instructions = as_text(question.get("instructions"))
    criteria = question.get("criteria")
    if kind == "noul":
        return {"t": "noul", "ins": instructions, "crit": None}
    if kind == "choice":
        described = {name: as_text(text) for name, text in criteria.items()} if isinstance(criteria, dict) else None
        return {"t": "choice", "ins": instructions, "crit": described or option_names(criteria)}
    return {"t": "score", "ins": instructions, "crit": [as_text(level) for level in criteria]}


def probabilities_of(result, names):
    probabilities = result.get("probabilities")
    if isinstance(probabilities, dict):
        return {str(name): float(probabilities.get(name, 0.0)) for name in names}
    return {str(name): float(value) for name, value in zip(names, probabilities or [])}


def to_answer(question, result):
    kind = question["type"]
    if kind == "noul":
        probabilities = result.get("probabilities")
        yes = None
        if isinstance(probabilities, dict):
            yes = next((float(v) for k, v in probabilities.items() if str(k).lower() in ("true", "yes")), None)
        if yes is None:
            top = float(result.get("top_probability", 0.0))
            yes = top if str(result.get("answer")).lower() in ("true", "yes") else 1.0 - top
        return {"type": "noul", "noul": yes}
    if kind == "choice":
        names = option_names(question.get("criteria"))
        probabilities = probabilities_of(result, names)
        choice = str(result.get("answer")) if result.get("answer") in probabilities else max(probabilities, key=probabilities.get)
        return {"type": "choice", "choice": choice, "confidence": probabilities[choice], "probabilities": probabilities}
    levels = [str(index) for index in range(len(question.get("criteria") or []))]
    probabilities = probabilities_of(result, levels)
    expected = sum(int(level) * probability for level, probability in probabilities.items())
    return {
        "type": "score",
        "score": expected,
        "confidence": max(probabilities.values()) if probabilities else 0.0,
        "probabilities": probabilities,
        "legend": {level: as_text(text) for level, text in zip(levels, question.get("criteria") or [])},
    }


class Handler(BaseHTTPRequestHandler):
    model = None
    name = "jev-style"

    def send(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.split("?")[0] != "/v1/models":
            return self.send(404, {"error": "not found"})
        return self.send(200, {"models": [{"name": self.name, "description": "Jev-Style served by the vibecheck-linear-jev adapter", "release_date": ""}]})

    def do_POST(self):
        if self.path.split("?")[0] != "/v1/systemone":
            return self.send(404, {"error": "not found"})
        try:
            request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
            questions = request["questions"]
            state = as_text(request.get("state"))
            ids = list(questions.keys())
            results = self.model.decide_many(state, [to_item(questions[i]) for i in ids])
        except (KeyError, ValueError, TypeError) as error:
            return self.send(422, {"error": str(error)})
        except Exception as error:  # the model failed; the client moves to its next source
            return self.send(500, {"error": str(error)})
        answers = {i: to_answer(questions[i], result) for i, result in zip(ids, results)}
        tokens = max((int(result.get("input_tokens", 0)) for result in results), default=0)
        return self.send(200, {"model": self.name, "answers": answers, "usage": {"input_tokens": tokens, "output_tokens": 0}})

    def log_message(self, *args):
        return


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model-dir", required=True, help="folder downloaded with hf download")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--name", default="jev-style", help="model name reported to clients")
    parser.add_argument("--runtime", choices=["transformers", "gguf"], default="transformers")
    parser.add_argument("--batched", action="store_true", help="GGUF only: score all questions on one pass over the state")
    args = parser.parse_args()
    sys.path.insert(0, args.model_dir)
    if args.runtime == "gguf":
        runtime = importlib.import_module("jev_style_decision_gguf")
        options = {"many_mode": "batched"} if args.batched else {}
        Handler.model = runtime.JevStyleDecisionGGUF(args.model_dir, **options)
    else:
        runtime = importlib.import_module("jev_style_decision")
        Handler.model = runtime.JevStyleDecision(args.model_dir)
    Handler.name = args.name
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Jev-Style is answering on http://{args.host}:{args.port}/v1/systemone")
    server.serve_forever()


if __name__ == "__main__":
    main()
