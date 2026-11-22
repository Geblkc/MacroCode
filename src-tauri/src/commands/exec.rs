use super::proc_tree::{self, ProcTree};
use super::tool_output::{
    artifact_metadata, clamp_summary, create_artifact_file, new_artifact_name, output_policy,
    shape_hard, shape_medium, ToolArtifact,
};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::watch;

const TIMEOUT_SECS: u64 = 15;
const MAX_TIMEOUT_MS: u64 = 600_000;
/// Aynı süreçte eşzamanlı capture dosyalarının ad çakışmasını engeller.
static CAPTURE_COUNTER: AtomicU64 = AtomicU64::new(0);
/// Süreç öldükten sonra boru okuyucularının boşalması için üst sınır.
/// Torun süreçler stdout/stderr'i açık tutarsa exec sonsuza kadar asılı
/// kalmasın (iptal/timeout sonucu yine UI'a döner).
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// Faz 3 (K3) — exec allowlist tek kaynağı: `src/lib/engine/allowlist.json`.
/// TS `policy.ts` aynı dosyayı import eder; burası `include_str!` ile gömer.
/// Boş liste = serbest argüman; diğerleri prefix eşleşmesi.
/// exec her zaman manuel onaylıdır (O6) — burası yalnızca allowlist filtresidir.
const ALLOWLIST_JSON: &str = include_str!("../../../src/lib/engine/allowlist.json");

/// O1 (Faz 4) — dosya operandsı alan serbest-argüman komutları: argümanlar
/// workspace-relative olmalı (mutlak yol / `..` / bloklu dosya-dizin reddi).
/// `cat /etc/passwd`, `find /`, `cat .env` bu kapıdan geçemez (read_file'daki
/// koruma exec ile delinemez). Diğer komutlarda argüman jail'i yok — allowlist
/// "hangi komut"u kısıtlar (bilinçli tasarım; bkz. `_note`).
const FILE_ARG_CMDS: [&str; 10] = [
    "cat", "head", "tail", "wc", "find", "rg", "ls", "touch", "mkdir", "prettier",
];

/// Dosya argümanı jail'i: mutlak yol, `..`, bloklu dosya/dizin reddi.
/// Bayraklar (`-la`, `--color`) ve desenler (`*.ts`) etkilenmez.
fn check_file_arg(a: &str) -> Result<(), String> {
    let v = a.trim().replace('\\', "/");
    if v.is_empty() || v.starts_with('-') {
        return Ok(()); // bayrak
    }
    if v.starts_with('/') {
        return Err(err(format!("argüman jail dışı (mutlak yol): {a}")));
    }
    for seg in v.split('/') {
        if seg == ".." {
            return Err(err(format!("argüman jail dışı (../): {a}")));
        }
        if crate::commands::fs::is_blocked_dir(seg) {
            return Err(err(format!("yasaklı dizin argümanda: {a}")));
        }
        if crate::commands::fs::is_blocked_file_name(seg)
            || crate::commands::fs::is_env_prefixed(seg)
        {
            return Err(err(format!("yasaklı dosya argümanda: {a}")));
        }
        // O7 (D2b senkronu): gizli/veri uzantıları — ad-bazlı (`.pem` dotfile
        // dahil) ve case-insensitive. Eskiden kopyalanmış küçük harf tablosuydu
        // (`CERT.PEM`/`.key` kaçardı); artık fs.rs tek kaynak fonksiyonunu kullanır.
        if crate::commands::fs::is_blocked_name_ext(seg) {
            return Err(err(format!("yasaklı dosya argümanda: {a}")));
        }
    }
    Ok(())
}

/// O1 (desen istisnası) — değeri yol değil **glob deseni** alan bayraklar.
/// TS `policy.ts` `PATTERN_FLAGS` ile senkron: `rg --glob '!**/.git/**'`,
/// `find . -name '*.pem'` gibi meşru aramalar jail'e takılmamalı.
fn pattern_flags(cmd: &str) -> &'static [&'static str] {
    match cmd {
        "find" => &["-name", "-iname", "-path", "-ipath", "-regex", "-iregex"],
        "rg" => &["-g", "--glob", "--iglob"],
        _ => &[],
    }
}

/// Dosya operandsı olarak denetlenecek argümanlar (desen bayraklarının
/// değerleri hariç). Glob içeren HER argümanı muaf tutmak `cat *.pem`
/// operandı üzerinden blok listesini atlatırdı; bu yüzden yalnızca desen
/// değeri alan bayraklar atlanır.
fn file_path_args(cmd: &str, args: &[String]) -> Vec<String> {
    let flags = pattern_flags(cmd);
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < args.len() {
        let a = args[i].as_str();
        if !a.starts_with('-') {
            out.push(args[i].clone());
            i += 1;
            continue;
        }
        // `-name desen` / `--glob desen`: değeri atla.
        if flags.contains(&a) {
            i += 2;
            continue;
        }
        // `--glob=desen`: argümanın tamamı desendir.
        if flags
            .iter()
            .any(|f| a.strip_prefix(f).is_some_and(|rest| rest.starts_with('=')))
        {
            i += 1;
            continue;
        }
        i += 1;
    }
    out
}

/// M6 — `--opt=değer` biçiminden değeri çıkarır (`--filefoo` gibi adları
/// yanlışlıkla eşleştirmez).
fn opt_value<'a>(arg: &'a str, flag: &str) -> Option<&'a str> {
    arg.strip_prefix(flag)?.strip_prefix('=')
}

/// M6 — git argümanlarından **dosya/dizin yolu** taşıyanları çıkarır.
///
/// Eski durum: `git` `FILE_ARG_CMDS` dışındaydı; `git diff --no-index
/// /etc/passwd x` keyfi dosya okuyor, `git commit -F /etc/passwd` dosyayı
/// mesaj olarak okuyor, `git show HEAD:.env` bloklu dosyayı döküyordu.
/// Kapsam: `--` sonrası operandlar, `rev:path` path kısmı, `-F/--file`,
/// `--output`, `--pathspec-from-file`, `add` pathspec'leri ve global
/// `-C/--git-dir/--work-tree` değerleri.
fn git_path_args(args: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    let mut sub: Option<&str> = None;

    // Global seçenekler alt komuttan ÖNCE gelir (`git -C dir status`).
    while i < args.len() {
        let a = args[i].as_str();
        if a == "--" {
            out.extend(args[i + 1..].iter().cloned());
            return out;
        }
        if !a.starts_with('-') {
            sub = Some(a);
            i += 1;
            break;
        }
        // `-C <dir>` ve bitişik `-C<dir>`.
        if a == "-C" {
            if let Some(v) = args.get(i + 1) {
                out.push(v.clone());
            }
            i += 2;
            continue;
        }
        if let Some(v) = a.strip_prefix("-C") {
            if !v.is_empty() {
                out.push(v.to_string());
            }
            i += 1;
            continue;
        }
        // `--git-dir=...` / `--work-tree=...`.
        if let Some((name, value)) = a.split_once('=') {
            if name == "--git-dir" || name == "--work-tree" {
                out.push(value.to_string());
            }
            i += 1;
            continue;
        }
        if a == "--git-dir" || a == "--work-tree" {
            if let Some(v) = args.get(i + 1) {
                out.push(v.clone());
            }
            i += 2;
            continue;
        }
        // Değer alan ama yol olmayan global seçenekler: değeri atla ki alt
        // komut sanılmasın.
        if matches!(
            a,
            "-c" | "--config-env" | "--namespace" | "--super-prefix" | "--attr-source"
        ) {
            i += 2;
            continue;
        }
        i += 1;
    }

    let Some(sub) = sub else {
        return out;
    };
    let rest = &args[i..];
    match sub {
        "add" => {
            let mut j = 0;
            while j < rest.len() {
                let a = rest[j].as_str();
                if a == "--" {
                    out.extend(rest[j + 1..].iter().cloned());
                    break;
                }
                if let Some(v) = opt_value(a, "--pathspec-from-file") {
                    out.push(v.to_string());
                } else if a == "--pathspec-from-file" {
                    if let Some(v) = rest.get(j + 1) {
                        out.push(v.clone());
                        j += 1;
                    }
                } else if !a.starts_with('-') {
                    out.push(a.to_string());
                }
                j += 1;
            }
        }
        "diff" | "log" | "show" => {
            let mut j = 0;
            while j < rest.len() {
                let a = rest[j].as_str();
                if a == "--" {
                    out.extend(rest[j + 1..].iter().cloned());
                    break;
                }
                if let Some(v) = opt_value(a, "--output") {
                    out.push(v.to_string());
                } else if a == "--output" {
                    if let Some(v) = rest.get(j + 1) {
                        out.push(v.clone());
                        j += 1;
                    }
                } else if !a.starts_with('-') {
                    // URL (`https://…`) dosya yolu değildir; `rev:path` ise
                    // yalnız path kısmı denetlenir.
                    if a.contains("://") {
                        // atla
                    } else if let Some((_, p)) = a.split_once(':') {
                        if !p.is_empty() {
                            out.push(p.to_string());
                        }
                    } else {
                        out.push(a.to_string());
                    }
                }
                j += 1;
            }
        }
        "commit" => {
            let mut j = 0;
            while j < rest.len() {
                let a = rest[j].as_str();
                if a == "--" {
                    out.extend(rest[j + 1..].iter().cloned());
                    break;
                }
                if let Some(v) =
                    opt_value(a, "--file").or_else(|| opt_value(a, "--pathspec-from-file"))
                {
                    out.push(v.to_string());
                } else if a == "--file" || a == "--pathspec-from-file" || a == "-F" {
                    if let Some(v) = rest.get(j + 1) {
                        out.push(v.clone());
                        j += 1;
                    }
                } else if a.starts_with("-F") && a.len() > 2 {
                    out.push(a[2..].to_string());
                }
                j += 1;
            }
        }
        "stash" => {
            // `git stash push -- <pathspec>`; `-m` değeri mesajdır, yol değil.
            if let Some(pos) = rest.iter().position(|a| a == "--") {
                out.extend(rest[pos + 1..].iter().cloned());
            }
        }
        _ => {}
    }
    out
}

/// M6 — `git -C <dir>` operand çözümlemesini değiştirir. Symlink/canonical
/// jail'in doğru tabanı kullanması için birikimli `-C` değerini döndürür.
fn git_c_base(args: &[String]) -> Option<PathBuf> {
    let mut base = PathBuf::new();
    let mut seen = false;
    let mut i = 0usize;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "--" || !a.starts_with('-') {
            break;
        }
        if a == "-C" {
            if let Some(v) = args.get(i + 1) {
                base = base.join(v);
                seen = true;
            }
            i += 2;
            continue;
        }
        if let Some(v) = a.strip_prefix("-C") {
            if !v.is_empty() {
                base = base.join(v);
                seen = true;
            }
            i += 1;
            continue;
        }
        if matches!(
            a,
            "-c" | "--git-dir"
                | "--work-tree"
                | "--config-env"
                | "--namespace"
                | "--super-prefix"
                | "--attr-source"
        ) {
            i += 2;
            continue;
        }
        i += 1;
    }
    if seen {
        Some(base)
    } else {
        None
    }
}

fn err(msg: impl Into<String>) -> String {
    msg.into()
}

#[derive(Debug, Serialize)]
pub struct ExecOut {
    /// Geriye uyumluluk: küçük çıktılarda ham stdout. Orta/hard çıktıda boştur.
    pub stdout: String,
    /// Geriye uyumluluk: küçük çıktılarda ham stderr. Orta/hard çıktıda boştur.
    pub stderr: String,
    /// Provider'a gönderilecek hazır çıktı payload'ı.
    pub output: String,
    /// Tam çıktı artifact'i (soft limit aşıldıysa).
    #[serde(default)]
    pub artifact: Option<ToolArtifact>,
    /// Çıktı hard sınırı aştı ve modele hiç içerik verilmedi.
    #[serde(default)]
    pub hard: bool,
    /// Boru drain zaman aşımı nedeniyle çıktının yalnızca bir kısmı yakalandı.
    #[serde(default)]
    pub capture_incomplete: bool,
    pub code: i32,
    pub truncated: bool,
    /// Kullanıcı `exec_cancel` ile süreci durdurdu.
    #[serde(default)]
    pub cancelled: bool,
    /// Süreç `timeout_ms` sınırını aştığı için durduruldu.
    #[serde(default)]
    pub timed_out: bool,
}

/// P0.2 — canlı exec akışı olayları (`Channel<ExecEvent>`).
/// `k` alanı TS tarafında ayrım için kullanılır: `stdout` / `stderr` / `exit`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "k", rename_all = "snake_case")]
pub enum ExecEvent {
    Stdout {
        data: String,
    },
    Stderr {
        data: String,
    },
    Exit {
        code: i32,
        truncated: bool,
        cancelled: bool,
        timed_out: bool,
    },
}

/// P0.2 — çalışan süreçlerin iptal kanalları.
///
/// `exec_cmd_stream` her çalıştırma için bir `watch` kanalı kaydeder;
/// `exec_cancel(run_id)` bu kanala `true` gönderir. Akış döngüsü sinyali
/// görünce `Child::start_kill` ile süreci sonlandırır ve `wait` ile reaping
/// yapar (zombie kalmaz).
#[derive(Default)]
pub struct ExecState {
    runs: Mutex<HashMap<String, watch::Sender<bool>>>,
}

