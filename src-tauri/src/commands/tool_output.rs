//! Tool çıktısı artifact'leri ve ortak context politikası.
//!
//! TS tarafı `src/lib/engine/toolOutputPolicy.json` dosyasını import eder; Rust
//! aynı dosyayı `include_str!` ile gömer. Böylece iki tarafın eşikleri
//! kayamaz.

use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

const POLICY_JSON: &str = include_str!("../../../src/lib/engine/toolOutputPolicy.json");
const OUTPUT_DIR_NAME: &str = "tool-outputs";
const ARTIFACT_PREFIX: &str = "tool-output-";
const ARTIFACT_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

static ARTIFACT_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Çakışma olasılığı çok düşük, deterministik ve güvenli artifact adı üretir.
/// `create_new` yine de son savunma katmanıdır.
pub fn new_artifact_name() -> String {
    let n = ARTIFACT_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{ARTIFACT_PREFIX}{pid}-{nanos:x}-{n:x}.log")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutputPolicy {
    pub soft_max_chars: usize,
    pub head_chars: usize,
    pub tail_chars: usize,
    pub hard_max_bytes: u64,
    pub hard_max_lines: u64,
    pub summary_max_chars: usize,
}

static POLICY: OnceLock<ToolOutputPolicy> = OnceLock::new();

