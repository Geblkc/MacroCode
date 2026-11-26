# Performans Baseline (Faz 0)

Optimizasyon çalışmalarının öncesi/sonrası karşılaştırması için ölçüm
altyapısı ve başlangıç değerleri. Bu dosya **yaşayan** bir kayıttır: her faz
sonunda yeni ölçümler eklenir, eski satırlar silinmez.

## 1. Ölçüm altyapısı

### `/perf` komutu (terminal)

| Komut | Etki |
| --- | --- |
| `/perf` | Anlık raporu terminale yazar |
| `/perf on` | Ölçümü açar ve `macrocode-perf=1` bayrağını kalıcı yazar |
| `/perf off` | Ölçümü durdurur, bayrağı siler |
| `/perf reset` | Sayaçları sıfırlar (bayrak korunur) |

Dev derlemesinde ölçüm otomatik açıktır; release'te yalnız bayrak veya
`/perf on` ile etkinleşir. Kapalıyken kancalar tek `if` ile döner.

### DevTools köprüsü

```js
window.__macrocodePerf.snapshot(); // ham JSON
window.__macrocodePerf.report();   // metin rapor
window.__macrocodePerf.reset();
window.__macrocodePerf.enable();
window.__macrocodePerf.mark('custom');
```

### Toplanan metrikler

