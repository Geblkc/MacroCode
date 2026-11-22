# Gömülü fontlar

Bu klasördeki `.woff2` dosyaları, uygulamanın çevrimdışı çalışabilmesi ve
çalışma anında hiçbir üçüncü taraf sunucusuna istek gitmemesi için yerel olarak
paketlenmiştir. `index.html` üzerinden harici font yüklenmez (CSP `font-src 'self'`).

| Font | Sürüm | Lisans |
|---|---|---|
| [Inter](https://github.com/rsms/inter) | v20 (değişken ağırlık) | SIL Open Font License 1.1 |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | v24 | SIL Open Font License 1.1 |

Alt kümeler (`latin`, `latin-ext`, `cyrillic`, `cyrillic-ext`, `greek`,
`greek-ext`, `vietnamese`) Google Fonts tarafından üretilmiştir; `unicode-range`
tanımları `src/styles/fonts.css` içindedir. Lisans metinleri:
<https://scripts.sil.org/OFL>