impl ExecState {
    /// `false` → aynı `run_id` zaten çalışıyor; yeni kayıt eskisini ezmemeli
    /// (eski akışın iptal kanalı düşerdi).
    fn register(&self, run_id: &str, tx: watch::Sender<bool>) -> bool {
        if let Ok(mut runs) = self.runs.lock() {
            if runs.contains_key(run_id) {
                return false;
            }
            runs.insert(run_id.to_string(), tx);
            return true;
        }
        false
    }

    fn remove(&self, run_id: &str) {
        if let Ok(mut runs) = self.runs.lock() {
            runs.remove(run_id);
        }
    }

    fn cancel(&self, run_id: &str) -> bool {
        if let Ok(runs) = self.runs.lock() {
            if let Some(tx) = runs.get(run_id) {
                tx.send_replace(true);
                return true;
            }
        }
        false
    }
}

fn resolve_timeout(timeout_ms: Option<u64>) -> Duration {
    Duration::from_millis(
        timeout_ms
            .unwrap_or(TIMEOUT_SECS * 1000)
            .clamp(1000, MAX_TIMEOUT_MS),
    )
}

/// Capture dosyasından çıkarılan özet satırı için karakter sınırı.
const CAPTURE_SUMMARY_MAX_CHARS: usize = 512;

/// Exec stdout/stderr yakalama istatistikleri. Ham çıktı bir dosyaya yazılır;
/// bellekte yalnızca özet için gerekli ilk/son satırlar tutulur.
#[derive(Debug, Default, Clone)]
struct CaptureStats {
    bytes: u64,
    newlines: u64,
    ends_with_newline: bool,
    first: String,
    last: String,
}

impl CaptureStats {
    fn push(&mut self, bytes: &[u8], text: &str) {
        self.bytes += bytes.len() as u64;
        self.newlines += bytes.iter().filter(|b| **b == b'\n').count() as u64;
        self.ends_with_newline = bytes.last() == Some(&b'\n');
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            let bounded = if trimmed.chars().count() > CAPTURE_SUMMARY_MAX_CHARS {
                trimmed
                    .chars()
                    .take(CAPTURE_SUMMARY_MAX_CHARS)
                    .collect::<String>()
            } else {
                trimmed.to_string()
            };
            if self.first.is_empty() {
                self.first = bounded.clone();
            }
            self.last = bounded;
        }
    }
}

/// Pump görevi zaman aşımında iptal edilse bile istatistikler sıfırlanmaz.
/// Görev, her yazılan parçadan sonra paylaşılan durumu günceller.
type SharedCaptureStats = Arc<Mutex<CaptureStats>>;

fn new_shared_capture_stats() -> SharedCaptureStats {
    Arc::new(Mutex::new(CaptureStats::default()))
}

fn snapshot_capture_stats(shared: &SharedCaptureStats) -> CaptureStats {
    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// Canlı UI akışını hard sınırdan sonra durdurur. Dosya yakalamaya devam eder.
///
/// Eşik, modele giden `[exit ...]` başlığı ve stderr ayırıcısı da hesaba
/// katılarak uygulanır. Böylece canlı akışta geçen sınır, final payload'ının
/// sınırdan farklı bir ölçümde hard sayılmasına yol açmaz.
#[derive(Default)]
struct GateStream {
    bytes: u64,
    newlines: u64,
    ends_with_newline: bool,
}

#[derive(Default)]
struct StreamGateState {
    stdout: GateStream,
    stderr: GateStream,
}

impl StreamGateState {
    fn projected_bytes(&self) -> u64 {
        // Exit code'un uzunluğu sonucu bilinmeden değişebilir. Gerçek
        // başlık bu üst sınırın altında kaldığı için canlı akış sonradan hard
        // sınıra geçmez.
        const EXIT_HEADER_RESERVE_BYTES: u64 = 32;
        let stderr_marker = if self.stderr.bytes > 0 {
            exec_stderr_marker().len() as u64
        } else {
            0
        };
        EXIT_HEADER_RESERVE_BYTES + self.stdout.bytes + stderr_marker + self.stderr.bytes
    }

    fn projected_lines(&self) -> u64 {
        let has_stderr = self.stderr.bytes > 0;
        let newlines = 1
            + self.stdout.newlines
            + if has_stderr {
                2 + self.stderr.newlines
            } else {
                0
            };
        let ends_with_newline = if has_stderr {
            self.stderr.ends_with_newline
        } else if self.stdout.bytes > 0 {
            self.stdout.ends_with_newline
        } else {
            true
        };
        if ends_with_newline {
            newlines
        } else {
            newlines + 1
        }
    }
}

struct StreamGate {
    state: Mutex<StreamGateState>,
    hard_bytes: u64,
    hard_lines: u64,
}

impl StreamGate {
    fn new() -> Self {
        let policy = output_policy();
        Self {
            state: Mutex::new(StreamGateState::default()),
            hard_bytes: policy.hard_max_bytes,
            hard_lines: policy.hard_max_lines,
        }
    }

    fn allow(&self, is_stderr: bool, bytes: u64, newlines: u64, ends_with_newline: bool) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let stream = if is_stderr {
            &mut state.stderr
        } else {
            &mut state.stdout
        };
        stream.bytes += bytes;
        stream.newlines += newlines;
        stream.ends_with_newline = ends_with_newline;
        !(state.projected_bytes() > self.hard_bytes || state.projected_lines() >= self.hard_lines)
    }
}

fn next_capture_id() -> String {
    let counter = CAPTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos:x}-{counter:x}", std::process::id())
}

/// Süreç çıktısı geçici dosyaya yazılır. Dosya adı process/counter ile
/// çakışmaz; `create_new` yine de mevcut dosyayı ezmeyi engeller.
fn create_capture_file(name: &str, stream: &str) -> Result<(PathBuf, File), String> {
    let path = std::env::temp_dir().join(format!("macrocode-{name}.{stream}.tmp"));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(&path)
        .map_err(|e| err(format!("exec capture dosyası oluşturulamadı: {e}")))?;
    Ok((path, file))
}

/// İki geçici capture dosyasını birlikte yönetir. Drop, dosya tanıtıcılarını
/// kapattıktan sonra yolları siler; böylece `exec_cmd` içindeki her erken hata
/// yolunda temp dosya kalmaz.
struct CaptureFiles {
    stdout_path: PathBuf,
    stderr_path: Option<PathBuf>,
    stdout_file: Option<File>,
    stderr_file: Option<File>,
}

impl CaptureFiles {
    fn create(capture_id: &str) -> Result<(Self, File, File), String> {
        let (stdout_path, stdout_file) = create_capture_file(capture_id, "stdout")?;
        let mut captures = Self {
            stdout_path,
            stderr_path: None,
            stdout_file: Some(stdout_file),
            stderr_file: None,
        };

        match create_capture_file(capture_id, "stderr") {
            Ok((stderr_path, stderr_file)) => {
                captures.stderr_path = Some(stderr_path);
                captures.stderr_file = Some(stderr_file);
            }
            Err(e) => return Err(e),
        }

        let stdout_file = captures.stdout_file.take().expect("stdout capture missing");
        let stderr_file = captures.stderr_file.take().expect("stderr capture missing");
        Ok((captures, stdout_file, stderr_file))
    }

    fn stdout_path(&self) -> &Path {
        &self.stdout_path
    }

    fn stderr_path(&self) -> &Path {
        self.stderr_path.as_deref().expect("stderr capture missing")
    }
}

impl Drop for CaptureFiles {
    fn drop(&mut self) {
        // Windows'ta açık dosya silinemediği için handle'ları önce kapat.
        drop(self.stdout_file.take());
        drop(self.stderr_file.take());
        let _ = std::fs::remove_file(&self.stdout_path);
        if let Some(path) = self.stderr_path.as_deref() {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Boru okuyucusunu sınırlı süre bekler. Süreç ölmüş olsa bile torun bir
/// süreç boruyu açık tutabilir; bu durumda görev iptal edilir ve exec sonucu
/// yine döner. Zaman aşımında payload sıfırlanmaz: pump'ın paylaşılan
/// istatistikleri okuma sırasında güncellenmeye devam eder. `timed_out` ile
/// eksik yakalama modele açıkça bildirilir.
#[derive(Debug, Clone)]
struct PumpResult {
    stats: CaptureStats,
    timed_out: bool,
}

async fn collect_pump(
    task: tokio::task::JoinHandle<Result<(), String>>,
    shared: &SharedCaptureStats,
    stream: &str,
) -> Result<PumpResult, String> {
    collect_pump_with_timeout(task, shared, stream, DRAIN_TIMEOUT).await
}

async fn collect_pump_with_timeout(
    mut task: tokio::task::JoinHandle<Result<(), String>>,
    shared: &SharedCaptureStats,
    stream: &str,
    drain_timeout: Duration,
) -> Result<PumpResult, String> {
    match tokio::time::timeout(drain_timeout, &mut task).await {
        Ok(Ok(Ok(()))) => Ok(PumpResult {
            stats: snapshot_capture_stats(shared),
            timed_out: false,
        }),
        Ok(Ok(Err(e))) => Err(e),
        Ok(Err(e)) => Err(err(format!("{stream} okunamadı: {e}"))),
        Err(_) => {
            task.abort();
            let _ = task.await;
            Ok(PumpResult {
                stats: snapshot_capture_stats(shared),
                timed_out: true,
            })
        }
    }
}

async fn pump_exec<R>(
    mut reader: R,
    is_stderr: bool,
    channel: Option<Channel<ExecEvent>>,
    mut file: File,
    gate: Arc<StreamGate>,
    shared: SharedCaptureStats,
) -> Result<(), String>
where
    R: AsyncRead + Unpin,
{
    // `read_until` newline beklerken devasa tek satırları bellekte büyütürdü.
    // Sabit chunk'lar hem ham baytları güvenle dosyaya yazar hem de hard
    // eşikten sonra canlı içerik akışını sınırlar.
    let mut buffer = [0u8; 64 * 1024];
    let mut decoder = LossyUtf8Decoder::default();
    loop {
        let read = match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => read,
            Err(e) => return Err(err(format!("exec çıktısı okunamadı: {e}"))),
        };
        let chunk = &buffer[..read];
        file.write_all(chunk)
            .map_err(|e| err(format!("exec çıktısı yazılamadı: {e}")))?;

        // UI metni Unicode-safe olmalı; chunk sınırında çok baytlı karakter
        // bölünse bile sonraki chunk ile doğru birleştirilir.
        let mut text = String::new();
        decoder.decode(chunk, &mut |ch| text.push(ch));
        let newlines = chunk.iter().filter(|b| **b == b'\n').count() as u64;
        let ends_with_newline = chunk.last() == Some(&b'\n');
        {
            let mut stats = shared
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            stats.push(chunk, &text);
        }
        if gate.allow(is_stderr, read as u64, newlines, ends_with_newline) {
            if let Some(channel) = channel.as_ref() {
                let ev = if is_stderr {
                    ExecEvent::Stderr { data: text }
                } else {
                    ExecEvent::Stdout { data: text }
                };
                // WebView kapandıysa gönderim başarısız olur; süreç yine
                // tamamlanana kadar arka planda çalışır.
                let _ = channel.send(ev);
            }
        }
    }
    file.flush()
        .map_err(|e| err(format!("exec çıktısı flush edilemedi: {e}")))?;
    Ok(())
}

fn allow_table() -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let v: serde_json::Value =
        serde_json::from_str(ALLOWLIST_JSON).map_err(|e| err(format!("allowlist bozuk: {e}")))?;
    v.as_object()
        .cloned()
        .ok_or_else(|| err("allowlist obje değil"))
}

/// O7 — allowlist.json `_predicates` bölümü: komut başına "bu flagler keyfi
/// süreç başlatır" listesi (tek kaynak; TS `policy.ts` aynı tabloyu okur).
fn predicate_table() -> &'static serde_json::Map<String, serde_json::Value> {
    static TABLE: OnceLock<serde_json::Map<String, serde_json::Value>> = OnceLock::new();
    TABLE.get_or_init(|| {
        serde_json::from_str::<serde_json::Value>(ALLOWLIST_JSON)
            .ok()
            .and_then(|v| v.get("_predicates")?.as_object().cloned())
            .unwrap_or_default()
    })
}

/// O7 — serbest-argüman komutlarda komut-çalıştıran flagler reddedilir.
/// `find . -exec sh -c '…' \;` / `rg --pre 'cmd' pattern` keyfi süreç başlatır;
/// allowlist bu komutları salt-okunur gibi listeler, bu tablo o deliği kapatır.
/// Tam bayrak (`-exec`) ya da `=`-değerli biçim (`--pre=cmd`) eşleşir.
fn check_predicates(cmd: &str, args: &[String]) -> Result<(), String> {
    let Some(bad) = predicate_table().get(cmd.trim()).and_then(|v| v.as_array()) else {
        return Ok(());
    };
    let bads: Vec<&str> = bad.iter().filter_map(|f| f.as_str()).collect();
    if bads.is_empty() {
        return Ok(());
    }
    for a in args {
        for f in &bads {
            if a.as_str() == *f || a.starts_with(&format!("{f}=")) {
                return Err(err(format!(
                    "yasaklı argüman: {cmd} {a} · bu flag komut çalıştırabilir"
                )));
            }
        }
    }
    Ok(())
}

