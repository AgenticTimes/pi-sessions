// pi-msessions 会话主机：进程内 live 会话注册表 + 激活/切换 + 子会话生命周期（来自 live.ts 拆分）。
// 依赖 locks.ts（路径锁）、adapter.ts（UI 适配器）、runtime.ts（createRuntime + 继承）。

import fs from "node:fs";
import path from "node:path";
import {
	createAgentSessionRuntime,
	getAgentDir,
	InteractiveMode,
	SessionManager,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { LockManager } from "./locks.ts";
import { InteractiveModeAdapter, resetExtendedKeyboardModesForHandoff } from "./adapter.ts";
import {
	createRuntime,
	runtimeInheritanceBySessionManager,
	safeCollectRuntimeInheritance,
	setActiveChildInheritanceProvider,
} from "./runtime.ts";

export const PARENT_SESSION_ID = "__parent__";
const HOST_KEY = "__PI_SESSIONS_HOST__";

export type Activity = "idle" | "working" | "waiting";
export type LiveState =
	| "active"
	| "suspended"
	| "starting"
	| "stopped"
	| "error";
export type WorkingIndicatorOptions = { frames?: string[]; intervalMs?: number };

export type LiveSessionRecord = {
	id: string;
	kind: "parent" | "child";
	name: string;
	cwd: string;
	state: LiveState;
	activity: Activity;
	sessionFile?: string;
	sessionId?: string;
	parentSessionFile?: string;
	parentLeafId?: string | null;
	createdAt: number;
	lastActivityAt: number;
	status?: string;
	transcript?: string;
	runtime?: any;
	mode?: any;
	adapter?: InteractiveModeAdapter;
	sessionManager?: any;
	context?: ExtensionCommandContext;
	inheritance?: any;
	started?: boolean;
	runPromise?: Promise<void>;
	expectedStop?: boolean;
	error?: string;
	pid?: number;
};

function readFirstMessage(filePath: string | undefined): string {
	if (!filePath) return "";
	try {
		const content = fs.readFileSync(filePath, "utf8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type !== "message") continue;
				const msg = entry.message;
				if (!msg || msg.role !== "user") continue;
				const text =
					typeof msg.content === "string"
						? msg.content
						: Array.isArray(msg.content)
							? msg.content
									.filter((p: any) => p.type === "text")
									.map((p: any) => p.text)
									.join(" ")
							: "";
				if (text.trim()) return text.trim().slice(0, 200);
			} catch {}
		}
	} catch {}
	return "";
}

function resolveTranscriptName(
	sessionName?: string,
	sessionFile?: string,
): string {
	return sessionName || readFirstMessage(sessionFile) || "";
}

