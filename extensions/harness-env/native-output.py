"""Capture one native program before PowerShell decodes it; report and replay UTF-8 text."""
import codecs
import subprocess
import sys
import tempfile


def chunks(stream):
    stream.seek(0)
    while data := stream.read(65536):
        yield data


def replay(name, stream, destination):
    size = stream.tell()
    decoders = {enc: codecs.getincrementaldecoder(enc)() for enc in ("utf-8", "cp949")}
    binary = False
    for data in chunks(stream):
        if b"\0" in data:
            binary = True
            break
        for enc in list(decoders):
            try:
                decoders[enc].decode(data)
            except UnicodeDecodeError:
                del decoders[enc]
    for enc in list(decoders):
        try:
            decoders[enc].decode(b"", final=True)
        except UnicodeDecodeError:
            del decoders[enc]
    encoding = next(iter(decoders), None) if not binary else None
    candidates = ','.join(decoders) if not binary and decoders else 'none'
    print(f"[native-output {name}: {size} bytes; valid={candidates}; display={encoding or 'omitted'}]",
          file=sys.stderr, flush=True)
    if encoding:
        decoder = codecs.getincrementaldecoder(encoding)()
        for data in chunks(stream):
            destination.write(decoder.decode(data).encode("utf-8"))
        destination.write(decoder.decode(b"", final=True).encode("utf-8"))
        destination.flush()


def main(argv):
    if not argv:
        sys.exit("usage: native-output.py executable [args ...]")
    # Files, not in-memory PIPE buffers: large build logs must not exhaust the agent's memory.
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        code = subprocess.run(argv, stdout=stdout, stderr=stderr, shell=False).returncode
        replay("stdout", stdout, sys.stdout.buffer)
        replay("stderr", stderr, sys.stderr.buffer)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
