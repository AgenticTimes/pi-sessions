# pi-msessions — 可切换可交互的多会话插件(带编程 API)

一个 pi 进程内跑多个 live 会话:**/msessions 或 Ctrl-R 切换过去完整交互**(看输出、打字、slash 命令,切走后台继续跑);同时提供编程 API,其他插件可创建/驱动子会话并取回指标。fork 自 pi-parallel-sessions(host/切换/路径锁/终端竞争处理),扩展了编程 API 与扩展过滤。

## 用法

```
/msessions                              # 打开会话切换器(输入过滤、↑↓选择、Enter 切换、Ctrl-K 停止)
Ctrl-R                                  # 同上
```

- 切换器里 `Ctrl-O` 选目录新建子会话、`Ctrl-R` 从历史会话恢复为 live、`Ctrl-K` 停止
- 子会话是完整 `InteractiveMode`:切过去 = 完整交互;切走 = TUI 停止、agent 后台继续跑

## 编程 API(其他插件调用)

```ts
const api = (globalThis as any)[Symbol.for("pi.msessions")];
const r = await api.run({
  cwd: "/path/to/workdir",
  prompt: "任务提示词…",
  timeoutSec: 600,
  excludeExtensions: ["pi-simplify"],   // 可选:排除全局扩展(无插件臂)
  visible: true,                        // true=注册进 live host(可切换交互);默认 false=纯后台
  keepAlive: false,                     // live 模式跑完保留会话(可继续交互);默认 false=跑完销毁
  name: "会话显示名",                    // live 模式可选
});
// r: { ok, error?, timeMs, inputTokens, outputTokens, cacheReadTokens,
//      totalTokens, cost, turns, toolCalls, toolNames[], answer, stopReason? }
```

## 工作机制

- `PiSessionsHost`:进程内 live 会话注册表 + 切换(activate/suspend/resume)+ 路径锁
- 子会话 = `createAgentSessionRuntime`(复用主进程模型/凭据)+ `InteractiveMode`(完整 TUI)
- `resourceLoaderOptions.extensionsOverride` 按路径过滤扩展加载 → "无插件臂"
- 订阅 `message_end`/`turn_end`/`tool_execution_start`/`agent_settled` 收集指标
- `keepAlive: false` 跑完 `stopChild` 销毁;`true` 保留可继续交互

## 与 pi-parallel-sessions 的关系

功能是超集(切换 UI + 编程 API + 扩展过滤)。**安装后请把 `npm:pi-parallel-sessions` 从 settings.json packages 移除**,否则 /sessions 与 Ctrl-R 命令冲突。

## 限制

- 子会话加载全部全局扩展,只支持**排除**(exclude),不支持注入未全局安装的插件
- 子会话模型继承主进程默认模型
- input tokens 偏高(~40K,继承完整系统提示/技能/工具),两臂同样重,对比仍公平

## 测试

```
npm test          # parseAgentEvent 指标累加单测
node scripts/smoke-live.ts   # live 端到端冒烟(真实 LLM,可选;需 tsc 编译:见下)
```

冒烟需要 tsc 编译(参数属性限制 node strip-types):
```
./node_modules/.bin/tsc --noEmit false --rewriteRelativeImportExtensions --outDir .build --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --types node --allowImportingTsExtensions scripts/smoke-live.ts
node .build/scripts/smoke-live.js
```
