use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Component, Path, PathBuf};

const MAX_READ_BYTES: u64 = 64 * 1024;
const MAX_GREP_FILES: usize = 500;
const MAX_GREP_HITS: usize = 50;
/// Bir managed tool-output artifact sayfasındaki kaynak karakter bütçesi.
const ARTIFACT_PAGE_CHARS: usize = 10_000;

/// Faz 10 (D2c) — blok listelerinin **tek kaynağı**: `src/lib/engine/blocks.json`.
/// TS tarafı (policy.ts, context.ts) aynı dosyayı import eder → iki tarafın
/// kayması (eski D2 bulgusu) imkânsız.
const BLOCKS_JSON: &str = include_str!("../../../src/lib/engine/blocks.json");

#[derive(Debug, serde::Deserialize, Default)]
pub(crate) struct Blocks {
    #[serde(default)]
    dirs: Vec<String>,
    #[serde(default)]
    files: Vec<String>,
    #[serde(rename = "secretExts", default)]
    secret_exts: Vec<String>,
    #[serde(rename = "dataExts", default)]
    data_exts: Vec<String>,
}

static BLOCKS: std::sync::OnceLock<Blocks> = std::sync::OnceLock::new();

/// Blok listeleri (dosya bozuksa boş liste → engelleme yok, ama hata loglanır).
pub(crate) fn blocks() -> &'static Blocks {
    BLOCKS.get_or_init(|| match serde_json::from_str(BLOCKS_JSON) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[fs] blok listesi okunamadi ({e}) — guvenlik duvari devre disi");
            Blocks::default()
        }
    })
}

/// Y1 (Faz 2) `exec.rs` ile paylaşılır (dosya argümanı jail'i).
///
/// **H2 düzeltmesi:** karşılaştırma ASCII-bağımsız (büyük/küçük harf duyarsız).
/// macOS/Windows dosya sistemleri `.GIT` → `.git` diye çözümler; blok listesi
/// küçük harf olduğu için eski birebir (`==`) karşılaştırma `KEYS.JSON` /
/// `.GIT/config` / `.ENV.local` ile geçiliyordu (uzantılar H2'den önce
/// duyarsız yapılmıştı, adlar unutulmuştu).
pub(crate) fn is_blocked_dir(name: &str) -> bool {
    blocks().dirs.iter().any(|d| d.eq_ignore_ascii_case(name))
}

/// Y1 (Faz 2) `exec.rs` ile paylaşılır (dosya argümanı jail'i).
pub(crate) fn is_blocked_file_name(name: &str) -> bool {
    blocks().files.iter().any(|f| f.eq_ignore_ascii_case(name))
}

/// D2b/H2 — `.env.` öneki de büyük/küçük harf duyarsız (`.ENV.local`).
pub(crate) fn is_env_prefixed(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with(".env.")
}

/// Faz 10 (D2b): gizli/veri uzantıları (`.pem`, `.key`, `.db` …) **her** fs
/// aracında kapalıdır (eskiden yalnızca walk/glob'da uygulanıyordu).
pub(crate) fn is_blocked_ext(path: &std::path::Path) -> bool {
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    is_blocked_name_ext(name)
}

/// O7 — **ad-bazlı** uzantı denetimi (exec.rs `check_file_arg` de bunu kullanır).
/// Düzeltmeler: (1) `.pem` tarzı **dotfile**'lar — Rust `Path::extension()`
/// bunlarda `None` döndürür, kaçabiliyorlardı (TS `isBlockedExt` yakalıyordu);
/// (2) `CERT.PEM` — büyük/küçük harf farkı kaçıyordu. Son `.` sonrasını uzantı
/// sayar; sonuç küçük harfe indirilip `blocks.json` listelerinde aranır.
pub(crate) fn is_blocked_name_ext(name: &str) -> bool {
    let Some(dot) = name.rfind('.') else {
        return false;
    };
    if dot == name.len() - 1 {
        return false; // "foo." → boş uzantı
    }
    let ext = name.split_at(dot + 1).1.to_ascii_lowercase();
    let b = blocks();
    b.secret_exts.iter().any(|e| e == &ext) || b.data_exts.iter().any(|e| e == &ext)
}

fn err(msg: impl Into<String>) -> String {
    msg.into()
}

/// `root` + `rel` birleşimini jail içinde çözer.
/// Mutlak path, `..` kaçışı ve bloklu dosyalar reddedilir.
pub fn resolve_rooted(root: &str, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().replace('\\', "/");
    if rel.is_empty() || rel == "." {
        return canonical_root(root);
    }
    let p = PathBuf::from(&rel);
    if p.is_absolute() {
        return Err(err("mutlak yol yasak · workspace-relative yol kullan"));
    }
    for c in p.components() {
        if matches!(c, Component::ParentDir) {
            return Err(err("root dışına çıkılamaz (../ yasak)"));
        }
    }
    // Y1 (Faz 2): bloklu dizinler YALNIZCA listeleme filtresi değildi — tüm bileşenler
    // her fs aracı için (okuma dahil) reddedilir. `.git/config` gibi token içeren
    // dosyalar otomatik onaylı `read_file`/`grep` ile okunamaz.
    for c in p.components() {
        if let Component::Normal(s) = c {
            if is_blocked_dir(&s.to_string_lossy()) {
                return Err(err(format!("yasaklı dizin: {}", s.to_string_lossy())));
            }
        }
    }
    let base = canonical_root(root)?;
    let joined = base.join(p);
    // Final hedef mevcutsa symlink'i çöz ve jail'i tekrar denetle
    // (yalnızca parent kontrolü final-component symlink kaçışını yakalamaz).
    let full = match joined.canonicalize() {
        Ok(canon) => {
            if !canon.starts_with(&base) {
                return Err(err("root dışına çıkılamaz"));
            }
            canon
        }
        Err(_) => {
            // Henüz var olmayan dosya (örn. yeni patch hedefi):
            // parent canonicalize edilir ve kontrol edilir.
            let parent = joined.parent().unwrap_or(&base);
            let canon_parent = parent
                .canonicalize()
                .map_err(|e| err(format!("dizin okunamadı: {e}")))?;
            if !canon_parent.starts_with(&base) {
                return Err(err("root dışına çıkılamaz"));
            }
            canon_parent.join(
                joined
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default(),
            )
        }
    };
    // H2: canonical çözüm sonrası GÖRELİ bileşenler yeniden denetlenir.
    // Sebebi: case-insensitive FS'te canonicalize gerçek adı döndürür
    // (`/ws/.GIT/config` → `/ws/.git/config`) ve bu adlar blok listesinden
    // geçmeli — `exec.rs::guard_file_args` deseninin fs araçlarına taşınması.
    check_rel_components(&base, &full)?;
    let file_name = full
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_owned();
    if is_blocked_file_name(&file_name) || is_env_prefixed(&file_name) {
        return Err(err(format!("yasaklı dosya: {file_name}")));
    }
    // Faz 10 (D2b): gizli/veri uzantıları da her yolda kapalı.
    if is_blocked_ext(&full) {
        return Err(err(format!("yasaklı dosya uzantısı: {file_name}")));
    }
    Ok(full)
}

/// H2 — `base` altındaki göreli yolun HER bileşeni blok listelerinden geçer
/// (dizin adı, dosya adı, `.env.` öneki, gizli/veri uzantısı — hepsi
/// büyük/küçük harf duyarsız). `resolve_rooted` canonical çözüm sonrası çağırır.
/// M5: `exec.rs` cwd jail'i de aynı denetimi kullanır.
pub(crate) fn check_rel_components(base: &Path, full: &Path) -> Result<(), String> {
    let rel = full
        .strip_prefix(base)
        .map_err(|_| err("root dışına çıkılamaz"))?;
    // `components()` platform ayracını (`/` ve Windows `\`) doğru böler;
    // `to_string_lossy().split('/')` Windows'ta tek parça verirdi.
    for comp in rel.components() {
        let seg = comp.as_os_str().to_string_lossy();
        if seg.is_empty() || seg == "." {
            continue;
        }
        if is_blocked_dir(&seg) {
            return Err(err(format!("yasaklı dizin: {seg}")));
        }
        if is_blocked_file_name(&seg) || is_env_prefixed(&seg) {
            return Err(err(format!("yasaklı dosya: {seg}")));
        }
        if is_blocked_name_ext(&seg) {
            return Err(err(format!("yasaklı dosya uzantısı: {seg}")));
        }
    }
    Ok(())
}

pub(crate) fn canonical_root(root: &str) -> Result<PathBuf, String> {
    let r = root.trim();
    if r.is_empty() {
        return Err(err("workspace root boş olamaz · /root ile seç"));
    }
    PathBuf::from(r)
        .canonicalize()
        .map_err(|e| err(format!("workspace kökü geçersiz: {e}")))
}

/// H1 devamı — `.macrocode` dizinini jail içinde çözer. Dizin henüz yoksa
/// aday yol döner (çağıran `create_dir_all` ile base altında kurar); var olan
/// ama dışarıyı gösteren symlink `Err` olur.
fn jailed_macrocode_dir(base: &Path) -> Result<PathBuf, String> {
    let dir = base.join(MEMORY_DIR);
    match dir.canonicalize() {
        Ok(d) if d.starts_with(base) => Ok(d),
        Ok(_) => Err(err(".macrocode dizini workspace dışında (symlink?)")),
        Err(_) => Ok(dir),
    }
}

/// H1 devamı — `.macrocode/<sub>` dizinini de jail içinde çözer. `apply_patch`
/// yedeği `backups` altına yazmadan önce bu kapıdan geçer; alt dizin symlink
/// ile dışarıyı gösteriyorsa yedek/manifest workspace dışına yazılamaz.
pub(crate) fn jailed_macrocode_subdir(base: &Path, sub: &str) -> Result<PathBuf, String> {
    let macro_dir = jailed_macrocode_dir(base)?;
    let dir = macro_dir.join(sub);
    match dir.canonicalize() {
        Ok(d) if d.starts_with(base) => Ok(d),
        Ok(_) => Err(err(format!(
            ".macrocode/{sub} dizini workspace dışında (symlink?)"
        ))),
        Err(_) => Ok(dir),
    }
}

/// Yedek dosyasının disk adını güvenli hale getirir.
///
/// Orijinal ad okunabilirlik için korunur, ancak `safe_backup_name` ile
/// uyumlu olmayan karakterler (`boşluk`, unicode, `:`, `?` …) `_` olur.
/// Sonuna `.bak` eklenir: böylece yedek, kaynak uzantısını (`*.test.ts`,
/// `*.tsx` …) taşımaz ve kullanıcı projelerindeki test/lint araçları
/// tarafından kaynak dosya sanılıp toplanmaz.
fn sanitize_backup_name(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.trim_matches('.').is_empty() {
        out = "file".to_string();
    }
    // `out` artık yalnızca ASCII olduğundan byte kesme güvenlidir.
    if out.len() > 80 {
        out.truncate(80);
    }
    if !out.ends_with(".bak") {
        out.push_str(".bak");
    }
    out
}

/// K1 (Faz 1) — manifest alanı `backup_file` **güvenilmez girdidir**: manifest
/// workspace içinde yaşar ve 3. taraf bir repo ile birlikte gelebilir.
/// Yalnızca tek bileşenli, `[A-Za-z0-9._-]` karakter setinde ad kabul edilir
/// (`..`, mutlak yol ve dizin ayracı reddedilir) — aksi halde `PathBuf::join`
/// mutlak tarafta tam yolu alır ve keyfi dosya silinip hedefe kopyalanabilir.
fn safe_backup_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() || n == "." || n == ".." {
        return Err(err("yedek adı geçersiz"));
    }
    if n.contains('/') || n.contains('\\') {
        return Err(err("yedek adı geçersiz (yol içeremez)"));
    }
    if !n
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err(err("yedek adı geçersiz karakterler içeriyor"));
    }
    Ok(())
}

/// K1 (Faz 1) — güvenilen yedek dosyasının son adımı: `backup_dir` ve dosyanın
/// canonical hali workspace altında olmalı (dosya adı güvenli olsa da
/// symlink dışarıyı gösterebilir).
fn resolve_backup_inside(
    root_canon: &Path,
    backup_dir: &Path,
    rel: &str,
) -> Result<PathBuf, String> {
    safe_backup_name(rel)?;
    let canon_dir = backup_dir
        .canonicalize()
        .map_err(|e| err(format!("yedek dizini okunamadı: {e}")))?;
    if !canon_dir.starts_with(root_canon) {
        return Err(err("yedek dizini workspace dışında"));
    }
    let candidate = canon_dir.join(rel.trim());
    match candidate.canonicalize() {
        Ok(canon) => {
            if !canon.starts_with(&canon_dir) {
                return Err(err("yedek dosyası yedek dizini dışında"));
            }
            Ok(canon)
        }
        // Dosya henüz yok: geri-alma zaten "bulunamadı" hatası verecek;
        // yine de aday yolu döndür ki varlık kontrolü şaşırtmasın.
        Err(_) => Ok(candidate),
    }
}

