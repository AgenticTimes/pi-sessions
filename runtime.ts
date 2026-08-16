// pi-msessions 子会话运行时构建：继承解析 + createRuntime（来自 live.ts 拆分）。
// 不 import host.ts（避免循环依赖）：活跃子会话继承的回退通过 setActiveChildInheritanceProvider
// 由 host.ts 在模块初始化时注入（DI seam，调用时点解析，无初始化期循环）。

import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	getAgentDir,
	getPackageDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	SettingsManager,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

type AnyContext = ExtensionCommandContext | Record<string, any>;

let modelResolverPromise: Promise<any> | null = null;
export const runtimeInheritanceBySessionManager = new WeakMap<object, any>();

async function loadModelResolver(): Promise<any> {
	modelResolverPromise ??= import(
		pathToFileURL(path.join(getPackageDir(), "dist/core/model-resolver.js"))
			.href
	);
	return await modelResolverPromise;
}

function sameModel(a: any, b: any): boolean {
	return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

export function hasExistingMessages(sessionManager: any): boolean {
	return (sessionManager.buildSessionContext?.().messages?.length ?? 0) > 0;
}

function inferThinkingLevel(ctx: AnyContext): string | undefined {
	const branch = (ctx as any).sessionManager?.getBranch?.() ?? [];
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "thinking_level_change" && entry.thinkingLevel) {
			return entry.thinkingLevel;
		}
	}
	return undefined;
}

/** 收集父会话的可继承运行时选项（工具选择/模型/思考级别/authStorage）。 */
export function collectRuntimeInheritance(ctx?: AnyContext): any {
	if (!ctx) return {};
	const promptOptions = (ctx as any).getSystemPromptOptions?.() ?? {};
	const sessionOptions: any = {};
	if (Array.isArray(promptOptions.selectedTools)) {
		sessionOptions.tools = [...promptOptions.selectedTools];
	}
	if ((ctx as any).model) sessionOptions.model = (ctx as any).model;
	const thinkingLevel = inferThinkingLevel(ctx);
	if (thinkingLevel) sessionOptions.thinkingLevel = thinkingLevel;
	return {
		ctx,
		authStorage: (ctx as any).modelRegistry?.authStorage,
		sessionOptions,
	};
}

export function safeCollectRuntimeInheritance(ctx?: AnyContext): any {
	try {
		return collectRuntimeInheritance(ctx);
	} catch {
		return {};
	}
}

function createInheritedSettingsManager(
	cwd: string,
	agentDir: string,
	inheritance: any,
): { settingsManager: any; diagnostics: any[] } {
	const diagnostics: any[] = [];
	const sameCwd =
		inheritance?.ctx?.cwd &&
		path.resolve(inheritance.ctx.cwd) === path.resolve(cwd);
	let projectTrusted = true;
	if (sameCwd) {
		projectTrusted = inheritance.ctx.isProjectTrusted?.() ?? true;
	} else if (hasTrustRequiringProjectResources(cwd)) {
		const trustStore = new ProjectTrustStore(agentDir);
		projectTrusted = trustStore.get(cwd) === true;
		if (!projectTrusted) {
			diagnostics.push({
				type: "warning",
				message: `Project resources in child cwd are not trusted: ${cwd}`,
			});
		}
	}
	return {
		settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted }),
		diagnostics,
	};
}

async function resolveChildSessionOptions(
	services: any,
	sessionManager: any,
	inheritance: any,
): Promise<any> {
	const options: any = { ...(inheritance?.sessionOptions ?? {}) };
	const existing = hasExistingMessages(sessionManager);
	if (existing) {
		delete options.model;
		delete options.thinkingLevel;
	}

	const patterns = services.settingsManager?.getEnabledModels?.();
	if (!patterns?.length) return options;

	const { resolveModelScope } = await loadModelResolver();
	const scopedModels = await resolveModelScope(
		patterns,
		services.modelRegistry,
	);
	if (!scopedModels.length) return options;

	options.scopedModels = scopedModels;
	if (!existing) {
		const inheritedModel = inheritance?.sessionOptions?.model;
		const savedProvider = services.settingsManager?.getDefaultProvider?.();
		const savedModelId = services.settingsManager?.getDefaultModel?.();
		const savedModel =
			savedProvider && savedModelId
				? services.modelRegistry.find(savedProvider, savedModelId)
				: undefined;
		const selected =
			scopedModels.find((scoped: any) =>
				sameModel(scoped.model, inheritedModel),
			) ??
			scopedModels.find((scoped: any) => sameModel(scoped.model, savedModel)) ??
			scopedModels[0];
		options.model = selected.model;
		if (selected.thinkingLevel) options.thinkingLevel = selected.thinkingLevel;
	}

	return options;
}

/** host.ts 注入：返回活跃子会话的继承（/new、/resume 重建 SessionManager 时 WeakMap 丢失的回退）。 */
export type ActiveChildInheritanceProvider = (
	sessionManager: any,
) => any | null | undefined;

let activeChildProvider: ActiveChildInheritanceProvider | null = null;

export function setActiveChildInheritanceProvider(
	fn: ActiveChildInheritanceProvider,
): void {
	activeChildProvider = fn;
}

export const createRuntime: CreateAgentSessionRuntimeFactory = async ({
	cwd,
	agentDir,
	sessionManager,
	sessionStartEvent,
}) => {
	let inheritance = runtimeInheritanceBySessionManager.get(sessionManager);
	// /new and /resume inside a child create a fresh SessionManager, so WeakMap
	// inheritance from the original child manager is lost. Reattach it from the
	// active child record before session construction, without mutating session log.
	if (!inheritance) {
		const fallback = activeChildProvider?.(sessionManager);
		if (fallback) {
			inheritance = fallback;
			runtimeInheritanceBySessionManager.set(sessionManager, fallback);
		}
	}
	inheritance ??= {};
	const inheritedSettings = createInheritedSettingsManager(
		cwd,
		agentDir,
		inheritance,
	);
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		authStorage: inheritance.authStorage,
		settingsManager: inheritedSettings.settingsManager,
		// 支持按继承传入的 extensionsOverride 过滤扩展加载（pi-msessions 无插件臂）
		...(inheritance.extensionsOverride
			? { resourceLoaderOptions: { extensionsOverride: inheritance.extensionsOverride } }
			: {}),
	} as any); // authStorage 选项在 .d.ts 中缺失但运行时真实支持（原 @ts-nocheck 时代即如此）
	services.diagnostics.push(...inheritedSettings.diagnostics);
	let sessionOptions: any = {};
	try {
		sessionOptions = await resolveChildSessionOptions(
			services,
			sessionManager,
			inheritance,
		);
	} catch (error) {
		services.diagnostics.push({
			type: "warning",
			message: `Failed to resolve inherited child session options: ${String(error)}`,
		});
	}
	const result = await createAgentSessionFromServices({
		services,
		sessionManager,
		sessionStartEvent,
		...sessionOptions,
	});
	return {
		...result,
		services,
		diagnostics: services.diagnostics,
	};
};
