import { runSubsession } from "../api.ts";
const r = await runSubsession({
	cwd: process.cwd(),
	prompt: "只回复 OK 两个字，不要调用任何工具，不要读文件。",
	visible: true,
	excludeExtensions: ["pi-simplify"],
	timeoutSec: 120,
});
console.log(JSON.stringify({ ok: r.ok, timeMs: r.timeMs, turns: r.turns, toolCalls: r.toolCalls, cost: r.cost, totalTokens: r.totalTokens, error: r.error, answer: r.answer }, null, 2));
process.exit(r.ok ? 0 : 1);
