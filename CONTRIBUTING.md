# Contributing to prompt-guard

Thank you for your interest in improving `prompt-guard`! We welcome contributions, bug reports, and suggestions.

## Development Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Syed-Haseeb97/prompt-guard.git
   cd prompt-guard
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Run tests**:
   ```bash
   npm test
   ```

4. **Typecheck**:
   ```bash
   npm run typecheck
   ```

5. **Build the CLI**:
   ```bash
   npm run build
   ```

## Development Guidelines

- **Zero Runtime Dependencies Policy**: To keep `prompt-guard` ultra-fast, lightweight, and auditable, the core framework relies only on `zod` and native Node.js APIs (`node:crypto`, `node:fs`, `node:path`, `node:http`). Avoid adding heavy runtime dependencies unless absolutely necessary.
- **Strict Typing**: All code is written in strict TypeScript with `noUncheckedIndexedAccess`.
- **Test Coverage**: Any new assertions, providers, or CLI options should include comprehensive unit and integration tests under `src/__tests__/`.

## Pull Request Process

1. Fork the repo and create your branch from `main`: `git checkout -b feature/my-feature`.
2. Ensure `npm test` and `npm run typecheck` pass with zero errors or warnings.
3. Commit with descriptive conventional commit messages (`feat: ...`, `fix: ...`, `docs: ...`).
4. Submit a Pull Request describing your changes, motivation, and verification steps.
