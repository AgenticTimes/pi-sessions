# 代码结构（pi-msessions 模块划分）

## Capability

pi-msessions 源码按职责分层组织，全部文件通过 TypeScript 类型检查（无 `@ts-nocheck`），运行时行为与对外契约与重构前完全一致。

## 模块划分

- `locks.ts`：路径锁纯逻辑——`LockManager`（acquire/release/releaseByToolCall）、路径规范化/冲突判定（`normalizeLockPath`/`pathsConflict`）、工具调用路径推断（`inferToolPaths`/`asString`）。无 pi/live 依赖，可独立测试。
- `adapter.ts`：`InteractiveModeAdapter`（start/suspend/resume/dispose + terminal gate 劫持 setProgress/setTitle）+ `resetExtendedKeyboardModesForHandoff`。依赖 host 的 activeId 判断。
- `host.ts`：`PiSessionsHost`——会话注册表（records）、激活/切换（activate/doActivate/enterFromParent/activateFromContext）、子会话创建（createChildFromContext/openSavedSessionAsLive/createLiveSession/createRecordForSessionManager）、销毁（stopChild）、上下文绑定（bindSessionContext/updateActivity/currentContextId/registerParent）、快照/订阅（snapshot/listLive/publicSession/subscribe/notify）。定义 `LiveSessionRecord`/`LiveState`/`Activity` 类型。
- `runtime.ts`：`createRuntime`（CreateAgentSessionRuntimeFactory）——子会话 services 构建、继承解析（collectRuntimeInheritance/safeCollectRuntimeInheritance/createInheritedSettingsManager/resolveChildSessionOptions/loadModelResolver）、`runtimeInheritanceBySessionManager` WeakMap。依赖 host 读取 active 记录。
- `live.ts`：胶水层——`registerLiveUi`（/msessions 命令、Ctrl-R、session_start/agent_start/agent_end/tool_call/tool_result/session_shutdown 事件绑定、widget 安装）、`openSessions` 切换器回调、`getLiveHost` 再导出、`patchInteractiveModeWorkingIndicator`。
- `ui.ts`：切换器 UI（SessionWidget/FileExplorer/ResumeSessionPicker/SessionsView/showSessionsView），单文件，全部类型化。

## 依赖方向

runtime → host → (locks + adapter)；live.ts → host + ui + runtime；api.ts → live.ts（getLiveHost 再导出）+ metrics。无循环依赖；`runtimeInheritanceBySessionManager` WeakMap 为跨模块共享状态，定义在 runtime.ts。

## 类型策略

- 内部结构（LiveSessionRecord、SessionInfo、SessionsActions、WidgetSnapshot、MetricsAcc 等）完整类型化。
- pi 内部 API 边界（CommandContext 内部字段、事件 payload、InteractiveMode 运行时对象）用 `any` 或最小局部接口。
- 不引入 strict 全量；`tsconfig` 维持现状（除 `skipLibCheck` 外不新增严格开关）。

## 行为不变式

- 全局键不变：`HOST_KEY`（`__PI_SESSIONS_HOST__`）、`Symbol.for("pi.msessions")`、`INTERACTIVE_MODE_SPINNER_PATCHED`。
- `api.ts`/`index.ts`/冒烟脚本的 import 路径不变。
- 静态 import 链保持（防 jiti 双实例分裂）；不做运行时行为改动。
