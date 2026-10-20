"""Bundled stdio MCP endpoint, started by pi from config/mcp.json. stdout is reserved for the MCP protocol."""
import argparse
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from mcp.server.fastmcp import FastMCP
from redis.exceptions import RedisError

from service import QueryError, RedisService


def create_server(config_dir):
    service = RedisService(Path(config_dir))

    @asynccontextmanager
    async def lifespan(_server):
        try:
            yield service
        finally:
            service.close()

    server = FastMCP("빌드센터", lifespan=lifespan)

    def call(method, **kwargs):
        try:
            with service.lock:
                return method(**kwargs)
        except QueryError as error:
            raise ValueError(str(error)) from None
        except (RedisError, OSError, UnicodeError):
            # redis-py errors may contain connection details. Never expose credentials or raw values.
            raise ValueError("Redis 조회 실패: 연결·인증·TLS·문자열 자료형·UTF-8 설정을 확인하세요") from None

    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    def list_projects() -> dict[str, Any]:
        """List ProjectNames and their server IPs (servers map) from server_IP_mappings.json; no Redis connection needed."""
        return call(service.list_projects)

    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    def find_modules(project_name: str, name: str | None = None, path: str | None = None,
                           owner: str | None = None, offset: int = 0, limit: int = 50, refresh: bool = False) -> dict[str, Any]:
        """Find modules by name/path/owner ID or Korean owner name. Participation means itemid.owner.

        Filters are case-insensitive substrings combined with AND. Use returned module IDs with get_results.
        next_offset continues results; refresh rebuilds the short-lived SCAN index.
        """
        return call(service.find_modules, project_name=project_name, name=name, path=path, owner=owner,
                    offset=offset, limit=limit, refresh=refresh)

    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    def resolve_owner(query: str, project_name: str | None = None, limit: int = 50) -> dict[str, Any]:
        """Resolve owner ID ↔ Korean name using owners.json, optionally also project itemid records."""
        return call(service.resolve_owner, query=query, project_name=project_name, limit=limit)

    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    def get_results(project_name: str, module_ids: list[str],
                          task: Literal["build", "dynamic", "static"] | None = None) -> dict[str, Any]:
        """Batch-read latest results for 1–100 modules; omit task for all three. No logs in output.

        build=빌드, dynamic=동적시험, static=정적시험. String state '4'=success, '5'=failure.
        checktime and meanbuildtime meanings remain assumptions. This is not execution history.
        """
        return call(service.get_results, project_name=project_name, module_ids=module_ids, task=task)

    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    def get_log(project_name: str, module_id: str, task: Literal["build", "dynamic", "static"],
                      offset: int | None = None, limit: int = 100, max_chars: int = 12000,
                      character_offset: int | None = None) -> dict[str, Any]:
        """Read a result log; default is the last 100 lines, bounded to 12000 characters.

        offset is a zero-based line offset. Use next/previous_offset for line pages.
        For a clipped page, keep its returned offset/limit and use next/previous_character_offset
        as character_offset to read the rest of that page. Logs may change between requests.
        """
        return call(service.get_log, project_name=project_name, module_id=module_id, task=task,
                    offset=offset, limit=limit, max_chars=max_chars, character_offset=character_offset)

    return server


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config-dir", type=Path, default=Path(__file__).resolve().parents[2] / "config/redis")
    args = parser.parse_args()
    create_server(args.config_dir).run(transport="stdio")
