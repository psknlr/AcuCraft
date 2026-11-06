#!/usr/bin/env bash
# Everything CI runs: the pinned engine, the typecheck, the tests, content validation and the baseline benchmark.
#   tools/check.sh            (uses .deps/clinicalcraft, fetching the pinned revision if needed)
#   CLINICALCRAFT_DIR=../ClinicalCraft tools/check.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
bash tools/bootstrap.sh
rev="$(grep -Eo '^[0-9a-f]{40}' tools/clinicalcraft.rev | head -1)"
have="$(git -C .deps/clinicalcraft rev-parse HEAD)"
if [ "$have" != "$rev" ]; then echo "error: ClinicalCraft is at $have, the pin is $rev" >&2; exit 1; fi
echo "== typecheck"; npx tsc -p tsconfig.json --noEmit
echo "== tests"; npx vitest run
echo "== content"; npx tsx packages/cli/src/bin.ts validate
echo "== baseline benchmark (protocol agent)"; npx tsx packages/cli/src/bin.ts bench --agent protocol --out runs/ci-protocol
