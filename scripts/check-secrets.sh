#!/usr/bin/env bash
# MacroCode — izlenen kaynak ağacında gerçek API anahtarı/secret izi arar.
#
# Yalnızca `git ls-files` kullanır: derleme çıktıları, node_modules ve yerel
# `keys.json` zaten izlenmez. Test fixture'larındaki kısa sahte değerler
# (sk-ant-test..., nvapi-test, AIza…IJKLMOP vb.) allowlist ile atlanır.
# Eşleşme varsa değeri ASLA yazdırmaz, sadece dosya:satır + prefix verir.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

python3 - <<'PY'
import os
import re
import subprocess
import sys

fail = False

tracked = [p for p in subprocess.check_output(['git', 'ls-files', '-z']).decode('utf-8', 'replace').split('\0') if p]

# 1) Depoya girmemesi gereken dosya adları.
for path in tracked:
    base = os.path.basename(path)
    if base == 'keys.json' or (base.startswith('.env') and base != '.env.example'):
        print(f'HATA: secret dosyası izleniyor: {path}', file=sys.stderr)
        fail = True

# 2) Bilinen gerçek anahtar desenleri. Eşikler sahte/test değerlerinin üstünde.
SECRET = re.compile(
    r'(?:'
    r'sk-ant-[A-Za-z0-9_-]{35,}|'
    r'sk-or-v1-[A-Za-z0-9_-]{30,}|'
    r'sk-proj-[A-Za-z0-9_-]{30,}|'
    r'nvapi-[A-Za-z0-9_-]{30,}|'
    r'evre[A-Za-z0-9_-]{38,}|'
    r'AIza[0-9A-Za-z_-]{28,}|'
    r'gh[pousr]_[A-Za-z0-9]{30,}|'
    r'github_pat_[A-Za-z0-9_]{30,}|'
    r'xox[baprs]-[A-Za-z0-9-]{30,}|'
    r'AKIA[0-9A-Z]{16}|'
    r'sk-[A-Za-z0-9]{36,}'
    r')'
)
# Allowlist yalnızca eşleşen DEĞERE uygulanır; dosya adındaki "test" bir
# gerçek anahtarı gizlemesin.
PLACEHOLDER = re.compile(
    r'test|example|dummy|placeholder|sample|abcdef|123456|ijklmnop|klmnop|xxxx|…',
    re.IGNORECASE,
)
PEM = re.compile(r'BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY')

for path in tracked:
    try:
        with open(path, 'rb') as fh:
            raw = fh.read()
    except OSError:
        continue
    if b'\0' in raw[:8192]:
        continue
    text = raw.decode('utf-8', 'replace')

    for match in SECRET.finditer(text):
        value = match.group()
        if PLACEHOLDER.search(value):
            continue
        line = text.count('\n', 0, match.start()) + 1
        print(f'HATA: {path}:{line}: {value[:6]}<REDACTED>', file=sys.stderr)
        fail = True

    for match in PEM.finditer(text):
        line = text.count('\n', 0, match.start()) + 1
        print(f'HATA: özel anahtar bloğu: {path}:{line}', file=sys.stderr)
        fail = True

if fail:
    print('Secret taraması BAŞARISIZ — yukarıdaki dosyaları temizle.', file=sys.stderr)
    sys.exit(1)

print('Secret taraması temiz ✓')
PY
