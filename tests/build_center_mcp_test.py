"""Domain/error/performance regression tests; no company Redis or credentials needed."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "mcp/build-center"))
from service import QueryError, RedisService


class FakeRedis:
    def __init__(self):
        self.values = {}
        self.mgets = []
        self.scans = 0
        self.closed = False

    def scan(self, **_kwargs):
        self.scans += 1
        return 0, [key for key in self.values if key.startswith("itemid:")]

    def mget(self, keys):
        self.mgets.append(keys)
        return [self.values.get(key) for key in keys]

    def get(self, key):
        return self.values.get(key)

    def close(self):
        self.closed = True


class RedisQueries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="redis 설정 한글 ")
        self.addCleanup(self.temp.cleanup)
        self.config = Path(self.temp.name)
        self.write("settings.json", {"batch_size": 100, "timezone": "Asia/Seoul"})
        self.write("server_IP_mappings.json", {"ProjectA": "127.0.0.1"})
        self.write("owners.json", {"example.user": "홍길동", "other.song": "홍길동"})
        self.fake = FakeRedis()
        self.created = []

        def factory(**options):
            self.created.append(options)
            return self.fake

        self.service = RedisService(self.config, factory)
        self.addCleanup(self.service.close)
        self.put("itemid:1", {"name": "TestModule", "path": "src/한글", "owner": "example.user", "owner_kr": "옛이름"})
        self.put("itemid:2", {"name": "Other", "owner": "other.song", "owner_kr": "홍길동"})
        self.record = {"state": "4", "starttime": "1775199106", "finishtime": "1775199158",
                       "checktime": "1791963436", "meanbuildtime": "30", "buildcount": "83",
                       "builder": "client (Linux build machine)", "log": "시작\n완료", "revision": "excluded",
                       "product_version": "excluded", "file_version": "excluded", "build_date": "excluded"}
        self.put("buildid:1", self.record)

    def write(self, name, value):
        (self.config / name).write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def put(self, key, value):
        self.fake.values[key] = json.dumps(value, ensure_ascii=False)

    def test_names_owner_mapping_duplicate_names_and_combined_filters(self):
        found = self.service.find_modules("ProjectA", name="test", path="한글", owner="홍길동")
        self.assertEqual([m["module_id"] for m in found["modules"]], ["1"])
        self.assertEqual(found["modules"][0]["owner_kr"], "홍길동")
        self.assertEqual(found["modules"][0]["owner_kr_original"], "옛이름")
        self.assertEqual(self.service.resolve_owner("홍길동")["total"], 2)
        self.assertEqual(self.service.find_modules("ProjectA", owner="EXAMPLE.USER")["total"], 1)

    def test_redis_fallback_without_owner_mapping(self):
        self.write("owners.json", {})
        self.assertEqual(self.service.resolve_owner("홍길동", "ProjectA")["owners"][0]["owner"], "other.song")

    def test_states_timestamps_and_excluded_fields(self):
        result = self.service.get_results("ProjectA", ["1"])["modules"][0]["tasks"]
        build = result["build"]
        self.assertEqual(build["state"], "4")
        self.assertEqual(build["result"], "성공")
        self.assertEqual(build["duration_seconds"], 52)
        self.assertEqual(build["buildcount"], 83)
        self.assertEqual(build["times"]["checktime"]["unix_seconds"], 1791963436)
        self.assertTrue(build["times"]["starttime"]["iso"].endswith("+09:00"))
        self.assertNotIn("log", json.dumps(result))
        for key in ("revision", "product_version", "file_version", "build_date"):
            self.assertNotIn(key, build["raw"])
        self.assertEqual(result["dynamic"]["error"], "missing")
        self.put("analysisid:1", {**self.record, "state": "5"})
        self.assertEqual(self.service.get_results("ProjectA", ["1"], "dynamic")["modules"][0]["tasks"]["dynamic"]["result"], "실패")

    def test_unknown_state_and_invalid_time_are_not_success(self):
        for state in ("1", "unknown", 4, ["4"], None):
            self.put("buildid:1", {**self.record, "state": state, "starttime": "bad", "finishtime": "0", "checktime": "9" * 100})
            result = self.service.get_results("ProjectA", ["1"], "build")["modules"][0]["tasks"]["build"]
            self.assertEqual(result["result"], "미확인")
            self.assertIsNone(result["duration_seconds"])
            self.assertIsNone(result["times"]["checktime"]["iso"])

    def test_bad_json_missing_keys_and_partial_success(self):
        self.fake.values["itemid:broken"] = "not json"
        self.fake.values["analysisid:1"] = "[]"
        found = self.service.find_modules("ProjectA")
        self.assertEqual(found["total"], 2)
        self.assertEqual(found["index_error_count"], 1)
        modules = self.service.get_results("ProjectA", ["1", "missing"])["modules"]
        self.assertEqual(modules[0]["tasks"]["dynamic"]["error"], "invalid_json")
        self.assertEqual(modules[0]["tasks"]["build"]["result"], "성공")
        self.assertEqual(modules[1]["module_error"], "missing")

    def test_connection_reuse_cache_refresh_and_mapping_reload(self):
        self.service.find_modules("ProjectA")
        self.service.find_modules("ProjectA")
        self.service.get_results("ProjectA", ["1"])
        self.assertEqual(len(self.created), 1)
        self.assertEqual(self.fake.scans, 1)
        self.service.find_modules("ProjectA", refresh=True)
        self.assertEqual(self.fake.scans, 2)
        self.write("server_IP_mappings.json", {"ProjectA": "127.0.0.2"})
        self.service.find_modules("ProjectA")
        self.assertEqual(self.fake.scans, 3)
        self.assertEqual(self.created[-1]["host"], "127.0.0.2")
        self.assertTrue(self.fake.closed)
        self.write("owners.json", {"example.user": "새이름"})
        self.assertEqual(self.service.find_modules("ProjectA", owner="새이름")["total"], 1)

    def test_resp2_and_credentials_only_when_set(self):
        with patch.dict("os.environ", {}, clear=True):
            self.service.connection("ProjectA")
        self.assertEqual(self.created[-1]["protocol"], 2)
        self.assertNotIn("username", self.created[-1])
        self.assertNotIn("password", self.created[-1])
        with patch.dict("os.environ", {"REDISCLI_AUTH": "secret", "HSC_REDIS_USERNAME": "reader"}, clear=True):
            self.service.connection("ProjectA")
        self.assertEqual((self.created[-1]["username"], self.created[-1]["password"]), ("reader", "secret"))

    def test_100_modules_are_read_in_four_batches_not_400_calls(self):
        self.service.get_results("ProjectA", [str(i) for i in range(100)])
        self.assertEqual(len(self.fake.mgets), 4)
        self.assertTrue(all(len(keys) <= 100 for keys in self.fake.mgets))

    def test_scan_limit_never_returns_incomplete_success(self):
        self.write("settings.json", {"max_scan_keys": 1})
        with self.assertRaisesRegex(QueryError, "한도"):
            self.service.find_modules("ProjectA")
        self.assertNotIn("ProjectA", self.service.indexes)

    def test_scan_empty_pages_duplicates_and_timeout(self):
        pages = iter([(1, []), (2, ["itemid:1", "itemid:1"]), (0, ["itemid:2"])])
        self.fake.scan = lambda **_kwargs: next(pages)
        found = self.service.find_modules("ProjectA")
        self.assertEqual(found["total"], 2)
        self.service.indexes.clear()
        with patch("service.time.monotonic", side_effect=[0, 31]):
            with self.assertRaisesRegex(QueryError, "시간이 초과"):
                self.service.find_modules("ProjectA")
        self.assertNotIn("ProjectA", self.service.indexes)

    def test_log_tail_line_pages_and_long_line_character_pages(self):
        self.put("buildid:1", {**self.record, "log": "\n".join(f"로그 {i}" for i in range(200))})
        tail = self.service.get_log("ProjectA", "1", "build", limit=10)
        self.assertEqual(tail["offset"], 190)
        self.assertIn("로그 199", tail["text"])
        self.assertEqual(tail["previous_offset"], 180)
        long_line = "한" * 350
        self.put("buildid:1", {**self.record, "log": long_line})
        tail = self.service.get_log("ProjectA", "1", "build", max_chars=100)
        self.assertEqual(tail["character_offset"], 250)
        chunks, position = [], 0
        while position is not None:
            page = self.service.get_log("ProjectA", "1", "build", offset=0, max_chars=100, character_offset=position)
            chunks.append(page["text"])
            position = page["next_character_offset"]
        self.assertEqual("".join(chunks), long_line)

    def test_unknown_project_bad_config_and_input_limits(self):
        with self.assertRaisesRegex(QueryError, "등록되지"):
            self.service.get_results("unknown", ["1"])
        for ids in ([], ["1"] * 101, [""]):
            with self.assertRaises(QueryError):
                self.service.get_results("ProjectA", ids)
        with self.assertRaises(QueryError):
            self.service.get_log("ProjectA", "1", "staticanalysis")
        self.assertEqual(self.service.list_projects()["servers"], {"ProjectA": "127.0.0.1"})
        self.write("server_IP_mappings.json", {"ProjectA": {"host": "127.0.0.1"}})
        with self.assertRaises(QueryError):
            self.service.list_projects()
        (self.config / "settings.json").write_text("broken")
        with self.assertRaises(QueryError):
            self.service.connection("ProjectA")


if __name__ == "__main__":
    unittest.main()
