# Complete Redis for Windows package

The bundle includes the complete, unmodified Redis 7.2.16 MSYS2 with-Service
package: seven executables, five DLLs, upstream configurations, READMEs and start.bat.
This includes RedisService 2.0.0 and its embedded self-contained .NET 10.0.11 runtime.
This is not an official Redis Ltd. Windows binary.
The local development config in `config/redis.local.conf` is provided by the harness.

- Binary release: https://github.com/redis-windows/redis-windows/releases/tag/7.2.16
- Archive SHA256: `91e663e401a3945831c3674fd63aa979ff7a5498b34939044ddd258896891381`
- Build recipe: https://github.com/redis-windows/redis-windows/blob/7.2.16/.github/workflows/build-redis.yml
- Redis source (BSD-3-Clause): https://github.com/redis/redis/tree/7.2.16
- MSYS2 runtime source (GPL with the exceptions in MSYS2-CYGWIN_LICENSE, plus newlib notices): https://github.com/msys2/msys2-runtime/tree/msys2-3.6.10
- OpenSSL source (Apache-2.0): https://github.com/openssl/openssl/tree/openssl-3.6.3
- GCC runtime source (GPL-3.0 with GCC Runtime Library Exception): https://github.com/gcc-mirror/gcc/tree/releases/gcc-15.2.0
- MSYS2 package sources and build recipes: https://github.com/msys2/MSYS2-packages
- Embedded .NET runtime source (MIT with third-party notices): https://github.com/dotnet/runtime/tree/v10.0.11

Runtime versions above were read from the distributed DLLs. redis-cli also
contains hiredis, linenoise and HdrHistogram code; their upstream notices are
included below. LINENOISE.h retains the original license header verbatim.
The server additionally embeds Lua and fpconv. REDIS-SERVER-NOTICES.txt preserves
copyright/license comment blocks from the Redis and embedded Lua source files,
including Lua CJSON, Struct and BitOp. This MSYS2 server uses the libc allocator.
The redis-windows repository license covers its own files, not Redis or the DLLs.

## License file sources

These files were copied verbatim from the versioned upstream sources:

| Included file | Source |
|---|---|
| `REDIS-COPYING` | https://raw.githubusercontent.com/redis/redis/7.2.16/COPYING |
| `LUA-COPYRIGHT` | https://raw.githubusercontent.com/redis/redis/7.2.16/deps/lua/COPYRIGHT |
| `FPCONV-LICENSE.txt` | https://raw.githubusercontent.com/redis/redis/7.2.16/deps/fpconv/LICENSE.txt |
| `REDIS-SERVER-NOTICES.txt` | Copyright/license comment blocks from `src/` and `deps/lua/src/` in https://github.com/redis/redis/tree/7.2.16; each excerpt identifies its source |
| `HIREDIS-COPYING` | https://raw.githubusercontent.com/redis/redis/7.2.16/deps/hiredis/COPYING |
| `LINENOISE.h` | https://raw.githubusercontent.com/redis/redis/7.2.16/deps/linenoise/linenoise.h |
| `HDR-HISTOGRAM-LICENSE.txt` | https://raw.githubusercontent.com/redis/redis/7.2.16/deps/hdr_histogram/LICENSE.txt |
| `HDR-HISTOGRAM-COPYING.txt` | https://raw.githubusercontent.com/redis/redis/7.2.16/deps/hdr_histogram/COPYING.txt |
| `MSYS2-COPYING` | https://raw.githubusercontent.com/msys2/msys2-runtime/msys2-3.6.10/winsup/COPYING |
| `MSYS2-CYGWIN_LICENSE` | https://raw.githubusercontent.com/msys2/msys2-runtime/msys2-3.6.10/winsup/CYGWIN_LICENSE |
| `MSYS2-COPYING.NEWLIB` | https://raw.githubusercontent.com/msys2/msys2-runtime/msys2-3.6.10/COPYING.NEWLIB |
| `OPENSSL-LICENSE.txt` | https://raw.githubusercontent.com/openssl/openssl/openssl-3.6.3/LICENSE.txt |
| `GCC-COPYING3` | https://raw.githubusercontent.com/gcc-mirror/gcc/releases/gcc-15.2.0/COPYING3 |
| `GCC-COPYING.RUNTIME` | https://raw.githubusercontent.com/gcc-mirror/gcc/releases/gcc-15.2.0/COPYING.RUNTIME |
| `REDIS-WINDOWS-LICENSE` | https://raw.githubusercontent.com/redis-windows/redis-windows/7.2.16/LICENSE |
| `DOTNET-LICENSE.txt` | https://raw.githubusercontent.com/dotnet/runtime/v10.0.11/LICENSE.TXT |
| `DOTNET-THIRD-PARTY-NOTICES.txt` | https://raw.githubusercontent.com/dotnet/runtime/v10.0.11/THIRD-PARTY-NOTICES.TXT |
