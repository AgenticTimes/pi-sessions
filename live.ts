// pi-msessions 入口胶水层：/msessions 命令、Ctrl-R、事件绑定、widget 安装。
// 拆分后仅保留编排职责；host/锁/适配器/运行时见 host.ts / locks.ts / adapter.ts / runtime.ts。

import {
	InteractiveMode,
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SessionWidget, showSessionsView } from "./ui.ts";
import { getHost, PARENT_SESSION_ID, type PiSessionsHost, type WorkingIndicatorOptions } from "./host.ts";
import { inferToolPaths } from "./locks.ts";

const INTERACTIVE_MODE_SPINNER_PATCHED = Symbol.for(
	"pi-msessions.interactiveMode.spinnerPatched",
);

type CommandContext = ExtensionCommandContext;

function patchInteractiveModeWorkingIndicator(host: PiSessionsHost): void {
	const proto = (InteractiveMode as any)?.prototype;
	if (
		!proto ||
		proto[INTERACTIVE_MODE_SPINNER_PATCHED] ||
		typeof proto.setWorkingIndicator !== "function"
	) {
		return;
	}
	const original = proto.setWorkingIndicator;
	proto.setWorkingIndicator = function (options?: WorkingIndicatorOptions) {
		const source = [...host.records.values()].find((record) => record.mode === this);
		const teardownReset =
			options === undefined &&
			source !== undefined &&
			(source.expectedStop === true ||
				source.state === "stopped" ||
				source.state === "error");
		if (!teardownReset) {
			host.workingIndicator = options;
			host.notify();
		}
		return original.call(this, options);
	};
	proto[INTERACTIVE_MODE_SPINNER_PATCHED] = true;
}

function installWidget(ctx: CommandContext, host: PiSessionsHost): void {
	ctx.ui.setWidget("pi-msessions", (tui: any, theme: any) => {
		const requestRender = () => tui.requestRender();
		const unsubscribe = host.subscribe(requestRender);
		const widget = new SessionWidget(
			theme,
			() => host.snapshot(),
			requestRender,
			() => host.workingIndicator,
		);
		return {
			render: (width: number) => widget.render(width),
			invalidate: () => widget.invalidate(),
			dispose: () => {
				unsubscribe();
				widget.dispose();
			},
		};
	});
}

async function getResumeSessions(): Promise<any[]> {
	const sessions = await SessionManager.listAll();
	return sessions.sort(
		(a: any, b: any) => Number(b.modified) - Number(a.modified),
	);
}

async function openSessions(
	ctx: CommandContext,
	host: PiSessionsHost,
): Promise<void> {
	let targetToActivate: string | null = null;
	let targetToKill: string | null = null;
	await showSessionsView(ctx, {
		getSessions: async () =>
			host.listLive().map((record) => host.publicSession(record)),
		getResumeSessions,
		getAttached: () => host.activeId,
		getCwd: () => ctx.cwd || process.cwd(),
		// 渲染某会话的真实聊天组件（LLM 输出 UI）：光标移动时切换器主区实时显示
		getSessionChat: (id: string, width: number) => {
			const record = host.get(id === "parent" ? PARENT_SESSION_ID : id);
			const doc = (record?.mode as any)?.documentContainer;
			try {
				return typeof doc?.render === "function"
					? (doc.render(width) as string[])
					: [];
			} catch {
				return [];
			}
		},
		switchTo: async (id: string) => {
			const target = host.get(id === "parent" ? PARENT_SESSION_ID : id);
			if (!target) throw new Error(`session not found: ${id}`);
			targetToActivate = target.id;
		},
		newSession: async () => {
			const child = await host.createChildFromContext(
				ctx,
				ctx.cwd || process.cwd(),
			);
			targetToActivate = child.id;
		},
		newSessionInFolder: async (cwd: string) => {
			const child = await host.createChildFromContext(ctx, cwd);
			targetToActivate = child.id;
		},
		resumeSession: async (sessionPath?: string) => {
			if (!sessionPath) {
				const sessions = await getResumeSessions();
				sessionPath = sessions[0]?.path;
			}
			if (!sessionPath) throw new Error("No saved sessions found");
			const child = await host.openSavedSessionAsLive(
				sessionPath,
				undefined,
				ctx,
			);
			targetToActivate = child.id;
		},
		killSession: async (id: string) => {
			targetToKill = id;
		},
		notify: (message: string, type?: "info" | "warning" | "error") =>
			ctx.ui.notify(message, type || "info"),
	});
	if (targetToKill) {
		await host.stopChild(targetToKill);
		return;
	}
	if (!targetToActivate || targetToActivate === host.activeId) return;
	await host.activateFromContext(ctx, targetToActivate);
}

/** 取进程内全局 host 实例（供 api.ts / 其他插件使用）。 */
export function getLiveHost(): PiSessionsHost {
	return getHost();
}

/** 注册 live 会话 UI：/msessions 切换器 + Ctrl-R + 事件绑定。 */
export function registerLiveUi(pi: ExtensionAPI) {
	const host = getHost();
	patchInteractiveModeWorkingIndicator(host);

	// pi 的 ExtensionAPI.on 类型仅收录 "input" 事件；其余事件（session_start 等）运行时真实存在，
	// 但 .d.ts 未覆盖 —— 边界单点 any 桥接（务实类型策略）。
	const on = (pi as any).on.bind(pi) as (
		event: string,
		handler: (event: any, ctx: any) => any,
	) => void;

	pi.registerCommand("msessions", {
		description: "Open the pi-msessions switcher (切换 live 子会话)",
		handler: async (_args: string, ctx: CommandContext) =>
			openSessions(ctx, host),
	});

	pi.registerShortcut("ctrl+r", {
		description: "Open msessions switcher",
		// shortcut 回调上下文是 ExtensionContext（非命令上下文），运行时含 cwd/sessionManager/ui，
		// 按命令上下文使用 — 边界 any 桥接。
		handler: async (ctx: ExtensionContext) =>
			openSessions(ctx as unknown as CommandContext, host),
	});

	on("session_start", (_event: any, ctx: CommandContext) => {
		host.bindSessionContext(ctx);
		installWidget(ctx, host);
	});

	on("agent_start", (_event: any, ctx: CommandContext) => {
		host.updateActivity(ctx, "working");
	});

	on("agent_end", (_event: any, ctx: CommandContext) => {
		host.updateActivity(ctx, "idle");
	});

	on("tool_call", async (event: any, ctx: CommandContext) => {
		const record = host.bindSessionContext(ctx);
		const paths = inferToolPaths(event.toolName, event.input);
		if (!paths.length) return undefined;
		const result = host.locks.acquire(record.id, paths, ctx.cwd || record.cwd);
		if (result.ok === false) {
			return {
				block: true,
				reason: `pi-msessions path lock conflict: ${JSON.stringify(result.conflicts)}`,
			};
		}
		host.locks.heldByToolCall.set(event.toolCallId, {
			sessionId: record.id,
			paths: result.paths,
		});
		return undefined;
	});

	on("tool_result", async (event: any, ctx: CommandContext) => {
		host.locks.releaseByToolCall(event.toolCallId);
		const record = host.bindSessionContext(ctx);
		if (record.activity === "waiting") {
			record.activity = "working";
			record.lastActivityAt = Date.now();
			host.notify();
		}
		return undefined;
	});

	on("session_shutdown", (_event: any, ctx: CommandContext) => {
		const record = host.bindSessionContext(ctx);
		host.locks.release(record.id);
		try {
			ctx.ui.setWidget("pi-msessions", undefined);
		} catch {}
		host.notify();
	});
}
