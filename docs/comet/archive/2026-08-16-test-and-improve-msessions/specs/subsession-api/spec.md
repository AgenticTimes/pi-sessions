# 子会话编程 API 与指标（pi-msessions）

## Capability

`pi-msessions` 在进程内为其他插件提供编程式子会话 API：创建独立子会话跑一次 prompt，收集指标后返回；支持扩展过滤（无插件臂）与 live 可见模式（可切换可交互）。

## Public API（对外契约，本变更后保持不变）

入口：`(globalThis as any)[Symbol.for("pi.msessions")].run(opts)`。

`run(opts: SubsessionOptions): Promise<SubsessionResult>`

- `cwd: string`（必填）、`prompt: string`（必填）
- `timeoutSec?: number` 默认 600
- `excludeExtensions?: string[]` 按 path 子串排除全局扩展
- `name?`、`visible?: boolean`（默认 false = 纯后台）、`keepAlive?: boolean`（默认 false = 跑完销毁）
- `onEvent?: (event, acc) => void` 实时累计指标回调

返回 `SubsessionResult`：`ok / error / timeMs / inputTokens / outputTokens / cacheReadTokens / totalTokens / cost / turns / toolCalls / toolNames[] / answer / stopReason?`。`toolNames` 为返回时刻的快照，后续事件不再修改它。

## Metric 累加（纯函数，可独立测试）

`parseAgentEvent(event, acc)`：

- `message_end`：仅统计 `role === "assistant"`；缺 `usage`/缺字段（input/output/cacheRead/totalTokens/cost）一律按 0 计，不抛错；`content` 仅拼 `type === "text"`，缺 content 不崩；记录 `stopReason` 与 `answer`。
- `turn_end`：turns+1；`tool_execution_start`：toolCalls+1 并记录 toolName。

`makeOverride(excludes?)`：

- `excludes` 为空/未传 → 返回 `undefined`（不做过滤）。
- 过滤时按 `e.path` 与 `e.resolvedPath` 的 path 子串匹配；两者任一缺失时视为不匹配该项，绝不抛 TypeError；`base.extensions` 缺失或为空时按空列表处理。

## 会话驱动（资源生命周期）

- 超时定时器在以下两条路径都必须被清理，不得遗留 dangling setTimeout：
  1. 正常结束（agent_settled）；
  2. `sendUserMessage` 抛错（会话已中止/内部错误）。
- `session.abort()` 可能同步抛错，必须防护。
- headless 路径：先 await `session.dispose()`，再 `rmSync(sessionDir)`，避免异步清理与目录删除竞态；异常路径同样清理。
- live 路径：任务跑完即 abort 停 agent；`keepAlive: false` 时 `stopChild` 销毁并清理临时 sessionDir，`keepAlive: true` 保留 transcript 供切换查看/续聊。
- 会话跑完后（settled）不再累计指标/触发 onEvent，防止 keepAlive 会话后续事件污染结果。