/// `rm` yalnızca `-i` ile; `-f`/`-r`/`-R`/`--force`/`--recursive` reddedilir.
fn is_rm_safe(args: &[String]) -> bool {
    if args.first().is_some_and(|a| a == "-i") {
        for a in &args[1..] {
            if *a == "--force" || *a == "--recursive" || *a == "--no-preserve-root" {
                return false;
            }
            if a.len() > 1
                && a.starts_with('-')
                && !a.starts_with("--")
                && a.chars()
                    .skip(1)
                    .any(|ch| ch == 'f' || ch == 'r' || ch == 'R')
            {
                return false;
            }
        }
        true
    } else {
        false
    }
}

/// Kullanıcının ayarlardan eklediği ek allowlist (TS `parseCustomAllowList` çıktısı).
/// Aynı biçim: `{ "<komut>": [["<arg0>"], ["<arg0>", "<arg1>"]] }` — boş liste = serbest argüman.
pub type ExtraAllow = serde_json::Map<String, serde_json::Value>;

/// `extra` tablosunda bir komutun izinli olup olmadığını kontrol eder.
/// Boş liste (serbest argüman) veya prefix eşleşmesi geçerli → true.
fn extra_allows(extra: &ExtraAllow, cmd: &str, args: &[String]) -> bool {
    let Some(entry) = extra.get(cmd) else {
        return false;
    };
    let Some(prefixes) = entry.as_array() else {
        return false;
    };
    if prefixes.is_empty() {
        return true;
    }
    prefixes.iter().any(|p| {
        p.as_array().is_some_and(|want| {
            want.iter().enumerate().all(|(i, w)| {
                w.as_str()
                    .is_some_and(|s| args.get(i).is_some_and(|a| a == s))
            })
        })
    })
}

/// O7 (Y2) — exec dosya argümanlarında **symlink çözümü** (senkron; `exec_cmd`
/// cwd jail'i çözüldükten sonra çağırır). `check_file_arg` string düzeyinde
/// çalışır; "creds -> ~/.ssh/id_ed25519" gibi workspace içi symlink'i
/// göremez (fs araçları bu kontrolü `resolve_rooted` içinde yapar, exec
/// deliyordu). Var olan hedef canonicalize edilip workspace (root yoksa cwd)
/// altında kalmak zorundadır; çözülen gerçek adlar da (case-insensitive)
/// blok listesinden geçer.
fn guard_file_args(
    dir: &std::path::Path,
    jail_base: &std::path::Path,
    cmd: &str,
    args: &[String],
) -> Result<(), String> {
    // M6: git için yol listesi `git_path_args`'tan gelir; `-C` operand
    // tabanını değiştirdiğinden canonical çözümleme o tabana göre yapılır.
    let (resolve_dir, paths): (PathBuf, Vec<String>) = if cmd == "git" {
        let resolve_dir = match git_c_base(args) {
            Some(rel) => {
                let canon = dir
                    .join(rel)
                    .canonicalize()
                    .map_err(|e| err(format!("git -C dizini geçersiz: {e}")))?;
                if !canon.starts_with(jail_base) {
                    return Err(err("git -C workspace dışına çıkıyor"));
                }
                canon
            }
            None => dir.to_path_buf(),
        };
        (resolve_dir, git_path_args(args))
    } else if cmd == "rm" {
        (
            dir.to_path_buf(),
            args.iter()
                .filter(|a| !a.starts_with('-'))
                .cloned()
                .collect(),
        )
    } else if FILE_ARG_CMDS.contains(&cmd) {
        (dir.to_path_buf(), file_path_args(cmd, args))
    } else {
        return Ok(());
    };
    for a in &paths {
        let v = a.trim().replace('\\', "/");
        if v.is_empty() {
            continue;
        }
        let joined = resolve_dir.join(&v);
        let Ok(canon) = joined.canonicalize() else {
            continue; // yok — string jail zaten desen/missing yoluna izin verir
        };
        if !canon.starts_with(jail_base) {
            return Err(err(format!(
                "argüman workspace dışına çıkıyor (symlink?): {a}"
            )));
        }
        // Çözülen gerçek yoldaki dosya/dizin adları da blok listesinden geçmeli.
        let rel = canon.strip_prefix(jail_base).unwrap_or(&canon);
        for comp in rel.components() {
            let name = comp.as_os_str().to_string_lossy();
            if name.is_empty() {
                continue;
            }
            if crate::commands::fs::is_blocked_dir(&name) {
                return Err(err(format!("yasaklı dizin argümanda: {a}")));
            }
            if crate::commands::fs::is_blocked_file_name(&name)
                || crate::commands::fs::is_env_prefixed(&name)
            {
                return Err(err(format!("yasaklı dosya argümanda: {a}")));
            }
            if crate::commands::fs::is_blocked_name_ext(&name) {
                return Err(err(format!("yasaklı dosya argümanda: {a}")));
            }
        }
    }
    Ok(())
}

fn check_cmd(
    cmd: &str,
    args: &[String],
    extra: &ExtraAllow,
    allow_unlisted: bool,
) -> Result<(), String> {
    let c = cmd.trim();
    if c.is_empty() {
        return Err(err("komut boş olamaz"));
    }
    // Tehlikeli argümanlar: shell operatörleri ve mutlak kaçışlar ham string olarak gelmemeli.
    // (args dizisi kullanıldığı için shell parse edilmez; yine de savunma amaçlı kontrol.)
    for a in args {
        if a.contains('\n') || a.contains('\0') {
            return Err(err("geçersiz argüman"));
        }
    }
    if c == "rm" {
        if !is_rm_safe(args) {
            return Err(err("yasaklı komut: rm yalnızca -i ile · -f/-r reddedilir"));
        }
        // O1: rm de dosya argümanı alır — jail dışı hedef satılamaz.
        for a in args.iter().filter(|a| !a.starts_with('-')) {
            check_file_arg(a)?;
        }
        return Ok(());
    }
    // O7: komut-çalıştıran flagler (`find -exec`, `rg --pre` …) — kullanıcı
    // ek allowlist'i de dahil HER yol geçemez (rm kuralıyla aynı sertlik).
    check_predicates(c, args)?;
    // L1 düzeltmesi: dosya argümanı jail'i `extra_allows` erken dönüşünden ÖNCE
    // çalışır. Eski sırayla kullanıcı `touch` gibi bir komutu serbest tanımlarsa
    // jail hiç çalışmıyor; mutlak yol / `../` / bloklu dosya doğrudan invoke
    // ile hedeflenebiliyordu (yerleşik tabloyla aynı sertlikte olmalı).
    if FILE_ARG_CMDS.contains(&c) {
        for a in file_path_args(c, args) {
            check_file_arg(&a)?;
        }
    }
    // M6 — git dosya argümanı jail'i. `git` eskiden `FILE_ARG_CMDS` dışındaydı:
    // `git diff --no-index /etc/passwd x` keyfi dosya okuyor, `git commit -F
    // /etc/passwd` dosyayı mesaj olarak okuyordu. `--exec-path` ise keyfi
    // `git-<altkomut>` programı çalıştırır → doğrudan reddedilir.
    if c == "git" {
        if args
            .iter()
            .any(|a| a == "--exec-path" || a.starts_with("--exec-path="))
        {
            return Err(err(
                "yasaklı argüman: git --exec-path · keyfi program çalıştırabilir",
            ));
        }
        for p in git_path_args(args) {
            check_file_arg(&p)?;
        }
    }
    let table = allow_table()?;
    // Kullanıcı açıkça onayladıysa allowlist kontrolü ATLANIR (yalnızca bu
    // çağrı için): izin listesinde olmayan komutlar da onay kartından
    // geçerek çalıştırılabilir. Yukarıdaki sert kontroller (rm kuralları,
    // komut-çalıştıran flag'ler, dosya argümanı jail'i) yine de geçerlidir.
    if allow_unlisted {
        return Ok(());
    }
    // Faz 8 L3: kullanıcının ek allowlist'i de geçerli (yerleşik tablo ile birleşik).
    if extra_allows(extra, c, args) {
        return Ok(());
    }
    // `_note`/`_predicates` meta anahtarları komut değildir.
    let entry = table.get(c).filter(|_| c != "_note" && c != "_predicates");
    match entry {
        None => {
            let mut cmds: Vec<&String> = table.keys().filter(|k| *k != "_note").collect();
            cmds.sort();
            Err(err(format!(
                "yasaklı komut: {c} · allowlist: {}",
                cmds.iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join("/")
            )))
        }
        Some(v) => {
            let prefixes = v.as_array().ok_or_else(|| err("allowlist biçimi bozuk"))?;
            // Dosya argümanı jail'i (FILE_ARG_CMDS) yukarıda, prefix'ten bağımsız
            // uygulandı; burada yalnızca allowlist prefix eşleşmesi kalır.
            // Boş liste: args serbest (ls/pwd/echo/eslint/pytest/…).
            if prefixes.is_empty() {
                return Ok(());
            }
            let ok = prefixes.iter().any(|p| {
                p.as_array().is_some_and(|want| {
                    want.iter().enumerate().all(|(i, w)| {
                        w.as_str()
                            .is_some_and(|s| args.get(i).is_some_and(|a| a == s))
                    })
                })
            });
            if ok {
                Ok(())
            } else {
                Err(err(format!("yasaklı argüman: {c} {}", args.join(" "))))
            }
        }
    }
}

/// M5 — cwd jail'i (test edilebilir, `exec_cmd`'den ayrı).
///
/// Sıra önemli: root canonical → cwd canonical → `is_dir` → `starts_with`
/// → bloklu bileşen denetimi. Eski kod root `Option` iken root verilmezse
/// tüm denetimi atlıyordu; artık her çağrı bu kapıdan geçer.
fn resolve_jailed_cwd(root: &str, cwd: &str) -> Result<(PathBuf, PathBuf), String> {
    let root_trimmed = root.trim();
    if root_trimmed.is_empty() {
        return Err(err("workspace root boş olamaz"));
    }
    let base = PathBuf::from(root_trimmed)
        .canonicalize()
        .map_err(|e| err(format!("workspace kökü geçersiz: {e}")))?;
    let cwd_trimmed = cwd.trim();
    if cwd_trimmed.is_empty() {
        return Err(err("cwd boş olamaz"));
    }
    let dir = PathBuf::from(cwd_trimmed)
        .canonicalize()
        .map_err(|e| err(format!("cwd geçersiz: {e}")))?;

    // M5 — cwd jail'i artık koşulsuz: canonical cwd workspace altında,
    // gerçekten bir dizin ve bloklu bileşen içermiyor olmalı. `.git` /
    // `.macrocode` gibi dizinlerde komut çalıştırmak (ör. `.git/hooks`)
    // argüman jail'ini atlatmanın dolaylı yoluydu.
    if !dir.is_dir() {
        return Err(err("cwd bir dizin değil"));
    }
    if !dir.starts_with(&base) {
        return Err(err("cwd workspace dışına çıkamaz"));
    }
    crate::commands::fs::check_rel_components(&base, &dir)?;
    Ok((base, dir))
}

/// P0.2 — güvenlik kapılarının tek ortak yolu (hem `exec_cmd` hem
/// `exec_cmd_stream` spawn'dan ÖNCE buradan geçer).
fn prepare_exec(
    cmd: &str,
    args: &[String],
    cwd: &str,
    root: &str,
    extra: &ExtraAllow,
    allow_unlisted: bool,
) -> Result<PathBuf, String> {
    check_cmd(cmd, args, extra, allow_unlisted)?;
    let (base, dir) = resolve_jailed_cwd(root, cwd)?;

    // O7 (Y2) — exec dosya argümanlarında **symlink çözümü**:
    // `check_file_arg` string düzeyinde çalışır; "creds -> ~/.ssh/id_ed25519"
    // gibi workspace içi symlink'i göremez (fs araçları bu kontrolü
    // `resolve_rooted` içinde yapar, exec deliyordu). Var olan hedef burada
    // canonicalize edilip workspace altında kalmak zorundadır.
    guard_file_args(&dir, &base, cmd.trim(), args)?;
    Ok(dir)
}

fn exec_header(code: i32) -> String {
    format!("[exit {code}]\n")
}

fn exec_stderr_marker() -> &'static str {
    "\n[stderr]\n"
}

/// Ham stdout/stderr'ın `[exit]`, stdout ve stderr biçimindeki toplam ölçüsü.
fn exec_total_size(code: i32, stdout: &CaptureStats, stderr: &CaptureStats) -> (u64, u64) {
    let header = exec_header(code);
    let marker = if stderr.bytes > 0 {
        exec_stderr_marker()
    } else {
        ""
    };
    let bytes = header.len() as u64 + stdout.bytes + marker.len() as u64 + stderr.bytes;
    let newlines = 1
        + stdout.newlines
        + if stderr.bytes > 0 {
            2 + stderr.newlines
        } else {
            0
        };
    let ends_with_newline = if stderr.bytes > 0 {
        stderr.ends_with_newline
    } else if stdout.bytes > 0 {
        stdout.ends_with_newline
    } else {
        true
    };
    let lines = if ends_with_newline {
        newlines
    } else {
        newlines + 1
    };
    (bytes, lines)
}

fn format_exec_text(code: i32, stdout: &str, stderr: &str) -> String {
    let mut out = format!("{}{stdout}", exec_header(code));
    if !stderr.is_empty() {
        out.push_str(exec_stderr_marker());
        out.push_str(stderr);
    }
    out
}