#[derive(Debug, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

#[tauri::command]
pub async fn list_dir(root: String, path: String) -> Result<Vec<DirEntry>, String> {
    let dir = resolve_rooted(&root, &path)?;
    let rd = std::fs::read_dir(&dir).map_err(|e| err(format!("dizin okunamadı: {e}")))?;
    let mut out = Vec::new();
    for e in rd {
        let e = e.map_err(|e| err(format!("girdi okunamadı: {e}")))?;
        let name = e.file_name().to_string_lossy().to_string();
        if name == ".DS_Store" {
            continue;
        }
        let ft = e
            .file_type()
            .map_err(|e| err(format!("tip okunamadı: {e}")))?;
        if ft.is_dir() && is_blocked_dir(&name) {
            continue;
        }
        out.push(DirEntry {
            name,
            is_dir: ft.is_dir(),
        });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(out)
}

/// UTF-8 bayt sınırını bir Unicode scalar sınırında keser. Ham bayt
/// dilimleme geçersiz UTF-8 sınırında panik yapabilir; burada en yakın tam
/// karakter sınırı seçilir.
fn truncate_utf8_bytes(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

#[derive(Debug, Serialize)]
pub struct ReadOut {
    pub content: String,
    pub truncated: bool,
    /// Artifact okumada bir sonraki sayfanın 1-tabanlı başlangıç satırı.
    #[serde(default)]
    pub next_offset: Option<usize>,
    /// Uzun satırın devamı için 1-tabanlı Unicode karakter sütunu.
    #[serde(default)]
    pub next_column: Option<usize>,
    /// Okunan dosyanın toplam satır sayısı (biliniyorsa).
    #[serde(default)]
    pub total_lines: Option<usize>,
    /// Yanıtın yönetilen tool-output artifact'ı olduğunu belirtir.
    #[serde(default)]
    pub artifact: bool,
}

/// UTF-8 baytlarını sabit bellek sınırında Unicode scalar'lara çevirir.
/// `read_until` gibi davranış uzun bir satırın tamamını belleğe almaz; geçersiz
/// UTF-8 ise `String::from_utf8_lossy` ile aynı biçimde replacement karaktere
/// dönüştürülür.
struct Utf8CharReader<R> {
    reader: R,
    pending: Vec<u8>,
    decoded: VecDeque<char>,
    pushback: VecDeque<char>,
    eof: bool,
}

impl<R: Read> Utf8CharReader<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            pending: Vec::new(),
            decoded: VecDeque::new(),
            pushback: VecDeque::new(),
            eof: false,
        }
    }

    fn fill_pending(&mut self) -> std::io::Result<bool> {
        if self.eof {
            return Ok(false);
        }
        let mut chunk = [0u8; 64 * 1024];
        let read = self.reader.read(&mut chunk)?;
        if read == 0 {
            self.eof = true;
            return Ok(false);
        }
        self.pending.extend_from_slice(&chunk[..read]);
        Ok(true)
    }

    fn next_char(&mut self) -> std::io::Result<Option<char>> {
        if let Some(ch) = self.pushback.pop_front() {
            return Ok(Some(ch));
        }
        if let Some(ch) = self.decoded.pop_front() {
            return Ok(Some(ch));
        }

        loop {
            if self.pending.is_empty() && !self.fill_pending()? {
                return Ok(None);
            }
            match std::str::from_utf8(&self.pending) {
                Ok(valid) => {
                    self.decoded.extend(valid.chars());
                    self.pending.clear();
                    return Ok(self.decoded.pop_front());
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        let valid = std::str::from_utf8(&self.pending[..valid_up_to])
                            .expect("valid UTF-8 prefix");
                        self.decoded.extend(valid.chars());
                        self.pending.drain(..valid_up_to);
                        return Ok(self.decoded.pop_front());
                    }
                    match error.error_len() {
                        Some(invalid_len) => {
                            self.pending.drain(..invalid_len);
                            return Ok(Some(char::REPLACEMENT_CHARACTER));
                        }
                        None if self.eof => {
                            self.pending.clear();
                            return Ok(Some(char::REPLACEMENT_CHARACTER));
                        }
                        None => {
                            if !self.fill_pending()? {
                                self.pending.clear();
                                return Ok(Some(char::REPLACEMENT_CHARACTER));
                            }
                        }
                    }
                }
            }
        }
    }

    fn peek_char(&mut self) -> std::io::Result<Option<char>> {
        if let Some(ch) = self.pushback.front().copied() {
            return Ok(Some(ch));
        }
        if let Some(ch) = self.decoded.front().copied() {
            return Ok(Some(ch));
        }
        let next = self.next_char()?;
        if let Some(ch) = next {
            self.pushback.push_back(ch);
        }
        Ok(next)
    }

    fn unread_char(&mut self, ch: char) {
        self.pushback.push_front(ch);
    }
}

/// Satır sonuna kadar kalan içeriği atlar. CRLF sonlandırıcısının `CR`
/// karakteri içerik sayılmaz.
fn skip_line_remainder<R: Read>(reader: &mut Utf8CharReader<R>) -> std::io::Result<()> {
    loop {
        let Some(ch) = reader.next_char()? else {
            return Ok(());
        };
        if ch == '\n' {
            return Ok(());
        }
        if ch == '\r' && reader.peek_char()? == Some('\n') {
            reader.next_char()?;
            return Ok(());
        }
    }
}

/// Bir satırdan en fazla `max_chars` Unicode scalar alır. `(count, ended)`
/// döner: `ended`, satır sonu/EOF'nin bu dilim içinde ya da tam sınırda
/// bulunduğunu belirtir. `capture=false` olduğunda içerik saklanmaz.
fn take_line_content<R: Read>(
    reader: &mut Utf8CharReader<R>,
    max_chars: usize,
    capture: bool,
    out: &mut String,
) -> std::io::Result<(usize, bool)> {
    let mut count = 0usize;
    while count < max_chars {
        let Some(ch) = reader.next_char()? else {
            return Ok((count, true));
        };
        if ch == '\n' {
            return Ok((count, true));
        }
        if ch == '\r' && reader.peek_char()? == Some('\n') {
            reader.next_char()?;
            return Ok((count, true));
        }
        if capture {
            out.push(ch);
        }
        count += 1;
    }

    // Bütçe tam bu satırda bitti. Sonraki karakter newline ise satır bitti;
    // aksi halde aynı satırın devam imleci gerekir.
    match reader.peek_char()? {
        None => Ok((count, true)),
        Some('\n') => {
            reader.next_char()?;
            Ok((count, true))
        }
        Some('\r') => {
            let cr = reader
                .next_char()?
                .expect("peeked carriage return must exist");
            if reader.peek_char()? == Some('\n') {
                reader.next_char()?;
                Ok((count, true))
            } else {
                reader.unread_char(cr);
                Ok((count, false))
            }
        }
        Some(_) => Ok((count, false)),
    }
}

