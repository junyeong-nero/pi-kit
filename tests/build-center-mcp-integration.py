"""Invoked by build-center-mcp-bundle.py with the bundled Python against a relocated Windows bundle + Redis server.

Starts the server exactly as config/mcp.json tells pi to (`python` resolved through PATH), plus the test config folder.
"""
import asyncio
import json
import os
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

bundle = Path(os.environ["TEST_BUNDLE"])
entry = json.loads((bundle / "config/mcp.json").read_text(encoding="utf-8"))["mcpServers"]["build_center"]


async def main():
    params = StdioServerParameters(command=entry["command"], args=[*entry["args"], "--config-dir", os.environ["TEST_REDIS_CONFIG"]],
                                   env=dict(os.environ), cwd=os.environ["TEST_CWD"])
    async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
        await session.initialize()
        names = sorted(tool.name for tool in (await session.list_tools()).tools)
        assert names == ["find_modules", "get_log", "get_results", "list_projects", "resolve_owner"], names

        async def call(tool, **arguments):
            result = await session.call_tool(tool, arguments)
            assert not result.isError, result.content
            assert result.structuredContent
            return result.structuredContent

        listed = await call("list_projects")
        assert listed["projects"] == ["ProjectA"]
        assert isinstance(listed["servers"]["ProjectA"], str)
        found = await call("find_modules", project_name="ProjectA", name="TestModule", owner="홍길동")
        assert (found["total"], found["next_offset"], found["index_error_count"]) == (100, 50, 1), found
        following = await call("find_modules", project_name="ProjectA", owner="example.user", offset=50)
        assert following["cached"] is True and len(following["modules"]) == 50
        assert (await call("resolve_owner", query="홍길동"))["owners"][0]["owner"] == "example.user"
        results = await call("get_results", project_name="ProjectA", module_ids=[str(i) for i in range(100)])
        assert len(results["modules"]) == 100
        tasks = results["modules"][0]["tasks"]
        assert (tasks["build"]["state"], tasks["build"]["buildcount"], tasks["build"]["duration_seconds"]) == ("4", 83, 52), tasks
        assert tasks["static"]["result"] == "실패" and tasks["dynamic"]["error"] == "missing", tasks
        log = await call("get_log", project_name="ProjectA", module_id="0", task="static", limit=2)
        assert (log["text"], log["truncated"]) == ("한글 실패 로그\n마지막 줄", True), log
        missing = await call("get_results", project_name="ProjectA", module_ids=["missing"])
        assert missing["modules"][0]["module_error"] == "missing"
    print("Relocated config/mcp.json command + Python + redis-py + native wheels: all five tools passed")


asyncio.run(main())
