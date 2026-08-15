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
