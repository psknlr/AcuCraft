#!/usr/bin/env bash
# Everything CI runs: the pinned engine, the typecheck, the tests, content validation, the baseline benchmark and the
# language-model loop run offline.
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
# the language-model loop with the reference trajectory in place of a model (no network): every encounter must succeed
echo "== the agent loop, offline (scripted-llm)"
npx tsx packages/cli/src/bin.ts bench --agent scripted-llm --out runs/ci-scripted-llm | tee runs/ci-scripted-llm.txt
grep -q "primary endpoint 15/15" runs/ci-scripted-llm.txt || { echo "error: the scripted-llm run did not succeed on every encounter" >&2; exit 1; }
