# Contributing to Canvas Notebook

Thanks for your interest in Canvas Notebook!

**GitHub:** https://github.com/canvascoding/canvas-notebook

---

## How to Contribute

- **Bug reports & small fixes** → open a PR directly
- **Larger features or design changes** → open a GitHub Issue or Discussion first so we can align before you invest time
- **Questions** → open a GitHub Issue

## Before You Submit a PR

- Test your change locally with `npm run setup`
- Run the test suite: `npm run test:all`
- Keep PRs focused — one thing per PR, no unrelated changes mixed in
- Describe what changed and why
- For UI changes, include a screenshot or short screen recording

## Repository Layout and Test Configuration

Keep feature-specific test configuration under `tests/playwright/`. The root
`playwright.config.ts` remains the default for `npm run test:e2e`; dedicated npm
scripts and fixture runners select the specialized configurations explicitly.
For a direct invocation, use `playwright test --config tests/playwright/<config>.ts`
from the repository root and follow the selected suite's fixture requirements.

See the [repository root inventory](docs/architecture/canvas-notebook/repository-root-layout.md)
for the purpose of the remaining root files and cleanup rules.

## AI-Assisted Contributions

Built with Claude, Codex, or another AI tool? Fine — just be transparent about it in the PR description, note how thoroughly you tested it, and make sure you understand what the code does.

## Security

Found a vulnerability? Please report it privately via GitHub's [security advisory](https://github.com/canvascoding/canvas-notebook/security/advisories/new) rather than opening a public issue.

Include: what you found, how to reproduce it, and what the impact is.
