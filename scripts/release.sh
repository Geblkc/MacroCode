#!/usr/bin/env bash
# MacroCode — sürüm alanlarını günceller (commit/tag/push YAPMAZ).
#
# Kullanım:
#   bash scripts/release.sh 1.0.0
#   bash scripts/release.sh 1.0.0 --dry-run   # ne yapılacağını gösterir, dosya değiştirmez
#
# Commit/tag/push adımları için RELEASE_GUIDE.md bölüm 5'e bakın.
set -euo pipefail

VERSION="${1:-}"
DRY_RUN=0
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    *)
      echo "kullanım: bash scripts/release.sh <X.Y.Z> [--dry-run]" >&2
      exit 1
      ;;
  esac
  shift
done

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "kullanım: bash scripts/release.sh <X.Y.Z> [--dry-run]" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

if [[ $DRY_RUN -eq 1 ]]; then
  echo "→ [dry-run] package.json + package-lock.json: $VERSION"
  echo "→ [dry-run] src-tauri/Cargo.toml: $VERSION"
  echo "→ [dry-run] src-tauri/tauri.conf.json: $VERSION"
  echo "→ [dry-run] Cargo.lock güncellenecek"
  echo
  echo "Dry-run: hiçbir dosya değiştirilmedi."
  exit 0
fi

echo "→ package.json + package-lock.json: $VERSION"
npm version "$VERSION" --no-git-tag-version >/dev/null

echo "→ src-tauri/Cargo.toml: $VERSION"
sed -i -E "s/^version = \"[^\"]+\"/version = \"$VERSION\"/" src-tauri/Cargo.toml

echo "→ src-tauri/tauri.conf.json: $VERSION"
sed -i -E "0,/\"version\": \"[^\"]+\"/s//\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json

echo "→ Cargo.lock güncelleniyor"
cargo check --quiet --lib --manifest-path src-tauri/Cargo.toml

echo
echo "Sürüm $VERSION hazır. Sonraki adımlar:"
echo "  1. npm test && npm run build"
echo "  2. cargo fmt --check && cargo clippy --lib -- -D warnings"
echo "  3. cargo test --lib --manifest-path src-tauri/Cargo.toml"
echo "  4. Git commit + tag + push (RELEASE_GUIDE.md bölüm 5)"
