"""Read-only Redis domain queries. Redis values are JSON strings, not hashes."""
from __future__ import annotations

import ipaddress
import json
import os
import time
import threading
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import redis
from redis.backoff import NoBackoff
from redis.retry import Retry


TASKS = {"build": ("buildid", "빌드"), "dynamic": ("analysisid", "동적시험"),
         "static": ("analysisstaticid", "정적시험")}
FIELDS = ("state", "starttime", "finishtime", "checktime", "meanbuildtime", "builder", "buildcount")


class QueryError(ValueError):
    """An actionable error safe to return without credentials or Redis values."""


def read_object(path: Path, optional=False):
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        if optional:
            return {}
        raise QueryError(f"설정 파일이 없습니다: {path.name}") from None
    except (OSError, ValueError):
        raise QueryError(f"JSON 설정을 읽을 수 없습니다: {path.name}") from None
    if not isinstance(value, dict):
        raise QueryError(f"JSON 객체가 필요합니다: {path.name}")
    return value


def integer(value):
    if isinstance(value, bool):
        return None
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return None


def bounded(value, low, high, name):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise QueryError(f"{name}: {low}~{high} 사이의 정수가 필요합니다")
    return value


def parse_record(raw, key):
    if raw is None:
        return None, "missing"
    try:
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError()
        return value, None
    except (ValueError, TypeError, UnicodeError):
        return None, "invalid_json"