fn summarize_exec_stats(code: i32, stdout: &CaptureStats, stderr: &CaptureStats) -> String {
    let first = if stdout.first.is_empty() {
        &stderr.first
    } else {
        &stdout.first
    };
    let last = if stderr.last.is_empty() {
        &stdout.last
    } else {
        &stderr.last
    };
    let detail = if first.is_empty() && last.is_empty() {
        "Output is empty.".to_string()
    } else if first.is_empty() {
        format!("Last line: {last}")
    } else if last.is_empty() || first == last {
        format!("First/last line: {first}")
    } else {
        format!("First line: {first} Last line: {last}")
    };
    clamp_summary(
        &format!("Command exited with code {code}. {detail}"),
        output_policy().summary_max_chars,
    )
}

fn read_capture(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| err(format!("exec çıktısı okunamadı: {e}")))
}

/// UTF-8 baytlarını chunk sınırlarından bağımsız olarak lossy metne çevirir.
/// Böylece dosya istatistikleri taranırken geçersiz UTF-8 veya çok baytlı bir
/// karakterin chunk ortasında bölünmesi özet satırını bozmaz.
#[derive(Default)]
struct LossyUtf8Decoder {
    pending: Vec<u8>,
}

impl LossyUtf8Decoder {
    fn decode(&mut self, bytes: &[u8], emit: &mut impl FnMut(char)) {
        if bytes.is_empty() {
            return;
        }

        let mut combined = Vec::with_capacity(self.pending.len() + bytes.len());
        combined.extend_from_slice(&self.pending);
        combined.extend_from_slice(bytes);
        self.pending.clear();

        let mut offset = 0usize;
        while offset < combined.len() {
            match std::str::from_utf8(&combined[offset..]) {
                Ok(valid) => {
                    for ch in valid.chars() {
                        emit(ch);
                    }
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        let valid = std::str::from_utf8(&combined[offset..offset + valid_up_to])
                            .expect("valid UTF-8 prefix");
                        for ch in valid.chars() {
                            emit(ch);
                        }
                        offset += valid_up_to;
                    }
                    match error.error_len() {
                        Some(invalid_len) => {
                            emit(char::REPLACEMENT_CHARACTER);
                            offset += invalid_len;
                        }
                        None => {
                            self.pending.extend_from_slice(&combined[offset..]);
                            break;
                        }
                    }
                }
            }
        }
    }

    fn finish(&mut self, emit: &mut impl FnMut(char)) {
        if !self.pending.is_empty() {
            self.pending.clear();
            emit(char::REPLACEMENT_CHARACTER);
        }
    }
}

/// Bir capture satırının yalnızca ilk `CAPTURE_SUMMARY_MAX_CHARS` anlamlı
/// karakterini tutar. Satırın tamamı belleğe alınmaz; sonundaki whitespace
/// özetlenmiş satıra taşınmaz.
#[derive(Default)]
struct CaptureLineSummary {
    prefix: String,
    prefix_chars: usize,
    pending_whitespace: String,
    pending_whitespace_chars: usize,
    has_content: bool,
}

impl CaptureLineSummary {
    fn push_char(&mut self, ch: char) {
        if ch.is_whitespace() {
            if self.prefix_chars == 0 {
                return; // Satır başındaki whitespace `trim` ile atılır.
            }
            let remaining = CAPTURE_SUMMARY_MAX_CHARS.saturating_sub(self.prefix_chars);
            if self.pending_whitespace_chars < remaining {
                self.pending_whitespace.push(ch);
                self.pending_whitespace_chars += 1;
            }
            return;
        }

        self.has_content = true;
        if self.prefix_chars >= CAPTURE_SUMMARY_MAX_CHARS {
            return;
        }
        if !self.pending_whitespace.is_empty() {
            self.prefix.push_str(&self.pending_whitespace);
            self.prefix_chars += self.pending_whitespace_chars;
            self.pending_whitespace.clear();
            self.pending_whitespace_chars = 0;
        }
        if self.prefix_chars < CAPTURE_SUMMARY_MAX_CHARS {
            self.prefix.push(ch);
            self.prefix_chars += 1;
        }
    }

    fn finish_line(&mut self, stats: &mut CaptureStats) {
        if self.has_content {
            let bounded = self.prefix.clone();
            if stats.first.is_empty() {
                stats.first = bounded.clone();
            }
            stats.last = bounded;
        }
        self.prefix.clear();
        self.prefix_chars = 0;
        self.pending_whitespace.clear();
        self.pending_whitespace_chars = 0;
        self.has_content = false;
    }
}

/// Capture dosyasını sabit boyutlu chunk'larla tarar. Dosyadaki gerçek bayt,
/// newline, son satır ve ilk/son anlamlı satır bilgisi bu şekilde pump
/// görevi zaman aşımına uğramış olsa bile güvenilir biçimde elde edilir.
fn reconcile_capture_stats(path: &Path, _shared: &CaptureStats) -> Result<CaptureStats, String> {
    let mut file = File::open(path).map_err(|e| err(format!("exec çıktısı okunamadı: {e}")))?;
    let mut stats = CaptureStats::default();
    let mut line = CaptureLineSummary::default();
    let mut decoder = LossyUtf8Decoder::default();
    let mut buffer = [0u8; 64 * 1024];
    let mut last_byte = None;

    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| err(format!("exec çıktısı okunamadı: {e}")))?;
        if read == 0 {
            break;
        }
        stats.bytes += read as u64;
        let chunk = &buffer[..read];
        last_byte = chunk.last().copied();

        let mut segment_start = 0usize;
        for (index, byte) in chunk.iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            decoder.decode(&chunk[segment_start..index], &mut |ch| line.push_char(ch));
            stats.newlines += 1;
            decoder.finish(&mut |ch| line.push_char(ch));
            line.finish_line(&mut stats);
            segment_start = index + 1;
        }
        if segment_start < chunk.len() {
            decoder.decode(&chunk[segment_start..], &mut |ch| line.push_char(ch));
        }
    }

    decoder.finish(&mut |ch| line.push_char(ch));
    line.finish_line(&mut stats);
    stats.ends_with_newline = last_byte == Some(b'\n');
    Ok(stats)
}

/// Artifact yazarken gerçekten yazılan bayt ve satır sayısını sayar. Metadata
/// bu değerlerden üretilir; capture istatistikleriyle tahmin edilmez.
struct ArtifactCounter {
    file: File,
    bytes: u64,
    newlines: u64,
    last_byte: Option<u8>,
}

impl ArtifactCounter {
    fn new(file: File) -> Self {
        Self {
            file,
            bytes: 0,
            newlines: 0,
            last_byte: None,
        }
    }

    fn line_count(&self) -> u64 {
        if self.bytes == 0 {
            0
        } else if self.last_byte == Some(b'\n') {
            self.newlines
        } else {
            self.newlines.saturating_add(1)
        }
    }
}

impl Write for ArtifactCounter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self.file.write(buf)?;
        if written > 0 {
            let written_bytes = &buf[..written];
            self.bytes += written as u64;
            self.newlines += written_bytes.iter().filter(|byte| **byte == b'\n').count() as u64;
            self.last_byte = written_bytes.last().copied();
        }
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

/// stdout/stderr dosyalarını tek bir model artifact'ine kopyalar. Ham çıktı
/// belleğe alınmaz; bu yüzden hard sınırı aşan komutlar da güvenle saklanır.
fn write_exec_artifact(
    root: &str,
    code: i32,
    stdout_path: &Path,
    stderr_path: &Path,
    stdout: &CaptureStats,
    stderr: &CaptureStats,
) -> Result<ToolArtifact, String> {
    let name = new_artifact_name();
    let (artifact_path, artifact_file) = create_artifact_file(root, &name)?;
    let mut artifact = ArtifactCounter::new(artifact_file);
    let write_result = (|| -> Result<(), String> {
        artifact
            .write_all(exec_header(code).as_bytes())
            .map_err(|e| err(format!("artifact yazılamadı: {e}")))?;
        let mut source =
            File::open(stdout_path).map_err(|e| err(format!("exec stdout okunamadı: {e}")))?;
        io::copy(&mut source, &mut artifact)
            .map_err(|e| err(format!("artifact yazılamadı: {e}")))?;
        if stderr.bytes > 0 {
            artifact
                .write_all(exec_stderr_marker().as_bytes())
                .map_err(|e| err(format!("artifact yazılamadı: {e}")))?;
            let mut source =
                File::open(stderr_path).map_err(|e| err(format!("exec stderr okunamadı: {e}")))?;
            io::copy(&mut source, &mut artifact)
                .map_err(|e| err(format!("artifact yazılamadı: {e}")))?;
        }
        artifact
            .flush()
            .map_err(|e| err(format!("artifact flush edilemedi: {e}")))
    })();
    if let Err(e) = write_result {
        drop(artifact);
        let _ = std::fs::remove_file(&artifact_path);
        return Err(e);
    }

    let bytes = match artifact.file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(e) => {
            drop(artifact);
            let _ = std::fs::remove_file(&artifact_path);
            return Err(err(format!("artifact okunamadı: {e}")));
        }
    };
    let lines = artifact.line_count();
    debug_assert_eq!(artifact.bytes, bytes);
    drop(artifact);

    Ok(artifact_metadata(
        &name,
        bytes,
        lines,
        summarize_exec_stats(code, stdout, stderr),
    ))
}

fn artifact_error_detail(error: &str) -> String {
    let detail = clamp_summary(error, 240);
    if detail.is_empty() {
        "unknown error".to_string()
    } else {
        detail
    }
}

fn take_head_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn take_tail_chars(text: &str, max: usize) -> String {
    let skip = text.chars().count().saturating_sub(max);
    text.chars().skip(skip).collect()
}

/// Artifact yazılamadığında medium çıktı yine head/tail bilgisini korur; ancak
/// var olmayan bir artifact yolunu modele göstermez.
fn shape_medium_fallback(raw: &str, bytes: u64, lines: u64, error: &str) -> String {
    let policy = output_policy();
    let head = take_head_chars(raw, policy.head_chars);
    let tail = take_tail_chars(raw, policy.tail_chars);
    let total_chars = raw.chars().count();
    let omitted = total_chars
        .saturating_sub(head.chars().count())
        .saturating_sub(tail.chars().count());
    format!(
        "[tool output truncated; middle omitted]\n{head}\n[... {omitted} characters omitted; artifact unavailable; captured {bytes} bytes, {lines} lines ...]\n{tail}\nartifact_error={error}",
        error = artifact_error_detail(error),
    )
}

/// Hard fallback yalnızca metadata ve içerik dışı özet verir. Ham çıktının
/// ilk/son satırı bile modele sızmaz.
fn shape_hard_fallback(code: i32, bytes: u64, lines: u64, error: &str) -> String {
    let summary = clamp_summary(
        &format!(
            "Command exited with code {code}. Output exceeded hard limit ({bytes} bytes, {lines} lines); artifact could not be written."
        ),
        output_policy().summary_max_chars,
    );
    format!(
        "[tool output omitted; artifact unavailable]\nbytes={bytes}\nlines={lines}\nsummary={summary}\nartifact_error={error}",
        error = artifact_error_detail(error),
    )
}

fn mark_capture_incomplete(output: String, capture_incomplete: bool) -> String {
    if capture_incomplete {
        format!("{output}\ncapture_incomplete=true")
    } else {
        output
    }
}

/// Dosyadan yakalanmış exec çıktısını ortak model politikasından geçirir.
/// Küçük çıktı aynen döner; orta çıktı head/tail + artifact; hard çıktı ise
/// yalnızca artifact özetidir. Artifact yazma hatası komutun tamamını
/// başarısız yapmaz: medium head/tail, hard ise metadata/summary döner.
#[allow(clippy::too_many_arguments)]
fn finalize_exec_files(
    root: &str,
    code: i32,
    stdout_path: &Path,
    stderr_path: &Path,
    stdout: &CaptureStats,
    stderr: &CaptureStats,
    cancelled: bool,
    timed_out: bool,
    capture_incomplete: bool,
) -> Result<ExecOut, String> {
    let stdout = reconcile_capture_stats(stdout_path, stdout)?;
    let stderr = reconcile_capture_stats(stderr_path, stderr)?;
    let (total_bytes, total_lines) = exec_total_size(code, &stdout, &stderr);
    let policy = output_policy();
    let hard = total_bytes > policy.hard_max_bytes || total_lines >= policy.hard_max_lines;

    if hard {
        return Ok(
            match write_exec_artifact(root, code, stdout_path, stderr_path, &stdout, &stderr) {
                Ok(artifact) => ExecOut {
                    stdout: String::new(),
                    stderr: String::new(),
                    output: mark_capture_incomplete(shape_hard(&artifact), capture_incomplete),
                    artifact: Some(artifact),
                    hard: true,
                    capture_incomplete,
                    code,
                    truncated: true,
                    cancelled,
                    timed_out,
                },
                Err(e) => ExecOut {
                    stdout: String::new(),
                    stderr: String::new(),
                    output: mark_capture_incomplete(
                        shape_hard_fallback(code, total_bytes, total_lines, &e),
                        capture_incomplete,
                    ),
                    artifact: None,
                    hard: true,
                    capture_incomplete,
                    code,
                    truncated: true,
                    cancelled,
                    timed_out,
                },
            },
        );
    }

    let stdout_bytes = read_capture(stdout_path)?;
    let stderr_bytes = read_capture(stderr_path)?;
    let stdout_text = String::from_utf8_lossy(&stdout_bytes).into_owned();
    let stderr_text = String::from_utf8_lossy(&stderr_bytes).into_owned();
    let raw_text = format_exec_text(code, &stdout_text, &stderr_text);
    if raw_text.chars().count() > policy.soft_max_chars {
        return Ok(
            match write_exec_artifact(root, code, stdout_path, stderr_path, &stdout, &stderr) {
                Ok(artifact) => ExecOut {
                    stdout: String::new(),
                    stderr: String::new(),
                    output: mark_capture_incomplete(
                        shape_medium(&raw_text, &artifact),
                        capture_incomplete,
                    ),
                    artifact: Some(artifact),
                    hard: false,
                    capture_incomplete,
                    code,
                    truncated: true,
                    cancelled,
                    timed_out,
                },
                Err(e) => ExecOut {
                    stdout: String::new(),
                    stderr: String::new(),
                    output: mark_capture_incomplete(
                        shape_medium_fallback(&raw_text, total_bytes, total_lines, &e),
                        capture_incomplete,
                    ),
                    artifact: None,
                    hard: false,
                    capture_incomplete,
                    code,
                    truncated: true,
                    cancelled,
                    timed_out,
                },
            },
        );
    }

    Ok(ExecOut {
        stdout: stdout_text,
        stderr: stderr_text,
        output: mark_capture_incomplete(raw_text, capture_incomplete),
        artifact: None,
        hard: false,
        capture_incomplete,
        code,
        truncated: capture_incomplete,
        cancelled,
        timed_out,
    })
}

