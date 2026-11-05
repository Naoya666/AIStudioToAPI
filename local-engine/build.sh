#!/usr/bin/env bash
# Fixed dependencies only; this script builds an engine, never starts it.
set -euo pipefail
cd "$(dirname "$0")"
sm_version=v152.0.4-aistudio2api.1
zig_version=0.15.2
case "$(uname -m)" in
  x86_64) engine_arch=amd64; zig_arch=x86_64; zig_hash=02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239; sm_hash=d3ecebf1890355426ad261ab8723038849a524b348af53e1bb440ca53cc2cacb ;;
  aarch64|arm64) engine_arch=arm64; zig_arch=aarch64; zig_hash=958ed7d1e00d0ea76590d27666efbf7a932281b3d7ba0c6b01b0ff26498f667f; sm_hash=b3c9539b8d8378d99f86b267e0e3d007dd01ff80acebf4f52f3e1d6ac04d9d00 ;;
  *) echo 'Supported: Linux amd64 / arm64' >&2; exit 1 ;;
esac
[ "$(uname -s)" = Linux ] || { echo 'Supported: Linux only' >&2; exit 1; }
[ "$(go env GOVERSION)" = go1.27.0 ] || { echo 'Go 1.27.0 is required' >&2; exit 1; }
deps="${LOCAL_ENGINE_DEPS:-$PWD/.deps}"
mkdir -p "$deps" bin
fetch() {
  local download_url=$1 download_hash=$2 download_file=$3 unpack_dir=$4
  if [ ! -f "$unpack_dir/.verified" ]; then
    curl -fL --retry 3 "$download_url" -o "$download_file"
    echo "$download_hash  $download_file" | sha256sum -c -
    mkdir -p "$unpack_dir"
    tar -xf "$download_file" -C "$unpack_dir" --strip-components="${5:-0}"
    touch "$unpack_dir/.verified"
    rm "$download_file"
  fi
}
fetch "https://ziglang.org/download/$zig_version/zig-$zig_arch-linux-$zig_version.tar.xz" "$zig_hash" "$deps/zig.tar.xz" "$deps/zig" 1
fetch "https://github.com/Mag1cFall/firefox/releases/download/$sm_version/spidermonkey-$sm_version-linux-$engine_arch.tar.gz" "$sm_hash" "$deps/sm.tar.gz" "$deps/sm"
export CGO_ENABLED=1 GOOS=linux GOARCH="$engine_arch" GOTOOLCHAIN=local
export CC="$deps/zig/zig cc -target $zig_arch-linux-musl"
export CXX="$deps/zig/zig c++ -target $zig_arch-linux-musl"
export CGO_CXXFLAGS="-I$deps/sm/include"
export CGO_LDFLAGS="-L$deps/sm/lib"
case "${1:-build}" in
  build) go build -mod=readonly -trimpath -tags netgo,osusergo -ldflags="-s -w -linkmode external -extldflags '-static'" -o bin/local-engine ./cmd/local-engine
    go mod download
    go run ./cmd/license-notices ./bin/third-party-licenses
    mkdir -p bin/third-party-licenses/native
    cp "$(go env GOROOT)/LICENSE" bin/third-party-licenses/native/Go-LICENSE
    cp "$deps/zig/LICENSE" bin/third-party-licenses/native/zig-LICENSE
    cp "$deps/zig/lib/libc/musl/COPYRIGHT" bin/third-party-licenses/native/musl-COPYRIGHT
    cp "$deps/zig/lib/libcxx/LICENSE.TXT" bin/third-party-licenses/native/libcxx-LICENSE
    cp "$deps/zig/lib/libcxxabi/LICENSE.TXT" bin/third-party-licenses/native/libcxxabi-LICENSE
    cp "$deps/zig/lib/libunwind/LICENSE.TXT" bin/third-party-licenses/native/libunwind-LICENSE
    ;;
  test) go test -mod=readonly ./... ;;
  *) echo 'Usage: build.sh [build|test]' >&2; exit 1 ;;
esac
