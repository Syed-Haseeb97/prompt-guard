# Changelog

All notable changes to `prompt-guard` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-21

### Added
- **FreeLLMAPI Provider**: Dedicated provider preset defaulting to `http://127.0.0.1:3001/v1` reading `FREELLMAPI_KEY` (with `OPENAI_API_KEY` fallback).
- **`llm-judge` Assertion Engine**: Model-graded evaluation asserting qualitative requirements against an LLM judge returning `{ score: 0.0-1.0, reasoning: string }`. Supports global and per-assertion judge overrides.
- **Result Caching**: Deterministic SHA-256 disk cache in `.prompt-guard/cache/` saving API quota and accelerating iterative suite runs. Controllable via `--no-cache` and `cache` config options.
- **Dataset-Driven Test Suites**: Native support for bulk `.csv` and `.jsonl` files in `suite.dataset`, expanding rows into fixtures with template variable mapping.
- **Provider Matrix CLI**: `--matrix <providers>` running prompt suites across multiple models and printing comparative cross-model scorecards (Total, Passed, Failed, Pass Rate, Avg Latency).
- **Test Suite Expansion**: Added 13 new unit and integration tests covering Phase 3 features (now 266 tests passing).

## [1.0.0] - 2026-11-21

### Added
- **Core CLI**: Subcommands `init`, `run`, `compare`, `help`, and `version`.
- **Zero-Dependency Evaluators**:
  - `semantic`: Embedding-distance, word-overlap, character n-gram, and Levenshtein similarity.
  - `jsonSchema`: Complete draft 04/07/2020-12 compatible validator with automatic JSON extraction from prose.
  - `regex`: Case-sensitive and insensitive pattern matching with capture group assertion support.
  - `keywords`: Keyword presence, absence, and frequency checks with whole-word boundary awareness.
  - `contains`: Substring validation.
  - `length`: Word, character, and line count boundaries.
  - `custom`: Inline synchronous and asynchronous evaluator plugins.
- **Provider Integrations**:
  - OpenAI (compatible with Groq, vLLM, LM Studio, Ollama).
  - Anthropic (Claude 3/3.5/3.7 with extended thinking token support).
  - Generic HTTP endpoint provider with template interpolation.
  - Deterministic Mock provider for cost-free offline regression testing.
- **Reporting & Diffing**:
  - Side-by-side ANSI color terminal diffs for comparing prompt revisions.
  - JSON run report output format.
  - JUnit XML output format for Jenkins, GitHub Actions, and GitLab CI test dashboards.
- **Scaffolding**: `prompt-guard init` scaffolds ready-to-run test suites, configs, and benchmarks.
- **CI / Testing**: Cross-platform Vitest suite with 241 unit and integration tests.
