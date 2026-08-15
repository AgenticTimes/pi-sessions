// 端到端冒烟：真实创建子会话跑一次 prompt，验证 runSubsession 全链路（真实 LLM，可选）。
// 运行: node scripts/smoke.ts

import { runSubsession } from "../api.ts";

const r = await runSubsession({
	cwd: process.cwd(),
	prompt: "只回复 OK 两个字，不要调用任何工具，不要读文件。",
	excludeExtensions: ["pi-simplify"],
	timeoutSec: 120,
});
console.log(JSON.stringify(r, null, 2));
process.exit(r.ok ? 0 : 1);