function sanitizeName(name: string): string {
	return (
		String(name || "")
			.trim()
			.replace(/[^a-zA-Z0-9_.-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64) || `session-${Date.now().toString(36)}`
	);
}

export class PiSessionsHost {
	activeId = PARENT_SESSION_ID;
	records = new Map<string, LiveSessionRecord>();
	subscribers = new Set<() => void>();
	locks = new LockManager();
	parentTui: any = null;
	parentDone: (() => void) | null = null;
	parentHandoffActive = false;
	activationInProgress: Promise<void> | null = null;
	queuedActivation: string | null = null;
	workingIndicator: WorkingIndicatorOptions | undefined = undefined;

	constructor() {
		this.records.set(PARENT_SESSION_ID, {
			id: PARENT_SESSION_ID,
			kind: "parent",
			name: "parent",
			cwd: process.cwd(),
			state: "active",
			activity: "idle",
			createdAt: Date.now(),
			lastActivityAt: Date.now(),
			status: "parent",
			pid: process.pid,
		});
	}

	get(id: string): LiveSessionRecord | undefined {
		return (
			this.records.get(id) ||
			[...this.records.values()].find((r) => r.name === id)
		);
	}

	subscribe(listener: () => void): () => void {
		this.subscribers.add(listener);
		return () => this.subscribers.delete(listener);
	}

	notify(): void {
		for (const listener of [...this.subscribers]) {
			try {
				listener();
			} catch {}
		}
	}

	publicSession(record: LiveSessionRecord): any {
		return {
			id: record.id,
			name: record.name,
			cwd: record.cwd,
			state: record.state,
			status: record.status || record.state,
			pid: process.pid,
			lastActivityAt: record.lastActivityAt,
			agentStatus: record.activity || "idle",
			transcript: record.transcript || "",
			sessionFile: record.sessionFile || "",
		};
	}

	snapshot(): any {
		return {
			attached: this.activeId,
			updatedAt: Date.now(),
			sessions: this.listLive().map((r) => this.publicSession(r)),
		};
	}

	listLive(): LiveSessionRecord[] {
		const parent = this.records.get(PARENT_SESSION_ID);
		const children = [...this.records.values()].filter(
			(r) => r.kind === "child" && !["stopped", "error"].includes(r.state),
		);
		return [parent, ...children].filter(
			(r): r is LiveSessionRecord => !!r,
		);
	}

	registerParent(ctx: ExtensionCommandContext): void {
		const record = this.records.get(PARENT_SESSION_ID)!;
		record.cwd = ctx.cwd || process.cwd();
		record.context = ctx;
		record.sessionManager = ctx.sessionManager;
		record.sessionFile = ctx.sessionManager?.getSessionFile?.();
		record.sessionId = ctx.sessionManager?.getSessionId?.();
		record.transcript = resolveTranscriptName(
			ctx.sessionManager?.getSessionName?.(),
			record.sessionFile,
		);
		record.lastActivityAt = Date.now();
		if (this.activeId === PARENT_SESSION_ID) record.state = "active";
		this.notify();
	}

	private updateChildFromContext(
		child: LiveSessionRecord,
		ctx: ExtensionCommandContext,
	): LiveSessionRecord {
		child.context = ctx;
		child.cwd = ctx.cwd || child.cwd;
		child.sessionManager = ctx.sessionManager || child.sessionManager;
		child.sessionId = ctx.sessionManager?.getSessionId?.() || child.sessionId;
		child.sessionFile =
			ctx.sessionManager?.getSessionFile?.() || child.sessionFile;
		child.transcript = resolveTranscriptName(
			ctx.sessionManager?.getSessionName?.(),
			child.sessionFile,
		);
		child.lastActivityAt = Date.now();
		this.notify();
		return child;
	}

	bindSessionContext(ctx: ExtensionCommandContext): LiveSessionRecord {
		const sessionId = ctx.sessionManager?.getSessionId?.();
		const sessionFile = ctx.sessionManager?.getSessionFile?.();
		const child = [...this.records.values()].find(
			(r) =>
				r.kind === "child" &&
				(r.sessionManager === ctx.sessionManager ||
					(sessionId && r.sessionId === sessionId) ||
					(sessionFile && r.sessionFile === sessionFile)),
		);
		if (child) return this.updateChildFromContext(child, ctx);

		const parent = this.records.get(PARENT_SESSION_ID)!;
		const isParentContext =
			(sessionId && parent.sessionId === sessionId) ||
			(sessionFile && parent.sessionFile === sessionFile);
		if (isParentContext) {
			this.registerParent(ctx);
			return parent;
		}

		// /new or /resume inside the active child changes session id/file before we
		// can match by identity. Route that replacement to the active child, but only
		// after ruling out the parent context above.
		const activeChild =
			this.activeId !== PARENT_SESSION_ID ? this.get(this.activeId) : null;
		if (activeChild?.kind === "child") {
			return this.updateChildFromContext(activeChild, ctx);
		}

		this.registerParent(ctx);
		return parent;
	}

	updateActivity(ctx: ExtensionCommandContext, activity: Activity): void {
		const record = this.bindSessionContext(ctx);
		record.activity = activity;
		record.lastActivityAt = Date.now();
		this.notify();
	}

	currentContextId(ctx: ExtensionCommandContext): string {
		return this.bindSessionContext(ctx).id;
	}

	async createChildFromContext(
		ctx: ExtensionCommandContext,
		cwd: string,
	): Promise<LiveSessionRecord> {
		this.bindSessionContext(ctx);
		const sessionManager = SessionManager.create(cwd, undefined, {});
		return await this.createRecordForSessionManager({
			name: path.basename(cwd || process.cwd()) || "session",
			cwd,
			sessionManager,
			inheritance: safeCollectRuntimeInheritance(ctx),
		});
	}

	async openSavedSessionAsLive(
		sessionPath: string,
		cwdOverride?: string,
		ctx?: ExtensionCommandContext,
	): Promise<LiveSessionRecord> {
		const existing = [...this.records.values()].find(
			(r) =>
				r.kind === "child" &&
				r.sessionFile === sessionPath &&
				!["stopped", "error"].includes(r.state),
		);
		if (existing) return existing;
		const sessionManager = SessionManager.open(
			sessionPath,
			undefined,
			cwdOverride,
		);
		const cwd = sessionManager.getCwd?.() || cwdOverride || process.cwd();
		const name = sanitizeName(
			sessionManager.getSessionName?.() ||
				path.basename(cwd) ||
				sessionManager.getSessionId?.(),
		);
		return await this.createRecordForSessionManager({
			name,
			cwd,
			sessionManager,
			inheritance: safeCollectRuntimeInheritance(ctx),
		});
	}

	private async createRecordForSessionManager(opts: {
		name: string;
		cwd: string;
		sessionManager: any;
		parent?: LiveSessionRecord;
		inheritance?: any;
		extensionsOverride?: (base: any) => any;
	}): Promise<LiveSessionRecord> {
		// extensionsOverride 随 inheritance 存入 WeakMap，createRuntime 里据此过滤扩展加载
		if (opts.extensionsOverride) {
			opts.inheritance = {
				...(opts.inheritance ?? {}),
				extensionsOverride: opts.extensionsOverride,
			};
		}
		const id = `${sanitizeName(opts.name)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
		const record: LiveSessionRecord = {
			id,
			kind: "child",
			name: sanitizeName(opts.name),
			cwd: opts.cwd,
			state: "starting",
			activity: "idle",
			sessionManager: opts.sessionManager,
			sessionFile: opts.sessionManager.getSessionFile?.(),
			sessionId: opts.sessionManager.getSessionId?.(),
			parentSessionFile: opts.parent?.sessionFile,
			parentLeafId: opts.parent?.sessionManager?.getLeafId?.() || null,
			createdAt: Date.now(),
			lastActivityAt: Date.now(),
			transcript: resolveTranscriptName(
				opts.sessionManager.getSessionName?.(),
				opts.sessionManager.getSessionFile?.(),
			),
			inheritance: opts.inheritance,
		};
		this.records.set(id, record);
		this.notify();
		if (opts.inheritance) {
			runtimeInheritanceBySessionManager.set(
				opts.sessionManager,
				opts.inheritance,
			);
		}
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: opts.cwd,
			agentDir: getAgentDir(),
			sessionManager: opts.sessionManager,
			sessionStartEvent: { type: "session_start", reason: "startup" } as any,
		});
		const mode = new InteractiveMode(runtime, {
			migratedProviders: [],
			modelFallbackMessage: runtime.modelFallbackMessage,
			initialMessage: undefined,
			initialImages: [],
			initialMessages: [],
		});
		record.runtime = runtime;
		record.mode = mode;
		record.adapter = new InteractiveModeAdapter(id, runtime, mode, this);
		record.state = "suspended";
		record.transcript = resolveTranscriptName(
			opts.sessionManager.getSessionName?.(),
			opts.sessionManager.getSessionFile?.(),
		);
		this.notify();
		return record;
	}

	async createLiveSession(opts: {
		cwd: string;
		name?: string;
		sessionDir?: string;
		extensionsOverride?: (base: any) => any;
	}): Promise<LiveSessionRecord> {
		const sessionManager = SessionManager.create(
			opts.cwd,
			opts.sessionDir,
			{},
		);
		return await this.createRecordForSessionManager({
			name:
				(opts.name ?? path.basename(opts.cwd || process.cwd())) || "session",
			cwd: opts.cwd,
			sessionManager,
			extensionsOverride: opts.extensionsOverride,
		});
	}

	async stopChild(nameOrId: string): Promise<void> {
		const record = this.get(nameOrId);
		if (!record || record.kind !== "child")
			throw new Error("session not found");
		const wasActive = this.activeId === record.id;
		record.expectedStop = true;
		record.state = "stopped";
		record.status = "stopped";
		this.locks.release(record.id);
		try {
			if (wasActive) record.adapter?.suspend();
			await record.adapter?.dispose();
		} catch {}
		this.records.delete(record.id);
		this.notify();
		if (wasActive) await this.activate(PARENT_SESSION_ID);
	}

	async activate(targetIdOrName: string): Promise<void> {
		const target = this.get(targetIdOrName);
		if (!target) throw new Error(`session not found: ${targetIdOrName}`);
		if (this.activationInProgress) {
			this.queuedActivation = target.id;
			await this.activationInProgress;
			return;
		}
		this.activationInProgress = this.doActivate(target).finally(() => {
			this.activationInProgress = null;
		});
		await this.activationInProgress;
		const queued = this.queuedActivation;
		this.queuedActivation = null;
		if (queued && queued !== this.activeId) await this.activate(queued);
	}

	private async doActivate(target: LiveSessionRecord): Promise<void> {
		if (target.id === this.activeId) return;
		const current = this.get(this.activeId);
		if (current?.kind === "child") current.adapter?.suspend();
		if (current?.kind === "parent") current.state = "suspended";

		if (target.kind === "parent") {
			this.activeId = PARENT_SESSION_ID;
			target.state = "active";
			try {
				this.parentTui?.terminal?.setProgress?.(false);
				this.parentTui?.start?.();
				this.parentTui?.requestRender?.(true);
			} catch {}
			const done = this.parentDone;
			this.parentTui = null;
			this.parentDone = null;
			this.parentHandoffActive = false;
			this.notify();
			done?.();
			return;
		}

		this.activeId = target.id;
		target.state = "active";
		if (!target.started) target.adapter?.start();
		else target.adapter?.resume();
		this.notify();
	}

	async enterFromParent(
		ctx: ExtensionCommandContext,
		targetId: string,
	): Promise<void> {
		if (this.parentHandoffActive) return this.activate(targetId);
		await ctx.ui.custom(
			(tui: any, _theme: any, _keybindings: any, done: (result?: unknown) => void) => {
				this.parentTui = tui;
				this.parentDone = done;
				this.parentHandoffActive = true;
				try {
					tui.stop();
					resetExtendedKeyboardModesForHandoff();
				} catch {}
				void this.activate(targetId).catch((error) => {
					try {
						tui.start();
						tui.requestRender(true);
					} catch {}
					this.parentHandoffActive = false;
					this.parentTui = null;
					this.parentDone = null;
					ctx.ui.notify(String(error?.message || error), "error");
					done();
				});
				return { render: () => [], invalidate: () => {}, dispose: () => {} };
			},
		);
	}

	async activateFromContext(
		ctx: ExtensionCommandContext,
		targetId: string,
	): Promise<void> {
		const current = this.currentContextId(ctx);
		if (current === PARENT_SESSION_ID && targetId !== PARENT_SESSION_ID) {
			await this.enterFromParent(ctx, targetId);
		} else {
			await this.activate(targetId);
		}
	}
}

/** 取进程内全局 host 实例（能力检测复用，防 jiti 双实例分裂重建丢 records）。 */
export function getHost(): PiSessionsHost {
	const g = globalThis as any;
	const existing = g[HOST_KEY];
	// 子会话/多实例/重载都会以新模块实例执行本文件，instanceof 永远不成立，
	// 会导致 getHost 把仍在使用的 host 误判为旧代码而重建副本：
	// 副本的 activeId/parentTui 是迁移时的旧值（父会话），子会话里切换回父会话
	// 会因 targetToActivate === host.activeId 被静默 no-op（"切不回去"）。
	// 按能力判断：现有 host 只要还具备当前 API（createLiveSession）就直接复用。
	if (existing && typeof existing.createLiveSession === "function") {
		return existing;
	}
	const fresh = new PiSessionsHost();
	// 重建时迁移旧 host 的 records（父 + 子），否则 /reload 或共享 HOST_KEY 的
	// 双实例会让切换器里的父会话/子会话全部"消失"（父 session 在 Ctrl-R 看不到的根因之一）
	if (existing?.records instanceof Map) {
		for (const [id, record] of existing.records) {
			fresh.records.set(id, record);
			if (record?.adapter?.host) record.adapter.host = fresh;
		}
		fresh.activeId = existing.activeId ?? PARENT_SESSION_ID;
		fresh.parentTui = existing.parentTui ?? null;
		fresh.parentDone = existing.parentDone ?? null;
	}
	g[HOST_KEY] = fresh;
	return fresh;
}

// /new、/resume 在子会话内创建新 SessionManager 时 WeakMap 继承丢失；
// 通过 DI seam 把活跃子会话的继承解析注册给 runtime.ts（调用时点解析，无初始化期循环）。
setActiveChildInheritanceProvider((sessionManager: any) => {
	const host = getHost();
	const activeRecord =
		host.activeId !== PARENT_SESSION_ID ? host.get(host.activeId) : null;
	if (activeRecord?.kind === "child") {
		const inheritance =
			activeRecord.inheritance ??
			safeCollectRuntimeInheritance(activeRecord.context);
		activeRecord.inheritance = inheritance;
		return inheritance;
	}
	return undefined;
});
