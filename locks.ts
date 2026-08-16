// pi-msessions 路径锁纯逻辑：跨会话文件写冲突拦截（来自 live.ts 拆分）。
// 无 pi/live 依赖，可独立测试。

import os from "node:os";
import path from "node:path";

export function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

/** 从工具调用推断可能被写入的路径（write/edit 目标 + bash 重定向/破坏性命令）。 */
export function inferToolPaths(toolName: string, input: any): string[] {
	const paths = new Set<string>();
	if (toolName === "write" || toolName === "edit") {
		const p =
			asString(input?.path) ||
			asString(input?.file_path) ||
			asString(input?.filePath);
		if (p) paths.add(p);
	}
	if (toolName === "bash") {
		const command = asString(input?.command) || "";
		const redir = [...command.matchAll(/(?:>|>>|2>|&>)\s*([^\s;&|]+)/g)].map(
			(m) => m[1],
		);
		for (const p of redir) {
			if (p && !p.startsWith("/dev/")) paths.add(p.replace(/^["']|["']$/g, ""));
		}
		const mutating =
			/\b(rm|mv|cp|touch|mkdir|rmdir|chmod|chown|install|tee|sed\s+-i|perl\s+-i|python\b.*\b(open|write)|node\b.*writeFile)\b/.test(
				command,
			);
		if (mutating) {
			const tokens = command.match(/(?:\.\.?|~|\/)?[\w@%+=:,./-]+/g) || [];
			for (const token of tokens) {
				if (token.includes("/") || token.startsWith("."))
					paths.add(token.replace(/^["']|["']$/g, ""));
			}
			if (paths.size === 0) paths.add(".");
		}
	}
	return [...paths];
}

export function normalizeLockPath(p: string, cwd: string): string | null {
	if (!p || typeof p !== "string") return null;
	if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
	return path.resolve(cwd || process.cwd(), p);
}

/** a 与 b 是否互为祖先/相同路径（含目录前缀语义）。 */
export function pathsConflict(a: string, b: string): boolean {
	const ar = a.endsWith(path.sep) ? a : a + path.sep;
	const br = b.endsWith(path.sep) ? b : b + path.sep;
	return a === b || a.startsWith(br) || b.startsWith(ar);
}

/** 会话级路径锁：一个会话持有路径期间，其他会话的冲突写入被拦截。 */
export type LockAcquireResult =
	| { ok: true; paths: string[] }
	| {
			ok: false;
			conflicts: { path: string; heldPath: string; by: string }[];
		};

export class LockManager {
	locks = new Map<string, { sessionId: string; acquiredAt: number }>();
	heldByToolCall = new Map<string, { sessionId: string; paths: string[] }>();

	acquire(sessionId: string, rawPaths: string[], cwd: string): LockAcquireResult {
		const paths = [
			...new Set(
				(rawPaths || [])
					.map((p) => normalizeLockPath(p, cwd))
					.filter((p): p is string => !!p),
			),
		].sort();
		const conflicts = [];
		for (const p of paths) {
			for (const [held, info] of this.locks.entries()) {
				if (info.sessionId !== sessionId && pathsConflict(p, held)) {
					conflicts.push({ path: p, heldPath: held, by: info.sessionId });
				}
			}
		}
		if (conflicts.length) return { ok: false, conflicts };
		const acquiredAt = Date.now();
		for (const p of paths) this.locks.set(p, { sessionId, acquiredAt });
		return { ok: true, paths };
	}

	release(sessionId: string, rawPaths?: string[]) {
		const wanted = rawPaths?.length ? new Set(rawPaths) : null;
		const released = [];
		for (const [p, info] of this.locks.entries()) {
			if (info.sessionId === sessionId && (!wanted || wanted.has(p))) {
				this.locks.delete(p);
				released.push(p);
			}
		}
		return released;
	}

	releaseByToolCall(toolCallId: string) {
		const held = this.heldByToolCall.get(toolCallId);
		if (!held) return [];
		this.heldByToolCall.delete(toolCallId);
		return this.release(held.sessionId, held.paths);
	}
}
