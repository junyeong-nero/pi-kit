// 배포본을 pi 패키지로 불러올 때 언어 서버·pi-lens·동봉 도구가 동작하도록 환경 기본값을 채우는 확장.
// pi는 확장을 목록 순서대로 불러오므로 패키지 매니페스트의 첫 번째에 둔다. 이미 설정된 값은 바꾸지 않는다.
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPowerShellToolDefinition, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatScan, scanEncodings } from "./encoding.ts";
import { createEncodingAwareTools } from "./file-tools.ts";
import { createWindowsPowerShellOperations } from "./powershell.ts";

export const GUIDE_MARKER = "# 도구 사용 규칙";

export function bundleRootOf(moduleUrl: string): string {
	return resolve(dirname(fileURLToPath(moduleUrl)), "..", "..");
}

/** 배포본 기본값을 비어 있는 변수에만 채운다. 이 프로세스와 자식 프로세스에만 적용된다. */
export function applyDefaults(env: NodeJS.ProcessEnv, bundle: string, agentDir: string, platform = process.platform): void {
	const defaults: Record<string, string> = {
		HARNESS_BUNDLE_ROOT: bundle,
		HARNESS_LSP_CONFIG: join(bundle, "config", "lsp.json"),
		PI_LENS_HOME: join(agentDir, "pi-lens"),
		PI_LENS_CONFIG_PATH: join(bundle, "config", "pi-lens.json"),
		PI_LENS_DISABLE_LSP_INSTALL: "1",
		PI_LENS_DISABLE_TOOL_INSTALL: "1",
		DOTNET_CLI_TELEMETRY_OPTOUT: "1",
		DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
		DOTNET_GENERATE_ASPNET_CERTIFICATE: "false",
		DOTNET_NOLOGO: "1",
		DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: "true",
	};
	const piExe = join(bundle, "bin", "pi", "pi.exe");
	if (platform === "win32" && existsSync(piExe)) defaults.PI_SUBAGENT_PI_BINARY = piExe;
	for (const [name, value] of Object.entries(defaults)) if (!env[name]) env[name] = value;

	// 동봉된 fd·rg·SVN·Redis·ast-grep이 기존 설치보다 먼저 선택되도록 프로세스 PATH 앞에 둔다.
	const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
	const current = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
	const pathId = (path: string) => platform === "win32" ? path.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase() : path;
	const known = new Set(current.map(pathId));
	const extra = [join(bundle, "bin"), join(bundle, "bin", "pi"), join(bundle, "bin", "svn", "bin"), join(bundle, "bin", "redis"), join(bundle, "runtime", "python"), join(bundle, "vendor", "extensions", "node_modules", "@ast-grep", "cli")]
		.filter((dir) => existsSync(dir));
	const bundled = new Set(extra.map(pathId));
	// pi 0.87.1은 where.exe로만 PowerShell을 찾는다. 두 경로가 PATH에서 빠져 있어도
	// Windows 기본 설치 파일을 찾도록 보완한다. 기존 PATH의 도구 우선순위는 유지한다.
	const system32 = join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32");
	const fallback = platform === "win32" ? [
		join(system32, "where.exe"),
		join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
	].filter((file) => existsSync(file)).map((file) => dirname(file)).filter((dir) => !known.has(pathId(dir))) : [];
	if (extra.length || fallback.length) env[pathKey] = [...extra, ...current.filter((dir) => !bundled.has(pathId(dir))), ...fallback].join(delimiter);
}

// config/settings.json의 defaultTools와 같다. pi 기본값(read, bash, edit, write)은 Bash가 없는 Windows PC에 맞지 않는다.
export const WINDOWS_TOOLS = ["read", "powershell", "edit", "write", "grep", "find", "ls"];

/** Windows에서 Bash가 활성화되었으면 배포본의 PowerShell 도구 구성으로 바꾼다. */
export function windowsToolSet(active: string[], registered: string[], platform = process.platform): string[] | undefined {
	if (platform !== "win32" || !active.includes("bash")) return undefined;
	const builtins = WINDOWS_TOOLS.filter((name) => registered.includes(name));
	return [...new Set([...builtins, ...active.filter((name) => name !== "bash")])];
}

const bundle = bundleRootOf(import.meta.url);
applyDefaults(process.env, bundle, getAgentDir());

export default function (pi: ExtensionAPI) {
	// read·edit·write: 원래 인코딩(CP949·UTF-16·BOM)을 유지한다. 도구 이름·스키마는 pi 것 그대로라 프롬프트가 늘지 않는다.
	const fileTools = createEncodingAwareTools(process.cwd());
	pi.registerTool(fileTools.read);
	pi.registerTool(fileTools.edit);
	pi.registerTool(fileTools.write);
	pi.registerCommand("encodings", {
		description: "현재 프로젝트의 확장자별 파일 인코딩 분포를 보여 줍니다",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatScan(ctx.cwd, scanEncodings(ctx.cwd)), "info");
		},
	});
	if (process.platform === "win32") {
		// Keep pi's schema, rendering, truncation and session environment; replace only shell discovery/execution.
		pi.registerTool(createPowerShellToolDefinition(process.cwd(), { operations: createWindowsPowerShellOperations() }));
	}
	pi.on("session_start", () => {
		const tools = windowsToolSet(pi.getActiveTools(), pi.getAllTools().map((tool) => tool.name));
		if (tools) pi.setActiveTools(tools);
	});

	// 도구 사용 가이드를 컨텍스트에 한 번만 넣는다. 사용자가 AGENTS.md에 직접 넣어 두었다면 건너뛴다.
	const guidePath = join(bundle, "config", "AGENTS.md");
	pi.on("before_agent_start", (event) => {
		const files = event.systemPromptOptions.contextFiles;
		if (files.some((file) => file.content.includes(GUIDE_MARKER)) || !existsSync(guidePath)) return;
		files.push({ path: guidePath, content: readFileSync(guidePath, "utf-8") });
	});
}