#[tauri::command]
pub async fn exec_cmd(
    cmd: String,
    args: Vec<String>,
    cwd: String,
    timeout_ms: Option<u64>,
    // M5: root artık ZORUNLU. Eskiden `Option` idi ve root verilmezse cwd
    // jail'i tamamen atlanıyordu (doğrudan invoke ile her dizinde komut).
    root: String,
    // Faz 8 L3: kullanıcı allowlist uzantısı (TS `parseCustomAllowList` çıktısı).
    extra_allow: Option<ExtraAllow>,
    // Kullanıcı açıkça onayladıysa allowlist kontrolü atlanır (yalnızca bu
    // çağrı için). TS katmanı yalnızca onay yolundan `true` geçirir.
    allow_unlisted: Option<bool>,
) -> Result<ExecOut, String> {
    let extra = extra_allow.unwrap_or_default();
    let dir = prepare_exec(
        &cmd,
        &args,
        &cwd,
        &root,
        &extra,
        allow_unlisted.unwrap_or(false),
    )?;

    let timeout = resolve_timeout(timeout_ms);
    let capture_id = next_capture_id();
    let (captures, stdout_file, stderr_file) = CaptureFiles::create(&capture_id)?;

    let mut child_cmd = tokio::process::Command::new(cmd.trim());
    proc_tree::configure_command(&mut child_cmd);
    child_cmd
        .args(&args)
        .current_dir(&dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = match child_cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            drop(stdout_file);
            drop(stderr_file);
            return Err(err(format!("komut çalıştırılamadı: {e}")));
        }
    };
    let mut tree = ProcTree::attach(&mut child);
    let Some(stdout_pipe) = child.stdout.take() else {
        tree.kill();
        drop(stdout_file);
        drop(stderr_file);
        return Err(err("stdout alınamadı"));
    };
    let Some(stderr_pipe) = child.stderr.take() else {
        tree.kill();
        drop(stdout_file);
        drop(stderr_file);
        return Err(err("stderr alınamadı"));
    };

    let gate = Arc::new(StreamGate::new());
    let stdout_shared = new_shared_capture_stats();
    let stderr_shared = new_shared_capture_stats();
    let stdout_task = tokio::spawn(pump_exec(
        stdout_pipe,
        false,
        None,
        stdout_file,
        gate.clone(),
        stdout_shared.clone(),
    ));
    let stderr_task = tokio::spawn(pump_exec(
        stderr_pipe,
        true,
        None,
        stderr_file,
        gate.clone(),
        stderr_shared.clone(),
    ));

    let (status_result, timed_out) = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => {
            tree.disarm();
            (Ok(status), false)
        }
        Ok(Err(e)) => {
            tree.kill();
            let _ = child.start_kill();
            (Err(err(format!("komut beklenemedi: {e}"))), false)
        }
        Err(_) => {
            tree.kill();
            let _ = child.start_kill();
            match child.wait().await {
                Ok(status) => {
                    tree.disarm();
                    (Ok(status), true)
                }
                Err(e) => (Err(err(format!("komut beklenemedi: {e}"))), true),
            }
        }
    };

    // İki pump da her durumda tamamlanır/iptal edilir. Böylece capture file
    // handle'ları kapanmadan RAII guard'ın temp dosyaları silmeye çalışması
    // engellenir ve hiçbir erken hata yolunda dosya kalmaz.
    let stdout_result = collect_pump(stdout_task, &stdout_shared, "stdout").await;
    let stderr_result = collect_pump(stderr_task, &stderr_shared, "stderr").await;

    let status = match status_result {
        Ok(status) => status,
        Err(e) => return Err(e),
    };
    let stdout_pump = match stdout_result {
        Ok(result) => result,
        Err(e) => return Err(e),
    };
    let stderr_pump = match stderr_result {
        Ok(result) => result,
        Err(e) => return Err(e),
    };
    let capture_incomplete = stdout_pump.timed_out || stderr_pump.timed_out;
    finalize_exec_files(
        &root,
        status.code().unwrap_or(-1),
        captures.stdout_path(),
        captures.stderr_path(),
        &stdout_pump.stats,
        &stderr_pump.stats,
        false,
        timed_out,
        capture_incomplete,
    )
}

/// P0.2 — canlı akışlı exec.
///
/// Güvenlik kapıları (`check_cmd`, cwd jail, symlink/dosya argümanı jail'i)
/// `prepare_exec` üzerinden **spawn'dan önce** aynen çalışır. Çıktı satır
/// satır `Channel<ExecEvent>` ile UI'a akar; nihai sonuç yine `ExecOut`'tur
/// (eski sözleşme korunur).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn exec_cmd_stream(
    run_id: String,
    cmd: String,
    args: Vec<String>,
    cwd: String,
    timeout_ms: Option<u64>,
    root: String,
    extra_allow: Option<ExtraAllow>,
    // Kullanıcı açıkça onayladıysa allowlist kontrolü atlanır (yalnızca bu
    // çağrı için). TS katmanı yalnızca onay yolundan `true` geçirir.
    allow_unlisted: Option<bool>,
    on_event: Channel<ExecEvent>,
    state: tauri::State<'_, ExecState>,
) -> Result<ExecOut, String> {
    let run_id = run_id.trim().to_string();
    if run_id.is_empty() || run_id.len() > 256 {
        return Err(err("geçersiz çalıştırma kimliği"));
    }
    let extra = extra_allow.unwrap_or_default();
    let dir = prepare_exec(
        &cmd,
        &args,
        &cwd,
        &root,
        &extra,
        allow_unlisted.unwrap_or(false),
    )?;
    let timeout = resolve_timeout(timeout_ms);

    // Kayıt spawn'dan ÖNCE: aynı kimlikle ikinci bir çalıştırma eskisinin
    // iptal kanalını ezmesin ve gereksiz süreç doğurmasın.
    let (tx, mut rx) = watch::channel(false);
    if !state.register(&run_id, tx) {
        return Err(err("çalıştırma kimliği zaten kullanımda"));
    }

    // Capture dosyaları süreç başlamadan önce oluşturulur. Böylece dosya
    // sistemi hatasında komut yanlışlıkla çalışmaz ve oluşabilecek her
    // stdout/stderr baytı yakalanmış olur.
    let capture_id = next_capture_id();
    let (captures, stdout_file, stderr_file) = match CaptureFiles::create(&capture_id) {
        Ok(value) => value,
        Err(error) => {
            state.remove(&run_id);
            return Err(error);
        }
    };

    let mut child_cmd = tokio::process::Command::new(cmd.trim());
    proc_tree::configure_command(&mut child_cmd);
    child_cmd
        .args(&args)
        .current_dir(&dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = match child_cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            drop(stdout_file);
            drop(stderr_file);
            state.remove(&run_id);
            return Err(err(format!("komut çalıştırılamadı: {e}")));
        }
    };
    // İptal/timeout'ta doğrudan child yerine tüm süreç ağacını durdur.
    let mut tree = ProcTree::attach(&mut child);
    let Some(stdout) = child.stdout.take() else {
        tree.kill();
        drop(stdout_file);
        drop(stderr_file);
        state.remove(&run_id);
        return Err(err("stdout alınamadı"));
    };
    let Some(stderr) = child.stderr.take() else {
        tree.kill();
        drop(stdout_file);
        drop(stderr_file);
        state.remove(&run_id);
        return Err(err("stderr alınamadı"));
    };

    // Kayıt sonrası HER çıkış yolunda state temizlenmeli (erken `?` dahil).
    let result = async {
        let gate = Arc::new(StreamGate::new());
        let stdout_shared = new_shared_capture_stats();
        let stderr_shared = new_shared_capture_stats();
        let stdout_task = tokio::spawn(pump_exec(
            stdout,
            false,
            Some(on_event.clone()),
            stdout_file,
            gate.clone(),
            stdout_shared.clone(),
        ));
        let stderr_task = tokio::spawn(pump_exec(
            stderr,
            true,
            Some(on_event.clone()),
            stderr_file,
            gate.clone(),
            stderr_shared.clone(),
        ));

        let started = std::time::Instant::now();
        let mut cancelled = false;
        let mut timed_out = false;
        let status_result = loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    // Süreç normal bitti; ağaç guard'ı artık drop'ta öldürmemeli.
                    tree.disarm();
                    break Ok(status);
                }
                Ok(None) => {}
                Err(e) => {
                    tree.kill();
                    let _ = child.start_kill();
                    break Err(err(format!("süreç durumu alınamadı: {e}")));
                }
            }
            if started.elapsed() >= timeout {
                timed_out = true;
                tree.kill();
                let _ = child.start_kill();
                break match child.wait().await {
                    Ok(status) => {
                        tree.disarm();
                        Ok(status)
                    }
                    Err(e) => Err(err(format!("süreç beklenemedi: {e}"))),
                };
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(40)) => {}
                changed = rx.changed() => {
                    if changed.is_err() || *rx.borrow() {
                        cancelled = true;
                        tree.kill();
                        let _ = child.start_kill();
                        break match child.wait().await {
                            Ok(status) => {
                                tree.disarm();
                                Ok(status)
                            }
                            Err(e) => Err(err(format!("süreç beklenemedi: {e}"))),
                        };
                    }
                }
            }
        };

        // Boru okuyucuları süreç ölünce EOF görür; burada reaping tamamlanır.
        // (Torun süreç boruyu açık tutarsa yine de asılı kalmayız.)
        // İki okuyucu da beklenir; biri hata verse bile diğeri boşta kalmaz.
        let out_result = collect_pump(stdout_task, &stdout_shared, "stdout").await;
        let err_result = collect_pump(stderr_task, &stderr_shared, "stderr").await;
        let status = status_result?;
        let out_pump = out_result?;
        let err_pump = err_result?;
        let capture_incomplete = out_pump.timed_out || err_pump.timed_out;
        let code = status.code().unwrap_or(-1);
        let out = finalize_exec_files(
            &root,
            code,
            captures.stdout_path(),
            captures.stderr_path(),
            &out_pump.stats,
            &err_pump.stats,
            cancelled,
            timed_out,
            capture_incomplete,
        )?;
        let _ = on_event.send(ExecEvent::Exit {
            code,
            truncated: out.truncated,
            cancelled,
            timed_out,
        });
        Ok(out)
    }
    .await;

    state.remove(&run_id);
    result
}

