---
description: "面向用户的 xgg-cycle 工作区流程面板，用于通过关联会话管理需求、原型、开发、测试、修复与部署。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-client-ui-xgg-cycle

[English](README.md) | 中文

## 概述

`dsh-client-ui-xgg-cycle` 为 Web Client 添加按工作区隔离的项目流程面板。面板记录项目信息与需求，把需求扩展为功能分组，并向会话投递结构化的原型、开发、测试、修复与部署轮次。随附的 `web` Profile 已包含本包；自定义 Profile 可以安装它的 Bundle 层。面板数据按工作区持久化到浏览器存储，而会话消息与回复仍是 agent 实际执行工作的权威记录。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

从会话头部或侧边栏底部打开**需求面板**。添加项目事实与需求，扩展每条需求，确认需要的功能点，然后单独运行各阶段或启动无人值守流程。投递会选择目标会话，因为只有已打开的会话才会接受用于判断完成状态的实时事件。

### 安装到 Profile

`web` Profile 已包含该配置行。对于其他兼容的 Web Profile，安装或移除 Bundle 后重启 Profile：

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-client-ui-xgg-cycle
dsh plugin --profile <name> remove @deepseek-ai/dsh-client-ui-xgg-cycle
```

Bundle patch 会插入 `ui-xgg-cycle` 配置行。它的浏览器半边依赖会话与工作区控制器、Conversation 与 Workspace UI 服务、slot renderer、侧边栏和 locale runtime。

### 你会得到什么

面板为每个工作区保存独立的项目状态。需要上下文连续性的手动阶段会复用仍存活的项目会话；需求扩展使用独立的规划会话，因此不会排在长时间构建之后。无人值守流程会生成功能点、构建带版本的原型、正式开发，并交替执行测试与修复，直到不再有 P0/P1 问题或完成五轮修复。服务器密码不会进入浏览器持久化，但直连服务器部署在投递时会把密码写入持久会话消息。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

浏览器插件把同一个组件注册到 `conversation.session.header.utilities` 与 `sidebar.footer.action`；根作用域控制器可跨会话导航存活，并拥有持久化 store 与自动循环。`session-ask.ts` 观察会话生命周期和事件窗口，直到出现新的 assistant 消息，或一个无消息轮次在队列为空时结束。协议解析器按预期键扫描每个 JSON 代码块，因此无关的 package 或配置 JSON 不会遮挡流程结果。

| 文件 | 职责 |
|---|---|
| [`src/client/controller.ts`](src/client/controller.ts) | 工作区 store、会话投递、完成监听与自动循环 |
| [`src/client/project-model.ts`](src/client/project-model.ts) | 项目类型、规则、提示构造与结果应用 |
| [`src/client/session-ask.ts`](src/client/session-ask.ts) | 会话提交、结束判断与 JSON 提取 |
| [`src/client/PopupPanel.tsx`](src/client/PopupPanel.tsx) | 本地化流程界面与用户操作 |
| [`cordis.patch.yml`](cordis.patch.yml) | 可安装的 Profile 层 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Conversation 子系统](../../../docs/subsystems/conversation.zh.md)——会话作用域 UI 组装与输入所有权。
- [应用组合](../../../docs/architecture.zh.md)——Profile 与 Bundle 分层。
- [Slot 类型链](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.zh.md)——注册与注入 props 规则。

-----

<a id="model-experience"></a>
## 模型体验

### 流程轮次消息

#### 模型看到什么

每个已投递阶段都会成为所选会话中的普通用户消息。本包会组装当前项目事实、需求、已确认功能点、适用的实现或部署规则、未解决的手动问题，以及该阶段的 JSON 回复约定。完成的轮次会在阶段结果旁报告 `{"roundComplete":true}`；续接消息会要求同一会话完成遗漏该标记的轮次。

#### Token 影响

每次投递都会把完整组装后的阶段消息加入所选会话，并保留 assistant 回复。因此重复轮次会再次加入当前项目清单与阶段专用指令；本包不注册隐藏提示段或工具 schema。

#### KV Cache 影响

在复用的会话内仅追加：后续阶段会扩展现有请求前缀。需求规划可以使用独立会话；目标缺失或已归档时会创建新会话，无法复用项目对话前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **浏览器本地项目清单**——需求、选择、轮次记录与自动循环状态不会在不同浏览器或设备之间同步。
- **投递时导航**——每次等待回复的投递都会打开其会话，因此流程运行期间当前对话会发生切换。
- **依赖结构化回复**——流程 JSON 缺失或格式错误会中止轮次或写入说明；容错提取不会推断省略字段。
- **直连服务器凭据进入历史**——密码不进入 local storage，面板记录中也会打码，但部署消息会持久写入所属会话。
- **没有回滚**——停止循环会中止面板等待与后续轮次；已经完成的文件修改、部署或 agent 工作不会撤销。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
