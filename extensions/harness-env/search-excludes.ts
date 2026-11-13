// pi의 grep 도구는 rg를 --hidden --no-config로 실행해 .vs·.svn·.git까지 뒤진다.
// Visual Studio는 디버깅 중 .vs 안의 파일을 잠그므로, glob이 없는 검색에는 이 폴더들을 빼는 glob을 넣는다.
export const EXCLUDED_DIRS = [".vs", ".svn", ".git"] as const;
export const EXCLUDE_GLOB = `!{${EXCLUDED_DIRS.join(",")}}`;

/** 검색 경로가 제외 폴더 안을 직접 가리키면 사용자가 의도한 것이므로 건드리지 않는다. */
function targetsExcluded(path: unknown): boolean {
	if (typeof path !== "string") return false;
	return path.split(/[\\/]+/).some((part) => (EXCLUDED_DIRS as readonly string[]).includes(part));
}

/** grep 입력에 제외 glob을 넣었으면 true. 모델이 glob을 지정했으면 그대로 둔다. */
export function excludeNoisyDirs(input: { glob?: unknown; path?: unknown }): boolean {
	if (input.glob || targetsExcluded(input.path)) return false;
	input.glob = EXCLUDE_GLOB;
	return true;
}