- **boot**: `install`, React `app:mounted`, FCP, DOMContentLoaded
- **store**: toplam güncelleme ve streaming sırasındaki güncelleme/s
- **persist**: `localStorage` anahtar bazında yazma sayısı, bayt, bloke süre
- **db**: `saveSessionsToDb` çağrı/süre/bayt/oturum sayısı (max süre dahil)
- **frames**: streaming sırasında rAF aralıkları (p50/p95/max, >50 ms)
- **longtasks**: 50 ms üstü ana thread görevleri (destekleyen WebView'de)
- **heap**: `performance.memory` varsa kullanılan/toplam JS heap

`localStorage` sayacı `Storage.prototype.setItem` sarmalar; Zustand persist
maliyeti doğrudan görünür. DB sayacı Rust hızlı yolunda serileştirilen JSON
boyutunu da raporlar.

## 2. Statik baseline (2026-11-25)

`npm run build` çıktısı:

| Artefakt | Ham | Gzip |
| --- | ---: | ---: |
| Ana JS (`index-BEDroJbT.js`) | 1.310,80 kB | 383,50 kB |
| CSS (`index-BzMV7HiX.css`) | 93,24 kB | 15,33 kB |
| Toplam `dist/` | 1,70 MB | — |
| `public/fonts/` | 304 KB | — |

Not: recharts, ana chunk içinde statik olarak yer alıyor; build 500 kB
üstü chunk uyarısı veriyor. Bu, Faz 8'deki lazy-load hedefinin referansıdır.

## 3. Manuel senaryolar

Aşağıdaki senaryolar kayıt altına alınırken `/perf reset` ile sayaçlar
sıfırlanır. Her senaryo en az iki kez koşulur.

| # | Senaryo | Nasıl | Kabul kriteri |
| --- | --- | --- | --- |
| 1 | Soğuk açılış | Uygulamayı kapat/aç, `/perf` → `boot` satırı | mount/FCP regresyonsuz |
| 2 | Boşta CPU/RSS | 10 dk bekle: `ps -o %cpu,rss -p <pid>` ortalama | CPU ~%0, RSS sabit |
| 3 | Akış (kısa) | ~30 sn'lik tek yanıt | `frames.p95` < 20 ms, >50 ms frame yok |
| 4 | Akış (uzun) | 500+ mesajlı oturumda 60 sn yanıt | `storeUpdatesDuringStream/s` düşer, `persist` yazması ~0 |
| 5 | DB yazımı | Senaryo 4 sonunda `/perf` → `db` satırı | `db.bytes` yalnız değişen oturum boyutu |
| 6 | Araç çıktısı | Uzun build/test komutu (tool stream) | UI donmuyor, `longtasks` artmıyor |
| 7 | Büyük repo | `grep` / `list_tree` / snapshot sırasında UI | invoke yanıtları < 100 ms gecikmeli |
| 8 | Git paneli açık | 5 dk boşta | CPU artışı yok |

## 4. Optimizasyon öncesi beklenen zayıf noktalar

Kod incelemesiyle doğrulanan ve ölçümle teyit edilecek başlıklar:

1. `localStorage` persist her token'da tüm oturumları yazıyor → senaryo 4'te
   `persist.writes` yüksek, `persist.ms` birikimli.
2. DB her yazmada tüm oturumları gönderiyor → `db.sessions/save` tüm arşiv.
3. Terminal/timeline her token'da tam yeniden kuruluyor → uzun oturumda
   `frames.p95` yükselir.
4. Streaming sırasında markdown tam yeniden parse → `longtasks` artar.

Hedef (Faz 1–3 sonrası): senaryo 4'te token başına persist yazması **0**,
`storeUpdatesDuringStream/s` en az **5×** azalma, >50 ms frame sayısında
belirgin düşüş.

## 5. Nasıl güncellenir

1. Değişiklik öncesi/sonrası aynı senaryoyu koş.
2. `/perf` çıktısını bu dosyaya tarih + commit ile ekle.
3. Regresyon varsa faz geri alınmadan ilerlenmez.

## 6. Faz 1 kaydı — streaming yazma yolu

Değişiklikler:

- **Oturum persist'i ertelendi** (`src/store/sessionPersist.ts`): Zustand'a
  `createJSONStorage` yerine doğrudan `PersistStorage` verildi. State referansı
  tutulur; `JSON.stringify` + `localStorage.setItem` yalnızca yazma trafiği
  1500 ms kesildikten sonra bir kez yapılır. `pagehide` / `beforeunload` /
  sekme gizlenince flush edilir.
- **Delta birleştirme** (`src/lib/deltaBatch.ts`): SSE metin/reasoning
  deltaları 40 ms'lik pencerede birleştirilip tek store yazımına indirildi
  (`useStream` + `useAgent`). Araç/sınır olayları öncesinde zorunlu flush.
- Sohbet akışında token başına `updateLastMessage` çağrısı ~25/s üst sınıra
  indi; agent akışında `appendToMessage`/`appendReasoning` aynı şekilde.

Beklenen ölçüm farkı (senaryo 3/4):

| Metrik | Önce | Sonra (beklenen) |
| --- | --- | --- |
| `persist` yazması / 60 sn akış | ~1200 | 0–1 |
| `persist.bytes` (akış başına) | MB mertebesinde | akış sonunda 1 yazma |
| `storeUpdatesDuringStream/s` | token hızında | ≤ ~25 |
| `longtasks` (markdown hariç) | yüksek | belirgin düşük |

Statik build (2026-11-25, Faz 1 sonrası): ana JS **1.312,52 kB** (gzip
384,21 kB), CSS değişmedi. Fark, ölçüm + birleştirici kodundan (+1,7 kB).

Doğrulama: 60 sn akış sırasında `/perf` → `persist: 0 writes` ve
`store: … during stream` satırındaki saniyelik hız ≤ 25 olmalı. Akış bitince
1,5 sn sonra tek `persist` yazması görülür.


## 7. Faz 2 kaydı — dar abonelikler ve türev sürümü

Değişiklikler:

- **Hafif oturum özeti** (`src/store/sessionSummaries.ts`): Sidebar artık tam
  `Session` nesnelerine değil, kimlik/ad/mesaj sayısı/model/mod/`updatedAt`
  alanlarından oluşan özetlere abone. Özetler oturum başına önbelleklenir ve
  görünen alanlar değişmedikçe **aynı referans** döner; `useShallow` ile dizi
  elemanları karşılaştırılır. `updatedAt` dakika kovasına yuvarlandığı için
  akış sırasında göreli zaman etiketi listeyi titretmez (gösterim zaten
  saat:dakika).
- **App** yalnız aktif oturumu (`sessions.find`) ve oturum kimlik listesini
  (`useShallow`) izler; tüm `sessions` aboneliği kaldırıldı.
- **StatusBar** aktif oturumun görünen alanlarını (`model`, `provider`,
  `agentMode`) ve yeni `usageRevision` sayacını izler. Token/maliyet/bağlam
  türevleri `useMemo` içinde `usageRevision` ile anahtarlanır; metin deltaları
  bu sayacı artırmaz.
- **`usageRevision`** (`src/store/session.ts`): mesaj ekleme/silme, tool
  mesajları, usage/lastRequest yazımı, oturum temizleme, compaction ve akış
  bitişinde (`setStreaming(false)`) artar. `updateLastMessage` /
  `appendToMessage` gibi token yolu **artırmaz**.
- **`memo` + stabil callback'ler**: `Sidebar` ve `StatusBar` `memo` ile
  sarıldı; App'teki modal açma, silme onayı, durum çubuğu tıklamaları
  `useCallback` ile sabitlendi. Kapalı `SessionHistoryModal` artık mount
  edilmiyor.

Beklenen ölçüm farkı (senaryo 3/4):

| Metrik | Faz 1 sonrası | Faz 2 sonrası (beklenen) |
| --- | --- | --- |
| Sidebar render / akış | her deltada | yalnız ad/sayı/mod dakika sınırında |
| StatusBar `sessionCost`/`contextUsage` | her deltada | yalnız `usageRevision` değişiminde |
| App store okuması | tüm `sessions` | aktif oturum + id listesi |
| Boşta yeniden render | — | modal kapalıyken yok |

Statik build (2026-11-26, Faz 2 sonrası): ana JS **1.315,20 kB** (gzip
385,12 kB), CSS 93,24 kB (gzip 15,33 kB). Fark (+2,7 kB) özet/abonelik
kodundan; çalışma zamanı kazancı bundle boyutundan bağımsız.

Doğrulama: uzun bir oturumda akış sürerken `/perf` → `store` satırındaki
saniyelik güncelleme ≤ 25 kalmalı; Sidebar/StatusBar'ın her deltada
yeniden çizilmediği React DevTools "Highlight updates" ile teyit edilir.
Akış bitince token/maliyet/bağlam göstergeleri tek seferde tazelenir.

## 8. Faz 3 kaydı — timeline, render ve markdown maliyeti

Değişiklikler:

- **Timeline iki aşamaya ayrıldı** (`src/lib/timeline.ts`):
  `buildTimelineBase` yalnızca mesajlardan gelen iskeleti (mesaj + araç
  kartları + süreler) kurar; `mergeTimeline` geçici `extras` satırlarını
  birleştirir. Birleştirme iskelet nesnelerini **değiştirmez**, güncellenen
  araç kartının kopyasını üretir.
- **`TimelineModel` önbelleği** (`src/lib/timelineModel.ts`): akış sırasında
  değişen tipik durum son mesajın içeriğidir. Önceki mesajlar aynı referansta
  ve `toolCalls` değişmediyse iskeletin yalnız son mesaj satırı kopyalanır
  (O(1)); yeni mesaj/araç çağrısı/compaction/oturum değişiminde iskelet
  sıfırdan kurulur.
- **ViewLine önbelleği** (`Terminal`): mesaj nesnesi ve akış bayrakları
  değişmedikçe aynı görünüm satırı referansı döner. Tamamlanmış mesajların
  markdown'ı ve `MessageLine` memo karşılaştırması böylece korunur; iskelet
  yeniden kurulsa bile içerik parse edilmez.
- **Canlı araç çıktısı birleştirme** (`useAgent`): `tool_stream` parçaları
  araç id'si başına 100 ms pencerede biriktirilip tek satır olarak emit edilir.
  `tool_result`, tur sonu ve iptal öncesinde zorunlu flush yapılır. Önceden her
  stdout parçası App'te yeni bir `extras` dizisi + timeline hesabı tetikliyordu.
- **rAF ile otomatik kaydırma** (`Terminal`): her delta'da zorunlu
  `scrollHeight` okuması yerine kare başına en fazla bir ölçüm.
- **Kademeli markdown penceresi** (`MessageLine`): stream sırasında tam parse
  aralığı içerik boyuyla birlikte 50 → 100 → 160 ms'ye çıkar (uzun yanıtta
  saniyede ≥6 güncelleme kalır); akış bitince son içerik anında senkronlanır.

