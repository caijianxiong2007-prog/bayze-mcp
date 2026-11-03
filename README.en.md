# Bayze

[![CI](https://github.com/caijianxiong2007-prog/bayze-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/caijianxiong2007-prog/bayze-mcp/actions/workflows/ci.yml)

A local-first, auditable, open-source **AI model-routing core**. Bayze plugs into MCP-capable AI clients over stdio and runs explicit multi-model workflows — starting with `review_then_revise`: one model drafts, a second model structurally reviews, a third revises only when rejected.

Bring your own keys (BYOK). No telemetry, no cloud components, no listening ports.

## Highlights

- **Waterfall with mandatory structured review** — the reviewer must return `{"verdict":"accept"|"revise","reasons":[...]}`; unparseable reviews fail closed (never silently accepted)
- **Explainable escalation** — every step records provider, model, trigger reason, usage and estimated cost; deterministic checks use structured `check_failed:<id>` reasons
- **Budget guard** — conservative pre-call reservation, actual-usage settlement, hard USD cap; unknown prices fail closed unless explicitly allowed
- **Privacy by construction** — keys are read from environment variables only; the local journal stores run summaries (status/models/usage/cost) — never prompts or responses; 7-day/10MB rotation, one-command clear
- **Provider adapters** — OpenAI-compatible (DeepSeek, DashScope, Volcengine Ark, OpenAI, …) plus a native Anthropic Messages adapter (different protocol/auth/error taxonomy); a mock adapter exercises every failure path without keys
- **MCP-native** — three tools (`list_workflows`, `run_workflow`, `get_run_summary`), step-level progress notifications, cancellation propagation, per-client stdio process (no daemon)

## Requirements

- Node.js ≥ 22 LTS

## Install

```bash
# Run directly (recommended)
npx -y bayze-mcp mcp --config /path/to/config.yaml

# Or install globally
npm install -g bayze-mcp
bayze config check --config /path/to/config.yaml
```

Configuration is a versioned YAML file: providers (`env:` key references only), models with optional pricing, and waterfall workflows with limits and per-step run conditions. Ready-made templates:

- Mainland China: `examples/config.cn.example.yaml` — DeepSeek → Qwen → Doubao cross-vendor review (CNY pricing / USD budget boundary explained)
- International: `examples/config.intl.example.yaml` — OpenAI and OpenAI→Claude cross-vendor review

All endpoint/model IDs are public shapes marked for verification; **all prices are placeholder data** — check official pricing pages.

## Client setup

Works with any MCP client that supports stdio servers (Claude Desktop, Cursor, Cherry Studio, …). See `docs/mcp-clients.md`. Three tools are exposed; `finalOutput` is always flagged `finalOutputUntrusted: true` — model-generated content, not instructions.

## Documentation

- `docs/baseline-spec.md` — the single source of truth (implementation constraints & acceptance checklist)
- `docs/architecture.md` · `docs/privacy.md` · `docs/threat-model.md`
- `docs/dependencies.md` · `docs/acceptance-status.md` · `CHANGELOG.md`

## Status

P0 complete: 103 tests green, `npm audit` clean, verified online against five providers (DeepSeek / Qwen / Doubao / OpenAI / Anthropic) including a real cross-vendor review loop in a production MCP client. Regional strategy: one codebase, distribution-level config differences only.

## License

[MIT](LICENSE)