/// P0.2 — çalışan bir `exec_cmd_stream` sürecini iptal eder.
/// Bilinmeyen/tamamlanmış `run_id` için `false` döner (yarış durumu güvenli).
#[tauri::command]
pub fn exec_cancel(run_id: String, state: tauri::State<'_, ExecState>) -> bool {
    state.cancel(run_id.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// Ek allowlist olmadan kontrol (yerleşik tablo).
    fn check_cmd2(cmd: &str, args: &[String]) -> Result<(), String> {
        check_cmd(cmd, args, &serde_json::Map::new(), false)
    }

    /// P0.2 — timeout üst sınırı 600 sn'ye çıkarıldı; alt sınır 1 sn korunur.
    #[test]
    fn p02_timeout_clamp() {
        assert_eq!(resolve_timeout(Some(0)).as_millis(), 1000);
        assert_eq!(resolve_timeout(Some(999)).as_millis(), 1000);
        assert_eq!(resolve_timeout(Some(15_000)).as_millis(), 15_000);
        assert_eq!(resolve_timeout(Some(300_000)).as_millis(), 300_000);
        assert_eq!(resolve_timeout(Some(600_000)).as_millis(), 600_000);
        assert_eq!(resolve_timeout(Some(9_999_999)).as_millis(), 600_000);
        // Verilmezse eski varsayılan (15 sn) korunur.
        assert_eq!(resolve_timeout(None).as_millis(), 15_000);
    }

    /// P0.2 — iptal kaydı: bilinen id sinyal gönderir, temizlenen id false döner.
    #[test]
    fn p02_exec_state_cancel() {
        let state = ExecState::default();
        let (tx, rx) = watch::channel(false);
        assert!(state.register("kosu-1", tx));
        assert!(!*rx.borrow());
        assert!(state.cancel("kosu-1"));
        assert!(*rx.borrow());
        assert!(!state.cancel("bilinmeyen"));
        // Aynı kimlik ikinci kez kaydedilemez (mevcut kanal ezilmez).
        let (tx2, _rx2) = watch::channel(false);
        assert!(!state.register("kosu-1", tx2));
        state.remove("kosu-1");
        assert!(!state.cancel("kosu-1"));
    }

    /// P0.2 — `exec_cmd` artık `spawn + wait_with_output` kullanıyor; süreç
    /// ağacı guard'ı normal çıkışta disarme edilmeli ve çıktı korunmalı.
    #[cfg(unix)]
    #[test]
    fn p02_exec_cmd_spawn_yolu_calisir() {
        use std::fs;
        let base = std::env::temp_dir().join(format!("macrocode-p02-exec-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let root = base.to_string_lossy().to_string();

        let out = tauri::async_runtime::block_on(exec_cmd(
            "echo".to_string(),
            vec!["merhaba".to_string()],
            root.clone(),
            Some(5_000),
            root,
            None,
            None,
        ))
        .expect("echo çalışmalı");
        assert_eq!(out.code, 0);
        assert!(out.stdout.contains("merhaba"));
        assert!(!out.cancelled);
        assert!(!out.timed_out);
        let _ = fs::remove_dir_all(&base);
    }

    /// Exec çıktısı artık bellekte 8KB ile kırpılmaz: pump paylaşılan
    /// istatistikleri ve capture dosyasının gerçek boyutunu kullanır.
    #[test]
    fn p02_capture_stats_ham_ciktiyi_sayar() {
        let mut stats = CaptureStats::default();
        stats.push(b"ilk\n", "ilk\n");
        stats.push(b"son", "son");
        assert_eq!(stats.bytes, 7);
        assert_eq!(stats.newlines, 1);
        assert_eq!(stats.first, "ilk");
        assert_eq!(stats.last, "son");
        assert!(!stats.ends_with_newline);
    }

    fn stats_for_bytes(bytes: &[u8]) -> CaptureStats {
        let mut stats = CaptureStats::default();
        let text = String::from_utf8_lossy(bytes);
        stats.push(bytes, &text);
        stats
    }

    fn line_count(bytes: &[u8]) -> u64 {
        if bytes.is_empty() {
            return 0;
        }
        let newlines = bytes.iter().filter(|byte| **byte == b'\n').count() as u64;
        if bytes.last() == Some(&b'\n') {
            newlines
        } else {
            newlines + 1
        }
    }

    fn unique_test_id(prefix: &str) -> String {
        format!(
            "{prefix}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        )
    }

    #[test]
    fn pump_timeout_shared_stats_sifirlanmaz() {
        let shared = new_shared_capture_stats();
        {
            let mut stats = shared
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            stats.push(b"captured\n", "captured\n");
        }
        let result = tauri::async_runtime::block_on(async {
            let task = tokio::spawn(async { std::future::pending::<Result<(), String>>().await });
            collect_pump_with_timeout(task, &shared, "stdout", Duration::from_millis(10)).await
        })
        .expect("timeout istatistikleri dönmeli");
        assert!(result.timed_out);
        let stats = result.stats;
        assert_eq!(stats.bytes, 9);
        assert_eq!(stats.newlines, 1);
        assert_eq!(stats.first, "captured");
    }

    #[test]
    fn stream_gate_son_terminasyonlu_satiri_hard_sinirina_dahil_eder() {
        let gate = StreamGate::new();
        let limit = output_policy().hard_max_lines;
        // `limit - 2` newline + son terminasyonsuz satır, exit başlığıyla
        // birlikte tam `limit` mantıksal satır oluşturur.
        assert!(gate.allow(false, limit - 2, limit - 2, true));
        assert!(!gate.allow(false, 1, 0, false));
    }

    #[test]
    fn stream_gate_bayt_limiti_final_cikti_icin_erken_durur() {
        let gate = StreamGate::new();
        let limit = output_policy().hard_max_bytes;
        // Exit başlığı için ayrılan 32 baytlık üst sınır dahil edilir.
        assert!(gate.allow(false, limit - 32, 0, false));
        assert!(!gate.allow(false, 1, 0, false));
    }

    #[test]
    fn hard_esikleri_ve_stream_gate_final_olcumuyle_uyumlu() {
        let policy = output_policy();
        assert_eq!(policy.hard_max_bytes, 131_072);
        assert_eq!(policy.hard_max_lines, 20_000);

        // Bayt sınırı kesin değer: 131.072 byte hâlâ hard değildir,
        // 131.073 byte hard olur. Exit başlığı ölçüme dahildir.
        let header_bytes = exec_header(0).len() as u64;
        let exact_bytes = CaptureStats {
            bytes: policy.hard_max_bytes - header_bytes,
            ..CaptureStats::default()
        };
        let (exact_total, _) = exec_total_size(0, &exact_bytes, &CaptureStats::default());
        assert_eq!(exact_total, policy.hard_max_bytes);
        assert!(!(exact_total > policy.hard_max_bytes));

        let mut over_bytes = exact_bytes;
        over_bytes.bytes += 1;
        let (over_total, _) = exec_total_size(0, &over_bytes, &CaptureStats::default());
        assert_eq!(over_total, policy.hard_max_bytes + 1);
        assert!(over_total > policy.hard_max_bytes);

        // Satır sınırı 19.999/20.000 mantıksal satırdadır. Exit başlığı
        // bir satır eklediği için stdout'ta 19.998/19.999 newline vardır.
        let below_lines = CaptureStats {
            bytes: policy.hard_max_lines - 2,
            newlines: policy.hard_max_lines - 2,
            ends_with_newline: true,
            ..CaptureStats::default()
        };
        let (_, below_total_lines) = exec_total_size(0, &below_lines, &CaptureStats::default());
        assert_eq!(below_total_lines, policy.hard_max_lines - 1);
        assert!(below_total_lines < policy.hard_max_lines);

        let at_limit = CaptureStats {
            bytes: policy.hard_max_lines - 1,
            newlines: policy.hard_max_lines - 1,
            ends_with_newline: true,
            ..CaptureStats::default()
        };
        let (_, at_limit_lines) = exec_total_size(0, &at_limit, &CaptureStats::default());
        assert_eq!(at_limit_lines, policy.hard_max_lines);
        assert!(at_limit_lines >= policy.hard_max_lines);

        // Canlı akış 19.999 mantıksal satıra kadar izin verir; 20.000'e
        // ulaşan chunk artık model/UI akışına gönderilmez.
        let gate = StreamGate::new();
        assert!(gate.allow(
            false,
            policy.hard_max_lines - 2,
            policy.hard_max_lines - 2,
            true
        ));
        assert!(!gate.allow(false, 1, 1, true));
    }

    #[test]
    fn eksik_capture_modele_acikca_bildirilir() {
        let output = mark_capture_incomplete("partial output".to_string(), true);
        assert_eq!(output, "partial output\ncapture_incomplete=true");
        assert_eq!(
            mark_capture_incomplete("complete output".to_string(), false),
            "complete output"
        );
    }

    #[test]
    fn stderr_only_ve_artifact_hatasi_yollari_capture_durumunu_korur() {
        let base = std::env::temp_dir().join(unique_test_id("capture-paths"));
        std::fs::create_dir_all(&base).unwrap();
        let stdout_path = base.join("stdout.capture");
        let stderr_path = base.join("stderr.capture");
        std::fs::write(&stdout_path, b"").unwrap();
        std::fs::write(&stderr_path, b"warning only\n").unwrap();
        let empty = CaptureStats::default();
        let stderr_stats = stats_for_bytes(b"warning only\n");

        // stderr-only çıktı normaldir: stderr ayırıcısı korunur, ancak
        // capture_incomplete yalnızca gerçekten eksik yakalamada işaretlenir.
        let complete = finalize_exec_files(
            &base.to_string_lossy(),
            0,
            &stdout_path,
            &stderr_path,
            &empty,
            &stderr_stats,
            false,
            false,
            false,
        )
        .expect("stderr-only çıktı finalize edilmeli");
        assert!(complete.output.contains("[stderr]"));
        assert!(complete.output.contains("warning only"));
        assert!(!complete.output.contains("capture_incomplete=true"));
        assert!(!complete.capture_incomplete);

        // Drain timeout ya da başka bir eksik yakalama aynı işareti taşır.
        let incomplete = finalize_exec_files(
            &base.to_string_lossy(),
            0,
            &stdout_path,
            &stderr_path,
            &empty,
            &stderr_stats,
            false,
            false,
            true,
        )
        .expect("eksik stderr-only çıktı finalize edilmeli");
        assert!(incomplete.output.contains("capture_incomplete=true"));
        assert!(incomplete.capture_incomplete);
        assert!(incomplete.truncated);

        // Artifact yazılamayan medium yolunda da eksik capture işareti ve
        // hata açıklaması birlikte bulunmalıdır.
        let long_stdout = base.join("long.capture");
        std::fs::write(&long_stdout, "x".repeat(20_000)).unwrap();
        let long_stats = stats_for_bytes(&std::fs::read(&long_stdout).unwrap());
        let failed = finalize_exec_files(
            &base.join("missing-root").to_string_lossy(),
            0,
            &long_stdout,
            &stderr_path,
            &long_stats,
            &stderr_stats,
            false,
            false,
            true,
        )
        .expect("artifact hatası fallback üretmeli");
        assert!(failed.artifact.is_none());
        assert!(failed.output.contains("artifact_error="));
        assert!(failed.output.contains("capture_incomplete=true"));

        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn pump_newline_bulunmayan_buyuk_ciktiyi_tam_dosyaya_yazar() {
        use tokio::io::{duplex, AsyncWriteExt};

        let capture_id = unique_test_id("pump-large-line");
        let (path, file) = create_capture_file(&capture_id, "stdout").unwrap();
        let (mut writer, reader) = duplex(4_096);
        let payload = vec![b'x'; 300_000];
        let expected_len = payload.len() as u64;
        let producer = tokio::spawn(async move {
            writer.write_all(&payload).await.unwrap();
            writer.shutdown().await.unwrap();
        });

        pump_exec(
            reader,
            false,
            None,
            file,
            Arc::new(StreamGate::new()),
            new_shared_capture_stats(),
        )
        .await
        .unwrap();
        producer.await.unwrap();

        assert_eq!(std::fs::metadata(&path).unwrap().len(), expected_len);
        let stats = reconcile_capture_stats(&path, &CaptureStats::default()).unwrap();
        assert_eq!(stats.bytes, expected_len);
        assert_eq!(stats.newlines, 0);
        assert!(stats.first.starts_with('x'));
        assert!(stats.last.ends_with('x'));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn capture_dosyasindaki_20000_satir_timeout_sonrasi_hard_sayilir() {
        let base = std::env::temp_dir().join(unique_test_id("capture-lines"));
        std::fs::create_dir_all(&base).unwrap();
        let stdout_path = base.join("stdout.capture");
        let stderr_path = base.join("stderr.capture");
        let mut content = String::with_capacity(20_000 * 12);
        for index in 0..20_000usize {
            if index == 0 {
                content.push_str("FIRST-LINE");
            } else if index == 19_999 {
                content.push_str("LAST-LINE");
            } else {
                content.push_str("middle-line");
            }
            content.push('\n');
        }
        std::fs::write(&stdout_path, &content).unwrap();
        std::fs::write(&stderr_path, b"").unwrap();

        // Pump timeout sonrası shared state boş kalmış gibi davran.
        let stale_shared = CaptureStats::default();
        let actual = reconcile_capture_stats(&stdout_path, &stale_shared).unwrap();
        assert_eq!(actual.bytes, content.len() as u64);
        assert_eq!(actual.newlines, 20_000);
        assert!(actual.ends_with_newline);
        assert_eq!(actual.first, "FIRST-LINE");
        assert_eq!(actual.last, "LAST-LINE");

        let empty_stats = CaptureStats::default();
        let (_, artifact_lines) = exec_total_size(0, &actual, &empty_stats);
        assert!(artifact_lines >= output_policy().hard_max_lines);
        let out = finalize_exec_files(
            &base.to_string_lossy(),
            0,
            &stdout_path,
            &stderr_path,
            &stale_shared,
            &empty_stats,
            false,
            false,
            false,
        )
        .expect("dosyadaki satırlar finalizasyonda kullanılmalı");
        assert!(out.hard);
        let artifact = out.artifact.expect("hard artifact oluşmalı");
        assert_eq!(artifact.lines, artifact_lines);
        assert!(artifact.summary.contains("FIRST-LINE"));
        assert!(artifact.summary.contains("LAST-LINE"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn capture_files_raii_erken_hata_yolunda_temizlenir() {
        let capture_id = unique_test_id("capture-raii");
        let stdout_path = std::env::temp_dir().join(format!("macrocode-{capture_id}.stdout.tmp"));
        let stderr_path = std::env::temp_dir().join(format!("macrocode-{capture_id}.stderr.tmp"));
        std::fs::write(&stderr_path, b"engel").unwrap();

        // stderr capture oluşturulurken hata verirse stdout yine temizlenir.
        assert!(CaptureFiles::create(&capture_id).is_err());
        assert!(!stdout_path.exists());
        assert!(stderr_path.exists());
        let _ = std::fs::remove_file(stderr_path);

        let (captures, stdout_file, stderr_file) = CaptureFiles::create(&capture_id).unwrap();
        let stdout_path = captures.stdout_path().to_path_buf();
        let stderr_path = captures.stderr_path().to_path_buf();
        assert!(stdout_path.exists());
        assert!(stderr_path.exists());
        drop(stdout_file);
        drop(stderr_file);
        drop(captures);
        assert!(!stdout_path.exists());
        assert!(!stderr_path.exists());
    }

    #[test]
    fn artifact_metadata_gercek_dosyayla_ayni() {
        let base = std::env::temp_dir().join(unique_test_id("artifact-metadata"));
        std::fs::create_dir_all(&base).unwrap();
        let stdout_path = base.join("stdout.capture");
        let stderr_path = base.join("stderr.capture");
        let stdout = b"out line\n";
        let stderr = b"err line\n";
        std::fs::write(&stdout_path, stdout).unwrap();
        std::fs::write(&stderr_path, stderr).unwrap();
        let stdout_stats = stats_for_bytes(stdout);
        let stderr_stats = stats_for_bytes(stderr);

        let artifact = write_exec_artifact(
            &base.to_string_lossy(),
            7,
            &stdout_path,
            &stderr_path,
            &stdout_stats,
            &stderr_stats,
        )
        .expect("artifact yazılmalı");
        let artifact_bytes = std::fs::read(base.join(&artifact.path)).unwrap();
        assert_eq!(artifact.bytes, artifact_bytes.len() as u64);
        assert_eq!(artifact.lines, line_count(&artifact_bytes));
        assert_eq!(
            artifact.bytes,
            exec_total_size(7, &stdout_stats, &stderr_stats).0
        );
        assert_eq!(
            artifact.lines,
            exec_total_size(7, &stdout_stats, &stderr_stats).1
        );
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn artifact_yazma_hatasi_medium_head_tail_dondurur() {
        let base = std::env::temp_dir().join(unique_test_id("artifact-fallback-medium"));
        std::fs::create_dir_all(&base).unwrap();
        let stdout_path = base.join("stdout.capture");
        let stderr_path = base.join("stderr.capture");
        let content = format!(
            "HEAD-SENTINEL\n{}\nTAIL-SENTINEL\n",
            "x".repeat(output_policy().soft_max_chars + 100)
        );
        std::fs::write(&stdout_path, &content).unwrap();
        std::fs::write(&stderr_path, b"").unwrap();
        let stdout_stats = stats_for_bytes(content.as_bytes());
        let stderr_stats = stats_for_bytes(b"");

        let out = finalize_exec_files(
            &base.join("missing-root").to_string_lossy(),
            0,
            &stdout_path,
            &stderr_path,
            &stdout_stats,
            &stderr_stats,
            false,
            false,
            false,
        )
        .expect("artifact hatası komutu başarısız yapmamalı");
        assert!(!out.hard);
        assert!(out.truncated);
        assert!(out.artifact.is_none());
        assert!(out.output.contains("HEAD-SENTINEL"));
        assert!(out.output.contains("TAIL-SENTINEL"));
        assert!(out.output.contains("artifact unavailable"));
        assert!(out.output.contains("artifact_error="));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn artifact_yazma_hatasi_hard_ham_icerik_dondurmez() {
        let base = std::env::temp_dir().join(unique_test_id("artifact-fallback-hard"));
        std::fs::create_dir_all(&base).unwrap();
        let stdout_path = base.join("stdout.capture");
        let stderr_path = base.join("stderr.capture");
        let content = format!(
            "{}\nHARD-RAW-SENTINEL\n{}",
            "x".repeat(output_policy().hard_max_bytes as usize / 2),
            "y".repeat(output_policy().hard_max_bytes as usize / 2)
        );
        std::fs::write(&stdout_path, &content).unwrap();
        std::fs::write(&stderr_path, b"").unwrap();
        let stdout_stats = stats_for_bytes(content.as_bytes());
        let stderr_stats = stats_for_bytes(b"");

        let out = finalize_exec_files(
            &base.join("missing-root").to_string_lossy(),
            0,
            &stdout_path,
            &stderr_path,
            &stdout_stats,
            &stderr_stats,
            false,
            false,
            false,
        )
        .expect("artifact hatası komutu başarısız yapmamalı");
        assert!(out.hard);
        assert!(out.truncated);
        assert!(out.artifact.is_none());
        assert!(out.stdout.is_empty());
        assert!(out.stderr.is_empty());
        assert!(out.output.contains("bytes="));
        assert!(out.output.contains("lines="));
        assert!(out.output.contains("summary="));
        assert!(!out.output.contains("HARD-RAW-SENTINEL"));
        let _ = std::fs::remove_dir_all(base);
    }

    /// Kullanıcı allowlist'i: `{ "docker": [["ps"]] }`
    fn extra(pairs: &[(&str, &[&[&str]])]) -> ExtraAllow {
        let mut m = ExtraAllow::new();
        for (cmd, prefixes) in pairs {
            let arr: Vec<serde_json::Value> =
                prefixes.iter().map(|p| serde_json::json!(p)).collect();
            m.insert((*cmd).to_string(), serde_json::Value::Array(arr));
        }
        m
    }

    #[test]
    fn keyfi_calistirma_reddedilir() {
        assert!(check_cmd2("node", &args(&["-e", "1"])).is_err());
        assert!(check_cmd2("npx", &args(&["kotu-paket"])).is_err());
        assert!(check_cmd2("npm", &args(&["install"])).is_err());
        assert!(check_cmd2("npm", &args(&["exec", "kotu"])).is_err());
        assert!(check_cmd2("rm", &args(&["-rf", "/"])).is_err());
        assert!(check_cmd2("rm", &args(&["-i", "-rf", "dosya"])).is_err());
        assert!(check_cmd2("rm", &args(&["dosya"])).is_err());
        assert!(check_cmd2("", &args(&[])).is_err());
    }

    #[test]
    fn o1_dosya_argumani_jail() {
        // O1 (Faz 4): serbest-argüman komutlarında dosya operandsı jail içinde olmalı.
        assert!(check_cmd2("cat", &args(&["/etc/passwd"])).is_err());
        assert!(check_cmd2("cat", &args(&["../../.ssh/id_rsa"])).is_err());
        assert!(check_cmd2("cat", &args(&[".env"])).is_err());
        assert!(check_cmd2("cat", &args(&[".git/config"])).is_err());
        assert!(check_cmd2("find", &args(&["/"])).is_err());
        assert!(check_cmd2("find", &args(&[".."])).is_err());
        assert!(check_cmd2("ls", &args(&["/home"])).is_err());
        assert!(check_cmd2("touch", &args(&["../kacis.txt"])).is_err());
        assert!(check_cmd2("rg", &args(&["token", ".git"])).is_err());
        assert!(check_cmd2("head", &args(&["-n", "5", "/var/log/syslog"])).is_err());
        // Bloklu dosya uzantısı da düşer (read_file ile senkron).
        assert!(check_cmd2("cat", &args(&["sertifika.pem"])).is_err());
        // Normal kullanım etkilenmez.
        assert!(check_cmd2("cat", &args(&["src/app.ts"])).is_ok());
        assert!(check_cmd2("find", &args(&[".", "-name", "*.ts"])).is_ok());
        assert!(check_cmd2("rg", &args(&["desen", "src"])).is_ok());
        assert!(check_cmd2("cat", &args(&["-n", "src/a.ts"])).is_ok());
        // Desen bayraklarının değerleri yol gibi denetlenmez (yanlış ret).
        assert!(check_cmd2("rg", &args(&["--glob", "!**/.git/**", "token", "src"])).is_ok());
        assert!(check_cmd2("rg", &args(&["-g", "*.pem", "token"])).is_ok());
        assert!(check_cmd2("rg", &args(&["--glob=!**/node_modules/**", "token"])).is_ok());
        assert!(check_cmd2("find", &args(&[".", "-path", "*/node_modules/*", "-prune"])).is_ok());
        assert!(check_cmd2("find", &args(&[".", "-name", "*.pem"])).is_ok());
        // Glob'lu OPERAND muaf değildir: gizli dosya hedefi hâlâ reddedilir.
        assert!(check_cmd2("cat", &args(&["*.pem"])).is_err());
        assert!(check_cmd2("rg", &args(&["--glob", "*.ts", "token", ".git"])).is_err());
        // Bayraklar jail'e takılmaz.
        assert!(check_cmd2("ls", &args(&["-la"])).is_ok());
    }

    #[test]
    fn o1_rm_jail() {
        assert!(check_cmd2("rm", &args(&["-i", "/etc/hosts"])).is_err());
        assert!(check_cmd2("rm", &args(&["-i", "../disari.txt"])).is_err());
        assert!(check_cmd2("rm", &args(&["-i", ".env"])).is_err());
        assert!(check_cmd2("rm", &args(&["-i", "build/turetilmis.js"])).is_ok());
    }

    /// M6 — git dosya argümanı jail'i (string düzeyi; symlink/canonical
    /// denetimi `guard_file_args` içinde ayrıca yapılır).
    #[test]
    fn m6_git_dosya_argumani_jail() {
        // Workspace dışı / bloklu dosya okuma.
        assert!(check_cmd2("git", &args(&["diff", "--no-index", "/etc/passwd", "x"])).is_err());
        assert!(check_cmd2("git", &args(&["commit", "-F", "/etc/passwd"])).is_err());
        assert!(check_cmd2("git", &args(&["commit", "--file=/etc/passwd"])).is_err());
        assert!(check_cmd2("git", &args(&["show", "HEAD:.env"])).is_err());
        assert!(check_cmd2("git", &args(&["log", "--", ".env"])).is_err());
        assert!(check_cmd2("git", &args(&["diff", "--output=/tmp/x", "HEAD"])).is_err());
        assert!(check_cmd2("git", &args(&["add", ".ssh/id_rsa"])).is_err());
        assert!(check_cmd2("git", &args(&["add", "../disari.txt"])).is_err());
        assert!(check_cmd2("git", &args(&["-C", "../disari", "status"])).is_err());
        assert!(check_cmd2("git", &args(&["--git-dir=/etc", "status"])).is_err());
        assert!(check_cmd2("git", &args(&["--exec-path=/tmp", "status"])).is_err());
        // Meşru kullanım etkilenmez.
        assert!(check_cmd2("git", &args(&["status"])).is_ok());
        assert!(check_cmd2("git", &args(&["show", "HEAD:src/app.ts"])).is_ok());
        assert!(check_cmd2("git", &args(&["diff", "src/a.ts", "src/b.ts"])).is_ok());
        assert!(check_cmd2("git", &args(&["log", "--", "src"])).is_ok());
        // `-m` değeri mesajdır, yol değil — `..` içermesi reddedilmemeli.
        assert!(check_cmd2("git", &args(&["commit", "-m", "fix: ../tmp yolunu düzelt"])).is_ok());
        assert!(check_cmd2("git", &args(&["add", "src/app.ts"])).is_ok());
    }

    /// M6 — symlink ve `git -C` tabanı canonical jail'den geçer.
    #[cfg(unix)]
    #[test]
    fn m6_git_symlink_ve_c_jail() {
        use std::fs;
        let base = std::env::temp_dir().join(format!("macrocode-m6-{}", std::process::id()));
        let outside = std::env::temp_dir().join(format!("macrocode-m6-out-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(base.join("alt")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("gizli.txt"), "x").unwrap();
        std::os::unix::fs::symlink(outside.join("gizli.txt"), base.join("creds")).unwrap();
        std::os::unix::fs::symlink(&outside, base.join("alt").join("kacis")).unwrap();

        // `creds` symlink'i dışarıyı gösterir → reddedilir.
        assert!(guard_file_args(
            &base,
            &base,
            "git",
            &args(&["diff", "--no-index", "creds", "x"])
        )
        .is_err());
        // `-C alt` tabanı doğru çözülür: alt/kacis dışarıyı gösterir.
        assert!(guard_file_args(
            &base,
            &base,
            "git",
            &args(&["-C", "alt", "diff", "--no-index", "kacis", "x"])
        )
        .is_err());
        // Workspace içi normal yol geçer.
        assert!(guard_file_args(
            &base,
            &base,
            "git",
            &args(&["diff", "--no-index", "alt", "alt"])
        )
        .is_ok());
        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&outside);
    }

    /// M5 — cwd jail: root zorunlu, cwd canonical + `is_dir` + bloklu bileşen.
    #[test]
    fn m5_cwd_jail() {
        use std::fs;
        let base = std::env::temp_dir().join(format!("macrocode-m5-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("alt")).unwrap();
        fs::create_dir_all(base.join(".git")).unwrap();
        fs::write(base.join("dosya.txt"), "x").unwrap();
        let root = base.to_string_lossy().to_string();
        let sub = base.join("alt").to_string_lossy().to_string();
        let git = base.join(".git").to_string_lossy().to_string();
        let file = base.join("dosya.txt").to_string_lossy().to_string();

        // Normal kullanım: kök ve alt dizin.
        assert!(resolve_jailed_cwd(&root, &root).is_ok());
        assert!(resolve_jailed_cwd(&root, &sub).is_ok());
        // Bloklu dizin cwd olamaz (.git).
        assert!(resolve_jailed_cwd(&root, &git).is_err());
        // Workspace dışı (mutlak) cwd.
        assert!(resolve_jailed_cwd(&root, "/").is_err());
        // `..` ile kaçış canonicalize sonrası dışarıda kalır.
        assert!(resolve_jailed_cwd(&root, &format!("{sub}/../..")).is_err());
        // root/cwd boş olamaz.
        assert!(resolve_jailed_cwd("", &root).is_err());
        assert!(resolve_jailed_cwd(&root, "").is_err());
        // Dosya cwd olamaz.
        assert!(resolve_jailed_cwd(&root, &file).is_err());
        let _ = fs::remove_dir_all(&base);
    }

    /// M5 — workspace içindeki symlink dışarıyı gösteriyorsa cwd reddedilir.
    #[cfg(unix)]
    #[test]
    fn m5_cwd_symlink_escape_reddedilir() {
        use std::fs;
        let base = std::env::temp_dir().join(format!("macrocode-m5-link-{}", std::process::id()));
        let outside = std::env::temp_dir().join(format!("macrocode-m5-out-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&base).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, base.join("kacis")).unwrap();
        let root = base.to_string_lossy().to_string();
        let link = base.join("kacis").to_string_lossy().to_string();
        assert!(resolve_jailed_cwd(&root, &link).is_err());
        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&outside);
    }

    /// O7 — komut-çalıştıran flagler (`find -exec`, `rg --pre`) reddedilir;
    /// kullanıcı ek-allowlist'i boş (serbest) olsa bile geçemez.
    #[test]
    fn o7_komut_calistiran_flagler_reddedilir() {
        assert!(check_cmd2(
            "find",
            &args(&[".", "-name", "*.ts", "-exec", "sh", "-c", "id"])
        )
        .is_err());
        assert!(check_cmd2("find", &args(&[".", "-execdir", "rm", "-i", "{}", "+"])).is_err());
        assert!(check_cmd2("find", &args(&[".", "-ok", "sh", "{}", ";"])).is_err());
        assert!(check_cmd2("find", &args(&[".", "-okdir", "sh", "{}", ";"])).is_err());
        // `=`-değerli biçimler de yakalanır (find'ta biçimsiz ama savunma amaçlı).
        assert!(check_cmd2("rg", &args(&["--pre", "kotu.sh", "desen"])).is_err());
        assert!(check_cmd2("rg", &args(&["--pre=grep1", "desen"])).is_err());
        assert!(check_cmd2("rg", &args(&["--pre-glob", "*.txt", "desen"])).is_err());
        // Normal kullanım etkilenmez.
        assert!(check_cmd2("find", &args(&[".", "-name", "*.ts"])).is_ok());
        assert!(check_cmd2("rg", &args(&["desen", "-g", "*.ts"])).is_ok());
    }

    /// O7 — ek-allowlist (kullanıcı "find"i serbest tanımlasa bile) bu flagleri
    /// açamaz; predicate denetimi prefix eşleşmesinden ÖNCE çalışır.
    #[test]
    fn o7_ek_allowlist_predicateleri_asamaz() {
        let ex = extra(&[("find", &[&["-name"]]), ("rg", &[])]);
        assert!(check_cmd("find", &args(&["-name", "x", "-exec", "id"]), &ex, false).is_err());
        assert!(check_cmd("rg", &args(&["--pre", "kotu.sh", "d"]), &ex, false).is_err());
        // Temiz argümanlar yine geçer.
        assert!(check_cmd("find", &args(&["-name", "x"]), &ex, false).is_ok());
        assert!(check_cmd("rg", &args(&["desen"]), &ex, false).is_ok());
    }

    /// O7 senkronu — `rm` kısa bayrak kümesi char-üyeliğiyle denetlenir
    /// ("-1f" gibi regex'in kaçtığı biçimler de reddedilir; TS `isRmSafe` aynısı).
    #[test]
    fn o7_rm_bayrak_kumesi_char_uyeligi() {
        assert!(check_cmd2("rm", &args(&["-i", "-1f", "x"])).is_err());
        assert!(check_cmd2("rm", &args(&["-i", "-1r", "x"])).is_err());
        assert!(check_cmd2("rm", &args(&["-i", "-1", "x"])).is_ok());
    }

    /// O7 (Y2) — workspace içi symlink workspace dışına çıkarsa reddedilir:
    /// `cat .gizli/creds` string-jail'i geçer ama hedef jail dışındaysa
    /// canonicalize çözümüyle durdurulur.
    #[cfg(unix)]
    #[test]
    fn o7_exec_symlink_jail_disina_cikmaz() {
        use std::os::unix::fs::symlink;
        let kok = std::env::temp_dir().join(format!("mcode-exec-syml-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&kok);
        std::fs::create_dir_all(kok.join("ws/.gizli")).unwrap();
        // Jail DIŞI gerçek klasör (temp kökünde, ws dışında).
        std::fs::create_dir_all(kok.join("dis/ssh")).unwrap();
        std::fs::write(kok.join("dis/ssh/id_ed25519"), b"ab").unwrap();
        // ws içi symlink → jail dışı hedef.
        symlink(kok.join("dis/ssh/id_ed25519"), kok.join("ws/.gizli/creds")).unwrap();

        let ws = kok.join("ws");
        // root verilmediyse jail = cwd: symlink hedefi dışarı → reddedilir.
        let r1 = super::guard_file_args(&ws, &ws, "cat", &args(&[".gizli/creds"]));
        assert!(r1.is_err(), "symlink jail dışına çıkmamalı");

        // root daha genişse (jail = ws yerine temp kökü) symlink jail'i geçer;
        // bu kez çözülen GERÇEK yoldaki "id_ed25519" bloklu ad düşer.
        let r2 = super::guard_file_args(&ws, &kok, "cat", &args(&[".gizli/creds"]));
        assert!(
            r2.is_err(),
            "çözülen yoldaki bloklu ad (id_ed25519) reddedilmeli"
        );

        // String jail'de zaten yasak olan .env VARSA: çözülen yolda da düşer.
        std::fs::write(kok.join("ws/.env"), b"secret").unwrap();
        let r3 = super::guard_file_args(&ws, &ws, "cat", &args(&[".env"]));
        assert!(r3.is_err(), "string jail zaten reddeder");

        // Workspace İÇİ normal hedef: yine geçer (meşru akış bozulmaz).
        std::fs::write(kok.join("ws/ok.txt"), b"selam").unwrap();
        let r4 = super::guard_file_args(&ws, &ws, "cat", &args(&["ok.txt"]));
        assert!(r4.is_ok());

        // Desen (var olmayan yol): canonicalize başarısız → jail'e takılmaz.
        let r5 = super::guard_file_args(&ws, &ws, "find", &args(&[".", "-name", "*.ts"]));
        assert!(r5.is_ok());

        let _ = std::fs::remove_dir_all(&kok);
    }

    #[test]
    fn faz8_l3_kullanici_allowlisti_gecerer() {
        let ex = extra(&[("docker", &[&["ps"]]), ("mytool", &[])]);
        // Kullanıcının eklediği komut + prefix eşleşmesi → geçer.
        assert!(check_cmd("docker", &args(&["ps"]), &ex, false).is_ok());
        // Prefix eşleşmiyorsa reddedilir.
        assert!(check_cmd("docker", &args(&["rm", "-rf"]), &ex, false).is_err());
        // Boş liste = serbest argüman.
        assert!(check_cmd("mytool", &args(&["-x", "1"]), &ex, false).is_ok());
        // Ek tablo olmadan aynı komut reddedilir.
        assert!(check_cmd2("docker", &args(&["ps"])).is_err());
    }

    #[test]
    fn faz8_l3_yerlesik_ve_ek_tablo_birlestirilir() {
        // Yerleşik "npm" tablosu prefix eşleşmesi yapıyor; ek tablo da birleşir.
        let ex = extra(&[("npm", &[&["run", "build:ozel"]])]);
        assert!(check_cmd("npm", &args(&["run", "build"]), &ex, false).is_ok()); // yerleşik
        assert!(check_cmd("npm", &args(&["run", "build:ozel"]), &ex, false).is_ok()); // ek
        assert!(check_cmd("npm", &args(&["install"]), &ex, false).is_err());
    }

    /// L1 — kullanıcı ek-allowlist'i dosya argümanı jail'ini GEÇEMEZ
    /// (jail artık `extra_allows` erken dönüşünden önce çalışır).
    #[test]
    fn l1_ek_allowlist_dosya_argumani_jailini_asamaz() {
        let ex = extra(&[("touch", &[]), ("cat", &[])]);
        assert!(check_cmd("touch", &args(&["/etc/pwned"]), &ex, false).is_err());
        assert!(check_cmd("touch", &args(&["../kacis.txt"]), &ex, false).is_err());
        assert!(check_cmd("touch", &args(&[".env"]), &ex, false).is_err());
        assert!(check_cmd("cat", &args(&["../../.ssh/id_rsa"]), &ex, false).is_err());
        // Meşru kullanım etkilenmez.
        assert!(check_cmd("touch", &args(&["yeni.txt"]), &ex, false).is_ok());
        assert!(check_cmd("cat", &args(&["src/app.ts"]), &ex, false).is_ok());
    }

    /// H2 — dosya argümanı jail'i de büyük/küçük harf duyarlı (exec.rs daha
    /// önce yalnız çözülen yolu küçük harfe indiriyordu; ham seg'ler kaçıyordu).
    #[test]
    fn h2_dosya_argumani_jaili_buyuk_kucuk_harf_duyarsiz() {
        assert!(check_cmd2("cat", &args(&[".GIT/config"])).is_err());
        assert!(check_cmd2("cat", &args(&["KEYS.JSON"])).is_err());
        assert!(check_cmd2("cat", &args(&[".ENV.local"])).is_err());
        assert!(check_cmd2("ls", &args(&["Node_Modules"])).is_err());
        assert!(check_cmd2("cat", &args(&["src/app.ts"])).is_ok());
    }

    #[test]
    fn faz8_l3_ek_tablo_dangerous_komutlari_acmaz() {
        // `rm` ek tabloda olsa bile -f/-r reddedilir (kurallar değişmez).
        let ex = extra(&[("rm", &[&["-rf"]])]);
        assert!(check_cmd("rm", &args(&["-rf", "x"]), &ex, false).is_err());
    }

    /// Kullanıcı onayı: izin listesinde olmayan komut (ör. `bash`) onay
    /// kartından geçildiğinde çalıştırılabilir. Ancak sert kilitler
    /// (rm kuralları, komut-çalıştıran flag'ler, dosya argümanı jail'i)
    /// onayla da gevşemez.
    #[test]
    fn kullanici_onayi_izin_listesi_disi_komutu_acabilir() {
        let ex = extra(&[]);
        // Onaysız: reddedilir.
        assert!(check_cmd("bash", &args(&["-lc", "ls"]), &ex, false).is_err());
        // Onaylı: allowlist kontrolü atlanır.
        assert!(check_cmd("bash", &args(&["-lc", "ls"]), &ex, true).is_ok());
        // Prefix eşleşmeyen yerleşik komut da onayla açılır (ör. `cargo run`).
        assert!(check_cmd("cargo", &args(&["run"]), &ex, false).is_err());
        assert!(check_cmd("cargo", &args(&["run"]), &ex, true).is_ok());
        // Sert kilitler onayla da geçmez.
        assert!(check_cmd("rm", &args(&["-rf", "x"]), &ex, true).is_err());
        assert!(check_cmd("find", &args(&["-name", "x", "-exec", "id"]), &ex, true).is_err());
        assert!(check_cmd("rg", &args(&["--pre", "kotu.sh", "d"]), &ex, true).is_err());
        assert!(check_cmd("touch", &args(&["/etc/pwned"]), &ex, true).is_err());
    }

    #[test]
    fn izinli_prefixler_gecer() {
        assert!(check_cmd2("node", &args(&["--version"])).is_ok());
        assert!(check_cmd2("npx", &args(&["--version"])).is_ok());
        assert!(check_cmd2("npm", &args(&["--version"])).is_ok());
        assert!(check_cmd2("npm", &args(&["run", "build"])).is_ok());
        assert!(check_cmd2("npm", &args(&["run"])).is_ok()); // betiksiz `npm run` sadece listeler (salt-okunur)
        assert!(check_cmd2("npm", &args(&["test"])).is_ok());
        assert!(check_cmd2("cargo", &args(&["check"])).is_ok());
        assert!(check_cmd2("cargo", &args(&["clippy"])).is_ok());
        assert!(check_cmd2("cargo", &args(&["test", "--", "filtre"])).is_ok());
        assert!(check_cmd2("cargo", &args(&["run"])).is_err());
        assert!(check_cmd2("git", &args(&["status"])).is_ok());
        assert!(check_cmd2("git", &args(&["push"])).is_ok());
        assert!(check_cmd2("git", &args(&["add", "."])).is_ok());
        assert!(check_cmd2("ls", &args(&["-la"])).is_ok());
        assert!(check_cmd2("echo", &args(&["merhaba"])).is_ok());
        assert!(check_cmd2("rm", &args(&["-i", "dosya"])).is_ok());
        assert!(check_cmd2("pytest", &args(&["-k", "test_x"])).is_ok());
        assert!(check_cmd2("tsc", &args(&["--noEmit"])).is_ok());
        assert!(check_cmd2("go", &args(&["test", "./..."])).is_ok());
        assert!(check_cmd2("rg", &args(&["desen"])).is_ok());
        assert!(check_cmd2("pip", &args(&["install", "paket"])).is_ok());
        assert!(check_cmd2("pip", &args(&["uninstall", "paket"])).is_err());
    }
}
