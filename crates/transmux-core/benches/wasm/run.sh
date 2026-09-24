#!/usr/bin/env bash
#
# Builds the transmux core for Node and runs the WASM boundary benchmark.
#
#   benches/wasm/run.sh            # build, then assert
#   benches/wasm/run.sh --json     # machine-readable output
#
# The build matches the shipped artifact: `--release --no-opt` - release
# codegen with the workspace `strip = "symbols"`, and no wasm-opt (which the
# crate disables because `target_features` is stripped). wasm-opt only changes
# codegen, not the serialization path this benchmark guards.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate="$(cd "$here/../.." && pwd)"
out="$crate/wasm/dist"

# Keep build artifacts out of the repository's target/ so a benchmark run never
# perturbs a developer's cargo caches.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${TMPDIR:-/tmp}/rivmux-wasm-bench-target}"

profile_args=(--release --no-opt)

echo "building rivmux_transmux_core for node (${profile_args[*]})" >&2

# Build progress goes to stderr so stdout stays reserved for benchmark output
# (notably the `--json` form, which is meant to be piped).
wasm-pack build "$crate" \
  "${profile_args[@]}" \
  --target nodejs \
  --out-dir "$out" \
  --out-name rivmux_transmux_core >&2

exec node "$here/bench.mjs" "$@"
