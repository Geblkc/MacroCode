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

