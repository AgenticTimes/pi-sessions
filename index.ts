// pi-msessions 插件入口：live 多会话 UI（/msessions 切换器 + Ctrl-R）+ 编程式多会话 API。
// 其他插件通过 globalThis[Symbol.for("pi.msessions")] 调用：
//   const api = (globalThis as any)[Symbol.for("pi.msessions")];
//   const r = await api.run({ cwd, prompt, visible: true, keepAlive: false, excludeExtensions: ["pi-simplify"] });

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLiveUi } from "./live.ts";
import { runSubsession, type SubsessionOptions, type SubsessionResult } from "./api.ts";

export const API_KEY: unique symbol = Symbol.for("pi.msessions");

export interface PiSessionsApi {
	run(opts: SubsessionOptions): Promise<SubsessionResult>;
}

export default function (pi: ExtensionAPI) {
	// live 会话 UI：/msessions 切换器、Ctrl-R、事件绑定、路径锁
	registerLiveUi(pi);
	// 编程 API：其他插件可创建/驱动子会话（visible=true 时可切换交互）
	(globalThis as any)[API_KEY] = { run: runSubsession } satisfies PiSessionsApi;
}
