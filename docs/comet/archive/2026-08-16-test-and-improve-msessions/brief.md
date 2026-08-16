# Outcome

pi-msessions 插件经过完整测试（单测 + 真实 LLM 冒烟）并修复审查/测试发现的缺陷，补上缺失的边界单测；对外 API 行为不变。

# Scope

- 运行并记录全部现有测试：`npm test`（4 单测）、`npm run typecheck`、真实 LLM 冒烟（headless + live 两条链路）。
- 修复代码审查发现的具体缺陷：
  1. `metrics.ts makeOverride`：`e.resolvedPath.includes(x)` 未防护 `resolvedPath`/`path` 缺失，且 `base.extensions` 可能为 undefined → 扩展加载时可能 TypeError 炸掉整个子会话。
  2. `api.ts driveSession`：`sendUserMessage` 抛错时超时定时器不被清理（dangling setTimeout），且 `session.abort()` 同步抛错无防护。
  3. `api.ts runHeadless`：`session.dispose()` 未 await 就直接 `rmSync(sessionDir)`，异步清理与目录删除存在竞态。
- 补齐边界单测（只测纯函数，不引入 pi/live 链）：
  - `makeOverride`：无 excludes → undefined；按 path 子串过滤；`resolvedPath`/`path` 缺失不抛错；`extensions` 为空数组。
  - `toResult`：toolNames 快照不可变（toResult 后修改 acc 不影响已返回结果）。
  - `parseAgentEvent`：缺 usage 字段、缺 content 不崩。
- 全部测试/冒烟/typecheck 复跑通过，无回归。

# Non-goals

- 不改编程 API 的对外签名与语义（run 的选项/返回结构保持兼容）。
- 不做 API 增强（list/cancel/status 等新能力）、不去 `@ts-nocheck`、不做 input tokens 裁剪 —— 均属后续独立变更。
- 不改 live 切换 UI 的行为与快捷键。
- 不改变 headless 路径 `projectTrusted: true` 的信任模型（API 调用方显式委托，属有意设计）。

# Acceptance examples

- A1: `npm test` 全绿，且新增用例覆盖 makeOverride 缺字段不抛错、toResult 快照不可变、parseAgentEvent 缺字段不崩。
- A2: 代码审查确认 `driveSession` 在 sendUserMessage 抛错与正常结束两条路径都清理超时定时器；abort 同步抛错被防护；`runHeadless` 在 rmSync 前 await dispose。
- A3: 真实 LLM 冒烟 headless 与 live 均 `ok: true` 且 `answer === "OK"`。
- A4: `npm run typecheck` 干净；原有 4 个单测仍通过；smoke 无回归。
- A5: 提交仅含本次变更相关文件（不含 .build/、.comet/ 等非交付物）。

# Constraints and invariants

- 不修改 `live.ts`/`ui.ts` 的行为逻辑（本次只动 metrics.ts / api.ts / test）。
- 保持 @ts-nocheck 现状（去类型化属 non-goal）。
- api.ts 的 SubsessionOptions/SubsessionResult 签名不变。

# Decisions

- D1: 完善方向 = 测试加固 + 修 bug（用户"继续"，采纳推荐选项 1）；真实 LLM 冒烟默认执行（用户已知会花少量 token）。
- D2: 语言用 zh-CN（与用户交流语言、README 一致）。
- D3: 隔离模式 = current（仓库未提交内容仅 Comet 自身托管状态，无并行意图）。
- D4: headless 强制 projectTrusted: true 保持现状（显式 API 委托，见 Non-goals）。

# Open questions
# Verification expectations

- 单测：`npm test`（node --test）全绿。
- 类型：`npm run typecheck` 干净。
- 端到端：`node .build/scripts/smoke.js` 与 `node .build/scripts/smoke-live.js` 均 ok:true。
- 由独立只读 Verifier 按 A1–A5 逐项验收。