pub fn output_policy() -> &'static ToolOutputPolicy {
    POLICY.get_or_init(|| {
        serde_json::from_str(POLICY_JSON)
            .unwrap_or_else(|e| panic!("tool output policy JSON bozuk: {e}"))
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolArtifact {
    /// Artifact adı (`.log` uzantısı hariç).
    pub id: String,
    /// Workspace-relative yol.
    pub path: String,
    pub bytes: u64,
    pub lines: u64,
    pub summary: String,
}

fn err(msg: impl Into<String>) -> String {
    msg.into()
}

/// Unicode scalar değer sayısı.
pub fn char_count(text: &str) -> usize {
    text.chars().count()
}

/// Satır sayısı: Sondaki newline'ı saymayan son satırı da hesaba katar.
pub fn line_count_bytes(bytes: &[u8]) -> u64 {
    if bytes.is_empty() {
        return 0;
    }
    let newlines = bytes.iter().filter(|b| **b == b'\n').count() as u64;
    if bytes.last() == Some(&b'\n') {
        newlines
    } else {
        newlines + 1
    }
}

pub fn clamp_summary(text: &str, max: usize) -> String {
    one_line(text, max)
}

fn one_line(text: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut count = 0usize;
    let mut pending_space = false;
    let mut seen_content = false;
    let mut overflow = false;

    for ch in text.chars() {
        if ch.is_whitespace() {
            if seen_content {
                pending_space = true;
            }
            continue;
        }
        if pending_space {
            if count >= max {
                overflow = true;
                break;
            }
            out.push(' ');
            count += 1;
            pending_space = false;
        }
        if count >= max {
            overflow = true;
            break;
        }
        out.push(ch);
        count += 1;
        seen_content = true;
    }

    if !overflow {
        return out;
    }
    let mut bounded = out.chars().take(max - 1).collect::<String>();
    bounded.push('…');
    bounded
}

/// Deterministik özet: ilk/son anlamlı satırlar. Model çağrısı yapmaz.
pub fn summarize_text(text: &str) -> String {
    let mut first = None;
    let mut last = None;
    let mut meaningful_lines = 0usize;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let bounded = one_line(trimmed, 220);
        meaningful_lines += 1;
        if first.is_none() {
            first = Some(bounded.clone());
        }
        last = Some(bounded);
    }

    let (Some(first), Some(last)) = (first, last) else {
        return "Output is empty.".to_string();
    };
    if meaningful_lines == 1 || first == last {
        format!("First/last line: {first}")
    } else {
        format!("First line: {first} Last line: {last}")
    }
}

fn take_head(text: &str, max: usize) -> &str {
    if max == 0 {
        return "";
    }
    match text.char_indices().nth(max) {
        Some((idx, _)) => &text[..idx],
        None => text,
    }
}

fn take_tail(text: &str, max: usize) -> &str {
    if max == 0 {
        return "";
    }
    let total = text.chars().count();
    if total <= max {
        return text;
    }
    let skip = total - max;
    text.char_indices()
        .nth(skip)
        .map(|(idx, _)| &text[idx..])
        .unwrap_or("")
}

fn artifact_id(name: &str) -> String {
    name.strip_suffix(".log").unwrap_or(name).to_string()
}

pub fn artifact_rel_path(name: &str) -> String {
    format!(".macrocode/{OUTPUT_DIR_NAME}/{name}")
}

fn valid_artifact_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".log") else {
        return false;
    };
    let Some(suffix) = stem.strip_prefix(ARTIFACT_PREFIX) else {
        return false;
    };
    if suffix.is_empty() || stem.len() > 128 {
        return false;
    }
    stem.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn cleanup_old_artifacts(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !valid_artifact_name(&name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age > ARTIFACT_TTL {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn artifact_dir(root: &str) -> Result<PathBuf, String> {
    let base = super::fs::canonical_root(root)?;
    let dir = super::fs::jailed_macrocode_subdir(&base, OUTPUT_DIR_NAME)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| err(format!("artifact dizini oluşturulamadı: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let canon = dir
        .canonicalize()
        .map_err(|e| err(format!("artifact dizini okunamadı: {e}")))?;
    if !canon.starts_with(&base) {
        return Err(err("artifact dizini workspace dışında"));
    }
    cleanup_old_artifacts(&canon);
    Ok(canon)
}

fn create_new_artifact_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|e| err(format!("artifact dosyası oluşturulamadı: {e}")))
}

pub(crate) fn create_artifact_file(root: &str, name: &str) -> Result<(PathBuf, File), String> {
    if !valid_artifact_name(name) {
        return Err(err("geçersiz artifact adı"));
    }
    let dir = artifact_dir(root)?;
    let path = dir.join(name);
    let file = create_new_artifact_file(&path)?;
    Ok((path, file))
}

pub(crate) fn artifact_metadata(
    name: &str,
    bytes: u64,
    lines: u64,
    summary: String,
) -> ToolArtifact {
    ToolArtifact {
        id: artifact_id(name),
        path: artifact_rel_path(name),
        bytes,
        lines,
        summary,
    }
}

/// Ham tool çıktısını workspace içindeki güvenli artifact klasörüne yazar.
#[tauri::command]
pub fn store_tool_output(
    root: String,
    name: String,
    content: String,
) -> Result<ToolArtifact, String> {
    store_tool_output_bytes(&root, &name, content.as_bytes(), summarize_text(&content))
}

/// Exec de aynı artifact yazıcısını kullanır; ham baytları korur.
pub fn store_tool_output_bytes(
    root: &str,
    name: &str,
    bytes: &[u8],
    summary: String,
) -> Result<ToolArtifact, String> {
    let (path, mut file) = create_artifact_file(root, name)?;
    if let Err(e) = file.write_all(bytes) {
        let _ = std::fs::remove_file(&path);
        return Err(err(format!("artifact yazılamadı: {e}")));
    }
    if let Err(e) = file.flush() {
        let _ = std::fs::remove_file(&path);
        return Err(err(format!("artifact flush edilemedi: {e}")));
    }
    Ok(artifact_metadata(
        name,
        bytes.len() as u64,
        line_count_bytes(bytes),
        summary,
    ))
}

/// Orta çıktının model payload'ı: ilk N + son N karakter ve artifact bilgisi.
pub fn shape_medium(raw: &str, artifact: &ToolArtifact) -> String {
    let policy = output_policy();
    let head = take_head(raw, policy.head_chars);
    let tail = take_tail(raw, policy.tail_chars);
    let omitted = char_count(raw)
        .saturating_sub(char_count(head))
        .saturating_sub(char_count(tail));
    format!(
        "[tool output truncated; middle omitted]\n{head}\n[... {omitted} characters omitted; full output at {path} ({bytes} bytes, {lines} lines) ...]\n{tail}\nread_more=read_file(path=\"{path}\", offset=1, limit=200)",
        path = artifact.path,
        bytes = artifact.bytes,
        lines = artifact.lines,
    )
}

/// Hard çıktının model payload'ı: hiçbir ham içerik yok.
pub fn shape_hard(artifact: &ToolArtifact) -> String {
    let summary = one_line(&artifact.summary, output_policy().summary_max_chars);
    format!(
        "[tool output redirected to file; content omitted]\npath={path}\nbytes={bytes}\nlines={lines}\nsummary={summary}\nread_more=read_file(path=\"{path}\", offset=1, limit=200)",
        path = artifact.path,
        bytes = artifact.bytes,
        lines = artifact.lines,
    )
}

/// `read_file` için yalnızca yönetilen artifact alt yolunu tanır.
pub fn is_tool_output_rel(path: &str) -> bool {
    let normalized = path.trim().replace('\\', "/");
    let mut parts = normalized.split('/');
    matches!(parts.next(), Some(".macrocode"))
        && matches!(parts.next(), Some(OUTPUT_DIR_NAME))
        && parts.next().is_some_and(valid_artifact_name)
        && parts.next().is_none()
}

/// Artifact dosyasını workspace içinde, symlink dışı ve düzenli dosya olarak çözer.
pub fn resolve_tool_output_path(root: &str, rel: &str) -> Result<PathBuf, String> {
    if !is_tool_output_rel(rel) {
        return Err(err("geçersiz tool output artifact yolu"));
    }
    let normalized = rel.trim().replace('\\', "/");
    let name = normalized.rsplit('/').next().unwrap_or_default();
    let base = super::fs::canonical_root(root)?;
    let dir = artifact_dir(root)?;
    if !dir.starts_with(&base) {
        return Err(err("artifact dizini workspace dışında"));
    }
    let path = dir.join(name);
    let meta =
        std::fs::symlink_metadata(&path).map_err(|e| err(format!("artifact bulunamadı: {e}")))?;
    if !meta.file_type().is_file() {
        return Err(err("artifact düzenli dosya değil"));
    }
    let canon = path
        .canonicalize()
        .map_err(|e| err(format!("artifact okunamadı: {e}")))?;
    if !canon.starts_with(&dir) {
        return Err(err("artifact workspace dışında"));
    }
    Ok(canon)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_values_are_shared() {
        let p = output_policy();
        assert_eq!(p.soft_max_chars, 12_000);
        assert_eq!(p.head_chars, 4_000);
        assert_eq!(p.tail_chars, 2_000);
        assert_eq!(p.hard_max_bytes, 131_072);
        assert_eq!(p.hard_max_lines, 20_000);
    }

    #[test]
    fn artifact_path_accepts_only_managed_files() {
        assert!(is_tool_output_rel(
            ".macrocode/tool-outputs/tool-output-550e8400-e29b-41d4-a716-446655440000.log"
        ));
        assert!(!is_tool_output_rel(".macrocode/context.md"));
        assert!(!is_tool_output_rel(
            ".macrocode/tool-outputs/../../outside.log"
        ));
        assert!(!is_tool_output_rel("src/a.log"));
        assert!(!is_tool_output_rel(
            ".macrocode/tool-outputs/tool-output-.log"
        ));
        assert!(!is_tool_output_rel(
            ".macrocode/tool-outputs/tool-output-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.log"
        ));
    }

    #[test]
    fn store_tool_output_writes_exact_content_with_safe_permissions() {
        let base = std::env::temp_dir().join(format!(
            "macrocode-artifact-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&base).unwrap();
        let root = base.to_string_lossy().to_string();
        let content = "ilk satır\n😀 son satır\n";
        let artifact = store_tool_output(
            root.clone(),
            "tool-output-store-test.log".to_string(),
            content.to_string(),
        )
        .expect("artifact yazılmalı");

        assert_eq!(
            artifact.path,
            ".macrocode/tool-outputs/tool-output-store-test.log"
        );
        assert_eq!(artifact.bytes, content.as_bytes().len() as u64);
        assert_eq!(artifact.lines, 2);
        assert!(artifact.summary.contains("ilk satır"));
        assert!(artifact.summary.contains("son satır"));
        let written = std::fs::read_to_string(base.join(&artifact.path)).unwrap();
        assert_eq!(written, content);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file_mode = std::fs::metadata(base.join(&artifact.path))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            let dir_mode = std::fs::metadata(base.join(".macrocode/tool-outputs"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(file_mode, 0o600);
            assert_eq!(dir_mode, 0o700);
        }

        assert!(store_tool_output(root, "../outside.log".to_string(), "x".to_string(),).is_err());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn medium_shape_keeps_head_and_tail() {
        let raw = format!("{}MIDDLE{}", "a".repeat(6_000), "z".repeat(6_000));
        let artifact = ToolArtifact {
            id: "tool-output-test".to_string(),
            path: ".macrocode/tool-outputs/tool-output-test.log".to_string(),
            bytes: raw.len() as u64,
            lines: 1,
            summary: "test".to_string(),
        };
        let shaped = shape_medium(&raw, &artifact);
        assert!(shaped.contains("tool output truncated"));
        assert!(shaped.contains("read_more=read_file"));
        assert!(!shaped.contains("MIDDLE"));
    }
}
