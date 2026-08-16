// 回归测试：删除曾运行过的子会话（stopChild）不得向共享终端写控制序列/残留输入监听。
// 覆盖 adapter.dispose 的 renderer.mode 修复（防止 stopInteractiveTui 的 switchTuiMode 污染终端）。
// 运行: node --test test/dispose.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { getHost } from "../host.ts";

test("stopChild 不写控制序列、无 stdin 监听残留", async () => {
	const host = getHost();
	const stdoutWrites: string[] = [];
	const origWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk: any, ...rest: any[]) => {
		const s = String(chunk);
		if (s.includes("\x1b[")) stdoutWrites.push(s);
		return origWrite(chunk, ...rest);
	};
	const rec = await host.createLiveSession({ cwd: process.cwd(), name: "diag" });
	// 模拟会话曾 start 过（isInitialized=true → stop() 会走 stopInteractiveTui 的 fullscreen 分支）
	(rec.mode as any).isInitialized = true;
	await host.stopChild(rec.id);
	assert.equal(process.stdin.listenerCount("data"), 0, "stdin 监听残留");
	assert.equal(stdoutWrites.length, 0, `删除时向共享终端写入控制序列: ${JSON.stringify(stdoutWrites)}`);

	// InteractiveMode 构造会留下未清理的 open handles（timer/stdin buffer），测试断言后强制退出
	process.exit(0);
});