Beklenen ölçüm farkı (senaryo 3/4):

| Metrik | Faz 2 sonrası | Faz 3 sonrası (beklenen) |
| --- | --- | --- |
| Timeline kurulumu / metin deltası | O(n log n), tüm satırlar | O(1) son satır + hafif extras birleşimi |
| `extras` güncellemesi / sn (exec çıktısı) | parça hızında | ≤ ~10 |
| Markdown parse / sn | her 50 ms | 50–160 ms (içerik boyuna göre) |
| Scroll layout / delta | 1 | ≤ 1 / kare |
| Tamamlanmış mesaj render'ı | memo ile atlanıyordu | aynı + satır nesnesi de sabit |

Not: Sanallaştırma (yalnız görünür satırları DOM'da tutma) bu fazda
uygulanmadı. Ölçümlerde kalan maliyet satır sayısıyla doğrusal React
karşılaştırması; çok uzun oturumlarda (1000+ satır) gerekirse sonraki fazda
`content-visibility` veya pencereleme ayrıca değerlendirilecek.

Statik build (2026-11-26, Faz 3 sonrası): ana JS **1.317,75 kB** (gzip
386,19 kB), CSS değişmedi. Fark (+2,55 kB) timeline modeli ve testlerden.

Doğrulama: uzun bir yanıtta React DevTools "Highlight updates" ile yalnız son
satırın güncellendiği; exec çıktısı akarken `extras` güncellemelerinin parça
hızında değil ~10/s olduğu görülür. `/perf` → `frames.p95` < 20 ms ve >50 ms
frame sayısı Faz 2'ye göre düşük kalmalı. Test/lint/tsc/build: 96 test dosyası
/ 850 test geçti; lint, tsc ve build temiz.

## 9. Faz 4 kaydı — Rust tarafı (thread, disk, HTTP, release)

Değişiklikler:

- **Exec yakalama dosyasına disk sınırı** (`exec.rs`): her stdout/stderr
  geçici dosyası en fazla **1 MiB**. Sınırdan sonra boru boşaltılmaya devam
  edilir (çocuk süreç yazmada takılmaz), yalnızca dosyaya yazma kesilir ve
  sonuç `capture_incomplete=true` ile işaretlenir. Artifact da bu sınırlı
  dosyalardan üretildiği için sınırsız disk büyümesi ortadan kalktı. Yeni Rust
  testi: `pump_disk_sinirini_asinca_boruyu_yine_bosaltir`.
- **Ana thread'de disk yazısı kaldırıldı** (`tool_output.rs`): sync Tauri
  komutları ana thread'de çalıştığı için `store_tool_output` artık `async` ve
  yazma + özetleme `spawn_blocking` içinde. Frontend `invoke` sözleşmesi aynı.
- **FS komutları bloklayıcı havuza taşındı** (`fs.rs`, `commands/mod.rs`):
  `list_dir`, `read_file`, `read_file_full`, `apply_patch`, `undo_patch`,
  `grep_files`, `glob_files`, `list_tree`, `memory_read`, `memory_append`,
  `write_file` artık gövdelerini `spawn_blocking` içinde çalıştırıyor. Harici
  çağrı imzaları ve davranışları değişmedi.
- **Paylaşılan HTTP istemcileri** (`stream.rs`, `proxy.rs`): her istekte
  `reqwest::Client` kurulması TLS kurulumu ve bağlantı havuzunu çöpe atıyordu.
  İki farklı güvenlik yapılandırması (redirect kapalı Anthropic istemcisi /
  DNS+redirect korumalı proxy istemcisi) süreç boyunca `OnceLock` ile
  paylaşılıyor; davranış aynı.
- **Keystore göçü açılıştan çıkarıldı** (`lib.rs`): `migrate_legacy_keys`
  D-Bus/Keychain erişimini `spawn_blocking` ile arka plana alıyor; UI thread'i
  açılışta bloke olmuyor. Zincir okuma yine doğrudan ana depodan yapılır,
  göç gecikmesi yanlış `key_status` üretmez.
- **Release profili** (`Cargo.toml`): `opt-level=3`, `lto="thin"`,
  `codegen-units=1`, `strip="symbols"`, `incremental=false`. `panic="abort"`
  bilinçli olarak kullanılmadı (bağımlılıkların unwind beklentisi).

Beklenen ölçüm farkı:

| Metrik | Önce | Sonra (beklenen) |
| --- | --- | --- |
| UI thread engelleme (artifact yazma, keystore göçü) | var | yok |
| Uzun `grep`/`list_tree` sırasında async runtime | worker blokajı | blocking havuzu |
| Her LLM isteğinde TLS el sıkışması | var | bağlantı havuzu yeniden kullanılır |
| Sınırsız çıktı üreten exec | disk doldurabilir | ≤ 1 MiB capture + artifact |
| Release ikilisi | varsayılan | LTO + strip ile küçük |

Doğrulama: `cargo check --offline` ve `cargo test --offline` temiz —
**151 Rust testi geçti** (yeni disk sınırı testi dahil). JS tarafında bu fazda
kod değişmedi; build boyutu Faz 3 değerinde kalır (1.317,75 kB / gzip 386,19 kB).

## 10. Faz 4 (devam) — gerçek async dosya yazısı ve paralel keychain

Değişiklikler:

- **Exec pump gerçek async I/O** (`exec.rs`, `Cargo.toml`): capture dosyası
  `tokio::fs::File::from_std` ile sarıldı; her 64 KB chunk'ın `write_all` ve
  son `flush` çağrıları `await` ediliyor. `tokio` bağımlılığına `fs` feature'ı
  eklendi. Disk işlemi artık tokio blocking havuzunda, async worker'da değil.
- **`key_status` paralelleştirildi** (`keystore.rs`): 12 sağlayıcının var/yok
  kontrolü sırayla yapılıyordu (her biri ayrı keychain/D-Bus turu). Artık
  `join_all` ile aynı anda başlatılıyor; `KeyStatus` alan eşlemesi sabit
  sırayla korunuyor.

Beklenen ölçüm farkı:

| Metrik | Önce | Sonra |
| --- | --- | --- |
| Exec çıktısı akarken async worker blokajı | chunk başına senkron yazı | blocking havuzunda async yazı |
| `key_status` gecikmesi | 12 × keychain turu | ~1 tur (paralel) |

Doğrulama: `cargo check --offline` temiz, `cargo test --offline` → **151 Rust
testi geçti**. DOM sanallaştırması bu turda uygulanmadı: Tauri'nin Linux/macOS
webview'lerinde `content-visibility` desteği tutarsız, tam pencereleme ise
arama/otomatik kaydırma davranışını değiştireceği için ölçüm gerektirir. Faz 3
önbelleği ile kalan maliyet satır sayısına bağlı React karşılaştırmasıdır;
1000+ satırlık oturumlarda ayrı bir ölçüm turu önerilir.

Release derlemesi tamamlandı (2026-11-26): `target/release/macrocode` **19 MB**,
`libmacrocode_lib.so` **1,3 MB**. Soğuk ilk LTO derlemesi 15 dakikalık sınırı
aştığı için iptal edildi; artifact'lar korunarak yeniden çalıştırıldığında
4 dk 58 sn tamamlandı. Önceki profille ikili karşılaştırması yapılmadı; bu
sayılar yeni profilin referans değeridir.

## 11. Faz 5 deneyi — ölçüm + `content-visibility`

Bu adım DOM sanallaştırmasına **ölçümle karar vermek** için yapıldı; tam
pencereleme uygulanmadı.

Değişiklikler:

- **Terminal ölçümü** (`perf.ts`, `Terminal.tsx`): her render → commit süresi,
  görünüm satırı sayısı, en yüksek satır sayısı ve deneyin açık/kapalı olduğu
  `/perf` raporuna `terminal:` satırı olarak eklenir (`cv on/off`). Ölçüm yalnız
  perf açıkken yapılır; `perfReset` sayaçları sıfırlar.
- **CSS deneyi** (`message.css`, `Terminal.tsx`): 120 satırı aşan oturumlarda
  `.terminal-view` sınıfı `terminal-view-cv` alır; doğrudan çocuk `.msg`
  satırlarına `content-visibility: auto` + `contain-intrinsic-size: 88px`
  (destekleyenlerde `auto 88px`) uygulanır ve `msg-rise` animasyonu kapatılır.
  Desteklenmeyen webview'de kural yok sayılır; mevcut davranış korunur.
- **A/B anahtarı**: `localStorage.setItem('macrocode-cv', '0')` + uygulamayı
  yeniden başlatmak deneyi kapatır. Varsayılan açıktır.

A/B protokolü:

1. 1000+ satırlık bir oturum aç; dev derlemesinde ölçüm otomatik, release'te
   `/perf on` çalıştır.
2. Deney kapalıyken (`macrocode-cv=0`) 60 sn akış + yukarı/aşağı kaydırma;
   `/perf` → `terminal:` ve `frames:` satırlarını kaydet, `/perf reset`.
3. Deney açıkken aynı senaryoyu tekrarla; `terminal:` satırındaki `cv on`
   doğrulanır.
4. Karşılaştır: `terminal max/last`, `frames p95`, `frames >50ms`,
   `longtasks`. Kaydırma sırasında scrollbar sıçraması/satır atlaması varsa
   deney iptal edilir (`macrocode-cv=0`).

Beklenen: JS render süresi değişmez (DOM'da aynı satır sayısı), buna karşın
ekran dışı satırların düzen/paint maliyeti düşer → `frames p95` ve `longtasks`
azalır. WebKitGTK `content-visibility`'i desteklemiyorsa fark görülmez; bu
durumda gerçek sanallaştırma (tail-window) gerekir.

Statik build (2026-11-26, Faz 5 deneyi): ana JS **1.318,83 kB** (gzip
386,57 kB), CSS **93,37 kB** (gzip 15,38 kB). JS farkı (~1,1 kB) ölçüm
kodundan, CSS farkı (~0,13 kB) deney kuralından.

Doğrulama: 96 test dosyası / **852 test geçti** (perf sayaçları için 2 yeni
test), lint, tsc ve build temiz. Gerçek webview ölçümü henüz yapılmadı; sonuç
gelene kadar bu bir deney olarak kalır.
