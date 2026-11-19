import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createGrepToolDefinition, DEFAULT_MAX_BYTES, truncateHead, truncateLine, type GrepToolDetails } from "@earendil-works/pi-coding-agent";
import { detectEncoding } from "./encoding.ts";

// Yield rg's JSON stream rather than buffering an unrestricted search. Breaking the loop stops rg.
async function* events(rg: string, args: string[], cwd: string, signal?: AbortSignal) {
	signal?.throwIfAborted();
	const child = spawn(rg, args, { cwd, signal, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	let error: Error | undefined, stderr = "";
	child.on("error", (err) => { error = err; });
	child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
	const closed = new Promise<number | null>((done) => child.once("close", done));
	const lines = createInterface({ input: child.stdout });
	try {
		for await (const line of lines) {
			signal?.throwIfAborted();
			const { type, data } = JSON.parse(line);
			if (type !== "match" && type !== "context") continue;
			yield {
				match: type === "match", number: Number(data.line_number),
				path: String(data.path.text ?? Buffer.from(data.path.bytes, "base64")),
				text: String(data.lines.text ?? Buffer.from(data.lines.bytes, "base64")),
			};
		}
		const code = await closed;
		signal?.throwIfAborted();
		if (error) throw error;
		if (code !== 0 && code !== 1) throw new Error(stderr.trim() || `rg exited with code ${code}`);
	} finally {
		lines.close();
		child.kill();
		await closed;
	}
}

export function createMixedGrep(cwd: string, rg: string): ReturnType<typeof createGrepToolDefinition> {
	return { ...createGrepToolDefinition(cwd), async execute(_id, input, signal, _update, ctx) {
		const path = (input.path || ".").replace(/^@/, "").replace(/^~(?=$|[\\/])/, () => homedir());
		const target = resolve(ctx?.cwd || cwd, path);
		const directory = (await stat(target)).isDirectory();
		const root = directory ? target : dirname(target);
		const args = ["--no-config", "--json", "--hidden"];
		if (input.glob) args.push("--glob", input.glob.replace(/^(!?)(?:\.\/)+/, "$1"));
		if (input.ignoreCase) args.push("-i");
		if (input.literal) args.push("-F");
		const context = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(input.context ?? 0)));
		if (context) args.push("-C", String(context));
		const limit = Math.max(1, Math.floor(input.limit ?? 100));
		const cp949 = new Map<string, boolean>();
		const rows: string[] = [], details: GrepToolDetails = {};
		let matches = 0, bytes = 0, lastPath = "", contextEnd = 0;
		// rg accepts one encoding per invocation. Only accept each candidate in its file's pass,
		// never infer encoding from an individual line (an ASCII line fits both encodings).
		search: for (const legacy of [false, true]) {
			for await (const row of events(rg, [...args, "-E", legacy ? "euc-kr" : "auto", "--", input.pattern, directory ? "." : target], root, signal)) {
				if (!cp949.has(row.path)) cp949.set(row.path, detectEncoding(await readFile(resolve(root, row.path), { signal })) === "cp949");
				if (cp949.get(row.path) !== legacy) continue;
				const atLimit = matches >= limit;
				const trailing = atLimit && row.path === lastPath && row.number <= contextEnd;
				if (atLimit && row.match) details.matchLimitReached = limit;
				if (atLimit && !trailing) {
					if (details.matchLimitReached) break search;
					continue;
				}
				const name = directory ? relative(root, resolve(root, row.path)).replaceAll("\\", "/") : basename(target);
				const { text, wasTruncated } = truncateLine(row.text.replace(/\r?\n$/, ""));
				if (wasTruncated) details.linesTruncated = true;
				const match = row.match && !atLimit;
				const line = match ? `${name}:${row.number}: ${text}` : `${name}-${row.number}- ${text}`;
				rows.push(line);
				bytes += Buffer.byteLength(line) + 1;
				if (bytes - 1 > DEFAULT_MAX_BYTES) break search;
				if (match && ++matches === limit) { lastPath = row.path; contextEnd = row.number + context; }
			}
		}
		const result = truncateHead(rows.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
		const notices = [];
		if (result.truncated) { details.truncation = result; notices.push("Output byte limit reached"); }
		if (details.linesTruncated) notices.push("Long lines truncated");
		if (details.matchLimitReached) notices.push(`${limit} matches limit reached`);
		const text = (result.content || "No matches found") + (notices.length ? `\n\n[${notices.join(". ")}]` : "");
		return { content: [{ type: "text", text }], details: notices.length ? details : undefined };
	} };
}
