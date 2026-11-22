# PACKAGING — MacroCode Dağıtım Rehberi

> MacroCode paketleme ve dağıtım talimatları. Mimari için bkz. `ARCHITECTURE.md`,
> tarihli kayıtlar için bkz. `DEVLOG.md`.

## Ne üretilir?

| Platform | Paket | Üretim yeri |
|---|---|---|
| Linux | `.deb` (Debian/Ubuntu) | Yerel: `npm run dist:deb` |
| Linux | `.rpm` (Fedora/openSUSE) | Yerel: `npm run dist:rpm` |
| Linux | `.AppImage` (tüm dağıtımlar) | Yerel: `npm run dist:appimage` |
| Windows | NSIS `.exe` kurulumu | CI: `release.yml` |
| Windows | `.msi` (WiX) | CI: `release.yml` |

Tüm çıktılar repo kökündeki **`bundles/`** klasöründe toplanır (git'e girmez)
ve `SHA256SUMS` üretilir.

## Linux — yerel derleme

```bash
npm run dist:linux                # deb + rpm + AppImage (hepsi)
npm run dist:deb                  # yalnız .deb
npm run dist:rpm                  # yalnız .rpm
npm run dist:appimage             # yalnız .AppImage
bash scripts/build-linux.sh --bundles deb,appimage   # seçimli
bash scripts/build-linux.sh --skip-install           # node_modules hazırsa hızlandırır
```

### Sistem bağımlılıkları

Tauri Linux derlemesi için (betik `pkg-config` ile kontrol eder ve eksikse
kurulum komutunu söyler):

| Dağıtım | Paketler |
|---|---|
| Debian/Ubuntu | `libwebkit2gtk-4.1-dev libgtk-3-dev libssl-dev librsvg2-dev libdbus-1-dev build-essential curl wget file` |
| Fedora | `webkit2gtk4.1-devel gtk3-devel openssl-devel librsvg2-devel dbus-devel` |
| Arch | `webkit2gtk-4.1 gtk3 openssl librsvg dbus base-devel curl wget file` |

`libdbus-1-dev` / `dbus-devel`, API anahtarlarını Linux Secret Service'te saklayan
`keyring` bağımlılığı için gereklidir. Çalışma zamanında Secret Service yoksa
anahtarlar `0600` izinli yerel dosyaya yazılır (bkz. `SECURITY.md`).

Ek olarak:

- **AppImage** → `libfuse2` (Debian/Ubuntu: `libfuse2`, Fedora: `fuse-libs`, Arch: `fuse2`).
- **RPM** için `rpmbuild` gerekmez — Tauri rpm paketini Rust ile üretir.

`.deb` bağımlılıkları `src-tauri/tauri.conf.json` → `bundle.linux.deb.depends`,
`.rpm` için `bundle.linux.rpm.depends` aynı dosyada tanımlıdır (deb'de
webkit2gtk + gtk3 Tauri tarafından otomatik eklenir).

## Windows ve macOS — CI üzerinden

Linux'tan `.msi`/NSIS `.exe` güvenilir üretilemez (MSVC + WebView2 +
NSIS araç zinciri). Windows paketleri **GitHub Actions** tarafından üretilir:

```bash
bash scripts/release.sh 1.0.0           # yalnız sürüm alanlarını günceller
bash scripts/release.sh 1.0.0 --dry-run # ne yapılacağını gösterir
```

`release.sh` şunları yapar:

1. Versiyonu senkronlar: `package.json`, `package-lock.json`,
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (+ `Cargo.lock`)
2. Başka bir şey yapmaz — commit, tag ve push **manuel** adımlardır
   (bkz. `RELEASE_GUIDE.md` bölüm 5).

`vX.Y.Z` tag'i push edildiğinde `.github/workflows/release.yml` tetiklenir:

- **linux** işi (ubuntu-22.04): deb + rpm + AppImage derler
- **windows** işi (windows-latest): NSIS `.exe` + `.msi` derler
- **macos** işi (macos-latest): universal `.dmg` derler
- **release** işi: `latest.json` + `SHA256SUMS` üretir, paketleri GitHub Release'e yükler.
  Sürüm notları `docs/releases/vX.Y.Z.md` dosyasından okunur.

Yayınlanan sürüm: <https://github.com/Geblkc/Macro-Code/releases>


### Windows kurulum notları

- `webviewInstallMode: embedBootstrapper` — WebView2 Runtime kurulum
  programı NSIS kurulumuna gömülür; kullanıcı indirmeye gerek kalmadan
  (varsa) Runtime'ı kurar.
- NSIS `installMode: currentUser` — yönetici hakkı gerekmez; makine geneli
  kurulum için `tauri.conf.json` → `bundle.windows.nsis.installMode`'ı
  `machine` yapın.
- Kurulum dilleri: İngilizce + Türkçe (`displayLanguageSelector: true`).

## Elle tetikleme

`release.yml` ayrıca Actions sekmesinden **workflow_dispatch** ile elle
çalıştırılabilir; ancak Release yalnızca bir **tag** seçilerek
çalıştırıldığında oluşturulur ("Use workflow from" → tag).

## Sorun giderme

| Belirti | Çözüm |
|---|---|
| `pkg-config --exists webkit2gtk-4.1` başarısız | Yukarıdaki sistem bağımlılıklarını kurun |
| AppImage "fuse" hatası | `libfuse2` kurun (yukarıdaki tablo) |
| `.rpm` boş/eksik | `--bundles rpm` ile yeniden derleyin; `bundles/` altına bakın |
| CI Windows job'u NSIS bulamıyor | Tauri CLI NSIS'i otomatik indirir; ilk derleme uzun sürer (cache) |
| Sürüm üç dosyada farklı | `bash scripts/release.sh X.Y.Z` kullanın — elle bump yapmayın |
