from pathlib import Path
import subprocess
import sys
import unittest


HELPER = Path(__file__).resolve().parents[1] / 'extensions/harness-env/native-output.py'


class NativeOutputTest(unittest.TestCase):
    def run_child(self, script):
        return subprocess.run([sys.executable, str(HELPER), sys.executable, '-c', script, '공백 인자'],
                              capture_output=True, encoding='utf-8', timeout=10)

    def test_mixed_streams_and_exit_code(self):
        result = self.run_child("import sys; sys.stdout.buffer.write(b'a'*65535 + sys.argv[1].encode('cp949')); "
                                "sys.stderr.buffer.write('경고'.encode('utf-8')); sys.exit(17)")
        self.assertEqual(result.returncode, 17)
        self.assertEqual(result.stdout, 'a' * 65535 + '공백 인자')
        self.assertIn('valid=cp949; display=cp949', result.stderr)
        self.assertIn('display=utf-8', result.stderr)
        self.assertTrue(result.stderr.endswith('경고'))

    def test_incomplete_and_binary_streams_are_not_displayed(self):
        result = self.run_child("import sys; sys.stdout.buffer.write(b'secret\\x81'); sys.stderr.buffer.write(b'bin\\x00')")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertEqual(result.stderr.count('display=omitted'), 2)
        self.assertNotIn('secret', result.stderr)
