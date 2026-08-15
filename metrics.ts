// pi-msessions 指标纯函数（无 pi/live 依赖，可独立测试）。
// api.ts 复用；test 只 import 本文件，不触碰 live.ts/ui.ts 链。

export interface SubsessionResult {
	ok: boolean;
	error?: string;
	timeMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	cost: number;
	turns: number;
	toolCalls: number;
	toolNames: string[];
	answer: string;
	stopReason?: string;
}

export interface MetricsAcc {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	cost: number;
	turns: number;
	toolCalls: number;
	toolNames: string[];
	answer: string;
	stopReason?: string;
}

export function emptyMetrics(): MetricsAcc {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		totalTokens: 0,
		cost: 0,
		turns: 0,
		toolCalls: 0,
		toolNames: [],
		answer: "",
	};
}

/** 累加一条 agent 事件到指标（与 pi-ab 解析 --mode json 事件流的逻辑一致）。 */
export function parseAgentEvent(event: any, acc: MetricsAcc): void {
	switch (event.type) {
		case "message_end": {
			const msg = event.message;
			if (!msg || msg.role !== "assistant") break;
			const u = msg.usage;
			if (u) {
				acc.inputTokens += u.input ?? 0;
				acc.outputTokens += u.output ?? 0;
				acc.cacheReadTokens += u.cacheRead ?? 0;
				acc.totalTokens += u.totalTokens ?? 0;
				acc.cost += u.cost?.total ?? 0;
			}
			if (msg.stopReason) acc.stopReason = msg.stopReason;
			if (Array.isArray(msg.content)) {
				acc.answer = msg.content
					.filter((c: any) => c?.type === "text")
					.map((c: any) => c.text ?? "")
					.join("");
			}
			break;
		}
		case "turn_end":
			acc.turns++;
			break;
		case "tool_execution_start":
			acc.toolCalls++;
			if (typeof event.toolName === "string") acc.toolNames.push(event.toolName);
			break;
	}
}

/** 生成扩展过滤函数（按 path 子串排除，无插件臂）。 */
export function makeOverride(
	excludes?: string[],
): ((base: any) => any) | undefined {
	if (!excludes?.length) return undefined;
	return (base: any) => ({
		...base,
		extensions: base.extensions.filter(
			(e: any) =>
				!excludes.some(
					(x) => e.path.includes(x) || e.resolvedPath.includes(x),
				),
		),
	});
}

export function toResult(
	acc: MetricsAcc,
	ok: boolean,
	error?: string,
	timeMs?: number,
): SubsessionResult {
	return {
		ok,
		error,
		timeMs: timeMs ?? 0,
		...acc,
		// 快照：keepAlive 会话跑完后仍活着，后续事件会继续 push 同一数组；
		// 不拷贝的话已返回的结果会被继续修改（报告里的工具数越写越大）
		toolNames: [...acc.toolNames],
	};
}
