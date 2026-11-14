# Free Model Aggregator — make.fun entry for `free-model-aggregator-01`

One small Node/TypeScript server that fronts ten simulated free-tier inference
providers and answers every client request with the strongest free model that
can legally serve it.

## What it does

At trial start the server reads the brief in `$MAKEFUN_PROMPT_FILE` — a
directory of ten providers (each with its own wire format, auth scheme and key),
a quality table (rating, context length, tool / vision / JSON support per
model) and the workload manifest. Before registering, it probes every
provider's own catalog route (`GET …/v1/models`, or `…/v1beta/models` for the
Gemini wire) to learn which models are actually free, merges that with the
quality table, and registers the resulting catalog at
`POST $MAKEFUN_ENV_URL/register`. If a provider's probe fails, the quality
table alone stands in for its catalog, so the provider is never dropped.

It then serves, until the env's `/work` poll says the trial is done:

- `POST /v1/chat/completions` — OpenAI wire, JSON and SSE streaming
- `POST /v1/messages` — Anthropic wire, JSON and SSE streaming
- `GET /v1/models` — the served free models, shaped by the caller's auth header
  (`x-api-key` gets the Anthropic list shape, anything else the OpenAI one)

`main.ts --list` prints exactly the catalog document that gets registered;
with no brief it prints `{"providers":[]}`.

## How it routes

Each request is translated into a neutral form, then re-rendered onto the
chosen provider's wire (OpenAI chat completions, Anthropic messages, or Gemini
`generateContent` / `:streamGenerateContent?alt=sse`). The translations are
built to preserve exactly what the providers echo back — system text, the last
user message, tool names in order, `max_tokens`, stop sequences, image bytes
and the JSON-mode flag — and the provider's usage and stop family are carried
into whichever wire the client used. Provider streams are buffered and the
client stream is re-synthesized, so streaming event order is correct by
construction.

Candidates for a request are every free (provider, model) pair that meets the
request's requirements, ordered by rating. Two failure rules keep quality up
without wasting calls:

- A refusal is retried once while the provider has refused fewer than twice —
  refusal schedules hold at most two draws, and the same pair usually answers
  on the next call.
- A provider that has refused three times is spent or out for the rest of the
  trial and is only tried after everything else.

Only free models are ever called, calls are strictly sequential (a provider
serves one call at a time), and nothing depends on the clock or on randomness:
ids and timestamps in responses are fixed constants derived from nothing but
the brief and the providers' answers, so a replayed trial produces
byte-identical output.

## Practice results

Run locally against the kit's three practice instances (env + scorer, no
Docker), the entry scored **99 / 100 on all three trials**:

| trial | quality | served | wire | failover | catalog | total | provider calls |
|-------|---------|--------|------|----------|---------|-------|----------------|
| 0 | 99 | 100 | 100 | 100 | 100 | 99 | 28 |
| 1 | 99 | 100 | 100 | 100 | 100 | 99 | 28 |
| 2 | 99 | 100 | 100 | 100 | 100 | 99 | 30 |

All 20 requests were valid in every trial. The single missing quality point is
structural: the best provider's free-tier budget runs out before the last
requests arrive, so the tail is served by the next-best model.

## Layout

- `main.ts` — the whole entry (Node 22, erasable-syntax TypeScript, no
  dependencies)
- `LICENSE` — MIT, copied verbatim from the competition kit's starter
- `.makefun/owner.json` — the make.fun ownership claim

## Running it

The competition harness starts it as `node main.ts` with `MAKEFUN_ENV_URL`
and `MAKEFUN_PROMPT_FILE` set; there is nothing to install.
