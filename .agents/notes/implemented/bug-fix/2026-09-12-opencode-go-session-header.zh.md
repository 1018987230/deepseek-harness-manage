# Agent Note: OpenCode Go Session 标头归属

Status: implemented

[English](2026-09-12-opencode-go-session-header.md) | 中文

## 问题

OpenCode Go 要求每个对话携带稳定的 `x-opencode-session` 标头。agent-loop 请求通过 `GenerateOptions.sessionId` 携带持久 Harness Session id，但 pi-ai 的各提供方 API 不会一致地把该选项转换为所需标头。静态 profile 标头无法表示不同对话，还会静默地把每个 Session 路由到同一个身份下。

## 决策

pi-ai 适配器为 `opencode-go` 提供方从 `GenerateOptions.sessionId` 派生 `x-opencode-session`，并通过 pi-ai 的逐请求 `headers` 选项传递它。适配器在协议分派前应用该规则，因此 Anthropic Messages 与 OpenAI Chat Completions 会收到同一个 Session 身份。动态值归 Harness 所有，并替换与其发生不区分大小写冲突的 profile 标头。没有 `sessionId` 的请求保持不变，因为提供方无关的 LLM API 允许这类请求。

## 考虑过的替代方案

**依赖 pi-ai Session affinity。** 其协议专用 affinity 格式不保证 OpenCode Go 所需的精确标头，而且部分格式默认关闭。

**配置一个 profile 标头。** 一个静态值会合并互不相关的 Harness Session，并破坏按对话路由和提示词缓存。

**在 agent-loop 中添加提供方标头。** 这会把提供方专用协议策略放进提供方无关的请求所有者中，并遗漏其他合法的适配器调用方。

## 后果

每个带 Session 的 OpenCode Go 请求都会在目录支持的协议上携带所需身份，其他提供方和无 Session 调用则保持现有标头。适配器回归测试通过由操作系统分配端口的回环服务器覆盖两条协议路径，并证明运行时值会覆盖陈旧的 profile 值；Loader 组合测试还会证明由 `settings.yaml` 提供的路由得到相同结果。如果 pi-ai 日后为每条 OpenCode Go 协议拥有该精确标头，只有当相同协议断言通过上游实现时，才能移除适配器注入。
