// pi-msessions 单测：parseAgentEvent 指标累加逻辑。
// 运行: node --test test/api.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	emptyMetrics,
	makeOverride,
	parseAgentEvent,
	toResult,
	type MetricsAcc,
} from "../metrics.ts";

test("parseAgentEvent: message_end 累加 usage 与 answer", () => {
	const acc = emptyMetrics();
	parseAgentEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 100, output: 50, cacheRead: 10, totalTokens: 160, cost: { total: 0.001 } },
				stopReason: "end_turn",
				content: [{ type: "text", text: "hello" }, { type: "text", text: " world" }],
			},
		},
		acc,
	);
	assert.equal(acc.inputTokens, 100);
	assert.equal(acc.outputTokens, 50);
	assert.equal(acc.cacheReadTokens, 10);
	assert.equal(acc.totalTokens, 160);
	assert.equal(acc.cost, 0.001);
	assert.equal(acc.stopReason, "end_turn");
	assert.equal(acc.answer, "hello world");
});

test("parseAgentEvent: turn_end / tool_execution_start 计数", () => {
	const acc = emptyMetrics();
	parseAgentEvent({ type: "turn_end" }, acc);
	parseAgentEvent({ type: "turn_end" }, acc);
	parseAgentEvent({ type: "tool_execution_start", toolName: "bash" }, acc);
	parseAgentEvent({ type: "tool_execution_start", toolName: "read" }, acc);
	assert.equal(acc.turns, 2);
	assert.equal(acc.toolCalls, 2);
	assert.deepEqual(acc.toolNames, ["bash", "read"]);
});

test("parseAgentEvent: 非 assistant 消息忽略", () => {
	const acc = emptyMetrics();
	parseAgentEvent(
		{ type: "message_end", message: { role: "user", usage: { input: 999 } } },
		acc,
	);
	assert.equal(acc.totalTokens, 0);
});

test("toResult: 聚合结果", () => {
	const acc = emptyMetrics();
	acc.turns = 3;
	const r = toResult(acc, true, undefined, 1234);
	assert.equal(r.ok, true);
	assert.equal(r.turns, 3);
	assert.equal(r.timeMs, 1234);
});

test("toResult: toolNames 快照不可变（返回后修改 acc 不影响结果）", () => {
	const acc = emptyMetrics();
	acc.toolNames.push("bash", "read");
	const r = toResult(acc, true, undefined);
	acc.toolNames.push("write"); // 模拟 keepAlive 会话后续事件继续 push
	assert.deepEqual(r.toolNames, ["bash", "read"]);
});

test("makeOverride: 无 excludes 返回 undefined（不做过滤）", () => {
	assert.equal(makeOverride(), undefined);
	assert.equal(makeOverride([]), undefined);
});

test("makeOverride: 按 path 子串过滤", () => {
	const filter = makeOverride(["pi-simplify"])!;
	const base = {
		extensions: [
			{ path: "/x/pi-simplify/index.js", resolvedPath: "/x/pi-simplify/index.js" },
			{ path: "/x/pi-msessions/index.js", resolvedPath: "/x/pi-msessions/index.js" },
		],
	};
	const out = filter(base);
	assert.deepEqual(
		out.extensions.map((e: any) => e.path),
		["/x/pi-msessions/index.js"],
	);
});

test("makeOverride: 缺 path/resolvedPath 不抛 TypeError", () => {
	const filter = makeOverride(["pi-simplify"])!;
	const out = filter({
		extensions: [
			{ path: "/x/pi-simplify/index.js" }, // 缺 resolvedPath
			{ resolvedPath: "/x/pi-simplify/index.js" }, // 缺 path
			{ path: "/x/a.js", resolvedPath: undefined }, // resolvedPath 为 undefined
		],
	});
	assert.equal(out.extensions.length, 1);
	assert.equal(out.extensions[0].path, "/x/a.js");
});

test("makeOverride: base.extensions 缺失/为空按空列表处理", () => {
	const filter = makeOverride(["pi-simplify"])!;
	assert.deepEqual(filter({}).extensions, []);
	assert.deepEqual(filter({ extensions: undefined }).extensions, []);
});

test("parseAgentEvent: 缺 usage/缺字段不崩、按 0 计", () => {
	const acc = emptyMetrics();
	parseAgentEvent(
		{ type: "message_end", message: { role: "assistant" } }, // 无 usage 无 content
		acc,
	);
	assert.equal(acc.totalTokens, 0);
	assert.equal(acc.cost, 0);
	assert.equal(acc.answer, "");
	parseAgentEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 5, cost: {} }, // cost 无 total
			},
		},
		acc,
	);
	assert.equal(acc.inputTokens, 5);
	assert.equal(acc.cost, 0);
});
