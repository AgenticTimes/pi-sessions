# Outcome

pi-msessions 代码结构重构：`live.ts`（1114 行）按职责拆分为独立模块，`ui.ts` 与拆分后文件全部去掉 `@ts-nocheck`，补上内部类型（pi API 边界保留 `any`）。行为零变化，全部测试/冒烟/typecheck 通过。

# Scope

- 拆分 `live.ts` → 5 个模块（行为纯搬迁 + 类型标注，不改逻辑）：
  - `locks.ts`：LockManager + 路径工具（normalizeLockPath / pathsConflict / inferToolPaths / asString）
  - `adapter.ts`：InteractiveModeAdapter + terminal gate + resetExtendedKeyboardModesForHandoff
  - `host.ts`：PiSessionsHost（records/激活/切换/enterFromParent/createChild/openSaved/createLive/stopChild/bindSessionContext/updateActivity）+ LiveSessionRecord 类型
  - `runtime.ts`：createRuntime + 继承解析（loadModelResolver / resolveChildSessionOptions / createInheritedSettingsManager / collectRuntimeInheritance / runtimeInheritanceBySessionManager WeakMap）
  - `live.ts`：薄胶水层（registerLiveUi / openSessions / getLiveHost 再导出 / widget 安装 / 事件绑定）
- `ui.ts` 去 `@ts-nocheck`：用 pi-tui 导出类型（Component/Focusable/Input/Key/matchesKey/fuzzyFilter/truncateToWidth/visibleWidth/getKeybindings）标注现有类与函数；保持单文件（本次只补类型不拆分）。
- `api.ts` 的 `import { getLiveHost } from "./live.ts"` 保持可用（live.ts 再导出）。
- 类型策略：内部结构（LiveSessionRecord/SessionInfo/SessionsActions/WidgetSnapshot 等）完整类型化；pi 内部 API 边界（CommandContext 细节、事件 payload、InteractiveMode 运行时对象）用 `any` + 局部接口，不追求全 strict。
- 验收：行为无回归（单测 10/10、typecheck 干净、headless+live 真实 LLM 冒烟 ok:true）、无 @ts-nocheck 残留、模块职责边界清晰。

# Non-goals

- 不改任何运行时行为/API 签名/UI 行为——纯结构移动 + 类型。
- 不新增功能、不修新 bug（除非是拆文件中必然暴露的纯类型错误）。
- 不做 PTY 交互 UI 测试（已知不稳定，且本变更不改 UI 行为）。
- 不拆分 ui.ts（补类型即可，拆分留待后续）。
- 不引入 strict 全量类型（pi 内部 API 类型不完整，边界用 any 是务实选择）。

# Acceptance examples

- A1: `live.ts` 拆分为 locks/adapter/host/runtime/live 五个模块，职责边界清晰（无循环依赖，host 依赖 locks+adapter，runtime 独立，live.ts 仅胶水）。
- A2: 所有源文件（含 ui.ts）无 `@ts-nocheck` 残留；`npm run typecheck` 干净。
- A3: 行为无回归：`npm test` 10/10；headless + live 真实 LLM 冒烟均 ok:true 且 answer="OK"。
- A4: `api.ts`/`index.ts`/冒烟脚本的导入路径不变（对外契约不变），live.ts 对 getLiveHost 再导出。
- A5: 拆分后代码与拆分前逻辑等价（Verifier 对照 diff 审查：无逻辑改动，仅搬移+类型）。

# Constraints and invariants

- 保持静态 import（api.ts 静态 import live.ts 链，防 host 双实例分裂）——拆分后模块间仍静态互连。
- 注释语言中文、UI 字符串英文，保持现状。
- HOST_KEY / Symbol.for("pi.msessions") 全局键不变。
- @ts-nocheck 移除后不得为了过编译而静默改行为（如把 undefined 判断改成 !! 短路）。

# Decisions

- D1: 用户确认推进"去 @ts-nocheck + 拆文件"方向（回应"好"）。
- D2: ui.ts 只补类型不拆分（用户原话"给 ui.ts 补类型"）。
- D3: 类型策略 = 内部结构类型化 + pi 边界 any（务实，非全 strict）。
- D4: 不做 PTY UI 测试（不稳定），验证靠 typecheck + 单测 + 冒烟 + Verifier 对照 diff。
- D5: 隔离模式 current（工作区干净，无并行意图）。

# Open questions
# Verification expectations

- 单测：`npm test` 10/10。
- 类型：`npm run typecheck` 干净，且 grep 确认无 `@ts-nocheck`。
- 端到端：headless + live 冒烟 ok:true。
- 由独立只读 Verifier 对照 git diff 逐项验收（重点 A5 逻辑等价）。
