// pi-msessions 核心：在进程内独立子会话里跑一次 prompt，收集指标后返回。
// 通过 extensionsOverride 过滤扩展加载（支持"无插件臂"），不 spawn 子进程。
// parseAgentEvent 为纯函数，可独立测试。

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
// 静态 import（而非 await import）：与 index.ts 共享同一 live.ts 模块实例，避免 host 双实例分裂
import { getLiveHost } from "./live.ts";
import {
	emptyMetrics,
	makeOverride,
	parseAgentEvent,
	toResult,
	type MetricsAcc,
	type SubsessionResult,
} from "./metrics.ts";

export interface SubsessionOptions {
	cwd: string;
	prompt: string;
	/** 超时（秒），默认 600 */
	timeoutSec?: number;
	/** 从子会话排除的全局扩展（按 path 子串匹配），如 ["pi-simplify"] → 无插件臂 */
	excludeExtensions?: string[];
	/** 会话显示名（live 模式） */
	name?: string;
	/** true: 会话注册进 live host（/msessions 可切换可交互）；默认 false = 纯后台 */
	visible?: boolean;
	/** live 模式跑完后保留会话（可切过去继续交互）；默认 false = 跑完销毁 */
	keepAlive?: boolean;
	/** 实时事件回调：每次 agent 事件（turn_end/工具调用等）携带当前累计指标 */
	onEvent?: (event: any, acc: MetricsAcc) => void;
}

export type { SubsessionResult } from "./metrics.ts";
/** 驱动一个已创建会话跑 prompt：订阅事件收集指标，等 agent_settled/超时。 */
async function driveSession(
	session: any,
	prompt: string,
	timeoutSec: number,
	onEvent?: (event: any, acc: MetricsAcc) => void,
): Promise<{ acc: MetricsAcc; ok: boolean; error?: string }> {
	const acc = emptyMetrics();
	let timedOut = false;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let resolveSettled!: () => void;
	const settledPromise = new Promise<void>((r) => (resolveSettled = r));
	const onSettled = () => {
		if (settled) return;
		settled = true;
		if (timer) clearTimeout(timer);
		resolveSettled();
	};
	timer = setTimeout(() => {
		timedOut = true;
		const p = session?.abort?.();
		if (p?.catch) p.catch(() => {});
		onSettled();
	}, timeoutSec * 1000);
	session.subscribe((event: any) => {
		// 跑完后（keepAlive 会话仍活着、可能被切进去互动/续跑）不再累计/上报，
		// 否则结果指标被后续事件污染、进度消息无限刷
		if (settled) return;
		parseAgentEvent(event, acc);
		onEvent?.(event, acc);
		if (event.type === "agent_settled") onSettled();
	});
	await session.sendUserMessage(prompt, { deliverAs: "followUp" });
	await settledPromise;
	const stopErr = acc.stopReason === "error" || acc.stopReason === "aborted";
	return {
		acc,
		ok: !timedOut && !stopErr,
		error: timedOut
			? `超时 (${timeoutSec}s)`
			: stopErr
				? `stopReason=${acc.stopReason}`
				: undefined,
	};
}

/** 在独立子会话里跑一次 prompt，返回指标。
 *  visible=true: 会话注册进 live host（/msessions 可切换、可交互）；keepAlive=false 跑完销毁。
 *  visible=false(默认): 纯后台，用完即销毁（临时 sessionDir，不落盘污染）。 */
export async function runSubsession(opts: SubsessionOptions): Promise<SubsessionResult> {
	const t0 = Date.now();
	if (opts.visible) return runLive(opts, t0);
	return runHeadless(opts, t0);
}

async function runHeadless(
	opts: SubsessionOptions,
	t0: number,
): Promise<SubsessionResult> {
	const timeoutSec = opts.timeoutSec ?? 600;
	const agentDir = getAgentDir();
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-subsession-"));
	let session: any;
	try {
		const settingsManager = SettingsManager.create(opts.cwd, agentDir, {
			projectTrusted: true,
		});
		const services = await createAgentSessionServices({
			cwd: opts.cwd,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				extensionsOverride: makeOverride(opts.excludeExtensions),
			},
		});
		const sessionManager = SessionManager.create(opts.cwd, sessionDir, {});
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
		});
		session = created.session;

		const { acc, ok, error } = await driveSession(
			session,
			opts.prompt,
			timeoutSec,
			opts.onEvent,
		);
		return toResult(acc, ok, error, Date.now() - t0);
	} catch (err) {
		return toResult(
			emptyMetrics(),
			false,
			err instanceof Error ? err.message : String(err),
			Date.now() - t0,
		);
	} finally {
		try {
			session?.dispose?.();
		} catch {}
		rmSync(sessionDir, { recursive: true, force: true });
	}
}

/** visible 模式：会话注册进 live host（/msessions 可切换可交互），keepAlive=false 跑完销毁。 */
async function runLive(
	opts: SubsessionOptions,
	t0: number,
): Promise<SubsessionResult> {
	const host = getLiveHost();
	// live 不可用（旧代码/旧 host 实例/未定义 createLiveSession）→ 降级纯后台，任务照跑
	if (typeof (host as any)?.createLiveSession !== "function") {
		const r = await runHeadless(opts, t0);
		r.error = [r.error, "live 模式不可用(扩展版本过旧?)，已降级纯后台；请 /reload 后重试启用可切换交互"].filter(Boolean).join("; ");
		return r;
	}
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-msession-"));
	let record: any;
	try {
		record = await host.createLiveSession({
			cwd: opts.cwd,
			name: opts.name ?? `msession-${Date.now().toString(36)}`,
			sessionDir,
			extensionsOverride: makeOverride(opts.excludeExtensions),
		});
		const { acc, ok, error } = await driveSession(
			record.runtime.session,
			opts.prompt,
			opts.timeoutSec ?? 600,
			opts.onEvent,
		);
		// 任务跑完即停 agent：防 keepAlive 会话自转烧钱（记录/transcript 保留，
		// 用户切进去查看，要继续聊再发消息 — 成本用户显式触发）
		record.runtime.session?.abort?.().catch?.(() => {});
		if (!opts.keepAlive) {
			await host.stopChild(record.id).catch(() => {});
		}
		return toResult(acc, ok, error, Date.now() - t0);
	} catch (err) {
		if (record?.id) await host.stopChild(record.id).catch(() => {});
		return toResult(
			emptyMetrics(),
			false,
			err instanceof Error ? err.message : String(err),
			Date.now() - t0,
		);
	} finally {
		// keepAlive 会话保留 transcript 供 /msessions 切换查看/续聊；只有销毁式会话才清理
		if (!opts.keepAlive) rmSync(sessionDir, { recursive: true, force: true });
	}
}
