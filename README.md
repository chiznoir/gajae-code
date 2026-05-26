# Gajae-Code

Gajae-Code (`gjc`) is a private MVP coding-agent CLI with a deliberately small workflow surface: four bundled skills and four matching agent definitions, all loaded from `.gjc`.

It keeps the core coding-agent strengths—fast file/search tools, LSP-aware edits, native helpers, model-provider flexibility, and a terminal TUI—while removing broad inherited workflow sprawl from the default surface.

## Current MVP contract

Default public workflow definitions are exactly:

| Skill / agent | Purpose | State/artifacts |
| --- | --- | --- |
| `deep-interview` | Socratic requirements interview for ambiguous work. | `.gjc/specs/` |
| `ralplan` | Consensus planning and approval before mutation. | `.gjc/plans/` |
| `ultragoal` | Durable goal decomposition and checkpoint ledger. | `.gjc/ultragoal/` |
| `team` | Tmux-backed parallel execution after approval. | `.gjc/state/team/` |

Default definitions are stored in two places and must stay in sync:

```text
.gjc/skills/<name>/SKILL.md
.gjc/agents/<name>.md
packages/coding-agent/src/defaults/gjc/skills/<name>/SKILL.md
packages/coding-agent/src/defaults/gjc/agents/<name>.md
```

GJC default skill loading accepts only `.gjc` definitions. Use `.gjc` for project-local runtime state, specs, plans, goals, and team coordination.

## Install for local development

```sh
bun install
bun run install:defaults
```

`install:defaults` installs the four bundled GJC definitions into the active GJC config directory without overwriting local edits unless forced by the setup command.

## Run

```sh
bun packages/coding-agent/src/cli.ts --help
bun packages/coding-agent/src/cli.ts setup defaults --check --json
bun packages/coding-agent/src/cli.ts setup defaults --json
```

When installed globally, use `gjc`:

```sh
gjc --help
gjc setup defaults --check --json
gjc setup defaults --json
```

## Workflow usage

Start with the lightest path that fits the work:

1. Direct edit for clear, low-risk implementation tasks.
2. `deep-interview` for unclear requirements.
3. `ralplan` for architectural/test planning and approval.
4. `ultragoal` for durable multi-goal execution tracking.
5. `team` for approved parallel execution.

Planning workflows must stop at `pending approval` until execution is explicitly approved.

## Provider base URLs

Built-in provider base URL environment variables override the host only; they do not change the selected API transport.

For example, the built-in OpenAI provider uses the Responses API, so:

```sh
OPENAI_BASE_URL=https://proxy.example.com/v1
```

still calls:

```text
https://proxy.example.com/v1/responses
```

If your proxy only supports OpenAI-compatible Chat Completions, configure a custom provider in `models.yml`:

```yaml
providers:
  openai-compatible:
    baseUrl: https://proxy.example.com/v1
    apiKey: OPENAI_API_KEY
    api: openai-completions
    models:
      - id: gpt-4o
        name: GPT-4o via proxy
        api: openai-completions
```

## Development checks

For workflow-definition or rebrand-surface changes, run:

```sh
bun scripts/check-visible-definitions.ts
bun scripts/verify-g002-gates.ts
bun scripts/rebrand-inventory.ts --strict
bun test packages/coding-agent/test/default-gjc-definitions.test.ts
```

For TypeScript/lint verification, run:

```sh
bun run check:ts
```

Do not use `tsc` or `npx tsc` directly.

## Repository layout

| Path | Purpose |
| --- | --- |
| `packages/coding-agent/` | Main `gjc` CLI and TUI product surface |
| `packages/ai/` | Multi-provider model client and stream adapters |
| `packages/agent/` | Agent runtime primitives |
| `packages/tui/` | Terminal UI rendering |
| `packages/natives/` | Native bindings package |
| `packages/stats/` | Local stats dashboard |
| `packages/utils/` | Shared utilities |
| `crates/pi-natives/` | Rust native helpers |
| `.gjc/` | GJC-visible skills, agents, and workflow state |

## CI/CD

The private GitHub repository is configured with:

- default branch: `main`
- development branch: `dev`
- CI workflow on `main`, `dev`, and pull requests
- tag-based release jobs for binaries and npm publishing
- `main` branch protection requiring `check` and `test`

## Attribution

Gajae-Code is a forked/rebranded derivative that preserves upstream attribution where required while presenting GJC commands, package names, and runtime paths in the active product surface.