class RedisService:
    def __init__(self, config_dir: Path, client_factory=redis.Redis):
        self.config_dir = Path(config_dir)
        self.client_factory = client_factory
        self.clients = {}
        self.indexes = {}
        self.lock = threading.RLock()

    def settings(self):
        value = read_object(self.config_dir / "settings.json")
        for name, default, low, high in (
            ("port", 6379, 1, 65535), ("db", 0, 0, 1024),
            ("connect_timeout_seconds", 5, 1, 60), ("socket_timeout_seconds", 10, 1, 60),
            ("max_connections", 4, 1, 32), ("batch_size", 100, 1, 500),
            ("index_ttl_seconds", 30, 0, 300), ("max_scan_keys", 50000, 1, 1000000),
            ("max_scan_seconds", 30, 1, 60),
        ):
            value[name] = bounded(value.get(name, default), low, high, name)
        try:
            ZoneInfo(value.get("timezone", "Asia/Seoul"))
        except (KeyError, ValueError, TypeError):
            raise QueryError("timezone은 유효한 IANA 시간대여야 합니다") from None
        if not isinstance(value.get("tls", False), bool):
            raise QueryError("tls는 true 또는 false여야 합니다")
        for field, default in (("username_env", "HSC_REDIS_USERNAME"), ("password_env", "REDISCLI_AUTH")):
            if not isinstance(value.get(field, default), str) or not value.get(field, default):
                raise QueryError(f"{field}는 환경 변수 이름이어야 합니다")
        if value.get("ca_file") is not None and not isinstance(value["ca_file"], str):
            raise QueryError("ca_file은 인증서 경로 문자열이어야 합니다")
        return value

    def projects(self):
        value = read_object(self.config_dir / "server_IP_mappings.json", optional=True)
        for name, host in value.items():
            try:
                if not name or not isinstance(host, str):
                    raise ValueError()
                ipaddress.ip_address(host)
            except ValueError:
                raise QueryError("server_IP_mappings.json은 ProjectName: IP 문자열 형식이어야 합니다") from None
        return value

    def owners(self):
        value = read_object(self.config_dir / "owners.json", optional=True)
        if any(not key or not isinstance(name, str) or not name for key, name in value.items()):
            raise QueryError("owners.json은 owner ID: 이름 문자열 형식이어야 합니다")
        return value

    def list_projects(self):
        projects = self.projects()
        return {"projects": sorted(projects), "servers": {name: projects[name] for name in sorted(projects)}, "mapping_file": "config/redis/server_IP_mappings.json"}

    def connection(self, project_name):
        projects, settings = self.projects(), self.settings()
        if project_name not in projects:
            raise QueryError(f"등록되지 않은 프로젝트: {project_name}. server_IP_mappings.json을 확인하세요")
        password = os.environ.get(settings.get("password_env", "REDISCLI_AUTH"))
        username = os.environ.get(settings.get("username_env", "HSC_REDIS_USERNAME"))
        ca = settings.get("ca_file")
        if ca:
            ca = str((self.config_dir / ca).resolve())
        # protocol=2 (RESP2): Redis 5.x has no HELLO/RESP3.
        options = dict(host=projects[project_name], port=settings["port"], db=settings["db"], protocol=2,
                       decode_responses=True, encoding_errors="strict",
                       socket_connect_timeout=settings["connect_timeout_seconds"],
                       socket_timeout=settings["socket_timeout_seconds"], max_connections=settings["max_connections"])
        # Pass credentials only when set, so unauthenticated Redis 5 servers never receive AUTH.
        if username is not None:
            options["username"] = username
        if password is not None:
            options["password"] = password
        if settings.get("tls"):
            options.update(ssl=True, ssl_cert_reqs="required", ssl_check_hostname=True)
            if ca:
                options["ssl_ca_certs"] = ca
        signature = tuple(sorted(options.items()))
        previous = self.clients.get(project_name)
        if previous is None or previous[0] != signature:
            if previous:
                previous[1].close()
            self.clients[project_name] = (signature, self.client_factory(**options, retry=Retry(NoBackoff(), 0)))
            self.indexes.pop(project_name, None)
        return self.clients[project_name][1], settings

    def batch_get(self, client, keys, size):
        values = []
        for start in range(0, len(keys), size):
            values.extend(client.mget(keys[start:start + size]))
        return values

    def module_index(self, project_name, refresh=False):
        client, settings = self.connection(project_name)
        cached = self.indexes.get(project_name)
        if not refresh and cached and time.monotonic() - cached[0] < settings["index_ttl_seconds"]:
            return cached[1], cached[2], True
        records, errors, seen, pending = [], [], set(), []
        started = time.monotonic()

        def consume():
            values = self.batch_get(client, pending, settings["batch_size"])
            for key, raw in zip(pending, values):
                record, error = parse_record(raw, key)
                if error:
                    errors.append({"module_id": key[len("itemid:"):], "error": error})
                else:
                    # The suffix is the canonical ID; untrusted JSON cannot replace it.
                    records.append({**record, "module_id": key[len("itemid:"):]})
            pending.clear()

        cursor = 0
        while True:
            if time.monotonic() - started > settings["max_scan_seconds"]:
                raise QueryError("모듈 탐색 시간이 초과되었습니다. 연결과 max_scan_seconds 설정을 확인하세요")
            cursor, keys = client.scan(cursor=cursor, match="itemid:*", count=settings["batch_size"])
            for key in keys:
                if key in seen:
                    continue
                seen.add(key)
                if len(seen) > settings["max_scan_keys"]:
                    raise QueryError("모듈 탐색 한도를 초과했습니다. max_scan_keys 설정을 확인하세요")
                pending.append(key)
                if len(pending) >= settings["batch_size"]:
                    consume()
            if time.monotonic() - started > settings["max_scan_seconds"]:
                raise QueryError("모듈 탐색 시간이 초과되었습니다. 연결과 max_scan_seconds 설정을 확인하세요")
            if int(cursor) == 0:
                break
        if pending:
            consume()
        records.sort(key=lambda item: item["module_id"])
        self.indexes[project_name] = (time.monotonic(), records, errors)
        return records, errors, False

    def module_view(self, record, owners):
        owner = str(record.get("owner") or "")
        raw_name = str(record.get("owner_kr") or "")
        return {**{key: record.get(key) for key in ("module_id", "name", "path", "platform", "buildfile")},
                "owner": owner, "owner_kr": owners.get(owner, raw_name or owner), "owner_kr_original": raw_name}

    def find_modules(self, project_name, name=None, path=None, owner=None, offset=0, limit=50, refresh=False):
        bounded(offset, 0, 1000000, "offset")
        bounded(limit, 1, 100, "limit")
        owners = self.owners()
        records, errors, cached = self.module_index(project_name, refresh)
        matches = []
        for record in records:
            view = self.module_view(record, owners)
            if name and name.casefold() not in str(view.get("name") or "").casefold():
                continue
            if path and path.casefold() not in str(view.get("path") or "").casefold():
                continue
            if owner and not any(owner.casefold() in str(view.get(key) or "").casefold()
                                 for key in ("owner", "owner_kr", "owner_kr_original")):
                continue
            matches.append(view)
        end = offset + limit
        return {"project_name": project_name, "modules": matches[offset:end], "total": len(matches),
                "next_offset": end if end < len(matches) else None, "cached": cached,
                "index_errors": errors[:20], "index_error_count": len(errors),
                "participation_basis": "itemid.owner (담당자)", "observed_at": self.now()}

    def resolve_owner(self, query, project_name=None, limit=50):
        bounded(limit, 1, 100, "limit")
        if not query.strip():
            raise QueryError("query가 비어 있습니다")
        owners = self.owners()
        pairs = {(key, name, "mapping") for key, name in owners.items()}
        errors = []
        if project_name:
            records, errors, _ = self.module_index(project_name)
            for record in records:
                owner, name = str(record.get("owner") or ""), str(record.get("owner_kr") or "")
                if owner and owner not in owners:
                    pairs.add((owner, name or owner, "redis"))
        matches = [{"owner": owner, "owner_kr": name, "source": source}
                   for owner, name, source in sorted(pairs)
                   if query.casefold() in owner.casefold() or query.casefold() in name.casefold()]
        return {"owners": matches[:limit], "total": len(matches), "truncated": len(matches) > limit,
                "index_error_count": len(errors)}

    @staticmethod
    def now():
        return datetime.now(timezone.utc).isoformat()

    def time_view(self, raw, settings):
        seconds = integer(raw)
        if seconds is None or seconds <= 0:
            return {"raw": raw, "unix_seconds": seconds, "iso": None}
        try:
            iso = datetime.fromtimestamp(seconds, ZoneInfo(settings.get("timezone", "Asia/Seoul"))).isoformat()
        except (ValueError, OverflowError, OSError):
            iso = None
        return {"raw": raw, "unix_seconds": seconds, "iso": iso}

    def result_view(self, record, settings):
        raw = {key: record.get(key) for key in FIELDS}
        state = raw["state"]
        start, finish = integer(raw["starttime"]), integer(raw["finishtime"])
        return {"raw": raw, "state": state,
                "result": {"4": "성공", "5": "실패"}.get(state, "미확인") if isinstance(state, str) else "미확인",
                "times": {key: self.time_view(raw[key], settings) for key in ("starttime", "finishtime", "checktime")},
                "duration_seconds": finish - start if start and finish and finish >= start else None,
                "buildcount": integer(raw["buildcount"]), "builder": raw["builder"],
                "meanbuildtime_seconds_assumed": integer(raw["meanbuildtime"]),
                "assumptions": {"checktime": "마지막 성공 시각으로 추정", "meanbuildtime": "소요 시간(초)으로 추정"}}

    def get_results(self, project_name, module_ids, task=None):
        if not isinstance(module_ids, list) or not 1 <= len(module_ids) <= 100:
            raise QueryError("module_ids는 1~100개여야 합니다")
        if any(not isinstance(mid, str) or not mid.strip() or len(mid) > 256 for mid in module_ids):
            raise QueryError("module_id는 비어 있지 않은 256자 이하 문자열이어야 합니다")
        if task is not None and task not in TASKS:
            raise QueryError("task는 build, dynamic, static 중 하나여야 합니다")
        client, settings = self.connection(project_name)
        owners = self.owners()
        ids, tasks = list(dict.fromkeys(module_ids)), [task] if task else list(TASKS)
        keys = [f"{prefix}:{mid}" for mid in ids for prefix in ["itemid", *(TASKS[t][0] for t in tasks)]]
        values = iter(self.batch_get(client, keys, settings["batch_size"]))
        modules = []
        for mid in ids:
            item, error = parse_record(next(values), f"itemid:{mid}")
            module = {"module_id": mid, "module": self.module_view({**(item or {}), "module_id": mid}, owners),
                      "module_error": error, "tasks": {}}
            for kind in tasks:
                key = f"{TASKS[kind][0]}:{mid}"
                record, error = parse_record(next(values), key)
                module["tasks"][kind] = {"label": TASKS[kind][1], "error": error,
                                          **(self.result_view(record, settings) if record is not None else {})}
            modules.append(module)
        return {"project_name": project_name, "modules": modules, "observed_at": self.now(),
                "scope": "현재 키에 저장된 결과; 실행 이력이나 원자적 스냅샷이 아님"}

    def get_log(self, project_name, module_id, task, offset=None, limit=100, max_chars=12000, character_offset=None):
        if task not in TASKS:
            raise QueryError("task는 build, dynamic, static 중 하나여야 합니다")
        if not isinstance(module_id, str) or not module_id.strip() or len(module_id) > 256:
            raise QueryError("유효한 module_id가 필요합니다")
        bounded(limit, 1, 500, "limit")
        bounded(max_chars, 100, 20000, "max_chars")
        if offset is not None:
            bounded(offset, 0, 10000000, "offset")
        if character_offset is not None:
            bounded(character_offset, 0, 1000000000, "character_offset")
        client, _ = self.connection(project_name)
        key = f"{TASKS[task][0]}:{module_id}"
        record, error = parse_record(client.get(key), key)
        result = {"project_name": project_name, "module_id": module_id, "task": task, "error": error,
                  "observed_at": self.now()}
        if error:
            return result
        log = record.get("log")
        if log is None:
            return {**result, "error": "missing_log"}
        if not isinstance(log, str):
            return {**result, "error": "invalid_log"}
        lines = log.splitlines()
        start = max(0, len(lines) - limit) if offset is None else min(offset, len(lines))
        selected = lines[start:start + limit]
        text = "\n".join(selected)
        clipped = len(text) > max_chars
        char_start = (max(0, len(text) - max_chars) if offset is None else 0) if character_offset is None else min(character_offset, len(text))
        char_end = min(char_start + max_chars, len(text))
        return {**result, "text": text[char_start:char_end], "total_lines": len(lines), "offset": start,
                "character_offset": char_start,
                "next_character_offset": char_end if char_end < len(text) else None,
                "previous_character_offset": max(0, char_start - max_chars) if char_start else None,
                "next_offset": start + len(selected) if start + len(selected) < len(lines) else None,
                "previous_offset": max(0, start - limit) if start else None,
                "truncated": clipped or start > 0 or start + len(selected) < len(lines),
                "characters_truncated": clipped,
                "note": "로그는 실행 결과 갱신으로 페이지 사이에 바뀔 수 있습니다"}

    def close(self):
        for _, client in self.clients.values():
            client.close()
        self.clients.clear()
        self.indexes.clear()
