# Agent Note: OpenCode Go session header ownership

Status: implemented

English | [中文](2026-09-12-opencode-go-session-header.zh.md)

## Problem

OpenCode Go requires a stable `x-opencode-session` header for each conversation. Agent-loop requests carry the durable Harness Session id as `GenerateOptions.sessionId`, but pi-ai's provider APIs do not consistently translate that option to the required header. A static profile header cannot represent separate conversations and can silently route every Session under one identity.

## Decision

The pi-ai adapter derives `x-opencode-session` from `GenerateOptions.sessionId` for the `opencode-go` provider and passes it through pi-ai's per-request `headers` option. The adapter applies the rule before protocol dispatch, so Anthropic Messages and OpenAI Chat Completions receive the same Session identity. The dynamic value is Harness-owned and replaces a case-insensitive profile-header collision. Requests without `sessionId` remain unchanged because the provider-neutral LLM API permits them.

## Alternatives considered

**Rely on pi-ai session affinity.** Its protocol-specific affinity formats do not guarantee OpenCode Go's exact header, and some formats are disabled by default.

**Configure one profile header.** One static value would merge unrelated Harness Sessions and defeat conversation-scoped routing and prompt caching.

**Add the provider header in agent-loop.** That would put provider-specific wire policy in the provider-neutral request owner and leave other legitimate adapter consumers uncovered.

## Consequences

Every session-bearing OpenCode Go request carries the required identity across the catalog's supported protocols, while other providers and sessionless calls retain their existing headers. The adapter regression test exercises both protocol paths through loopback servers allocated by the operating system and proves the runtime value overrides a stale profile value; the Loader composition test proves the same result for a route supplied through `settings.yaml`. If pi-ai later owns the exact header for every OpenCode Go protocol, the adapter injection can be removed only after the same wire assertions pass through the upstream implementation.
