# prompt-guard

[![CI](https://github.com/Syed-Haseeb97/prompt-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/Syed-Haseeb97/prompt-guard/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/prompt-guard.svg)](https://www.npmjs.com/package/prompt-guard)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests: 241 passed](https://img.shields.io/badge/tests-241%20passed-brightgreen.svg)](https://github.com/Syed-Haseeb97/prompt-guard)

**Regression testing and guardrails for LLM prompts.**

`prompt-guard` turns your prompts into a test suite. It replays saved prompt
fixtures against a real or mocked LLM endpoint, evaluates the responses with
*fuzzy* assertion engines (semantic similarity, JSON Schema, regex, keyword
rules), and diffs two runs side by side so you can see exactly what a prompt
edit or a model upgrade broke.

```
✔ prompt-guard init                    scaffold a project
✔ prompt-guard run                     execute the suite
✔ prompt-guard compare before after    diff two runs, report regressions
```

---

## Table of contents

- [Why prompt-guard](#why-prompt-guard)
- [Install](#install)
- [Quick start](#quick-start)
- [Concepts](#concepts)
  - [Project layout](#project-layout)
  - [Configuration](#configuration)
  - [Suites and fixtures](#suites-and-fixtures)
  - [Providers](#providers)
  - [Benchmarks](#benchmarks)
- [Assertion engines](#assertion-engines)
  - [`semantic` — semantic similarity](#semantic--semantic-similarity)
  - [`jsonSchema` — JSON Schema validation](#jsonschema--json-schema-validation)
  - [`regex` — pattern matching](#regex--pattern-matching)
  - [`keywords` — required / prohibited terms](#keywords--required--prohibited-terms)
  - [`contains` and `length`](#contains-and-length)
  - [`custom` — your own validator](#custom--your-own-validator)
- [CLI reference](#cli-reference)
- [Run reports](#run-reports)
- [Comparing runs](#comparing-runs)
- [CI integration](#ci-integration)
- [Using prompt-guard as a library](#using-prompt-guard-as-a-library)
- [Architecture](#architecture)
- [Development](#development)
- [License](#license)

---

## Why prompt-guard

Changing a prompt is a refactor with a non-deterministic compiler. The
usual workflow — paste the prompt into a chat window, eyeball the answer —
does not scale and does not catch the failure modes that matter:

| Risk | How prompt-guard catches it |
| --- | --- |
| A prompt edit silently breaks a downstream expectation | Saved fixtures with semantic/regex/keyword assertions |
| A model upgrade changes behaviour | Compare two runs and diff the outputs |
| The model starts emitting invalid JSON | `jsonSchema` assertion with a full JSON Schema |
| The model leaks data it should not | `keywords` prohibited list, `semantic` in `notSimilar` mode |
| The prompt itself drifted without anyone noticing | Prompt hashes are recorded in every report and compared across runs |

Everything is deterministic and offline-friendly: the bundled **mock provider**
gives byte-identical output for the same prompt, so your test suite is green in
CI without spending a cent.

---

## Install

```bash
# Global CLI installation
npm install -g prompt-guard

# Or add to your existing project
npm install -D prompt-guard

# Or run directly via npx
npx prompt-guard run
```

Or install from source:

```bash
git clone https://github.com/Syed-Haseeb97/prompt-guard.git
cd prompt-guard
npm install
npm run build
npm link            # optional: links `prompt-guard` globally
```

Requires **Node.js >= 18.17**.

---

## Quick start

```bash
mkdir my-prompts && cd my-prompts
prompt-guard init
```

`init` creates:

```
prompt-guard.config.json          # project configuration
suites/smoke.suite.json           # a working example suite
benchmarks/baseline.benchmark.json
.gitignore
```

Then:

```bash
prompt-guard run
```

```
  ✔ smoke › refund-request — Refund request is answered with next steps
  ✔ smoke › policy-question — Policy question is answered as a structured JSON list
  ✔ smoke › no-pii-leak — The agent does not leak internal data

✔ 3/3 passed (100.0%)
  total 3 · skipped 0 · duration 0.02s · run 20240115T101500Z-a1b2c3

  Tags
    billing  100%  (1/1)
    policy   100%  (1/1)
    safety   100%  (1/1)

  Assertions
    jsonSchema  1/1 passed
    keywords    1/1 passed
    length      1/1 passed
    regex       1/1 passed
    semantic    2/2 passed
```

Now point it at a real model and compare the two runs:

```bash
prompt-guard run --label baseline --provider openai --model gpt-4o-mini
prompt-guard run --label upgraded --provider openai --model gpt-4o-2024-08-06
prompt-guard compare baseline upgraded
```

```
  Run comparison
    A  20240115T101500Z-a1b2c3 (baseline)  2024-01-15T10:15:00.003Z · 12/12 passed
    B  20240115T101530Z-d4e5f6 (upgraded)  2024-01-15T10:15:30.221Z · 11/12 passed

    totals   12 cases · 2 changed · 10 unchanged · 0 added · 0 removed
    regressed 1 case(s) that previously passed now fail

  Diff (2 of 2 changed case(s))

  REGRESSED smoke › refund-request — Refund request is answered with next steps
      status passed → failed · similarity 62%
      regressed mentions a refund or a way to request one (passed → failed)
┌───────────────────────────────────────────────┬────────────────────────────────────────────────┐
│ A · refund-request                           │ B · refund-request                              │
├───────────────────────────────────────────────┼────────────────────────────────────────────────┤
│ 1. Verify the duplicate charge on order      │ 1. Confirm the account holder details for        │
│ 4821. 2. Confirm the customer account and    │ order 4821. 2. Escalate the duplicate charge to  │
│ original payment method. 3. Issue a refund   │ the billing team. 3. Advise the customer that a  │
│ once the duplicate charge is confirmed.      │ refund follows review.                           │
└───────────────────────────────────────────────┴────────────────────────────────────────────────┘
```

`compare` exits with code `1` when a regression is detected, so it drops
straight into CI.

---

## Concepts

### Project layout

```
my-prompts/
├── prompt-guard.config.json      # configuration (providers, suites, output)
├── suites/                       # *.suite.json files
│   └── smoke.suite.json
├── benchmarks/                   # *.benchmark.json files
│   └── baseline.benchmark.json
└── .prompt-guard/
    └── runs/                     # generated run reports (git-ignored)
```

Paths inside the config are resolved **relative to the config file**, so a
config can live in a subdirectory and still work. The same rule applies to
the `suites` list of a benchmark file: it is resolved against the directory
of the config file, not the benchmark file.

> `bail` stops the run after the first failure. Fixtures that have not started
> yet are reported as `skipped`; fixtures already in flight are allowed to
> finish, so the totals may include more than one executed case.

### Configuration

`prompt-guard.config.json`:

```jsonc
{
  "version": 1,
  "suites": [{ "path": "suites/**/*.suite.json" }],
  "outputDir": ".prompt-guard/runs",

  "providers": {
    "mock": {
      "kind": "mock",
      "model": "mock-deterministic-v1",
      "mock": { "mode": "hash", "seed": "stable-seed" }
    },
    "openai": {
      "kind": "openai",
      "model": "gpt-4o-mini",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "timeoutMs": 30000,
      "temperature": 0
    }
  },

  "defaultProvider": "mock",
  "defaultModel": "mock-deterministic-v1",
  "concurrency": 4,
  "timeoutMs": 30000,
  "retries": 1,

  "defaultAssertions": [
    { "type": "length", "name": "response is not empty", "min": 1, "unit": "chars" }
  ],

  "report": { "formats": ["json", "junit"], "keepRuns": 20 },
  "env": { "apiVersion": "API_VERSION" },
  "color": "auto",
  "bail": false
}
```

| Key | Meaning |
| --- | --- |
| `suites` | Suite file paths or globs. Accepts a string or `{ "path": "…" }`. |
| `outputDir` | Where run reports are written. |
| `providers` | Named provider definitions. |
| `defaultProvider` | Provider used when a fixture does not name one. |
| `defaultModel` | Model used when a fixture does not name one. |
| `concurrency` | Fixtures executed in parallel. |
| `timeoutMs` | Per-fixture timeout. |
| `retries` | Retries for transient provider errors (429/5xx/network). |
| `defaultAssertions` | Applied to fixtures that define no assertions of their own. |
| `report.formats` | `json` (always written) and/or `junit` (CI test reporters). |
| `report.keepRuns` | How many historical runs to keep in `outputDir`. |
| `env` | Maps a template variable to an environment variable name. |
| `color` | `auto`, `always` or `never`. |
| `bail` | Stop at the first failing case. |

### Suites and fixtures

A suite is a `*.suite.json` file:

```jsonc
{
  "name": "support-agent",
  "description": "Regression suite for the customer support prompt.",
  "version": 3,

  "defaults": {
    "system": "You are a support agent. Be concise.",
    "assertions": [
      { "type": "length", "name": "response is not empty", "min": 1, "unit": "chars" }
    ]
  },

  "fixtures": [
    {
      "id": "duplicate-charge",
      "title": "Duplicate charge is handled with concrete next steps",
      "tags": ["billing", "happy-path"],
      "system": "You are a support agent. Be concise.",
      "prompt": "Customer says: \"I was charged twice for order {{orderId}}.\"",
      "variables": { "orderId": "4821" },
      "assertions": [
        { "type": "semantic", "name": "explains the refund", "expected": "verify the duplicate charge and refund the customer", "threshold": 0.35 }
      ]
    }
  ]
}
```

Fixture fields:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Unique within the suite. |
| `title` / `description` | `string` | Human readable metadata. |
| `tags` | `string[]` | Used for filtering and per-tag thresholds. |
| `system` | `string` | System prompt. Overrides `defaults.system`. |
| `prompt` | `string \| message[]` | The user prompt, or a full message list. |
| `variables` | `object` | Values interpolated into `{{placeholders}}`. |
| `assertions` | `assertion[]` | Replaces the suite defaults entirely. |
| `provider` | `object` | Per-fixture provider overrides (merged over the named provider). |
| `model` | `string` | Per-fixture model override. |
| `timeoutMs` / `retries` | `number` | Per-fixture overrides. |
| `skip` | `boolean` | Skip the fixture without deleting it. |
| `frozenOutput` | `string` | Pin the model output — useful for deterministic tests. |
| `mockResponse` | `string` | Response used by the mock provider for this fixture. |
| `metadata` | `object` | Arbitrary data copied into the run report. |

**Template variables.** `{{name}}` is replaced with the value from
`variables`; `{{name | fallback}}` uses a default when the variable is absent.
Unknown variables are left untouched and reported as a warning.

**Multi-turn prompts.** `prompt` may be an array of messages:

```json
{ "prompt": [
    { "role": "system", "content": "You are a support agent." },
    { "role": "user", "content": "Where is my order?" },
    { "role": "assistant", "content": "Could you share the order id?" },
    { "role": "user", "content": "Order 4821 please." }
] }
```

### Providers

| `kind` | Description |
| --- | --- |
| `mock` | Deterministic, offline. Modes: `hash` (default), `echo`, `rules`. |
| `openai` | OpenAI-compatible `/v1/chat/completions` (OpenAI, Groq, Ollama, LM Studio, vLLM, OpenRouter…). |
| `anthropic` | Anthropic Messages API. |
| `http` | Any HTTP endpoint. Request body from a template, response read from a JSON path. |
| `echo` | Returns the prompt verbatim (useful for prompt-shape tests). |

The mock provider in `rules` mode maps prompts to canned responses:

```jsonc
{
  "kind": "mock",
  "mock": {
    "mode": "rules",
    "rules": [
      { "fixtureId": "duplicate-charge", "response": "1. Verify the charge…" },
      { "match": "how do I (refund|cancel)", "response": "…", "caseInsensitive": true },
      { "match": "^\\s*\\{", "json": { "answer": "42" } }
    ],
    "defaultResponse": "I am not sure yet.",
    "latencyMs": 25
  }
}
```

Custom HTTP provider:

```jsonc
{
  "kind": "http",
  "baseUrl": "https://my-gateway.internal/llm",
  "apiKeyEnv": "GATEWAY_TOKEN",
  "requestTemplate": {
    "system": "{{system}}",
    "user": "{{prompt}}",
    "temperature": 0
  },
  "responsePath": "choices.0.message.content"
}
```

### Benchmarks

A benchmark file pins the provider/model and adds **acceptance thresholds**
that are checked after the run:

```jsonc
{
  "name": "production-model",
  "suites": ["suites/**/*.suite.json"],
  "providers": {
    "openai": { "kind": "openai", "model": "gpt-4o-mini", "apiKeyEnv": "OPENAI_API_KEY" }
  },
  "defaultProvider": "openai",
  "model": "gpt-4o-mini",

  "thresholds": {
    "passRate": 0.95,
    "maxFailures": 0,
    "maxErrors": 0,
    "maxRegressions": 0,
    "byTag": { "safety": 1, "billing": 0.95 }
  },
  "budgets": {
    "maxDurationMs": 60000,
    "maxCaseDurationMs": 10000
  },
  "requiredTags": ["safety"]
}
```

```bash
prompt-guard run --benchmark benchmarks/production-model.benchmark.json
```

If a threshold or budget is violated the run still writes its report, but the
process exits with code **3** and prints what was violated.

---

## Assertion engines

Every assertion supports `name` (a label shown in reports), `severity`
(`error` — the default — or `warn`, which reports but never fails a case) and
`enabled` (set to `false` to disable an inherited assertion).

### `semantic` — semantic similarity

The fuzzy workhorse. Compares the output to one or more reference texts with a
blended similarity metric and checks it against a threshold.

```jsonc
{
  "type": "semantic",
  "name": "mentions a refund",
  "expected": [
    "verify the duplicate charge and issue a refund",
    "ask the customer to confirm the duplicate charge before refunding"
  ],
  "threshold": 0.35,
  "minTermCoverage": 0.4
}
```

| Option | Default | Description |
| --- | --- | --- |
| `expected` | — | Reference text or list of alternatives. The best-scoring one wins. |
| `threshold` | `0.7` | Minimum acceptable similarity (mode `similar`). |
| `mode` | `"similar"` | `"notSimilar"` asserts the output is *dissimilar* instead. |
| `maxSimilarity` | `0.3` | Maximum acceptable similarity (mode `notSimilar`). |
| `minTermCoverage` | — | Minimum fraction of salient expected terms that must appear. |
| `weights` | see below | Override the blended metric weights. |
| `ignoreCase` | `true` | Case-insensitive comparison. |
| `ignorePunctuation` | `true` | Strip punctuation before comparing. |
| `stopwords` | `false` | Remove English stopwords before comparing. |

**How the score is computed.** Four complementary signals are blended:

| Signal | Weight | Why |
| --- | --- | --- |
| `wordJaccard` | 0.35 | Set overlap of stemmed tokens — precise, but brittle to reordering. |
| `wordDice` | 0.30 | Softer set overlap; forgiving of added or dropped words. |
| `charBigram` | 0.20 | Character bigram overlap — robust to inflection and typos. |
| `levenshtein` | 0.15 | Normalised edit distance — catches surface-level drift. |

Weights are normalised over the active signals, so you can zero one out or
add an embedding signal. `minTermCoverage` adds a second, stricter gate: the
salient terms of the reference (stemmed, stopwords removed) must actually
appear in the output, which stops a vague-but-plausible answer from passing.

**`notSimilar` mode** is how you write a "must not disclose X" guard:

```jsonc
{
  "type": "semantic",
  "name": "does not disclose internal details",
  "mode": "notSimilar",
  "expected": "The internal fraud escalation number is +1 555 0100.",
  "maxSimilarity": 0.3
}
```

**Embeddings.** If you supply an embedding function, the cosine similarity of
the two embeddings is folded into the blend as a fifth signal:

```ts
import { RegressionEngine } from 'prompt-guard';

const engine = new RegressionEngine({
  config,
  suites,
  embed: async (text) => myEmbeddingProvider.embed(text), // number[]
});
```

### `jsonSchema` — JSON Schema validation

A dependency-free validator covering the draft-07 subset: `type`, `enum`,
`const`, `properties`, `required`, `additionalProperties`,
`patternProperties`, `propertyNames`, `min/maxProperties`, `dependencies`,
`items` (schema or tuple), `prefixItems`, `additionalItems`, `min/maxItems`,
`uniqueItems`, `contains`, `minimum`/`maximum`/`exclusiveMinimum`/
`exclusiveMaximum`/`multipleOf`, `minLength`/`maxLength`/`pattern`,
`allOf`/`anyOf`/`oneOf`/`not`, `if`/`then`/`else`, local `$ref`
(`#/$defs/…`), and `format` for `date-time`, `date`, `time`, `email`, `uri`,
`uuid`, `ipv4` and `hostname`.

```jsonc
{
  "type": "jsonSchema",
  "name": "matches the answer schema",
  "extract": "auto",
  "schema": {
    "type": "object",
    "required": ["answer", "confidence"],
    "additionalProperties": false,
    "properties": {
      "answer": { "type": "string", "minLength": 1 },
      "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
      "sources": { "type": "array", "items": { "type": "string" } }
    }
  }
}
```

`extract` controls how JSON is pulled out of the response:

| Mode | Behaviour |
| --- | --- |
| `auto` (default) | Strict parse → markdown fence → first balanced `{…}` / `[…]`. |
| `strict` | The whole response must be JSON. |
| `markdown` | The last ` ```json ` fenced block. |
| `first` / `last` | The first or last balanced JSON region in the text. |

Validation errors are reported with a JSON pointer to the offending value
(`/items/0/answer`) and a human readable message.

### `regex` — pattern matching

```jsonc
{
  "type": "regex",
  "name": "has a numbered step",
  "pattern": ["\\d[.)]\\s+\\S", "^\\s*-\\s+\\S"],
  "flags": "m",
  "match": "any"
}
```

| Option | Default | Description |
| --- | --- | --- |
| `pattern` | — | One pattern or a list. |
| `flags` | `""` (`"i"` for `match: "none"`) | JavaScript regex flags. |
| `match` | `"any"` | `any` (at least one), `all` (every one), `none` (no prohibited pattern). |

PCRE-flavoured `(?i)` prefixes and Python-style `(?P<name>…)` groups are
translated automatically.

### `keywords` — required / prohibited terms

```jsonc
{
  "type": "keywords",
  "name": "mentions the order but never leaks the card",
  "required": ["order", "refund"],
  "anyOf": ["email", "phone", "ticket"],
  "prohibited": ["4111", "guarantee"],
  "minRequired": 2,
  "caseSensitive": false,
  "wholeWord": false
}
```

`wholeWord: true` matches on word boundaries, so `cat` does not match
`concatenate`.

### `contains` and `length`

```jsonc
{ "type": "contains", "value": "I cannot help with that", "ignoreCase": true, "negate": false }

{ "type": "length", "min": 20, "max": 400, "unit": "words" }
```

`unit` is one of `chars`, `words`, `sentences`, `lines` or `tokens`
(an approximation using a 4-chars-per-token heuristic blended with the word
count).

### `custom` — your own validator

Register a validator and reference it by name:

```ts
import { RegressionEngine, type CustomValidator } from 'prompt-guard';

const noUrls: CustomValidator = (assertion, context) => {
  const found = /https?:\/\//.test(context.output);
  return {
    name: 'no urls',
    type: 'custom',
    status: found ? 'failed' : 'passed',
    passed: !found,
    message: found ? 'the response contains a URL' : 'no URLs found',
    durationMs: 0,
  };
};

const validators = new Map([['noUrls', noUrls]]);
const engine = new RegressionEngine({ config, suites, validators });
```

```jsonc
{ "type": "custom", "validator": "noUrls", "options": { "allowed": ["example.com"] } }
```

---

## CLI reference

### `prompt-guard init`

Scaffolds a project.

```bash
prompt-guard init [--force] [--no-samples] [--dir <path>]
```

| Flag | Description |
| --- | --- |
| `--force` | Overwrite existing files. |
| `--no-samples` | Do not create the example suite. |
| `--dir <path>` | Scaffold into a subdirectory. |

### `prompt-guard run`

Executes the configured suites.

```bash
prompt-guard run [options]
```

| Flag | Description |
| --- | --- |
| `-c, --config <path>` | Config file (default: discovered by walking up). |
| `--benchmark <path>` | Benchmark file — pins provider/model and adds thresholds. |
| `-p, --provider <name>` | Provider from the `providers` section. |
| `-m, --model <id>` | Model identifier. |
| `-t, --tag <tag>` | Only fixtures with this tag. Repeatable / comma separated. |
| `--exclude-tag <tag>` | Skip fixtures with this tag. |
| `-i, --id <id>` | Only these fixture ids. |
| `-s, --search <text>` | Substring match over id / title / description. |
| `-n, --concurrency <n>` | Parallel fixtures. |
| `--timeout <ms>` | Per-fixture timeout. |
| `--retries <n>` | Retries for transient errors. |
| `--label <name>` | Label stored in the report and the file name. |
| `-o, --out <dir>` | Override the output directory. |
| `-f, --format <list>` | `json,junit`. |
| `--bail` | Stop at the first failing case. |
| `--json` | Print the raw run report JSON to stdout. |
| `-q, --quiet` | Suppress the human readable output. |
| `-v, --verbose` | Print diagnostics to stderr. |
| `--color <mode>` | `auto`, `always`, `never`. |

### `prompt-guard compare <runA> <runB>`

Diffs two runs.

```bash
prompt-guard compare baseline upgraded [options]
```

A run reference can be a path to a report JSON file, a run id, or a label
(`--label baseline` produces a file ending in `-baseline.json`).

| Flag | Description |
| --- | --- |
| `--max-cases <n>` | Changed cases rendered in full (default 10). |
| `-w, --width <n>` | Width of the side-by-side diff. |
| `--only-changed` | Only render cases whose output changed (default). |
| `--no-only-changed` | Render every case. |
| `--no-write` | Do not write the comparison report. |
| `--no-fail-on-regression` | Always exit 0. |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | One or more cases failed or errored; or `compare` found a regression. |
| `2` | Usage error. |
| `3` | Benchmark thresholds or budgets were violated. |

---

## Run reports

Every run writes a JSON report to `outputDir`:

```jsonc
{
  "schemaVersion": "1.0",
  "runId": "20240115T101500Z-a1b2c3",
  "label": "baseline",
  "startedAt": "2024-01-15T10:15:00.000Z",
  "finishedAt": "2024-01-15T10:15:01.200Z",
  "durationMs": 1204.512,

  "config": {
    "suite": "support-agent, summarizer",
    "provider": "openai",
    "model": "gpt-4o-mini",
    "concurrency": 4,
    "timeoutMs": 30000,
    "retries": 1,
    "filters": { "tags": ["billing"] }
  },

  "totals": { "total": 12, "passed": 12, "failed": 0, "errored": 0, "skipped": 0, "durationMs": 1204.512 },

  "summary": {
    "passRate": 1,
    "byTag": { "billing": { "total": 3, "passed": 3, "passRate": 1 } },
    "assertionCounts": { "semantic": { "total": 3, "passed": 3, "failed": 0 } }
  },

  "results": [
    {
      "id": "duplicate-charge",
      "title": "Duplicate charge is handled with concrete next steps",
      "suite": "support-agent",
      "status": "passed",
      "tags": ["billing", "happy-path"],
      "prompt": "Customer says: \"I was charged twice for order 4821.\"",
      "system": "You are a support agent.",
      "output": "1. Verify the duplicate charge…",
      "promptHash": "3f2a91c0be47",
      "model": "gpt-4o-mini",
      "provider": "openai",
      "durationMs": 412.8,
      "startedAt": "…",
      "finishedAt": "…",
      "assertions": [
        {
          "name": "explains the refund",
          "type": "semantic",
          "status": "passed",
          "passed": true,
          "message": "output is similar to the reference (score 0.612 >= 0.35)",
          "score": 0.612,
          "expected": ["verify the duplicate charge and issue a refund"],
          "details": {
            "components": { "wordJaccard": 0.5, "wordDice": 0.67, "charBigram": 0.55, "levenshtein": 0.71 },
            "termCoverage": 0.8,
            "missingTerms": ["duplicate"]
          },
          "durationMs": 0.412
        }
      ]
    }
  ],

  "environment": {
    "node": "v20.11.1",
    "platform": "linux",
    "arch": "x64",
    "promptGuardVersion": "1.0.0",
    "cwd": "/home/me/my-prompts",
    "gitCommit": "9f1c2ab"
  }
}
```

A JUnit XML report is written alongside it when `junit` is enabled, so the run
shows up in GitHub Actions, CircleCI, GitLab CI and similar.

`prompt-guard run --json` prints exactly this document to stdout, which makes
it easy to pipe into `jq` or store as a CI artefact.

---

## Comparing runs

`compare` produces a `ComparisonReport`:

```jsonc
{
  "schemaVersion": "1.0",
  "createdAt": "…",
  "runA": { "runId": "…", "startedAt": "…", "label": "baseline", "model": "gpt-4o-mini" },
  "runB": { "runId": "…", "startedAt": "…", "label": "upgraded", "model": "gpt-4o-2024-08-06" },

  "drift": {
    "modelChanged": true,
    "modelA": "gpt-4o-mini",
    "modelB": "gpt-4o-2024-08-06",
    "promptChangedCount": 2,
    "suiteChanged": false
  },

  "totals": {
    "total": 12, "changed": 3, "unchanged": 9,
    "added": 0, "removed": 0,
    "regressed": 1, "fixed": 0, "newFailures": 0,
    "regressedAssertions": 2, "fixedAssertions": 0
  },

  "cases": [
    {
      "suite": "support-agent",
      "id": "duplicate-charge",
      "change": "changed",
      "statusA": "passed",
      "statusB": "failed",
      "verdict": "regressed",
      "promptChanged": false,
      "promptHashA": "3f2a91c0be47",
      "promptHashB": "3f2a91c0be47",
      "modelA": "gpt-4o-mini",
      "modelB": "gpt-4o-2024-08-06",
      "modelChanged": true,
      "outputSimilarity": 0.62,
      "assertionChanges": [
        { "name": "explains the refund", "type": "semantic", "statusA": "passed", "statusB": "failed", "change": "regressed" }
      ],
      "outputA": "1. Verify the duplicate charge…",
      "outputB": "1. Confirm the account holder…",
      "durationDeltaMs": 21.4
    }
  ]
}
```

Verdicts per case: `regressed` (passed → failed), `fixed` (failed → passed),
`stable`, `added`, `removed`. Three kinds of drift are reported separately:
**model drift** (the model identifier changed), **prompt drift** (the rendered
prompt hash changed) and **behaviour drift** (the outputs changed).

The `totals` block counts **cases**; `regressedAssertions` and
`fixedAssertions` count the individual assertions whose status flipped, so a
single case failing three assertions is still one regression.

---

## CI integration

### GitHub Actions

```yaml
name: prompt regression
on: [pull_request]

jobs:
  prompt-guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci && npm run build
      - run: npx prompt-guard run --benchmark benchmarks/production-model.benchmark.json
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

### Comparing against a baseline branch

```bash
prompt-guard run --label candidate --quiet
prompt-guard compare "$BASELINE_REPORT" candidate || exit 1
```

### Pinning a baseline report

Commit the JSON report of a known-good run and diff against it:

```bash
prompt-guard compare baselines/support-agent.json candidate
```

---

## Using prompt-guard as a library

```ts
import { RegressionEngine, loadConfig, loadSuites, compareRuns } from 'prompt-guard';

const { config, rootDir } = await loadConfig(process.cwd());
const { suite } = (await loadSuites(config.suites, rootDir))[0]!;

const engine = new RegressionEngine({
  config,
  suites: [suite],
  providerName: 'openai',
  model: 'gpt-4o-mini',
  onProgress: (event) => {
    if (event.type === 'case-end') {
      console.log(event.id, event.status);
    }
  },
});

const report = await engine.run();
console.log(report.summary.passRate);
```

Useful exports:

| Export | Purpose |
| --- | --- |
| `RegressionEngine` | The test runner. |
| `loadConfig`, `loadSuites`, `validateSuite`, `validateConfig` | Loading and validation. |
| `runAssertions`, `BUILT_IN_VALIDATORS` | The assertion engines. |
| `semanticSimilarity`, `validateJsonSchema`, `findKeyword` | Individual primitives. |
| `compareRuns`, `loadRunReport` | Comparison. |
| `renderSideBySide`, `diffWords`, `diffLines` | Diffing and rendering. |
| `createProvider` | Build a provider from a config object. |
| `evaluateThresholds`, `loadBenchmark` | Benchmarks. |

---

## Architecture

```
src/
├── cli/
│   ├── index.ts                 # argument dispatch, help, exit codes
│   ├── args.ts                  # dependency-free argument parser
│   ├── output.ts                # terminal formatting helpers
│   └── commands/
│       ├── init.ts              # project scaffolding
│       ├── run.ts               # suite execution
│       └── compare.ts           # run diffing
├── core/
│   ├── types.ts                 # the shared type contract
│   ├── config.ts                # config discovery + validation (zod)
│   ├── benchmark.ts             # benchmark files + threshold evaluation
│   ├── errors.ts                # typed error hierarchy
│   └── logger.ts                # level-aware logger
├── runner/
│   ├── regressionEngine.ts      # the test runner
│   ├── suiteLoader.ts           # suite discovery, validation, defaults
│   ├── template.ts              # {{variable}} rendering
│   ├── providers/               # mock, openai, anthropic, http
│   ├── assertions/              # the fuzzy assertion engines
│   │   ├── semantic.ts          # blended similarity metric
│   │   ├── jsonSchema.ts        # JSON Schema validator
│   │   ├── jsonSchemaAssertion.ts
│   │   ├── jsonExtract.ts       # JSON extraction from model output
│   │   ├── regex.ts
│   │   ├── keywords.ts
│   │   ├── misc.ts              # contains + length
│   │   ├── custom.ts
│   │   └── embedding.ts         # cosine similarity
│   ├── diff/
│   │   ├── textDiff.ts          # LCS diff
│   │   └── sideBySide.ts        # side-by-side terminal renderer
│   └── report/
│       ├── jsonReport.ts        # JSON + JUnit artefacts
│       └── compare.ts           # comparison engine
├── utils/                       # hash, text, fs, ansi, async, id
└── __tests__/                   # 241 unit and integration tests
```

Design notes:

- **The CLI is a thin wrapper.** Every capability is available as a library
  function, so prompt-guard can be embedded in an existing Vitest/Jest suite.
- **One type contract.** `src/core/types.ts` describes the config, the suite
  files, the run reports and the comparison reports, so the CLI, the engine and
  the assertion engines never disagree.
- **Deterministic by default.** The mock provider is seeded and the prompt
  hash is derived from the rendered prompt, so a green suite stays green.
- **Zero heavy runtime dependencies.** `zod` is the only runtime dependency.

---

## Development

```bash
npm install
npm test              # run the test suite
npm run test:watch    # watch mode
npm run test:coverage # coverage report
npm run typecheck     # tsc --noEmit
npm run build         # emit dist/
npm run dev -- run    # run the CLI from source
```

The test suite covers the assertion engines, the JSON Schema validator, the
diff engine, the comparison engine, the config loader, the providers, the
argument parser and the CLI end to end (including `init`, `run` and
`compare`).

---

## License

MIT
