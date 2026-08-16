// pi-msessions 会话 UI 适配器：子会话的 InteractiveMode 生命周期管理（来自 live.ts 拆分）。
// 仅类型依赖 host.ts（activeId 判断），无运行时循环依赖。

import type { PiSessionsHost } from "./host.ts";
import type { LiveSessionRecord } from "./host.ts";

/** 切换/挂起时重置终端扩展键盘模式（kitty 上报/CSI 修正），避免跨会话串键。 */
export function resetExtendedKeyboardModesForHandoff(): void {
	try {
		process.stdout.write("\x1b[<999u\x1b[>4;0m");
	} catch {}
}

export type AdapterState =
	| "never-started"
	| "active"
	| "suspended"
	| "stopped";

export class InteractiveModeAdapter {
	state: AdapterState = "never-started";
	private terminalGateInstalled = false;
	private originalSetProgress?: any;
	private originalSetTitle?: any;
	readonly id: string;
	readonly runtime: any;
	readonly mode: any;
	private readonly host: PiSessionsHost;

	constructor(id: string, runtime: any, mode: any, host: PiSessionsHost) {
		this.id = id;
		this.runtime = runtime;
		this.mode = mode;
		this.host = host;
	}

	get ui(): any {
		return (this.mode as any).ui;
	}

	/** 终端进度/标题只在会话活跃时渲染（切走即静默，避免子会话刷父终端）。 */
	installTerminalGate(): void {
		if (this.terminalGateInstalled) return;
		const terminal = this.ui?.terminal;
		if (!terminal) return;
		this.terminalGateInstalled = true;
		this.originalSetProgress = terminal.setProgress?.bind(terminal);
		this.originalSetTitle = terminal.setTitle?.bind(terminal);
		if (this.originalSetProgress) {
			terminal.setProgress = (active: boolean) => {
				if (this.host.activeId === this.id) this.originalSetProgress(active);
			};
		}
		if (this.originalSetTitle) {
			terminal.setTitle = (...args: any[]) => {
				if (this.host.activeId === this.id) this.originalSetTitle(...args);
			};
		}
	}

	start(): void {
		if (this.state !== "never-started") return this.resume();
		this.installTerminalGate();
		this.state = "active";
		const record = this.host.get(this.id);
		if (record) {
			record.started = true;
			record.state = "active";
			record.runPromise = this.mode.run().catch((error: any) => {
				record.state = record.expectedStop ? "stopped" : "error";
				record.error = String(error?.message || error);
				record.status = record.error;
				this.host.locks.release(record.id);
				this.host.notify();
			});
		} else {
			void this.mode.run();
		}
	}

	suspend(): void {
		if (this.state === "stopped") return;
		try {
			this.ui?.stop?.();
			resetExtendedKeyboardModesForHandoff();
		} catch {}
		this.state = "suspended";
		const record = this.host.get(this.id);
		if (record && record.state !== "stopped" && record.state !== "error")
			record.state = "suspended";
	}

	resume(): void {
		if (this.state === "stopped") return;
		this.installTerminalGate();
		try {
			this.ui?.start?.();
			this.ui?.requestRender?.(true);
		} catch {}
		this.state = "active";
		const record = this.host.get(this.id);
		if (record) record.state = "active";
	}

	async dispose(): Promise<void> {
		this.state = "stopped";
		const ui = this.ui;
		const originalUiStop = ui?.stop?.bind(ui);
		const canTouchTerminal = this.host.activeId === this.id;
		try {
			if (ui && originalUiStop && !canTouchTerminal) {
				ui.stop = () => {};
			}
			this.mode?.stop?.();
		} catch {
		} finally {
			if (ui && originalUiStop) ui.stop = originalUiStop;
		}
		try {
			await this.runtime?.dispose?.();
		} catch {}
	}
}

export type { LiveSessionRecord };