/// Bir artifact dosyasını güvenli biçimde sayfalar. Normal workspace dosyaları
/// 256KB sınırını korur; artifact'lar bu sınırın ötesinde de okunabilir.
///
/// `offset` 1-tabanlı satır, `column` ise aynı satırda 1-tabanlı Unicode
/// karakter konumudur. Karakter bütçesi UTF-8 baytı değil Unicode scalar
/// sayar. Bir satır bütçeyi aşarsa satır atlanmaz: aynı `offset` ve
/// `next_column` ile kaldığı yerden devam edilir.
fn read_tool_output_page(
    root: &str,
    path: &str,
    limit: Option<usize>,
    offset: Option<usize>,
    column: Option<usize>,
) -> Result<ReadOut, String> {
    let full = super::tool_output::resolve_tool_output_path(root, path)?;
    // Exec artifact'ları keyfi bayt içerebilir. NUL ve geçersiz UTF-8'i
    // reddetmek, hard payload'da verilen `read_file` talimatını kullanılamaz
    // hâle getirirdi. Dosya ham olarak saklanır; modele verilen sayfa UTF-8
    // metin projeksiyonudur (geçersiz baytlar replacement character olur).
    let file = File::open(&full).map_err(|e| err(format!("artifact okunamadı: {e}")))?;

    let max_lines = limit.unwrap_or(200).clamp(1, 1000);
    let start_line = offset.unwrap_or(1).max(1);
    let start_column = column.unwrap_or(1).max(1);
    let mut reader = Utf8CharReader::new(BufReader::new(file));
    let mut total_lines = 0usize;
    let mut selected = Vec::<String>::new();
    let mut selected_line_count = 0usize;
    let mut body_chars = 0usize;
    let mut last_selected_line = None;
    // Bir satırın ortasında kesildiyse aynı satırın devam imleci.
    let mut split_cursor = None;
    // Bütçe bir sonraki satıra ayrılamadıysa o satırın başından devam edilir.
    let mut blocked_line = None;

    loop {
        if reader
            .peek_char()
            .map_err(|e| err(format!("artifact okunamadı: {e}")))?
            .is_none()
        {
            break;
        }
        total_lines += 1;
        let line_number = total_lines;

        if line_number < start_line
            || split_cursor.is_some()
            || blocked_line.is_some()
            || selected_line_count >= max_lines
        {
            // Kalan satırlar yalnızca toplam satır sayısını doğrulamak için
            // okunur; uzun satırlar belleğe alınmaz.
            skip_line_remainder(&mut reader)
                .map_err(|e| err(format!("artifact okunamadı: {e}")))?;
            continue;
        }

        let separator_chars = usize::from(!selected.is_empty());
        let used = body_chars.saturating_add(separator_chars);
        if used > ARTIFACT_PAGE_CHARS {
            blocked_line = Some(line_number);
            skip_line_remainder(&mut reader)
                .map_err(|e| err(format!("artifact okunamadı: {e}")))?;
            continue;
        }
        let available = ARTIFACT_PAGE_CHARS - used;

        let mut piece = String::new();
        let mut line_ended = false;
        // `column` yalnızca başlangıç satırına aittir. Sonraki satırlar
        // her zaman 1. karakterden başlar; aksi halde uzun bir ilk satır
        // devam edildikten sonra ikinci satırın cursor'ı yanlış hesaplanır.
        let effective_start_column = if line_number == start_line {
            start_column
        } else {
            1
        };
        let start_char = effective_start_column - 1;
        if start_char > 0 {
            let (skipped, ended) = take_line_content(&mut reader, start_char, false, &mut piece)
                .map_err(|e| err(format!("artifact okunamadı: {e}")))?;
            if skipped < start_char {
                return Err(err(format!(
                    "artifact column cursor {start_column} is outside line {line_number}"
                )));
            }
            line_ended = ended;
        }

        let (taken, ended) = if line_ended {
            (0, true)
        } else {
            take_line_content(&mut reader, available, true, &mut piece)
                .map_err(|e| err(format!("artifact okunamadı: {e}")))?
        };
        body_chars += separator_chars + taken;
        selected.push(piece);
        selected_line_count += 1;
        last_selected_line = Some(line_number);

        if !ended {
            // Satırın kalanı sonraki sayfaya aynı offset + column ile gider.
            // Cursor, bu satırın kendi başlangıç sütunundan hesaplanmalıdır;
            // önceki satırın continuation offset'i taşınmamalıdır.
            split_cursor = Some((line_number, effective_start_column + taken));
            skip_line_remainder(&mut reader)
                .map_err(|e| err(format!("artifact okunamadı: {e}")))?;
        }
    }

    let (next_offset, next_column) = if let Some((line, next_column)) = split_cursor {
        (Some(line), Some(next_column))
    } else if let Some(line) = blocked_line {
        (Some(line), None)
    } else if let Some(line) = last_selected_line {
        if total_lines > line && selected_line_count >= max_lines {
            (Some(line + 1), None)
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };

    let truncated = next_offset.is_some();
    // Modele giden marker tek katmanda TS wrapper tarafından üretilir; backend
    // yalnızca ham içerik ve yapılandırılmış sayfa imleçlerini döndürür.
    let content = selected.join("\n");

    Ok(ReadOut {
        content,
        truncated,
        next_offset,
        next_column,
        total_lines: Some(total_lines),
        artifact: true,
    })
}

#[tauri::command]
pub async fn read_file(
    root: String,
    path: String,
    limit: Option<usize>,
    offset: Option<usize>,
    column: Option<usize>,
) -> Result<ReadOut, String> {
    if super::tool_output::is_tool_output_rel(&path) {
        return read_tool_output_page(&root, &path, limit, offset, column);
    }
    let full = resolve_rooted(&root, &path)?;
    let meta = std::fs::metadata(&full).map_err(|e| err(format!("dosya bulunamadı: {e}")))?;
    if meta.is_dir() {
        return Err(err("dizin okunamaz · list_dir kullan"));
    }
    if meta.len() > MAX_READ_BYTES * 4 {
        return Err(err("dosya çok büyük (256KB+)"));
    }
    let text = std::fs::read(&full).map_err(|e| err(format!("dosya okunamadı: {e}")))?;
    // Binary sezgisi: ilk 8KB içinde NUL varsa reddet.
    let head = &text[..text.len().min(8192)];
    if head.contains(&0) {
        return Err(err("binary dosya okunamaz"));
    }
    let content = String::from_utf8_lossy(&text).to_string();
    // Faz 3: satır aralıklı okuma — offset 1-tabanlı, limit sayfa büyüklüğü.
    let max_lines = limit.unwrap_or(200).clamp(1, 1000);
    let start = offset.map(|o| o.max(1) - 1).unwrap_or(0);
    let lines: Vec<&str> = content.lines().collect();
    let total_lines = lines.len();
    if start >= lines.len() {
        return Ok(ReadOut {
            content: String::new(),
            truncated: start > 0,
            next_offset: None,
            next_column: None,
            total_lines: Some(total_lines),
            artifact: false,
        });
    }
    let end = (start + max_lines).min(lines.len());
    // Sayfa sonu satırda değilse ham satır içeriğini kullan; tam dosya
    // döndüğünde mevcut davranışı korlamak için trailing newline'ı koru.
    let selected = if start == 0 && end == lines.len() {
        content.clone()
    } else {
        lines[start..end].join("\n")
    };

    if selected.len() as u64 > MAX_READ_BYTES {
        // Bayt sınırı bir sayfanın devam imleci üretmez: TS yalnızca
        // next_offset varsa read_more önerir. Yanlış bir satır devamı üretilmez.
        Ok(ReadOut {
            content: truncate_utf8_bytes(&selected, MAX_READ_BYTES as usize),
            truncated: true,
            next_offset: None,
            next_column: None,
            total_lines: Some(total_lines),
            artifact: false,
        })
    } else if end < lines.len() {
        Ok(ReadOut {
            content: selected,
            truncated: true,
            next_offset: Some(end + 1),
            next_column: None,
            total_lines: Some(total_lines),
            artifact: false,
        })
    } else {
        Ok(ReadOut {
            content: selected,
            truncated: false,
            next_offset: None,
            next_column: None,
            total_lines: Some(total_lines),
            artifact: false,
        })
    }
}

#[tauri::command]
pub async fn read_file_full(root: String, path: String) -> Result<String, String> {
    let full = resolve_rooted(&root, &path)?;
    let meta = std::fs::metadata(&full).map_err(|e| err(format!("dosya bulunamadı: {e}")))?;
    if meta.is_dir() {
        return Err(err("dizin okunamaz · list_dir kullan"));
    }
    if meta.len() > 1024 * 1024 {
        return Err(err("dosya çok büyük (1MB+)"));
    }
    let text = std::fs::read(&full).map_err(|e| err(format!("dosya okunamadı: {e}")))?;
    let head = &text[..text.len().min(8192)];
    if head.contains(&0) {
        return Err(err("binary dosya okunamaz"));
    }
    Ok(String::from_utf8_lossy(&text).to_string())
}

#[derive(Debug, Serialize)]
pub struct GrepHit {
    pub path: String,
    pub line: usize,
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BackupEntry {
    pub id: String,
    pub rel_path: String,
    pub backup_file: String,
    pub timestamp: u64,
}

/// B1 — güvenli atomik yazma (tek kaynak: `apply_patch`, `undo_patch`,
/// `snapshots::write_atomic`, `snapshots::write_manifest`).
///
/// Eski desen `full.with_extension("tmp-macrocode")` gibi **öngörülebilir** bir
/// geçici ad kullanıyordu ve `std::fs::write`/`fs::copy` mevcut bir symlink'i
/// takip ediyordu: saldırgan repo'ya `README.md.tmp-macrocode -> ~/.bashrc`
/// symlink'i koyduğunda yazma jail dışına çıkıyor, `rename` sonrası hedef dosya
/// da symlink'e dönüşüyordu (RCE zinciri).
///
/// Yeni desen:
/// - geçici ad **rastgele** (pid + nanos + sayaç) ve hedefle aynı dizinde,
/// - `create_new` (O_EXCL) → var olan symlink/dosya asla takip edilmez/ezilmez,
/// - yazma sonrası `rename` (aynı dosya sistemi → atomik),
/// - hedef zaten symlink ise açıkça reddedilir.
pub(crate) fn atomic_write_exclusive(dst: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;

    // Hedef symlink ise `rename` onu ezer ve anlamı bozulur; net hata verelim.
    if let Ok(md) = std::fs::symlink_metadata(dst) {
        if md.file_type().is_symlink() {
            return Err(err("hedef symlink · üzerine yazma reddedildi"));
        }
        if md.is_dir() {
            return Err(err("hedef bir dizin · üzerine yazılamaz"));
        }
    }

    let dir = dst.parent().ok_or_else(|| err("hedef dizin yok"))?;
    let name = dst
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| err("geçersiz hedef dosya adı"))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    // Çakışma olasılığı ihmal edilebilir; yine de birkaç kez yeniden denenir.
    for _ in 0..8 {
        let seq = ATOMIC_WRITE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let cand = dir.join(format!(
            ".{name}.mc-{:x}-{nanos:x}-{seq:x}",
            std::process::id()
        ));
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        match opts.open(&cand) {
            Ok(mut f) => {
                if let Err(e) = f.write_all(bytes).and_then(|_| f.flush()) {
                    drop(f);
                    let _ = std::fs::remove_file(&cand);
                    return Err(err(format!("yazılamadı: {e}")));
                }
                drop(f);
                if let Err(e) = std::fs::rename(&cand, dst) {
                    let _ = std::fs::remove_file(&cand);
                    return Err(err(format!("taşınamadı: {e}")));
                }
                return Ok(());
            }
            // Aynı ad (çok düşük olasılık) veya artık kalmış dosya → yeni ad.
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(err(format!("geçici dosya oluşturulamadı: {e}"))),
        }
    }
    Err(err("geçici dosya adı üretilemedi (çakışma)"))
}

/// `atomic_write_exclusive` için süreç-içi sayaç (ad çakışmasını engeller).
static ATOMIC_WRITE_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[tauri::command]
pub async fn apply_patch(root: String, path: String, content: String) -> Result<(), String> {
    if content.len() as u64 > 1024 * 1024 {
        return Err(err("yeni içerik çok büyük (1MB+)"));
    }
    let base = canonical_root(&root)?;
    let full = resolve_rooted(&root, &path)?;
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| err(format!("dizin oluşturulamadı: {e}")))?;
    }
    // Backup: .macrocode/backups altına zaman damgalı kopyala ve manifest güncelle.
    if full.exists() {
        // H1 devamı: `.macrocode` veya `backups` dışarıyı gösteren bir symlink
        // ise yedek ve manifest workspace dışına yazılırdı — create_dir_all'dan
        // ÖNCE canonical jail.
        let backup_dir = jailed_macrocode_subdir(&base, "backups")?;
        std::fs::create_dir_all(&backup_dir)
            .map_err(|e| err(format!("yedek dizini oluşturulamadı: {e}")))?;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let id = ts.to_string();
        let safe_name = full.file_name().and_then(|s| s.to_str()).unwrap_or("file");
        let backup_file = format!("{id}_{}", sanitize_backup_name(safe_name));
        // Yedek dosyası ve manifest de symlink olabilir (önceden oluşturulmuş
        // hedef) — ikisi de yazımdan ÖNCE jail'den geçirilir ki kısmi durum
        // oluşmasın.
        let backup_path = resolve_backup_inside(&base, &backup_dir, &backup_file)?;
        let manifest_path = resolve_backup_inside(&base, &backup_dir, "manifest.json")?;
        // B1: `std::fs::copy` mevcut bir symlink'i takip eder — yedek de
        // güvenli atomik yazma ile alınır (hedef symlink ise reddedilir).
        let original = std::fs::read(&full).map_err(|e| err(format!("yedek alınamadı: {e}")))?;
        atomic_write_exclusive(&backup_path, &original)
            .map_err(|e| err(format!("yedek alınamadı: {e}")))?;
        let mut entries: Vec<BackupEntry> = if manifest_path.exists() {
            std::fs::read_to_string(&manifest_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let rel_str = path.trim().replace('\\', "/");
        entries.push(BackupEntry {
            id,
            rel_path: rel_str,
            backup_file,
            timestamp: ts,
        });
        if let Ok(json_str) = serde_json::to_string_pretty(&entries) {
            // B1: manifest de öngörülebilir ad/symlink takibi ile yazılmamalı.
            let _ = atomic_write_exclusive(&manifest_path, json_str.as_bytes());
        }
    }
    // B1 — atomik yazma: rastgele ad + O_EXCL, sonra rename.
    atomic_write_exclusive(&full, content.as_bytes())?;
    Ok(())
}

#[tauri::command]
pub async fn undo_patch(root: String, backup_id: Option<String>) -> Result<String, String> {
    let base = canonical_root(&root)?;
    // H1 devamı: yedek dizini veya manifest symlink ile dışarıyı gösteremez.
    let backup_dir = jailed_macrocode_subdir(&base, "backups")?;
    if !backup_dir.exists() {
        return Err(err("geri alınacak yama bulunamadı"));
    }
    let manifest_path = resolve_backup_inside(&base, &backup_dir, "manifest.json")?;
    if !manifest_path.exists() {
        return Err(err("geri alınacak yama bulunamadı"));
    }
    let raw_str = std::fs::read_to_string(&manifest_path)
        .map_err(|e| err(format!("manifest okunamadı: {e}")))?;
    let mut entries: Vec<BackupEntry> =
        serde_json::from_str(&raw_str).map_err(|e| err(format!("manifest bozuk: {e}")))?;
    if entries.is_empty() {
        return Err(err("geri alınacak yama bulunamadı"));
    }

    let target_idx = match backup_id {
        Some(ref id) => entries
            .iter()
            .rposition(|e| e.id == *id || e.id.starts_with(id)),
        None => Some(entries.len() - 1),
    };

    let Some(idx) = target_idx else {
        return Err(err("belirtilen yama id'si bulunamadı"));
    };

    let entry = entries.remove(idx);
    // K1 (Faz 1): manifest'ten gelen `backup_file` asla doğrulanmadan join edilmez —
    // mutlak yol / `..` / symlink kaçışı reddedilir.
    let backup_file_path = resolve_backup_inside(&base, &backup_dir, &entry.backup_file)?;
    if !backup_file_path.exists() {
        return Err(err(format!(
            "yedek dosyası bulunamadı: {}",
            entry.backup_file
        )));
    }

    let target_file_path = resolve_rooted(&root, &entry.rel_path)?;
    // B1 — geri yükleme de rastgele ad + O_EXCL ile yazılır; eski
    // `target.with_extension("tmp-restore")` adı öngörülebilirdi.
    let bytes =
        std::fs::read(&backup_file_path).map_err(|e| err(format!("geri yüklenemedi: {e}")))?;
    atomic_write_exclusive(&target_file_path, &bytes)
        .map_err(|e| err(format!("dosya değiştirilemedi: {e}")))?;
    let _ = std::fs::remove_file(&backup_file_path);

    let _ = atomic_write_exclusive(
        &manifest_path,
        serde_json::to_string_pretty(&entries)
            .unwrap_or_default()
            .as_bytes(),
    );

    Ok(format!("/// geri alındı: {}", entry.rel_path))
}

fn walk(dir: &PathBuf, out_files: &mut Vec<PathBuf>) {
    if out_files.len() >= MAX_GREP_FILES {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for e in rd.flatten() {
        if out_files.len() >= MAX_GREP_FILES {
            break;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name == ".DS_Store" {
            continue;
        }
        let Ok(ft) = e.file_type() else { continue };
        let p = e.path();
        if ft.is_dir() {
            if is_blocked_dir(&name) {
                continue;
            }
            // Symlink döngüsüne karşı derinlik: içe doğru ilerle.
            walk(&p, out_files);
        } else if ft.is_file() {
            if is_blocked_file_name(&name) || is_env_prefixed(&name) {
                continue;
            }
            if is_blocked_ext(&p) {
                continue;
            }
            // 256KB üstünü atla.
            if e.metadata().map(|m| m.len() > 256 * 1024).unwrap_or(true) {
                continue;
            }
            out_files.push(p);
        }
    }
}

#[tauri::command]
pub async fn grep_files(
    root: String,
    pattern: String,
    path: Option<String>,
    regex: Option<bool>,
) -> Result<Vec<GrepHit>, String> {
    let pat = pattern.trim().to_owned();
    if pat.is_empty() {
        return Err(err("arama deseni boş olamaz"));
    }
    if pat.len() > 200 {
        return Err(err("arama deseni çok uzun"));
    }
    // Faz 3: regex modu (default literal).
    let re = if regex.unwrap_or(false) {
        Some(regex::Regex::new(&pat).map_err(|e| err(format!("geçersiz regex: {e}")))?)
    } else {
        None
    };
    let start = resolve_rooted(&root, &path.unwrap_or_default())?;
    let base = canonical_root(&root)?;
    // start bir dosyaysa tek dosya tara.
    let mut files = Vec::new();
    if start.is_file() {
        files.push(start);
    } else {
        walk(&start, &mut files);
    }
    let mut hits = Vec::new();
    for f in files {
        if hits.len() >= MAX_GREP_HITS {
            break;
        }
        let Ok(bytes) = std::fs::read(&f) else {
            continue;
        };
        if bytes[..bytes.len().min(8192)].contains(&0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.lines().enumerate() {
            let hit = match &re {
                Some(re) => re.is_match(line),
                None => line.contains(&pat),
            };
            if hit {
                let rel = f
                    .strip_prefix(&base)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|_| f.to_string_lossy().to_string());
                hits.push(GrepHit {
                    path: rel,
                    line: i + 1,
                    text: line.chars().take(240).collect(),
                });
                if hits.len() >= MAX_GREP_HITS {
                    break;
                }
            }
        }
    }
    Ok(hits)
}

const MAX_GLOB_HITS: usize = 100;

/// Faz 3 — glob desenine göre dosya keşfi (ignore + secret filtreli, jail korumalı).
#[tauri::command]
pub async fn glob_files(
    root: String,
    pattern: String,
    path: Option<String>,
) -> Result<Vec<DirEntry>, String> {
    let pat = pattern.trim().replace('\\', "/");
    if pat.is_empty() {
        return Err(err("glob deseni boş olamaz"));
    }
    if pat.len() > 200 {
        return Err(err("glob deseni çok uzun"));
    }
    if pat.starts_with('/') || pat.split('/').any(|s| s == "..") {
        return Err(err(
            "root dışına çıkılamaz · workspace-relative desen kullan",
        ));
    }
    let start = resolve_rooted(&root, &path.unwrap_or_default())?;
    let base = canonical_root(&root)?;
    if !start.is_dir() {
        return Err(err("dizin değil · desen alt dizinde aranır"));
    }
    let abs_pat = start.join(&pat).to_string_lossy().to_string();
    let opts = glob::MatchOptions {
        case_sensitive: true,
        require_literal_separator: false,
        require_literal_leading_dot: false,
    };
    let mut out = Vec::new();
    let paths = glob::glob_with(&abs_pat, opts).map_err(|e| err(format!("geçersiz desen: {e}")))?;
    for entry in paths {
        if out.len() >= MAX_GLOB_HITS {
            break;
        }
        let p = match entry {
            Ok(p) => p,
            Err(_) => continue,
        };
        // Jail: symlink kaçışına karşı canonical + starts_with.
        let canon = match p.canonicalize() {
            Ok(c) => c,
            Err(_) => continue,
        };
        if !canon.starts_with(&base) {
            continue;
        }
        let name = match canon.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_owned(),
            None => continue,
        };
        if name == ".DS_Store" {
            continue;
        }
        let is_dir = canon.is_dir();
        if is_dir {
            if is_blocked_dir(&name) {
                continue;
            }
        } else {
            if is_blocked_file_name(&name) || is_env_prefixed(&name) {
                continue;
            }
            if is_blocked_ext(&p) {
                continue;
            }
        }
        let rel = canon
            .strip_prefix(&base)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| canon.to_string_lossy().to_string())
            // Windows ayırıcısı da normalize edilir; aksi hâlde `split('/')`
            // ara dizin filtresi çalışmaz ve UI'ya `src\\b.ts` döner.
            .replace('\\', "/");
        // Ara dizinler de ignore listesine takılır (örn. node_modules/…).
        if rel.split('/').any(is_blocked_dir) {
            continue;
        }
        out.push(DirEntry { name: rel, is_dir });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(out)
}

/// Faz 9 (P9.1) — repo haritası: workspace'teki dosyaların **göreli** yolları.
/// `walk` ile aynı filtreleri kullanır (bloklu dizinler, secret dosyalar, 256KB üstü).
#[derive(Debug, Serialize)]
pub struct TreeEntry {
    /// Workspace-relative yol (ör. `src/lib/engine/agent.ts`).
    pub path: String,
    /// Dosya boyutu (bayt) — 0 ise bilinmiyor.
    pub size: u64,
}

#[tauri::command]
pub async fn list_tree(root: String, max_entries: Option<usize>) -> Result<Vec<TreeEntry>, String> {
    let base = canonical_root(&root)?;
    let mut files: Vec<PathBuf> = Vec::new();
    walk(&base, &mut files);
    let max = max_entries.unwrap_or(400).clamp(1, 5000);
    let mut out: Vec<TreeEntry> = Vec::new();
    for p in files {
        if out.len() >= max {
            break;
        }
        let rel = p
            .strip_prefix(&base)
            .map(|r| r.to_string_lossy().to_string())
            .unwrap_or_default()
            // Windows'da `\` ayırıcısı göreli yolu bozar (UI `/` bekliyor).
            .replace('\\', "/");
        if rel.is_empty() {
            continue;
        }
        let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        out.push(TreeEntry { path: rel, size });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Faz 9 (P9.3) — kalıcı proje hafızası: `.macrocode/context.md`.
///
/// Notlar kullanıcı tarafından `/note` komutuyla yazılır ve sonraki oturumlarda
/// agent'ın system prompt'una eklenir (→ sağlayıcıya gider).
///
/// **H1 düzeltmesi:** sabit göreli yol *traversal*'ı engellemez ama **symlink**'i
/// engellemez — zararlı bir repo `.macrocode/context.md`'yi `../../.ssh/id_ed25519`'a
/// bağlayabilir (`read_to_string`/`append` takip eder, içerik sistem prompt'una
/// sızar). Bu yüzden hem dizin hem dosya canonicalize edilip jail içinde kalıyor
/// (K1 `resolve_backup_inside` ile aynı desen). Eski `file.starts_with(&base)`
/// kontrolü leksikal olarak **her zaman** doğruydu (boş check).
const MEMORY_DIR: &str = ".macrocode";
const MEMORY_FILE: &str = "context.md";
const MEMORY_MAX_BYTES: u64 = 64 * 1024;

/// Hafıza dosyasını jail içinde çözer. Dizin/dosya henüz yoksa aday yol döner
/// (yazma tarafı `create_dir_all` ile base altında kurar); var olan ama jail
/// dışını gösteren bir symlink kesinlikle `Err` olur.
fn memory_path(root: &str) -> Result<PathBuf, String> {
    let base = canonical_root(root)?;
    // 1) `.macrocode` dizini: varsa canonical + jail; yoksa aday yol.
    let canon_dir = jailed_macrocode_dir(&base)?;
    // 2) `context.md`: varsa canonical + jail (dosyanın kendisi symlink olabilir).
    let file = canon_dir.join(MEMORY_FILE);
    match file.canonicalize() {
        Ok(f) if f.starts_with(&canon_dir) && f.starts_with(&base) => Ok(f),
        Ok(_) => Err(err("hafıza dosyası workspace dışında (symlink?)")),
        Err(_) => Ok(file),
    }
}

#[tauri::command]
pub async fn memory_read(root: String) -> Result<String, String> {
    let file = memory_path(&root)?;
    match std::fs::read_to_string(&file) {
        Ok(txt) => Ok(txt),
        // Henüz yazılmamış not → boş (boot akışı hata görmemeli).
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(err(format!("hafıza okunamadı: {e}"))),
    }
}

#[tauri::command]
pub async fn memory_append(root: String, text: String) -> Result<String, String> {
    let clean = text.trim();
    if clean.is_empty() {
        return Err(err("not boş olamaz"));
    }
    if clean.len() as u64 > 8192 {
        return Err(err("not çok uzun (8KB sınır)"));
    }
    let file = memory_path(&root)?;
    // H1: jail denetimi `memory_path` içinde canonical olarak yapıldı (eski
    // `file.starts_with(&base)` leksikal ve her zaman doğruydu).
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| err(format!("hafıza dizini oluşturulamadı: {e}")))?;
    }
    // Mevcut boyut sınırı aşılıyorsa reddet.
    if let Ok(meta) = std::fs::metadata(&file) {
        if meta.len() + clean.len() as u64 + 1 > MEMORY_MAX_BYTES {
            return Err(err("hafıza dosyası dolu (64KB sınır)"));
        }
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("- [{stamp}] {clean}\n");
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|e| err(format!("hafıza yazılamadı: {e}")))?;
    f.write_all(line.as_bytes())
        .map_err(|e| err(format!("hafıza yazılamadı: {e}")))?;
    Ok(line)
}

#[derive(Debug, Serialize)]
pub struct WriteOut {
    pub created: bool,
}

/// Faz 3 — yeni dosya oluşturma (create-only, O_EXCL).
/// Mevcut dosya varsa hata verir (`edit_file` kullan).
#[tauri::command]
pub async fn write_file(root: String, path: String, content: String) -> Result<WriteOut, String> {
    if content.len() as u64 > 512 * 1024 {
        return Err(err("içerik çok büyük (512KB+)"));
    }
    let full = resolve_rooted(&root, &path)?;
    if full.is_dir() {
        return Err(err("dizin üzerine yazılamaz"));
    }
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&full)
    {
        Ok(mut f) => {
            use std::io::Write;
            f.write_all(content.as_bytes())
                .map_err(|e| err(format!("yazılamadı: {e}")))?;
            Ok(WriteOut { created: true })
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let rel = path.trim().replace('\\', "/");
            Err(err(format!("dosya zaten var: {rel} · edit_file kullan")))
        }
        Err(e) => Err(err(format!("yazılamadı: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parent_dir_reddedilir() {
        assert!(resolve_rooted("/tmp", "../etc/passwd").is_err());
    }

    #[test]
    fn mutlak_yol_reddedilir() {
        assert!(resolve_rooted("/tmp", "/etc/passwd").is_err());
    }

    #[test]
    fn secret_dosya_reddedilir() {
        let tmp = std::env::temp_dir().to_string_lossy().to_string();
        assert!(resolve_rooted(&tmp, ".env").is_err());
        assert!(resolve_rooted(&tmp, "keys.json").is_err());
    }

    #[tokio::test]
    async fn faz10_d2b_gizli_uzanti_read_file_reddedilir() {
        // D2b: uzantı blokajı walk/glob'da vardı ama read_file'da yoktu.
        let kok = benzersiz_tmp("uzanti");
        std::fs::write(kok.join("sertifika.pem"), "x").unwrap();
        std::fs::write(kok.join("veri.db"), "x").unwrap();
        std::fs::write(kok.join("normal.ts"), "x").unwrap();
        let kok_s = kok.to_str().unwrap().to_string();

        let err = read_file(kok_s.clone(), "sertifika.pem".to_string(), None, None, None)
            .await
            .err()
            .unwrap();
        assert!(
            err.contains("yasaklı dosya uzantısı"),
            "beklenmeyen hata: {err}"
        );

        let err = read_file(kok_s.clone(), "veri.db".to_string(), None, None, None)
            .await
            .err()
            .unwrap();
        assert!(
            err.contains("yasaklı dosya uzantısı"),
            "beklenmeyen hata: {err}"
        );

        // Normal dosya okunabilir.
        let ok = read_file(kok_s, "normal.ts".to_string(), None, None, None)
            .await
            .unwrap();
        assert_eq!(ok.content, "x");
        let _ = std::fs::remove_dir_all(&kok);
    }

    #[tokio::test]
    async fn read_file_full_1000_satir_ve_uzerini_kesintisiz_okur() {
        let kok = benzersiz_tmp("read_full");
        let mut lines = Vec::new();
        for i in 1..=1500 {
            lines.push(format!("let var_{i} = {i};"));
        }
        let full_text = lines.join("\n");
        std::fs::write(kok.join("large.ts"), &full_text).unwrap();
        let kok_s = kok.to_str().unwrap().to_string();

        // Standart read_file 1000 satıra kelepçeler ve truncated döner:
        let standard = read_file(
            kok_s.clone(),
            "large.ts".to_string(),
            Some(1000),
            None,
            None,
        )
        .await
        .unwrap();
        assert!(standard.truncated);

        // read_file_full ise 1500 satırın tamamını eksiksiz okur:
        let full_out = read_file_full(kok_s.clone(), "large.ts".to_string())
            .await
            .unwrap();
        assert_eq!(full_out.lines().count(), 1500);
        assert_eq!(full_out, full_text);

        let _ = std::fs::remove_dir_all(&kok);
    }

    #[tokio::test]
    async fn tool_output_artifact_read_file_ile_sayfalanir() {
        let kok = benzersiz_tmp("artifact-read");
        let dir = kok.join(".macrocode/tool-outputs");
        std::fs::create_dir_all(&dir).unwrap();
        let rel = ".macrocode/tool-outputs/tool-output-test.log";
        std::fs::write(dir.join("tool-output-test.log"), "line-1\nline-2\nline-3\n").unwrap();
        let root = kok.to_str().unwrap().to_string();

        let page = read_file(root.clone(), rel.to_string(), Some(2), None, None)
            .await
            .unwrap();
        assert!(page.artifact);
        assert!(page.truncated);
        assert_eq!(page.next_offset, Some(3));
        assert_eq!(page.next_column, None);
        assert_eq!(page.total_lines, Some(3));
        assert_eq!(page.content, "line-1\nline-2");

        // Satır bazlı offset önceki sürümle aynı şekilde çalışmaya devam eder.
        let last = read_file(
            root.clone(),
            rel.to_string(),
            Some(2),
            page.next_offset,
            page.next_column,
        )
        .await
        .unwrap();
        assert!(!last.truncated);
        assert_eq!(last.next_offset, None);
        assert_eq!(last.next_column, None);
        assert_eq!(last.total_lines, Some(3));
        assert_eq!(last.content, "line-3");

        // Normal .macrocode dosyaları kapalı kalır.
        assert!(
            read_file(root, ".macrocode/context.md".to_string(), None, None, None)
                .await
                .is_err()
        );
        let _ = std::fs::remove_dir_all(&kok);
    }

    #[tokio::test]
    async fn tool_output_artifact_exact_fit_ve_bos_satir_sinirlari_dogru() {
        let kok = benzersiz_tmp("artifact-boundaries");
        let dir = kok.join(".macrocode/tool-outputs");
        std::fs::create_dir_all(&dir).unwrap();
        let root = kok.to_str().unwrap().to_string();

        // Bütçeye tam oturan satır kesilmiş sayılmaz; sonraki satır yeni
        // offset'te başlar ve next_column üretilmez.
        let exact_rel = ".macrocode/tool-outputs/tool-output-exact.log";
        let exact_line = "x".repeat(ARTIFACT_PAGE_CHARS);
        std::fs::write(
            dir.join("tool-output-exact.log"),
            format!("{exact_line}\nnext\n"),
        )
        .unwrap();
        let exact = read_file(root.clone(), exact_rel.to_string(), Some(10), None, None)
            .await
            .unwrap();
        assert_eq!(exact.content.chars().count(), ARTIFACT_PAGE_CHARS);
        assert!(exact.truncated);
        assert_eq!(exact.next_offset, Some(2));
        assert_eq!(exact.next_column, None);
        assert_eq!(exact.total_lines, Some(2));
        let exact_next = read_file(
            root.clone(),
            exact_rel.to_string(),
            Some(10),
            exact.next_offset,
            exact.next_column,
        )
        .await
        .unwrap();
        assert_eq!(exact_next.content, "next");
        assert!(!exact_next.truncated);

        // Bütçeyi bir karakter aşan satır aynı offset içinde devam eder.
        let over_rel = ".macrocode/tool-outputs/tool-output-over.log";
        std::fs::write(
            dir.join("tool-output-over.log"),
            format!("{}\n", "y".repeat(ARTIFACT_PAGE_CHARS + 1)),
        )
        .unwrap();
        let over = read_file(root.clone(), over_rel.to_string(), Some(10), None, None)
            .await
            .unwrap();
        assert!(over.truncated);
        assert_eq!(over.next_offset, Some(1));
        assert_eq!(over.next_column, Some(ARTIFACT_PAGE_CHARS + 1));
        assert_eq!(over.total_lines, Some(1));

        // Sondaki newline ek satır saymaz; boş satırlar ise satır olarak
        // sayılır ve limit'e karşı sayılır.
        let empty_rel = ".macrocode/tool-outputs/tool-output-empty.log";
        std::fs::write(dir.join("tool-output-empty.log"), "\n\nthird\n").unwrap();
        let empty_first = read_file(root.clone(), empty_rel.to_string(), Some(1), None, None)
            .await
            .unwrap();
        assert_eq!(empty_first.content, "");
        assert!(empty_first.truncated);
        assert_eq!(empty_first.next_offset, Some(2));
        assert_eq!(empty_first.next_column, None);
        assert_eq!(empty_first.total_lines, Some(3));
        let empty_second = read_file(
            root.clone(),
            empty_rel.to_string(),
            Some(1),
            empty_first.next_offset,
            empty_first.next_column,
        )
        .await
        .unwrap();
        assert_eq!(empty_second.content, "");
        assert_eq!(empty_second.next_offset, Some(3));
        assert_eq!(empty_second.total_lines, Some(3));
        let empty_last = read_file(
            root,
            empty_rel.to_string(),
            Some(1),
            empty_second.next_offset,
            empty_second.next_column,
        )
        .await
        .unwrap();
        assert_eq!(empty_last.content, "third");
        assert!(!empty_last.truncated);
        assert_eq!(empty_last.next_offset, None);
        assert_eq!(empty_last.total_lines, Some(3));

        let _ = std::fs::remove_dir_all(&kok);
    }

    #[tokio::test]
    async fn tool_output_artifact_uzun_satir_kesilince_ozel_sutunla_devam_eder() {
        let kok = benzersiz_tmp("artifact-long-line");
        let dir = kok.join(".macrocode/tool-outputs");
        std::fs::create_dir_all(&dir).unwrap();
        let rel = ".macrocode/tool-outputs/tool-output-long-line.log";
        // 12.000 Unicode karakter + sonraki satır. UTF-8 bayt sayısı karakter
        // bütçesinden büyük olduğu için byte tabanlı bir kesme hata verirdi.
        let long_line = "é😀".repeat(6_000);
        let source = format!("{long_line}\nTAIL\n");
        std::fs::write(dir.join("tool-output-long-line.log"), &source).unwrap();
        let root = kok.to_str().unwrap().to_string();

        let first = read_file(root.clone(), rel.to_string(), Some(10), None, None)
            .await
            .unwrap();
        assert!(first.truncated);
        assert_eq!(first.next_offset, Some(1));
        assert_eq!(first.next_column, Some(ARTIFACT_PAGE_CHARS + 1));
        assert_eq!(first.total_lines, Some(2));
        assert_eq!(first.content.chars().count(), ARTIFACT_PAGE_CHARS);
        assert!(!first.content.contains('\u{fffd}'));

        let second = read_file(
            root,
            rel.to_string(),
            Some(10),
            first.next_offset,
            first.next_column,
        )
        .await
        .unwrap();
        assert!(!second.truncated);
        assert_eq!(second.next_offset, None);
        assert_eq!(second.next_column, None);
        assert_eq!(second.total_lines, Some(2));
        assert_eq!(
            first.content.chars().count() + second.content.chars().count(),
            long_line.chars().count() + 5
        );
        assert_eq!(
            format!("{}{}", first.content, second.content),
            format!("{long_line}\nTAIL")
        );

        let _ = std::fs::remove_dir_all(&kok);
    }

    #[tokio::test]
    async fn tool_output_artifact_iki_uzun_satir_cursor_offsetini_karıştirmaz() {
        let kok = benzersiz_tmp("artifact-two-long-lines");
        let dir = kok.join(".macrocode/tool-outputs");
        std::fs::create_dir_all(&dir).unwrap();
        let rel = ".macrocode/tool-outputs/tool-output-two-long-lines.log";
        let source = format!("{}\n{}\n", "A".repeat(10_001), "B".repeat(10_000));
        std::fs::write(dir.join("tool-output-two-long-lines.log"), &source).unwrap();
        let root = kok.to_str().unwrap().to_string();

        let first = read_file(root.clone(), rel.to_string(), Some(10), None, None)
            .await
            .unwrap();
        assert_eq!(first.next_offset, Some(1));
        assert_eq!(first.next_column, Some(10_001));

        // İlk satırın devamı alınırken ikinci satır da bütçeye sığar.
        // İkinci satırın cursor'ı 1'den başlamalı; ilk satırın 10.001
        // sütunu ikinci satıra taşınmamalıdır.
        let second = read_file(
            root.clone(),
            rel.to_string(),
            Some(10),
            first.next_offset,
            first.next_column,
        )
        .await
        .unwrap();
        assert_eq!(second.next_offset, Some(2));
        assert_eq!(second.next_column, Some(9_999));
        assert_eq!(second.content.chars().count(), ARTIFACT_PAGE_CHARS);

        let third = read_file(
            root,
            rel.to_string(),
            Some(10),
            second.next_offset,
            second.next_column,
        )
        .await
        .unwrap();
        assert!(!third.truncated);
        assert_eq!(third.next_offset, None);
        assert_eq!(third.next_column, None);
        assert_eq!(third.content, "BB");

        let _ = std::fs::remove_dir_all(&kok);
    }

    #[tokio::test]
    async fn tool_output_artifact_crlf_ve_bos_satirlari_sayfalar() {
        let kok = benzersiz_tmp("artifact-crlf");
        let dir = kok.join(".macrocode/tool-outputs");
        std::fs::create_dir_all(&dir).unwrap();
        let rel = ".macrocode/tool-outputs/tool-output-crlf.log";
        std::fs::write(
            dir.join("tool-output-crlf.log"),
            "one\r\ntwo\r\n\r\nlast\r\n",
        )
        .unwrap();
        let root = kok.to_str().unwrap().to_string();

        let first = read_file(root.clone(), rel.to_string(), Some(2), None, None)
            .await
            .unwrap();
        assert_eq!(first.content, "one\ntwo");
        assert_eq!(first.next_offset, Some(3));
        assert_eq!(first.next_column, None);
        assert_eq!(first.total_lines, Some(4));

        let second = read_file(
            root,
            rel.to_string(),
            Some(10),
            first.next_offset,
            first.next_column,
        )
        .await
        .unwrap();
        assert_eq!(second.content, "\nlast");
        assert!(!second.truncated);
        assert_eq!(second.total_lines, Some(4));

        let _ = std::fs::remove_dir_all(&kok);
    }

    #[tokio::test]
    async fn tool_output_artifact_256kb_sinirini_asabilir() {
        let kok = benzersiz_tmp("artifact-large");
        let dir = kok.join(".macrocode/tool-outputs");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tool-output-large.log"), "x".repeat(300_000)).unwrap();
        let root = kok.to_str().unwrap().to_string();
        let page = read_file(
            root,
            ".macrocode/tool-outputs/tool-output-large.log".to_string(),
            Some(10),
            None,
            None,
        )
        .await
        .unwrap();
        assert!(page.artifact);
        assert!(page.truncated);
        assert_eq!(page.next_offset, Some(1));
        assert_eq!(page.next_column, Some(ARTIFACT_PAGE_CHARS + 1));
        assert_eq!(page.total_lines, Some(1));
        assert_eq!(page.content.chars().count(), ARTIFACT_PAGE_CHARS);
        assert!(page.content.chars().count() <= ARTIFACT_PAGE_CHARS);
        let _ = std::fs::remove_dir_all(&kok);
    }

    #[tokio::test]
    async fn tool_output_artifact_keyfi_baytlari_metin_projeksiyonu_olarak_okur() {
        let kok = benzersiz_tmp("artifact-binary");
        let dir = kok.join(".macrocode/tool-outputs");
        std::fs::create_dir_all(&dir).unwrap();
        let rel = ".macrocode/tool-outputs/tool-output-binary.log";
        let bytes = [b'a', 0, b'b', 0xff, 0xfe, b'\n', b'z'];
        std::fs::write(dir.join("tool-output-binary.log"), bytes).unwrap();
        let root = kok.to_str().unwrap().to_string();

        let page = read_file(root, rel.to_string(), Some(10), None, None)
            .await
            .unwrap();
        assert_eq!(page.content, String::from_utf8_lossy(&bytes));
        assert_eq!(page.total_lines, Some(2));
        assert!(!page.truncated);
        let _ = std::fs::remove_dir_all(&kok);
    }

    #[test]
    fn faz10_d2c_tek_kaynak_dosyalari_iceriyor() {
        // Blok listeleri blocks.json'dan gelir (sabit tablo yok → kayma imkânsız).
        let b = blocks();
        assert!(b.dirs.contains(&"node_modules".to_string()));
        assert!(b.dirs.contains(&".git".to_string()));
        assert!(b.files.contains(&".env".to_string()));
        assert!(b.secret_exts.contains(&"pem".to_string()));
        assert!(b.data_exts.contains(&"db".to_string()));
        assert!(is_blocked_dir("node_modules"));
        assert!(!is_blocked_dir("src"));
        assert!(is_blocked_file_name("keys.json"));
        assert!(!is_blocked_file_name("a.ts"));
    }

    #[tokio::test]
    async fn faz9_liste_agaci_goreli_yol_verir() {
        let kok = benzersiz_tmp("tree");
        std::fs::write(kok.join("a.ts"), "x").unwrap();
        std::fs::create_dir_all(kok.join("src")).unwrap();
        std::fs::write(kok.join("src/b.ts"), "x").unwrap();
        // Bloklu dizin ve secret dosya listede olmamalı.
        std::fs::create_dir_all(kok.join("node_modules")).unwrap();
        std::fs::write(kok.join("node_modules/x.js"), "x").unwrap();
        std::fs::write(kok.join(".env"), "SECRET=1").unwrap();

        let out = list_tree(kok.to_str().unwrap().to_string(), Some(100))
            .await
            .unwrap();
        let paths: Vec<&str> = out.iter().map(|e| e.path.as_str()).collect();
        assert!(paths.contains(&"a.ts"));
        assert!(paths.contains(&"src/b.ts"));
        assert!(!paths.iter().any(|p| p.contains("node_modules")));
        assert!(!paths.iter().any(|p| p.contains(".env")));
        // Göreli yol (mutlak değil).
        assert!(paths.iter().all(|p| !p.starts_with('/')));
        let _ = std::fs::remove_dir_all(&kok);
    }

    #[tokio::test]
    async fn faz9_liste_agaci_limit_uygular() {
        let kok = benzersiz_tmp("tree-limit");
        for i in 0..10 {
            std::fs::write(kok.join(format!("f{i}.ts")), "x").unwrap();
        }
        let out = list_tree(kok.to_str().unwrap().to_string(), Some(3))
            .await
            .unwrap();
        assert_eq!(out.len(), 3);
        let _ = std::fs::remove_dir_all(&kok);
    }

    fn benzersiz_tmp(altdizin: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "macrocode-test-{}-{}-{}",
            std::process::id(),
            altdizin,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    #[cfg(unix)]
    fn disari_symlink_reddedilir() {
        use std::os::unix::fs::symlink;
        let dis = benzersiz_tmp("dis");
        let kok = benzersiz_tmp("kok");
        std::fs::write(dis.join("gizli.txt"), "gizli").unwrap();
        symlink(dis.join("gizli.txt"), kok.join("kacis")).unwrap();
        assert!(resolve_rooted(kok.to_str().unwrap(), "kacis").is_err());
        let _ = std::fs::remove_dir_all(&dis);
        let _ = std::fs::remove_dir_all(&kok);
    }

    #[test]
    #[cfg(unix)]
    fn iceri_symlink_kabul_edilir() {
        use std::os::unix::fs::symlink;
        let kok = benzersiz_tmp("kok2");
        std::fs::write(kok.join("hedef.txt"), "veri").unwrap();
        symlink(kok.join("hedef.txt"), kok.join("bag")).unwrap();
        let cikti = resolve_rooted(kok.to_str().unwrap(), "bag").unwrap();
        assert_eq!(cikti, kok.canonicalize().unwrap().join("hedef.txt"));
        let _ = std::fs::remove_dir_all(&kok);
    }

    /// H1 — `.macrocode/context.md` bir symlink ise (zararlı repo) içerik ne
    /// okunur ne yazılır: `repoContext.readMemory` bunu sistem prompt'una
    /// gömüp sağlayıcıya gönderirdi (`memory_append` ise keyfi dosyaya yazardı).
    #[tokio::test]
    #[cfg(unix)]
    async fn h1_memory_symlink_kacisi_reddedilir() {
        use std::os::unix::fs::symlink;
        let dis = benzersiz_tmp("mem-dis");
        let kok = benzersiz_tmp("mem-kok");
        std::fs::write(dis.join("gizli.txt"), "anahtar=SECRET").unwrap();
        std::fs::create_dir_all(kok.join(".macrocode")).unwrap();
        symlink(dis.join("gizli.txt"), kok.join(".macrocode/context.md")).unwrap();
        let root = kok.to_str().unwrap().to_string();

        let r = memory_read(root.clone()).await;
        assert!(r.is_err(), "symlink okuması reddedilmeli: {r:?}");

        let w = memory_append(root.clone(), "not".to_string()).await;
        assert!(w.is_err(), "symlink yazması reddedilmeli: {w:?}");
        assert_eq!(
            std::fs::read_to_string(dis.join("gizli.txt")).unwrap(),
            "anahtar=SECRET",
            "hedef dosyaya yazılmamalı"
        );
        let _ = std::fs::remove_dir_all(&dis);
        let _ = std::fs::remove_dir_all(&kok);
    }

    /// H1 — `.macrocode` DİZİNİNİN kendisi dışarıyı gösteren symlink olabilir.
    #[tokio::test]
    #[cfg(unix)]
    async fn h1_memory_dizin_symlinki_reddedilir() {
        use std::os::unix::fs::symlink;
        let dis = benzersiz_tmp("mem-dir-dis");
        let kok = benzersiz_tmp("mem-dir-kok");
        std::fs::write(dis.join("context.md"), "sızmış").unwrap();
        symlink(&dis, kok.join(".macrocode")).unwrap();
        let root = kok.to_str().unwrap().to_string();

        assert!(memory_read(root.clone()).await.is_err());
        assert!(memory_append(root, "not".to_string()).await.is_err());
        let _ = std::fs::remove_dir_all(&dis);
        let _ = std::fs::remove_dir_all(&kok);
    }

    /// H1 — normal akış bozulmaz: ilk yokluğunda yazma dizini kurar, okuma döner.
    #[tokio::test]
    async fn h1_memory_normal_akis_calisir() {
        let kok = benzersiz_tmp("mem-ok");
        let root = kok.to_str().unwrap().to_string();
        assert_eq!(memory_read(root.clone()).await.unwrap(), "");
        let line = memory_append(root.clone(), "selam".to_string())
            .await
            .unwrap();
        assert!(line.contains("selam"));
        assert!(memory_read(root).await.unwrap().contains("selam"));
        let _ = std::fs::remove_dir_all(&kok);
    }

    /// M4 — genişletilmiş blok listeleri (tek kaynak `blocks.json`).
    #[test]
    fn m4_genisletilmis_blok_listeleri() {
        assert!(is_blocked_dir(".ssh"));
        assert!(is_blocked_dir(".aws"));
        assert!(is_blocked_dir(".gnupg"));
        assert!(is_blocked_dir(".kube"));
        assert!(is_blocked_dir(".docker"));
        assert!(is_blocked_file_name(".netrc"));
        assert!(is_blocked_file_name(".git-credentials"));
        assert!(is_blocked_file_name(".pypirc"));
        assert!(is_blocked_file_name(".htpasswd"));
        assert!(is_blocked_file_name(".pgpass"));
        assert!(is_blocked_file_name("credentials.json"));
        assert!(is_blocked_file_name("secrets.json"));
        assert!(is_blocked_file_name("service-account.json"));
        assert!(is_blocked_file_name(".vault-token"));
        assert!(is_blocked_name_ext("vault.kdbx"));
        assert!(is_blocked_name_ext("client.p8"));
        assert!(is_blocked_name_ext("id.jks"));
        assert!(is_blocked_name_ext("server.ppk"));
        assert!(is_blocked_name_ext("vpn.ovpn"));
        // Negatifler: gerçekçi adlar hâlâ geçer.
        assert!(!is_blocked_dir("src"));
        assert!(!is_blocked_file_name("app.ts"));
        assert!(!is_blocked_name_ext("main.rs"));
    }

    /// H2 — blok listeleri büyük/küçük harf duyarsız (macOS/Windows FS bypass).
    #[test]
    fn h2_blok_listeleri_buyuk_kucuk_harf_duyarsiz() {
        assert!(is_blocked_dir(".GIT"));
        assert!(is_blocked_dir("Node_Modules"));
        assert!(is_blocked_file_name("KEYS.JSON"));
        assert!(is_blocked_file_name(".ENV"));
        assert!(is_env_prefixed(".ENV.local"));
        assert!(is_env_prefixed(".env.PROD"));
        // Negatifler: gerçekçi olmayan adlar hâlâ geçer.
        assert!(!is_blocked_dir("src"));
        assert!(!is_blocked_file_name("a.ts"));
        assert!(!is_env_prefixed(".envrc"));
    }

    /// H2 — yol düzeyinde: bileşen denetimi canonical çözüm ÖNCESI de,
    /// SONRASI da duyarlı (`.Git/config` → "dizin yok" hatası yerine
    /// "yasaklı dizin" hatası; canonical bileşenler ayrıca taranır).
    #[tokio::test]
    async fn h2_yol_bilesenleri_buyuk_harfle_reddedilir() {
        let kok = benzersiz_tmp("case");
        std::fs::write(kok.join("keys.json"), "SECRET").unwrap();
        let r = kok.to_str().unwrap().to_string();
        assert!(resolve_rooted(&r, ".Git/config").is_err());
        assert!(resolve_rooted(&r, "KEYS.JSON").is_err());
        assert!(resolve_rooted(&r, ".ENV.local").is_err());
        assert!(resolve_rooted(&r, "keys.json").is_err());
        assert!(resolve_rooted(&r, "a.ts").is_ok());
        let _ = std::fs::remove_dir_all(&kok);
    }

    /// H2 — `check_rel_components` bağımsız testi (canonical sonrası tarama).
    #[test]
    fn h2_canonical_yolun_bilesenleri_de_denetlenir() {
        let kok = benzersiz_tmp("rel");
        assert!(check_rel_components(&kok, &kok.join(".git").join("config")).is_err());
        assert!(check_rel_components(&kok, &kok.join("KEYS.JSON")).is_err());
        assert!(check_rel_components(&kok, &kok.join("sub").join(".ENV.x")).is_err());
        assert!(check_rel_components(&kok, &kok.join("src").join("a.ts")).is_ok());
        let _ = std::fs::remove_dir_all(&kok);
    }

    #[test]
    fn var_olmayan_dosya_parent_kontrolunden_gecer() {
        let kok = benzersiz_tmp("kok3");
        let cikti = resolve_rooted(kok.to_str().unwrap(), "yeni/alt/dosya.txt");
        // parent yoksa hata (create_dir_all apply_patch'te yapılır, burada değil).
        assert!(cikti.is_err());
        std::fs::create_dir_all(kok.join("yeni/alt")).unwrap();
        assert!(resolve_rooted(kok.to_str().unwrap(), "yeni/alt/dosya.txt").is_ok());
        let _ = std::fs::remove_dir_all(&kok);
    }

    #[test]
    fn bloklu_dizin_tum_araclar_reddedilir() {
        let kok = benzersiz_tmp("kok_blocked");
        let r = kok.to_str().unwrap().to_string();
        // Y1 (Faz 2): bloklu dizin artık listede değil — okuma da yazma da reddedilir.
        assert!(resolve_rooted(&r, ".git/config").is_err());
        assert!(resolve_rooted(&r, ".git").is_err());
        assert!(resolve_rooted(&r, "alt/.git/hooks/pre-commit").is_err());
        assert!(resolve_rooted(&r, "node_modules/x.js").is_err());
        assert!(resolve_rooted(&r, ".macrocode/backups/manifest.json").is_err());
        // Normal yol etkilenmez (parent'ın var olması gerekir — jail testi değil).
        std::fs::create_dir_all(kok.join("src")).unwrap();
        assert!(resolve_rooted(&r, "src/app.ts").is_ok());
        let _ = std::fs::remove_dir_all(&kok);
    }

    #[tokio::test]
    async fn git_ici_okuma_ve_yazma_reddedilir() {
        let kok = benzersiz_tmp("kok_git_blocked");
        let r = kok.to_str().unwrap().to_string();
        std::fs::create_dir_all(kok.join(".git")).unwrap();
        std::fs::write(kok.join(".git").join("config"), "token = gizli").unwrap();

        // Okuma: doğrudan invoke bile olsa reddedilir.
        assert!(
            read_file(r.clone(), ".git/config".to_string(), None, None, None)
                .await
                .is_err_and(|e| e.contains("yasaklı dizin"))
        );
        // Grep/glob/liste de reddedilir.
        assert!(
            grep_files(r.clone(), "token".to_string(), Some(".git".into()), None)
                .await
                .is_err()
        );
        assert!(list_dir(r.clone(), ".git".to_string()).await.is_err());
        // Yazma: `.git` altına yama yazılamaz.
        assert!(apply_patch(
            r.clone(),
            ".git/hooks/pre-commit".to_string(),
            "#!/bin/sh".to_string()
        )
        .await
        .is_err());
        assert!(
            write_file(r.clone(), ".git/deneme".to_string(), "x".to_string())
                .await
                .is_err()
        );

        let _ = std::fs::remove_dir_all(&kok);
    }

    #[tokio::test]
    async fn apply_patch_ve_undo_calisir() {
        let kok = benzersiz_tmp("kok_patch");
        let dosya = kok.join("ornek.txt");
        std::fs::write(&dosya, "versiyon 1").unwrap();

        // 1. apply_patch uygula
        apply_patch(
            kok.to_str().unwrap().to_string(),
            "ornek.txt".to_string(),
            "versiyon 2".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read_to_string(&dosya).unwrap(), "versiyon 2");

        // .macrocode/backups/manifest.json varlığını kontrol et
        let manifest = kok.join(".macrocode").join("backups").join("manifest.json");
        assert!(manifest.exists());

        // 2. undo_patch ile geri al
        let res = undo_patch(kok.to_str().unwrap().to_string(), None)
            .await
            .unwrap();
        assert!(res.contains("ornek.txt"));
        assert_eq!(std::fs::read_to_string(&dosya).unwrap(), "versiyon 1");

        let _ = std::fs::remove_dir_all(&kok);
    }

    /// B1 — `apply_patch` geçici dosyası artık öngörülebilir DEĞİL: saldırgan
    /// `README.md.tmp-macrocode` adında bir symlink koysa bile dışarıya yazma
    /// gerçekleşmemeli, hedef dosya symlink'e dönüşmemeli.
    #[tokio::test]
    #[cfg(unix)]
    async fn b1_apply_patch_temp_symlink_ile_disariya_yazmaz() {
        use std::os::unix::fs::symlink;
        let kok = benzersiz_tmp("b1-patch-kok");
        let dis = benzersiz_tmp("b1-patch-dis");
        let dis_file = dis.join("kurban.txt");
        std::fs::write(&dis_file, "DOKUNULMAMALI").unwrap();

        let hedef = kok.join("README.md");
        std::fs::write(&hedef, "v1").unwrap();
        // Eski kodun kullandığı öngörülebilir geçici ad → dışarıyı gösteren symlink.
        symlink(&dis_file, kok.join("README.tmp-macrocode")).unwrap();

        apply_patch(
            kok.to_str().unwrap().to_string(),
            "README.md".to_string(),
            "v2".to_string(),
        )
        .await
        .unwrap();

        // Dışarıdaki dosya değişmemiş olmalı.
        assert_eq!(
            std::fs::read_to_string(&dis_file).unwrap(),
            "DOKUNULMAMALI",
            "jail dışına yazıldı"
        );
        // Hedef normal dosya olarak kalmış olmalı (symlink'e dönüşmemeli).
        let md = std::fs::symlink_metadata(&hedef).unwrap();
        assert!(!md.file_type().is_symlink(), "hedef symlink'e dönüştü");
        assert_eq!(std::fs::read_to_string(&hedef).unwrap(), "v2");

        // Artık geçici dosya kalmamalı (eski symlink hariç).
        let artan: Vec<String> = std::fs::read_dir(&kok)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".mc-"))
            .collect();
        assert!(artan.is_empty(), "geçici dosya artığı: {artan:?}");

        let _ = std::fs::remove_dir_all(&kok);
        let _ = std::fs::remove_dir_all(&dis);
    }

    /// B1 — `undo_patch` eski `tmp-restore` adını kullanmıyor; geçici ad
    /// symlink'i varsa dışarıya yazma olmamalı.
    #[tokio::test]
    #[cfg(unix)]
    async fn b1_undo_patch_temp_symlink_ile_disariya_yazmaz() {
        use std::os::unix::fs::symlink;
        let kok = benzersiz_tmp("b1-undo-kok");
        let dis = benzersiz_tmp("b1-undo-dis");
        let dis_file = dis.join("kurban.txt");
        std::fs::write(&dis_file, "DOKUNULMAMALI").unwrap();

        let hedef = kok.join("ornek.txt");
        std::fs::write(&hedef, "v1").unwrap();
        apply_patch(
            kok.to_str().unwrap().to_string(),
            "ornek.txt".to_string(),
            "v2".to_string(),
        )
        .await
        .unwrap();

        symlink(&dis_file, kok.join("ornek.tmp-restore")).unwrap();
        undo_patch(kok.to_str().unwrap().to_string(), None)
            .await
            .unwrap();

        assert_eq!(
            std::fs::read_to_string(&dis_file).unwrap(),
            "DOKUNULMAMALI",
            "geri alma jail dışına yazdı"
        );
        assert_eq!(std::fs::read_to_string(&hedef).unwrap(), "v1");

        let _ = std::fs::remove_dir_all(&kok);
        let _ = std::fs::remove_dir_all(&dis);
    }

    /// B1 — hedef dosya symlink ise üzerine yazma reddedilir (rename symlink'i
    /// ezmeden önce net hata).
    #[tokio::test]
    #[cfg(unix)]
    async fn b1_hedef_symlink_reddedilir() {
        use std::os::unix::fs::symlink;
        let kok = benzersiz_tmp("b1-hedef-kok");
        let dis = benzersiz_tmp("b1-hedef-dis");
        let dis_file = dis.join("kurban.txt");
        std::fs::write(&dis_file, "ORIJINAL").unwrap();
        symlink(&dis_file, kok.join("bag")).unwrap();

        let res = apply_patch(
            kok.to_str().unwrap().to_string(),
            "bag".to_string(),
            "v2".to_string(),
        )
        .await;
        assert!(res.is_err(), "symlink hedefi kabul edilmemeli");
        assert_eq!(std::fs::read_to_string(&dis_file).unwrap(), "ORIJINAL");

        let _ = std::fs::remove_dir_all(&kok);
        let _ = std::fs::remove_dir_all(&dis);
    }

    /// B1 — `atomic_write_exclusive` art arda yazmalarda tek dosya bırakır,
    /// geçici artık üretmez ve içeriği doğru yazar.
    #[test]
    fn b1_atomic_write_exclusive_tekrar_ve_artik() {
        let kok = benzersiz_tmp("b1-atomic");
        let hedef = kok.join("veri.txt");
        for i in 0..50 {
            atomic_write_exclusive(&hedef, format!("içerik-{i}").as_bytes()).unwrap();
        }
        assert_eq!(std::fs::read_to_string(&hedef).unwrap(), "içerik-49");
        let dosyalar: Vec<String> = std::fs::read_dir(&kok)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(dosyalar, vec!["veri.txt".to_string()], "{dosyalar:?}");
        let _ = std::fs::remove_dir_all(&kok);
    }

    /// Yedek adı, kaynak uzantısını taşımaz ve boşluk/unicode içeren
    /// dosyalarda da `apply_patch` çalışır.
    #[tokio::test]
    async fn yedek_adi_guvenli_ve_kaynak_uzantisiz() {
        let kok = benzersiz_tmp("kok_yedek_adi");
        let ad = "rapor sonu şablon.test.ts";
        let dosya = kok.join(ad);
        std::fs::write(&dosya, "v1").unwrap();

        apply_patch(
            kok.to_str().unwrap().to_string(),
            ad.to_string(),
            "v2".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read_to_string(&dosya).unwrap(), "v2");

        let backup_dir = kok.join(".macrocode").join("backups");
        let manifest = std::fs::read_to_string(backup_dir.join("manifest.json")).unwrap();
        let entries: Vec<BackupEntry> = serde_json::from_str(&manifest).unwrap();
        assert_eq!(entries.len(), 1);
        let name = &entries[0].backup_file;
        assert!(
            name.ends_with(".test.ts.bak"),
            "beklenmeyen yedek adı: {name}"
        );
        assert!(safe_backup_name(name).is_ok());
        assert!(backup_dir.join(name).exists());

        undo_patch(kok.to_str().unwrap().to_string(), None)
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(&dosya).unwrap(), "v1");
        let _ = std::fs::remove_dir_all(&kok);
    }

    #[test]
    fn sanitize_backup_name_kontrolleri() {
        assert_eq!(sanitize_backup_name("a.txt"), "a.txt.bak");
        assert_eq!(sanitize_backup_name("rapor sonu.txt"), "rapor_sonu.txt.bak");
        assert_eq!(sanitize_backup_name("şablon.test.ts"), "_ablon.test.ts.bak");
        assert_eq!(sanitize_backup_name("..."), "file.bak");
    }

    /// H1 devamı — `.macrocode` dışarıyı gösteren symlink ise `apply_patch`
    /// yedek/manifest yazmadan reddeder; hedef dosya da değişmez.
    #[tokio::test]
    #[cfg(unix)]
    async fn h1_apply_patch_macrocode_symlink_reddedilir() {
        use std::os::unix::fs::symlink;
        let kok = benzersiz_tmp("patch-macro-kok");
        let dis = benzersiz_tmp("patch-macro-dis");
        std::fs::write(kok.join("a.txt"), "v1").unwrap();
        symlink(&dis, kok.join(".macrocode")).unwrap();
        let root = kok.to_str().unwrap().to_string();

        let r = apply_patch(root, "a.txt".to_string(), "v2".to_string()).await;
        assert!(r.is_err(), "symlink yedek dizini reddedilmeli: {r:?}");
        assert!(!dis.join("backups").exists(), "dışarı yedek yazılmamalı");
        assert_eq!(std::fs::read_to_string(kok.join("a.txt")).unwrap(), "v1");
        let _ = std::fs::remove_dir_all(&dis);
        let _ = std::fs::remove_dir_all(&kok);
    }

    /// H1 devamı — `.macrocode/backups` symlink'i de dışarı yazamaz.
    #[tokio::test]
    #[cfg(unix)]
    async fn h1_apply_patch_backups_symlink_reddedilir() {
        use std::os::unix::fs::symlink;
        let kok = benzersiz_tmp("patch-backup-kok");
        let dis = benzersiz_tmp("patch-backup-dis");
        std::fs::write(kok.join("a.txt"), "v1").unwrap();
        std::fs::create_dir_all(kok.join(".macrocode")).unwrap();
        symlink(&dis, kok.join(".macrocode/backups")).unwrap();
        let root = kok.to_str().unwrap().to_string();

        let r = apply_patch(root, "a.txt".to_string(), "v2".to_string()).await;
        assert!(r.is_err(), "symlink backups reddedilmeli: {r:?}");
        assert!(!dis.join("manifest.json").exists());
        assert_eq!(std::fs::read_to_string(kok.join("a.txt")).unwrap(), "v1");
        let _ = std::fs::remove_dir_all(&dis);
        let _ = std::fs::remove_dir_all(&kok);
    }

    /// H1 devamı — `manifest.json` symlink'i dışarıdaki dosyayı hedef alırsa
    /// yedekleme reddedilir; dışarıdaki dosya değişmez.
    #[tokio::test]
    #[cfg(unix)]
    async fn h1_apply_patch_manifest_symlink_reddedilir() {
        use std::os::unix::fs::symlink;
        let kok = benzersiz_tmp("patch-manifest-kok");
        let dis = benzersiz_tmp("patch-manifest-dis");
        std::fs::write(kok.join("a.txt"), "v1").unwrap();
        std::fs::create_dir_all(kok.join(".macrocode/backups")).unwrap();
        std::fs::write(dis.join("hedef.json"), "[]").unwrap();
        symlink(
            dis.join("hedef.json"),
            kok.join(".macrocode/backups/manifest.json"),
        )
        .unwrap();
        let root = kok.to_str().unwrap().to_string();

        let r = apply_patch(root, "a.txt".to_string(), "v2".to_string()).await;
        assert!(r.is_err(), "symlink manifest reddedilmeli: {r:?}");
        assert_eq!(
            std::fs::read_to_string(dis.join("hedef.json")).unwrap(),
            "[]",
            "dışarıdaki manifest değişmemeli"
        );
        assert_eq!(std::fs::read_to_string(kok.join("a.txt")).unwrap(), "v1");
        let _ = std::fs::remove_dir_all(&dis);
        let _ = std::fs::remove_dir_all(&kok);
    }

    #[tokio::test]
    async fn macrocode_dizini_listelemede_gorunmez() {
        let kok = benzersiz_tmp("kok_macrocode");
        std::fs::create_dir_all(kok.join(".macrocode")).unwrap();
        std::fs::write(kok.join("kod.rs"), "fn main() {}").unwrap();

        let entries = list_dir(kok.to_str().unwrap().to_string(), "".to_string())
            .await
            .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "kod.rs");

        let _ = std::fs::remove_dir_all(&kok);
    }

    #[tokio::test]
    async fn grep_literal_ve_regex_ayrimi() {
        let kok = benzersiz_tmp("kok_grep");
        let r = kok.to_str().unwrap().to_string();
        std::fs::write(kok.join("a.txt"), "foo bar\nfoo123\nbaz\n").unwrap();
        // Literal: nokta normal karakter.
        let lit = grep_files(r.clone(), "foo.".to_string(), None, None)
            .await
            .unwrap();
        assert!(lit.is_empty());
        // Regex: `foo.` eşleşir, geçersiz regex Türkçe hata verir.
        let re = grep_files(r.clone(), "foo.".to_string(), None, Some(true))
            .await
            .unwrap();
        assert_eq!(re.len(), 2);
        let bad = grep_files(r, "(".to_string(), None, Some(true)).await;
        assert!(bad.is_err_and(|e| e.contains("geçersiz regex")));
        let _ = std::fs::remove_dir_all(&kok);
    }

    #[tokio::test]
    async fn kotu_niyetli_manifest_red() {
        // K1 (Faz 1) regresyon: manifest'teki `backup_file` alanı doğrulanmadan
        // kullanılmamalı — mutlak yol / ../ ile workspace dışına çıkılamaz.
        let kok = benzersiz_tmp("kok_undo_k1");
        let dis = benzersiz_tmp("dis_undo_k1");
        let dis_file = dis.join("gizli.txt");
        std::fs::write(&dis_file, "hem-oku-hem-sil").unwrap();
        let r = kok.to_str().unwrap().to_string();

        let backup_dir = kok.join(".macrocode").join("backups");
        std::fs::create_dir_all(&backup_dir).unwrap();
        std::fs::write(kok.join("hedef.txt"), "orijinal").unwrap();

        let yaz_manifest = |backup_file: &str| {
            let entries = vec![BackupEntry {
                id: "1".into(),
                rel_path: "hedef.txt".into(),
                backup_file: backup_file.into(),
                timestamp: 1,
            }];
            std::fs::write(
                backup_dir.join("manifest.json"),
                serde_json::to_string_pretty(&entries).unwrap(),
            )
            .unwrap();
        };

        // 1. Mutlak yol: reddedilir, hedef değişmez, kaynak dosya silinmez.
        yaz_manifest(dis_file.to_str().unwrap());
        let res = undo_patch(r.clone(), None).await;
        assert!(res.is_err_and(|e| e.contains("yedek adı geçersiz")));
        assert_eq!(
            std::fs::read_to_string(kok.join("hedef.txt")).unwrap(),
            "orijinal"
        );
        assert!(dis_file.exists(), "kaynak dosya silinmemeli");

        // 2. ../ kaçışı: reddedilir.
        yaz_manifest("../..//kacis.txt");
        assert!(undo_patch(r.clone(), None).await.is_err());

        // 3. Dizin ayracı içeren ad: reddedilir.
        yaz_manifest("alt/dosya.txt");
        assert!(undo_patch(r.clone(), None).await.is_err());

        // 4. Geçersiz karakter: reddedilir.
        yaz_manifest("boşluklu.txt");
        assert!(undo_patch(r, None).await.is_err());

        assert!(dis_file.exists());
        let _ = std::fs::remove_dir_all(&kok);
        let _ = std::fs::remove_dir_all(&dis);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn kotu_niyetli_symlink_yedek_red() {
        use std::os::unix::fs::symlink;
        // K1 (Faz 1): dosya adı güvenli olsa bile symlink dışarıyı gösteremez.
        let kok = benzersiz_tmp("kok_undo_sym");
        let dis = benzersiz_tmp("dis_undo_sym");
        let dis_file = dis.join("sirl.txt");
        std::fs::write(&dis_file, "sirli-icerik").unwrap();
        let r = kok.to_str().unwrap().to_string();

        let backup_dir = kok.join(".macrocode").join("backups");
        std::fs::create_dir_all(&backup_dir).unwrap();
        std::fs::write(kok.join("hedef.txt"), "orijinal").unwrap();
        // Güvenli ada sahip ama dışarıyı gösteren symlink.
        symlink(&dis_file, backup_dir.join("1_guvenli-adi.txt")).unwrap();

        let entries = vec![BackupEntry {
            id: "1".into(),
            rel_path: "hedef.txt".into(),
            backup_file: "1_guvenli-adi.txt".into(),
            timestamp: 1,
        }];
        std::fs::write(
            backup_dir.join("manifest.json"),
            serde_json::to_string_pretty(&entries).unwrap(),
        )
        .unwrap();

        let res = undo_patch(r, None).await;
        assert!(res.is_err_and(|e| e.contains("yedek dizini dışında")));
        assert_eq!(
            std::fs::read_to_string(kok.join("hedef.txt")).unwrap(),
            "orijinal"
        );
        assert!(dis_file.exists(), "symlink kaynağı silinmemeli");

        let _ = std::fs::remove_dir_all(&kok);
        let _ = std::fs::remove_dir_all(&dis);
    }

    #[test]
    fn safe_backup_name_kontrolleri() {
        assert!(safe_backup_name("123_dosya.txt").is_ok());
        assert!(safe_backup_name("").is_err());
        assert!(safe_backup_name("..").is_err());
        assert!(safe_backup_name("../x").is_err());
        assert!(safe_backup_name("/etc/passwd").is_err());
        assert!(safe_backup_name("a\\b").is_err());
        assert!(safe_backup_name("boş").is_err());
        assert!(safe_backup_name("a b").is_err());
    }

    #[tokio::test]
    async fn read_offset_limit_sayfalar() {
        let kok = benzersiz_tmp("kok_offset");
        let r = kok.to_str().unwrap().to_string();
        let icerik = (1..=10)
            .map(|i| format!("satır{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(kok.join("b.txt"), icerik).unwrap();
        let sayfa = read_file(r.clone(), "b.txt".to_string(), Some(3), Some(4), None)
            .await
            .unwrap();
        assert_eq!(sayfa.content, "satır4\nsatır5\nsatır6");
        assert!(sayfa.truncated);
        assert_eq!(sayfa.next_offset, Some(7));
        assert_eq!(sayfa.next_column, None);
        assert_eq!(sayfa.total_lines, Some(10));
        assert!(!sayfa.artifact);
        let son = read_file(r.clone(), "b.txt".to_string(), Some(5), Some(9), None)
            .await
            .unwrap();
        assert_eq!(son.content, "satır9\nsatır10");
        assert!(!son.truncated);
        assert_eq!(son.next_offset, None);
        assert_eq!(son.total_lines, Some(10));
        let _ = std::fs::remove_dir_all(&kok);
    }

    #[tokio::test]
    async fn normal_read_file_byte_limiti_unicode_guvenli_ve_devamsiz() {
        let kok = benzersiz_tmp("normal-byte-limit");
        let root = kok.to_str().unwrap().to_string();
        // 64KB sınırı 4 baytlık emoji'nin içine düşer. Ham bayt dilimleme
        // panik yapardı; UTF-8 sınırındaki kesim geçerli metin üretmelidir.
        let prefix = "a".repeat(MAX_READ_BYTES as usize - 1);
        let source = format!("{prefix}😀tail\nsecond\n");
        std::fs::write(kok.join("unicode.txt"), &source).unwrap();

        let page = read_file(root.clone(), "unicode.txt".to_string(), Some(1), None, None)
            .await
            .unwrap();
        assert!(page.truncated);
        assert_eq!(page.next_offset, None);
        assert_eq!(page.next_column, None);
        assert_eq!(page.total_lines, Some(2));
        assert!(!page.artifact);
        assert_eq!(page.content, prefix);
        assert!(page.content.len() <= MAX_READ_BYTES as usize);
        assert!(!page.content.contains('\u{fffd}'));

        // Byte-limited sayfa devam imleci üretmese de offset hâlâ çalışır.
        let second = read_file(
            root.clone(),
            "unicode.txt".to_string(),
            Some(1),
            Some(2),
            None,
        )
        .await
        .unwrap();
        assert_eq!(second.content, "second");
        assert!(!second.truncated);
        assert_eq!(second.next_offset, None);
        assert_eq!(second.total_lines, Some(2));

        // 64KB'a tam oturan sayfa byte-limited değildir; satır devamı vardır.
        let exact = "x".repeat(MAX_READ_BYTES as usize);
        std::fs::write(kok.join("exact.txt"), format!("{exact}\nsecond\n")).unwrap();
        let exact_page = read_file(root, "exact.txt".to_string(), Some(1), None, None)
            .await
            .unwrap();
        assert_eq!(exact_page.content.len(), MAX_READ_BYTES as usize);
        assert!(exact_page.truncated);
        assert_eq!(exact_page.next_offset, Some(2));
        assert_eq!(exact_page.next_column, None);
        assert_eq!(exact_page.total_lines, Some(2));

        let _ = std::fs::remove_dir_all(&kok);
    }

    #[tokio::test]
    async fn glob_ignore_filtreler() {
        let kok = benzersiz_tmp("kok_glob");
        let r = kok.to_str().unwrap().to_string();
        std::fs::write(kok.join("a.ts"), "x").unwrap();
        std::fs::write(kok.join("b.ts"), "y").unwrap();
        std::fs::create_dir_all(kok.join("node_modules")).unwrap();
        std::fs::write(kok.join("node_modules/c.ts"), "z").unwrap();
        let hits = glob_files(r, "**/*.ts".to_string(), None).await.unwrap();
        let adlar: Vec<&str> = hits.iter().map(|e| e.name.as_str()).collect();
        assert!(adlar.contains(&"a.ts"));
        assert!(adlar.contains(&"b.ts"));
        assert!(!adlar.iter().any(|n| n.contains("node_modules")));
        let _ = std::fs::remove_dir_all(&kok);
    }

    #[tokio::test]
    async fn write_file_o_excl_korur() {
        let kok = benzersiz_tmp("kok_write");
        let r = kok.to_str().unwrap().to_string();
        let out = write_file(r.clone(), "yeni.txt".to_string(), "merhaba".to_string())
            .await
            .unwrap();
        assert!(out.created);
        assert_eq!(
            std::fs::read_to_string(kok.join("yeni.txt")).unwrap(),
            "merhaba"
        );
        // Mevcut dosya reddedilir.
        let again = write_file(r.clone(), "yeni.txt".to_string(), "başka".to_string()).await;
        assert!(again.is_err_and(|e| e.contains("dosya zaten var") && e.contains("edit_file")));
        assert_eq!(
            std::fs::read_to_string(kok.join("yeni.txt")).unwrap(),
            "merhaba"
        );
        // Jail korunur.
        assert!(write_file(r, "../kacis.txt".to_string(), "x".to_string())
            .await
            .is_err());
        let _ = std::fs::remove_dir_all(&kok);
    }

    #[test]
    fn windows_ayiraci_donusturulur() {
        let kok = benzersiz_tmp("kok_winsep");
        std::fs::create_dir_all(kok.join("alt")).unwrap();
        let r = kok.to_str().unwrap().to_string();
        // `\` ayracı `/` sayılır: mevcut parent altında çözülür.
        assert!(resolve_rooted(&r, "alt\\dosya.txt").is_ok());
        assert!(resolve_rooted(&r, "..\\..\\etc").is_err());
        let _ = std::fs::remove_dir_all(&kok);
    }

    #[test]
    #[cfg(unix)]
    fn git_ici_symlink_baskini_reddedilir() {
        use std::os::unix::fs::symlink;
        let dis = benzersiz_tmp("dis_git");
        let kok = benzersiz_tmp("kok_git");
        std::fs::create_dir_all(kok.join(".git")).unwrap();
        std::fs::write(dis.join("gizli.txt"), "gizli").unwrap();
        symlink(dis.join("gizli.txt"), kok.join(".git").join("kacis")).unwrap();
        assert!(resolve_rooted(kok.to_str().unwrap(), ".git/kacis").is_err());
        let _ = std::fs::remove_dir_all(&dis);
        let _ = std::fs::remove_dir_all(&kok);
    }

    #[tokio::test]
    async fn glob_ust_dizin_desenleri_reddedilir() {
        let kok = benzersiz_tmp("kok_glob2");
        let r = kok.to_str().unwrap().to_string();
        assert!(glob_files(r.clone(), "../*.ts".to_string(), None)
            .await
            .is_err());
        assert!(glob_files(r, "/mutlak/*.ts".to_string(), None)
            .await
            .is_err());
        let _ = std::fs::remove_dir_all(&kok);
    }
}
