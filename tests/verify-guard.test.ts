import assert from "node:assert/strict";
import { test } from "node:test";
import verifyGuard, { extractErrors, isBuildCommand, MAX_FORCED, MAX_TOTAL_FORCED, needsVerification } from "../extensions/verify-guard/index.ts";

function setup() {
	const handlers: Record<string, (event: any) => any> = {};
	verifyGuard({ on: (name: string, fn: (event: any) => any) => { handlers[name] = fn; } } as any);
	const result = (toolName: string, isError = false, command = "", output = "", path?: string) =>
		handlers.tool_result({ toolName, isError, input: { command, path }, content: [{ type: "text", text: output }] });
	const settle = (outcome = "completed", entries: unknown[] = []) => handlers.agent_before_settle({ outcome, entries });
	return { handlers, result, settle };
}

test("does not continue aborted or failed runs", () => {
	for (const outcome of ["aborted", "error"]) {
		const { result, settle } = setup();
		result("edit");
		assert.equal(settle(outcome), undefined);
	}
});

test("keeps entries added by other extensions", () => {
	const { result, settle } = setup();
	result("edit");
	const other = { type: "custom", customType: "other" };
	const out = settle("completed", [other]);
	assert.equal(out.entries[0], other);
	assert.equal(out.entries.length, 2);
});

test("does nothing without edits", () => {
	const { settle } = setup();
	assert.equal(settle(), undefined);
});

test("forces a verification turn after a successful edit", () => {
	const { result, settle } = setup();
	result("edit");
	const out = settle();
	assert.equal(out.continue, true);
	assert.equal(out.entries[0].type, "custom_message");
});

test("ignores failed edits", () => {
	const { result, settle } = setup();
	result("write", true);
	assert.equal(settle(), undefined);
});

test("does nothing when verified after the edit", () => {
	for (const tool of ["powershell", "lsp_diagnostics"]) {
		const { result, settle } = setup();
		result("write");
		result(tool);
		assert.equal(settle(), undefined);
	}
});

test("edit after verification requires verification again", () => {
	const { result, settle } = setup();
	result("edit");
	result("powershell");
	result("edit");
	assert.equal(settle().continue, true);
});

test("caps forced continuations and resets on the next user prompt", () => {
	const { handlers, result, settle } = setup();
	result("edit");
	for (let i = 0; i < MAX_FORCED; i++) assert.equal(settle().continue, true);
	assert.equal(settle(), undefined);
	handlers.before_agent_start({ messageType: "user" });
	result("edit");
	assert.equal(settle().continue, true);
});

test("extension-started runs do not reset pending verification", () => {
	const { handlers, result, settle } = setup();
	result("edit");
	handlers.before_agent_start({ messageType: "custom" });
	assert.equal(settle().continue, true);
});

const CS_ERROR = "Program.cs(12,5): error CS1002: ; expected [C:\\proj\\app.csproj]";

test("failed build after edit keeps the run unsettled with error lines in the reminder", () => {
	const { result, settle } = setup();
	result("edit");
	result("powershell", true, "dotnet build", `Build started\n${CS_ERROR}\n1 Error(s)`);
	const out = settle();
	assert.equal(out.continue, true);
	assert.match(out.entries[0].content, /error CS1002/);
});

test("failed build result gets an error summary prepended", () => {
	const { result } = setup();
	const out = result("powershell", true, "msbuild app.sln", `noise\n${CS_ERROR}`);
	assert.equal(out.content.length, 2);
	assert.match(out.content[0].text, /error CS1002/);
});

test("fixing and rebuilding successfully lets the run settle", () => {
	const { result, settle } = setup();
	result("edit");
	result("powershell", true, "dotnet build", CS_ERROR);
	result("edit");
	assert.equal(settle().continue, true);
	result("powershell", false, "dotnet build", "Build succeeded.");
	assert.equal(settle(), undefined);
});

test("a failing non-build command is not treated as a build failure", () => {
	const { result, settle } = setup();
	result("edit");
	assert.equal(result("powershell", true, "ls missing", "ls: cannot access"), undefined);
	assert.equal(settle(), undefined);
});

test("failed build without edits does not force continuation", () => {
	const { result, settle } = setup();
	result("powershell", true, "dotnet build", CS_ERROR);
	assert.equal(settle(), undefined);
});

test("build failure retries stop at the total cap and reset on the next prompt", () => {
	const { handlers, result, settle } = setup();
	const fail = () => result("powershell", true, "cmake --build .", "x.cpp:3:1: error: expected ';'");
	result("edit");
	fail();
	for (let i = 0; i < MAX_TOTAL_FORCED; i++) assert.equal(settle().continue, true);
	assert.equal(settle(), undefined);
	handlers.before_agent_start({ messageType: "user" });
	result("edit");
	fail();
	assert.equal(settle().continue, true);
});

test("build failure is not continued when the run was aborted", () => {
	const { result, settle } = setup();
	result("edit");
	result("powershell", true, "dotnet build", CS_ERROR);
	assert.equal(settle("aborted"), undefined);
});

test("isBuildCommand recognizes build tools but not ordinary commands", () => {
	for (const c of ["dotnet build -c Release", "& 'C:\\VS\\MSBuild.exe' app.sln", "cmake --build build; ctest", "cl /c a.cpp", "make -j4"]) assert.ok(isBuildCommand(c), c);
	for (const c of ["ls", "Get-ChildItem build", "git status", "type make.log", "dotnet --version", ""]) assert.ok(!isBuildCommand(c), c);
});

test("extractErrors picks compiler error lines and falls back to the last lines", () => {
	assert.deepEqual(extractErrors("a.cpp(3): error C2065: 'x': undeclared identifier\nnote\nb.cpp:4:2: error: bad\nfoo"), [
		"a.cpp(3): error C2065: 'x': undeclared identifier",
		"b.cpp:4:2: error: bad",
	]);
	assert.deepEqual(extractErrors("1\n2\n3\n4\n5"), ["3", "4", "5"]);
});

test("edits to docs and config files do not force verification", () => {
	for (const path of ["README.md", "docs/guide.md", "config/settings.json", "notes.txt", "a.yml"]) {
		const { result, settle } = setup();
		result("write", false, "", "", path);
		assert.equal(settle(), undefined, path);
	}
});

test("edits to C/C++/C# sources and project files still force verification", () => {
	for (const path of ["src/a.cpp", "include/A.HPP", "Program.cs", "App.csproj", "x.vcxproj", "CMakeLists.txt", "@src/b.h", undefined]) {
		const { result, settle } = setup();
		result("edit", false, "", "", path);
		assert.equal(settle()?.continue, true, String(path));
	}
});

test("a doc edit after a source edit keeps the pending verification", () => {
	const { result, settle } = setup();
	result("edit", false, "", "", "a.cpp");
	result("write", false, "", "", "NOTES.md");
	assert.equal(settle().continue, true);
	assert.equal(needsVerification("a.md"), false);
});
