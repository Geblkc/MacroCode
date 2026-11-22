#!/usr/bin/env bash
# MacroCode — Linux paketlerini (.deb / .rpm / AppImage) üretir ve
# repodaki `bundles/` klasöründe toplar.
#
# Kullanım:
#   bash scripts/build-linux.sh                  # deb + rpm + appimage
#   bash scripts/build-linux.sh --bundles deb    # yalnız .deb
#   bash scripts/build-linux.sh --bundles deb,appimage
#   bash scripts/build-linux.sh --skip-install   # node_modules hazırsa npm ci atla
#
# Updater imzası: `TAURI_SIGNING_PRIVATE_KEY` tanımlıysa `.sig` dosyaları da
# üretilir. Tanımlı değilse Tauri imzalamayı atlar; paketler yine üretilir.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUNDLES="deb,rpm,appimage"
SKIP_INSTALL=0

usage() {
  cat <<'EOF'
MacroCode — Linux paketlerini (.deb / .rpm / AppImage) üretir ve
repodaki `bundles/` klasöründe toplar.

Kullanım:
  bash scripts/build-linux.sh                  # deb + rpm + appimage
  bash scripts/build-linux.sh --bundles deb    # yalnız .deb
  bash scripts/build-linux.sh --bundles deb,appimage
  bash scripts/build-linux.sh --skip-install   # node_modules hazırsa npm ci atla

Updater imzası: `TAURI_SIGNING_PRIVATE_KEY` tanımlıysa `.sig` dosyaları da
üretilir. Tanımlı değilse Tauri imzalamayı atlar; paketler yine üretilir.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundles)
      [[ $# -ge 2 ]] || { echo "hata: --bundles değeri eksik" >&2; exit 1; }
      BUNDLES="$2"
      shift 2
      ;;
    --bundles=*)
      BUNDLES="${1#*=}"
      shift
      ;;
    --skip-install)
      SKIP_INSTALL=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "hata: bilinmeyen argüman: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# Yalnızca desteklenen paket türlerini kabul et.
IFS=',' read -r -a REQUESTED <<<"$BUNDLES"
if [[ ${#REQUESTED[@]} -eq 0 ]]; then
  echo "hata: --bundles boş olamaz" >&2
  exit 1
fi
for b in "${REQUESTED[@]}"; do
  case "$b" in
    deb | rpm | appimage) ;;
    *)
      echo "hata: geçersiz paket türü: $b (deb,rpm,appimage)" >&2
      exit 1
      ;;
  esac
done

log() { printf '\033[36m[build-linux]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[build-linux] BAŞARISIZ:\033[0m %s\n' "$*" >&2; exit 1; }

# pkg-config ile sistem bağımlılıklarını erkenden kontrol et.
if command -v pkg-config >/dev/null 2>&1; then
  missing=()
  for dep in webkit2gtk-4.1 gtk+-3.0 librsvg-2.0 dbus-1; do
    pkg-config --exists "$dep" || missing+=("$dep")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    fail "eksik sistem bağımlılıkları: ${missing[*]}
  Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev libdbus-1-dev build-essential
  Fedora:        sudo dnf install webkit2gtk4.1-devel gtk3-devel librsvg2-devel openssl-devel dbus-devel
  Arch:          sudo pacman -S webkit2gtk-4.1 gtk3 librsvg openssl dbus base-devel"
  fi
else
  log "UYARI: pkg-config yok — sistem bağımlılıkları önceden kontrol edilemedi"
fi

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  log "UYARI: TAURI_SIGNING_PRIVATE_KEY tanımlı değil — updater .sig dosyaları üretilmeyebilir"
fi

if [[ $SKIP_INSTALL -eq 0 ]]; then
  log "bağımlılıklar kuruluyor (npm ci)…"
  npm ci
fi

log "ön yüz derleniyor (npm run build)…"
npm run build

log "Tauri paketleri derleniyor: $BUNDLES"
npm run tauri build -- --bundles "$BUNDLES"

BUNDLE_DIR="src-tauri/target/release/bundle"
mkdir -p bundles

shopt -s nullglob
copied=()
for kind in "${REQUESTED[@]}"; do
  case "$kind" in
    deb) files=("$BUNDLE_DIR"/deb/*.deb) ;;
    rpm) files=("$BUNDLE_DIR"/rpm/*.rpm) ;;
    appimage) files=("$BUNDLE_DIR"/appimage/*) ;;
  esac
  if [[ ${#files[@]} -eq 0 ]]; then
    fail "$kind paketi bulunamadı ($BUNDLE_DIR/$kind)"
  fi
  cp -f "${files[@]}" bundles/
  copied+=("${files[@]}")
done
shopt -u nullglob

log "SHA256SUMS üretiliyor…"
(
  cd bundles
  rm -f SHA256SUMS
  sha256sum -- * >SHA256SUMS
)

log "toplanan dosyalar:"
ls -lh bundles

echo
log "BAŞARILI ✓ — ${#copied[@]} dosya bundles/ altında (SHA256SUMS dahil)"
