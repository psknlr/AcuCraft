#!/usr/bin/env bash
# Fetch the ClinicalCraft engine AcuCraft is built on, at the revision pinned in tools/clinicalcraft.rev.
#
# AcuCraft imports @clinicalcraft/core from source (it has one runtime dependency, zod, which AcuCraft provides).
# The checkout lives in .deps/clinicalcraft (git-ignored). Set CLINICALCRAFT_DIR to use an existing checkout instead;
# tests and the CLI then resolve the engine there (it should be at the pinned revision: tools/check.sh verifies it).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
rev="$(grep -Eo '^[0-9a-f]{40}' "$root/tools/clinicalcraft.rev" | head -1)"
if [ -z "$rev" ]; then echo "tools/clinicalcraft.rev holds no full commit id" >&2; exit 1; fi
url="${CLINICALCRAFT_URL:-https://github.com/psknlr/ClinicalCraft}"
link="$root/.deps/clinicalcraft"
if [ -n "${CLINICALCRAFT_DIR:-}" ]; then
  # an existing checkout: every resolver (vitest, tsc, tsx) looks in .deps/clinicalcraft, so link it there
  dir="$(cd "$CLINICALCRAFT_DIR" && pwd)"
  mkdir -p "$root/.deps"
  if [ -e "$link" ] && [ ! -L "$link" ]; then echo "$link exists and is not a link: remove it to use CLINICALCRAFT_DIR" >&2; exit 1; fi
  ln -sfn "$dir" "$link"
else
  dir="$link"
fi
if [ -d "$dir/.git" ]; then
  have="$(git -C "$dir" rev-parse HEAD)"
  if [ "$have" = "$rev" ]; then echo "ClinicalCraft $rev already at $dir"; exit 0; fi
  if [ -n "${CLINICALCRAFT_DIR:-}" ]; then
    echo "warning: $dir is at $have, not the pinned $rev (leaving it as it is)" >&2; exit 0
  fi
  git -C "$dir" fetch --depth 1 origin "$rev"
  git -C "$dir" checkout --detach "$rev"
else
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" remote add origin "$url"
  GIT_LFS_SKIP_SMUDGE=1 git -C "$dir" fetch --depth 1 origin "$rev"
  GIT_LFS_SKIP_SMUDGE=1 git -C "$dir" checkout -q --detach FETCH_HEAD
fi
echo "ClinicalCraft $(git -C "$dir" rev-parse --short HEAD) at $dir"
