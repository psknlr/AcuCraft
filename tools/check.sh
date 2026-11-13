#!/usr/bin/env bash
# Everything CI runs: the pinned engine, the typecheck, the tests (the equipment models among them: each checked the
# way the engine's own inspector checks one), content validation, the world content against its generator, the
# needling stations' models against the body the pinned figure kit draws, the baseline benchmark and the
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
# the clinic's floor plan, its catalog (with each model's reference) and the skills room are written by a script: what
# is committed must be what it writes (docs/MODELS.md)
echo "== the world content is what its generator writes (tools/content/clinic_world.py)"
python3 tools/content/clinic_world.py
git diff --exit-code --stat -- content/world content/sg/clinic.json || { echo "error: content/world is not what tools/content/clinic_world.py writes — commit the generated files" >&2; exit 1; }
# a station's model is built round a body the world draws (its `manikin`): the measurements it was built from must
# be what this ClinicalCraft's figures are, and every site on bare skin (docs/MODELS.md "A model round a body")
echo "== the bodies of the needling stations as the pinned figure kit draws them (tools/figure-fit.mts --check)"
npx tsx tools/figure-fit.mts --check
echo "== baseline benchmark (protocol agent)"; npx tsx packages/cli/src/bin.ts bench --agent protocol --out runs/ci-protocol
# the language-model loop with the reference trajectory in place of a model (no network): every encounter must succeed
echo "== the agent loop, offline (scripted-llm)"
npx tsx packages/cli/src/bin.ts bench --agent scripted-llm --out runs/ci-scripted-llm | tee runs/ci-scripted-llm.txt
grep -q "primary endpoint 15/15" runs/ci-scripted-llm.txt || { echo "error: the scripted-llm run did not succeed on every encounter" >&2; exit 1; }
