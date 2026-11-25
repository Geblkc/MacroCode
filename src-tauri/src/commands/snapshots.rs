//! Proje / dosya anlık görüntüleri.
//!
//! Mevcut `undo_patch` yalnızca tek dosya bazlı geri almadır. Bu modül tüm
//! workspace'in (blok listelerine uyan) anlık görüntüsünü `.macrocode/snapshots`
//! altına yazar ve tek adımda geri yükler.
//!
//! Güvenlik ilkeleri (fs.rs ile aynı):
//! - Tüm yollar `canonical_root` / `resolve_rooted` jail'inden geçer.
//! - `blocks.json` tek kaynağıdır (`.git`, `node_modules`, `.env*`, secret uzantılar…).
//! - Symlink'ler ne takip edilir ne de kopyalanır.
//! - Manifest/workspace içinde yaşar → her alan doğrulanmadan kullanılmaz.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use super::fs::{
    atomic_write_exclusive, canonical_root, is_blocked_dir, is_blocked_ext, is_blocked_file_name,
    is_env_prefixed, jailed_macrocode_subdir, resolve_rooted,
};

const SNAPSHOTS_SUBDIR: &str = "snapshots";
const MANIFEST_FILE: &str = "manifest.json";
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 50 * 1024 * 1024;
const MAX_FILES: usize = 5000;
const MAX_DEPTH: usize = 64;

/// Aynı anda birden fazla create/restore/delete çalışmasın (manifest yarışı).
static OP_LOCK: Mutex<()> = Mutex::new(());
static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

fn err(msg: impl Into<String>) -> String {
    msg.into()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn new_id() -> String {
    let n = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{:x}-{:04x}", now_ms(), std::process::id(), n as u16)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SnapshotFile {
    /// Workspace-göreli, `/` ayraclı yol.
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SnapshotInfo {
    pub id: String,
    pub label: String,
    pub created_at: u64,
    pub file_count: usize,
    pub total_bytes: u64,
    pub files: Vec<SnapshotFile>,
    /// Adı uygun olup içeriği (binary / 1MB üstü) nedeniyle kopyalanmayan dosyalar.
    /// Geri yüklemede bunlara DOKUNULMAZ — aksi halde kopyalanmayan dosya
    /// "snapshot sonrası eklenmiş" sanılıp silinirdi.
    #[serde(default)]
    pub excluded: Vec<String>,
}

#[derive(Clone)]
struct WalkFile {
    rel: String,
    full: PathBuf,
    bytes: u64,
}

/// Manifest'ten / kullanıcıdan gelen göreli yolun tek bileşenini doğrular.
/// `safe_backup_name`'den farkı: boşluk ve unicode'u kabul eder (gerçek repo
/// dosya adları), sadece yol ayıracı, `.`/`..`, NUL ve kontrol karakterlerini reddeder.
fn safe_rel_component(seg: &str) -> Result<(), String> {
    if seg.is_empty() || seg == "." || seg == ".." {
        return Err(err("geçersiz yol bileşeni"));
    }
    if seg.contains('/') || seg.contains('\\') || seg.contains('\0') {
        return Err(err("yol bileşeni ayraç içeremez"));
    }
    if seg.chars().any(|c| c.is_control()) {
        return Err(err("yol bileşeni kontrol karakteri içeremez"));
    }
    Ok(())
}

fn rel_to_path(rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().replace('\\', "/");
    if rel.is_empty() || rel.starts_with('/') {
        return Err(err("mutlak veya boş yol yasak"));
    }
    let mut out = PathBuf::new();
    for seg in rel.split('/') {
        safe_rel_component(seg)?;
        out.push(seg);
    }
    Ok(out)
}

/// `dir_canon` (canonical, doğrulanmış) altındaki bir yolu çözer.
/// Var olan hedef symlink dışarıyı gösteriyorsa reddeder; yoksa parent'ı
/// canonicalize edip yeniden jail denetimi yapar (create_dir_all sonrası).
fn inside(dir_canon: &Path, rel: &str) -> Result<PathBuf, String> {
    let candidate = dir_canon.join(rel_to_path(rel)?);
    match candidate.canonicalize() {
        Ok(canon) if canon.starts_with(dir_canon) => Ok(canon),
        Ok(_) => Err(err("hedef dizin dışına çıkılamaz (symlink?)")),
        Err(_) => {
            if let Some(parent) = candidate.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| err(format!("dizin oluşturulamadı: {e}")))?;
                let canon_parent = parent
                    .canonicalize()
                    .map_err(|e| err(format!("dizin okunamadı: {e}")))?;
                if !canon_parent.starts_with(dir_canon) {
                    return Err(err("hedef dizin dışına çıkılamaz (symlink?)"));
                }
                Ok(canon_parent.join(
                    candidate
                        .file_name()
                        .ok_or_else(|| err("geçersiz dosya adı"))?,
                ))
            } else {
                Ok(candidate)
            }
        }
    }
}

fn is_binary(path: &Path) -> bool {
    let Ok(mut f) = fs::File::open(path) else {
        return true;
    };
    let mut buf = [0u8; 8192];
    let n = f.read(&mut buf).unwrap_or(0);
    buf[..n].contains(&0)
}

/// Ad bazlı filtre (dizinler ve dosyalar). Blok listesi tek kaynaktır.
fn eligible_name(name: &str, is_dir: bool) -> bool {
    if name == ".DS_Store" || is_blocked_dir(name) {
        return false;
    }
    if is_dir {
        return true;
    }
    !is_blocked_file_name(name) && !is_env_prefixed(name) && !is_blocked_ext(Path::new(name))
}

/// Workspace'i rekreasyon sırasıyla (deterministik) tarar.
fn collect(
    base: &Path,
    dir: &Path,
    prefix: &str,
    depth: usize,
    out: &mut Vec<WalkFile>,
    excluded: &mut Vec<String>,
) -> Result<(), String> {
    if depth > MAX_DEPTH || out.len() >= MAX_FILES {
        return Err(err(
            "snapshot limiti aşıldı (dosya sayısı / dizin derinliği)",
        ));
    }
    let rd = fs::read_dir(dir).map_err(|e| err(format!("dizin okunamadı: {e}")))?;
    let mut entries: Vec<_> = rd.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue; // non-UTF8 ad: güvenli biçimde atla
        };
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue; // jail kaçışı: symlink ne takip ne kopyalanır
        }
        if !eligible_name(&name, meta.is_dir()) {
            continue;
        }
        let rel = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        if meta.is_dir() {
            collect(base, &path, &rel, depth + 1, out, excluded)?;
        } else if meta.is_file() {
            if is_binary(&path) || meta.len() > MAX_FILE_BYTES {
                excluded.push(rel);
                continue;
            }
            // Son jail denetimi: manifest yolu daha sonra aynı kuralla çözülecek.
            if resolve_rooted(base.to_string_lossy().as_ref(), &rel).is_err() {
                excluded.push(rel);
                continue;
            }
            out.push(WalkFile {
                rel,
                full: path,
                bytes: meta.len(),
            });
        }
    }
    Ok(())
}

fn read_manifest(snap_dir: &Path, base: &Path) -> Result<Vec<SnapshotInfo>, String> {
    let candidate = snap_dir.join(MANIFEST_FILE);
    if !candidate.exists() {
        return Ok(Vec::new());
    }
    let canon = candidate
        .canonicalize()
        .map_err(|e| err(format!("snapshot manifest'i okunamadı: {e}")))?;
    if !canon.starts_with(base) {
        return Err(err("snapshot manifest'i workspace dışında (symlink?)"));
    }
    let raw = fs::read_to_string(&canon).map_err(|e| err(format!("manifest okunamadı: {e}")))?;
    serde_json::from_str(&raw).map_err(|e| err(format!("snapshot manifest'i bozuk: {e}")))
}

fn write_manifest(snap_dir: &Path, base: &Path, list: &[SnapshotInfo]) -> Result<(), String> {
    let canon_dir = snap_dir
        .canonicalize()
        .map_err(|e| err(format!("snapshot dizini okunamadı: {e}")))?;
    if !canon_dir.starts_with(base) {
        return Err(err("snapshot dizini workspace dışında (symlink?)"));
    }
    let target = canon_dir.join(MANIFEST_FILE);
    let json =
        serde_json::to_string_pretty(list).map_err(|e| err(format!("manifest yazılamadı: {e}")))?;
    // B1: manifest de rastgele ad + O_EXCL ile yazılır (symlink takibi yok).
    atomic_write_exclusive(&target, json.as_bytes())
        .map_err(|e| err(format!("manifest yazılamadı: {e}")))?;
    Ok(())
}

fn sanitize_label(label: String) -> String {
    let cleaned: String = label
        .trim()
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    cleaned.chars().take(60).collect()
}

/// Snapshot klasörünü yazar ve manifest'e ekler (manifest DISK'E yazılmaz;
/// çağıran tek seferde yazar — pre-restore güvenlik kopyasıyla birlikte).
fn build_snapshot(
    base: &Path,
    root: &str,
    snap_dir: &Path,
    label: String,
    manifest: &mut Vec<SnapshotInfo>,
) -> Result<SnapshotInfo, String> {
    let mut files = Vec::new();
    let mut excluded = Vec::new();
    collect(base, base, "", 0, &mut files, &mut excluded)?;
    let total_bytes: u64 = files.iter().map(|f| f.bytes).sum();
    if files.len() > MAX_FILES || total_bytes > MAX_TOTAL_BYTES {
        return Err(err(
            "proje snapshot limitini aşıyor (5000 dosya / 50MB) · büyük dizinleri dışarıda bırak",
        ));
    }

    let info = SnapshotInfo {
        id: new_id(),
        label: sanitize_label(label),
        created_at: now_ms(),
        file_count: files.len(),
        total_bytes,
        files: files
            .iter()
            .map(|f| SnapshotFile {
                path: f.rel.clone(),
                bytes: f.bytes,
            })
            .collect(),
        excluded,
    };

    let dest = snap_dir.join(&info.id);
    let result = (|| -> Result<(), String> {
        fs::create_dir_all(&dest)
            .map_err(|e| err(format!("snapshot dizini oluşturulamadı: {e}")))?;
        let dest_canon = dest
            .canonicalize()
            .map_err(|e| err(format!("snapshot dizini okunamadı: {e}")))?;
        if !dest_canon.starts_with(base) {
            return Err(err("snapshot dizini workspace dışında (symlink?)"));
        }
        for f in &files {
            let target = inside(&dest_canon, &f.rel)?;
            // B1: `fs::copy` symlink'i takip ederdi; snapshot dizinindeki
            // önceden kurulmuş bir symlink hedefi dışarıya yazdırabilirdi.
            let bytes =
                fs::read(&f.full).map_err(|e| err(format!("dosya okunamadı ({}): {e}", f.rel)))?;
            atomic_write_exclusive(&target, &bytes)
                .map_err(|e| err(format!("dosya kopyalanamadı ({}): {e}", f.rel)))?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&dest); // yarım snapshot bırakma
    }
    result?;

    manifest.push(info.clone());
    let _ = root; // root yalnızca jail çağrılarında kullanılıyor (collect içinde base)
    Ok(info)
}

/// B1 — geri yükleme yazımı: tek kaynak `fs::atomic_write_exclusive`
/// (rastgele ad + O_EXCL + rename). Eski `{name}.tmp-snap-{id}` adı
/// öngörülebilirdi ve `fs::write` mevcut symlink'i takip ederdi.
fn write_atomic(dst: &Path, bytes: &[u8]) -> Result<(), String> {
    atomic_write_exclusive(dst, bytes).map_err(|e| format!("geri yükleme yazılamadı: {e}"))
}

/// Yeni anlık görüntü oluşturur.
#[tauri::command]
pub async fn create_snapshot(root: String, label: Option<String>) -> Result<SnapshotInfo, String> {
    let _guard = OP_LOCK
        .lock()
        .map_err(|_| err("snapshot kilidi alınamadı"))?;
    let base = canonical_root(&root)?;
    let snap_dir = jailed_macrocode_subdir(&base, SNAPSHOTS_SUBDIR)?;
    fs::create_dir_all(&snap_dir)
        .map_err(|e| err(format!("snapshot dizini oluşturulamadı: {e}")))?;
    let mut manifest = read_manifest(&snap_dir, &base)?;
    let info = build_snapshot(
        &base,
        &root,
        &snap_dir,
        label.unwrap_or_default(),
        &mut manifest,
    )?;
    write_manifest(&snap_dir, &base, &manifest)?;
    Ok(info)
}

/// Kayıtlı anlık görüntüleri listeler (dosya listesi IPC'yi küçültmek için boşaltılır).
#[tauri::command]
pub async fn list_snapshots(root: String) -> Result<Vec<SnapshotInfo>, String> {
    let _guard = OP_LOCK
        .lock()
        .map_err(|_| err("snapshot kilidi alınamadı"))?;
    let base = canonical_root(&root)?;
    let snap_dir = jailed_macrocode_subdir(&base, SNAPSHOTS_SUBDIR)?;
    if !snap_dir.exists() {
        return Ok(Vec::new());
    }
    let mut list = read_manifest(&snap_dir, &base)?;
    for s in &mut list {
        s.files.clear();
    }
    list.sort_by_key(|a| std::cmp::Reverse(a.created_at));
    Ok(list)
}

fn find_snapshot_index(manifest: &[SnapshotInfo], wanted: &str) -> Result<usize, String> {
    if let Some(pos) = manifest.iter().position(|s| s.id == wanted) {
        return Ok(pos);
    }
    let matches: Vec<usize> = manifest
        .iter()
        .enumerate()
        .filter(|(_, s)| s.id.starts_with(wanted))
        .map(|(i, _)| i)
        .collect();
    match matches.len() {
        0 => Err(err("belirtilen anlık görüntü bulunamadı")),
        1 => Ok(matches[0]),
        _ => Err(err("belirtilen kimlik birden fazla anlık görüntüyle eşleşiyor · daha uzun bir kimlik girin")),
    }
}

/// Verilen anlık görüntüye geri yükler.
///
/// Geri yüklemeden önce mevcut durum **otomatik olarak snapshot'lanır**
/// (`before-restore-<id>`) — böylece restore işleminin kendisi de geri alınabilir.
#[tauri::command]
pub async fn restore_snapshot(root: String, id: String) -> Result<String, String> {
    let _guard = OP_LOCK
        .lock()
        .map_err(|_| err("snapshot kilidi alınamadı"))?;
    let base = canonical_root(&root)?;
    let snap_dir = jailed_macrocode_subdir(&base, SNAPSHOTS_SUBDIR)?;
    if !snap_dir.exists() {
        return Err(err("geri yüklenecek anlık görüntü bulunamadı"));
    }
    let mut manifest = read_manifest(&snap_dir, &base)?;
    let wanted = id.trim();
    let idx = find_snapshot_index(&manifest, wanted)?;
    let target = manifest[idx].clone();

    let src_dir = snap_dir.join(&target.id);
    let src_canon = src_dir
        .canonicalize()
        .map_err(|_| err("anlık görüntü dizini bulunamadı"))?;
    if !src_canon.starts_with(&base) {
        return Err(err("anlık görüntü dizini workspace dışında (symlink?)"));
    }

    // 1) Güvenlik kopyası: mevcut durum kaybedilmesin.
    let safety = build_snapshot(
        &base,
        &root,
        &snap_dir,
        format!("before-restore-{}", target.id),
        &mut manifest,
    )?;

    // 2) Snapshot'taki dosyaları geri yaz (atomik).
    let mut restored = 0usize;
    for f in &target.files {
        let src = inside(&src_canon, &f.path)?;
        let bytes = fs::read(&src)
            .map_err(|e| err(format!("snapshot dosyası okunamadı ({}): {e}", f.path)))?;
        let dst = inside(&base, &f.path)?;
        write_atomic(&dst, &bytes)?;
        restored += 1;
    }

    // 3) Snapshot sonrası eklenmiş dosyaları sil. Bloklu/.macrocode dosyaları
    //    collect() tarafından zaten görülmez; excluded listesi de korunur.
    let mut current = Vec::new();
    let mut ignored = Vec::new();
    collect(&base, &base, "", 0, &mut current, &mut ignored)?;
    let keep: HashSet<&str> = target
        .files
        .iter()
        .map(|f| f.path.as_str())
        .chain(target.excluded.iter().map(String::as_str))
        .collect();
    let mut deleted = 0usize;
    for w in &current {
        if keep.contains(w.rel.as_str()) {
            continue;
        }
        let p = inside(&base, &w.rel)?;
        if p.exists() && p.is_file() {
            fs::remove_file(&p).map_err(|e| err(format!("dosya silinemedi ({}): {e}", w.rel)))?;
            deleted += 1;
        }
    }

    write_manifest(&snap_dir, &base, &manifest)?;
    Ok(format!(
        "/// anlık görüntü geri yüklendi: {restored} dosya yazıldı · {deleted} dosya silindi · güvenlik kopyası: {}",
        safety.id
    ))
}

/// Anlık görüntüyü siler (güvenlik kopyaları ayrı kayıtlardır).
#[tauri::command]
pub async fn delete_snapshot(root: String, id: String) -> Result<String, String> {
    let _guard = OP_LOCK
        .lock()
        .map_err(|_| err("snapshot kilidi alınamadı"))?;
    let base = canonical_root(&root)?;
    let snap_dir = jailed_macrocode_subdir(&base, SNAPSHOTS_SUBDIR)?;
    let mut manifest = read_manifest(&snap_dir, &base)?;
    let wanted = id.trim();
    let idx = find_snapshot_index(&manifest, wanted)?;
    let entry = manifest.remove(idx);

    let dir = snap_dir.join(&entry.id);
    let canon = dir.canonicalize().unwrap_or_else(|_| dir.clone());
    if canon.starts_with(&base) {
        let _ = fs::remove_dir_all(&canon);
    }
    write_manifest(&snap_dir, &base, &manifest)?;
    Ok(format!("/// anlık görüntü silindi: {}", entry.id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("mc-snap-{tag}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[tokio::test]
    async fn create_list_restore_ve_yeni_dosya_silme() {
        let root = tmp_root("roundtrip");
        fs::write(root.join("a.ts"), "A").unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/b.ts"), "B").unwrap();
        let root_s = root.to_str().unwrap().to_string();

        let snap = create_snapshot(root_s.clone(), Some("ilk".into()))
            .await
            .unwrap();
        assert_eq!(snap.file_count, 2);
        let list = list_snapshots(root_s.clone()).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].label, "ilk");
        assert!(list[0].files.is_empty()); // IPC için boşaltılır

        // Snapshot sonrası değişiklik + yeni dosya.
        fs::write(root.join("a.ts"), "A2").unwrap();
        fs::write(root.join("yeni.ts"), "Y").unwrap();

        let msg = restore_snapshot(root_s.clone(), snap.id.clone())
            .await
            .unwrap();
        assert_eq!(fs::read_to_string(root.join("a.ts")).unwrap(), "A");
        assert_eq!(fs::read_to_string(root.join("src/b.ts")).unwrap(), "B");
        assert!(!root.join("yeni.ts").exists());
        assert!(msg.contains("güvenlik kopyası"));

        // Güvenlik kopyası listeye eklenmiş olmalı.
        let after = list_snapshots(root_s.clone()).await.unwrap();
        assert_eq!(after.len(), 2);

        // Tekrar restore edilebilir (snapshot tüketilmedi).
        fs::write(root.join("a.ts"), "A3").unwrap();
        restore_snapshot(root_s.clone(), snap.id.clone())
            .await
            .unwrap();
        assert_eq!(fs::read_to_string(root.join("a.ts")).unwrap(), "A");

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn blocked_ve_binary_dosyalar_haric_tutulur() {
        let root = tmp_root("filters");
        fs::write(root.join("ok.ts"), "x").unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/p.js"), "x").unwrap();
        fs::write(root.join(".env"), "SECRET=1").unwrap();
        fs::write(root.join("key.pem"), "SECRET").unwrap();
        fs::write(root.join("img.bin"), [0u8, 1, 2]).unwrap();
        let root_s = root.to_str().unwrap().to_string();

        let snap = create_snapshot(root_s.clone(), None).await.unwrap();
        assert_eq!(snap.file_count, 1);
        assert_eq!(snap.files[0].path, "ok.ts");
        // binary, restore'da silinmesin diye excluded olarak kaydedilir.
        assert!(snap.excluded.contains(&"img.bin".to_string()));
        fs::write(root.join("extra.ts"), "y").unwrap();
        restore_snapshot(root_s.clone(), snap.id).await.unwrap();
        assert!(root.join("img.bin").exists());
        assert!(root.join(".env").exists());
        assert!(!root.join("extra.ts").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn bozuk_manifest_net_hata_verir() {
        let root = tmp_root("badmanifest");
        fs::write(root.join("a.ts"), "x").unwrap();
        let snap_dir = root.join(".macrocode").join(SNAPSHOTS_SUBDIR);
        fs::create_dir_all(&snap_dir).unwrap();
        fs::write(snap_dir.join(MANIFEST_FILE), "{bozuk").unwrap();
        let root_s = root.to_str().unwrap().to_string();
        let e = create_snapshot(root_s, None).await.unwrap_err();
        assert!(e.contains("bozuk"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn goreli_yol_dogrulama() {
        assert!(rel_to_path("src/a.ts").is_ok());
        assert!(rel_to_path("a b/c.ts").is_ok());
        assert!(rel_to_path("../a.ts").is_err());
        assert!(rel_to_path("/abs").is_err());
        assert!(rel_to_path("a/../b").is_err());
    }

    #[test]
    fn belirsiz_kimlik_reddedilir() {
        let manifest = vec![
            SnapshotInfo {
                id: "snap-1234-aaa".into(),
                label: "bir".into(),
                created_at: 1,
                file_count: 0,
                total_bytes: 0,
                files: vec![],
                excluded: vec![],
            },
            SnapshotInfo {
                id: "snap-1234-bbb".into(),
                label: "iki".into(),
                created_at: 2,
                file_count: 0,
                total_bytes: 0,
                files: vec![],
                excluded: vec![],
            },
        ];
        assert_eq!(find_snapshot_index(&manifest, "snap-1234-aaa").unwrap(), 0);
        let err = find_snapshot_index(&manifest, "snap-1234").unwrap_err();
        assert!(err.contains("birden fazla"));
        assert!(find_snapshot_index(&manifest, "yok").is_err());
    }

    /// B1 — `write_atomic` öngörülebilir `.tmp-snap-*` adı kullanmaz ve
    /// mevcut bir symlink'i takip etmez: dışarıdaki hedef dokunulmadan kalır,
    /// hedef dosya symlink'e dönüşmez.
    #[test]
    #[cfg(unix)]
    fn b1_write_atomic_symlink_takip_etmez() {
        use std::os::unix::fs::symlink;
        let kok = tmp_root("b1-write-atomic");
        let dis = tmp_root("b1-write-atomic-dis");
        let dis_file = dis.join("kurban.txt");
        fs::write(&dis_file, "DOKUNULMAMALI").unwrap();

        let hedef = kok.join("a.ts");
        fs::write(&hedef, "eski").unwrap();
        // Eski kodun öngörülebilir geçici adı → dışarıyı gösteren symlink.
        symlink(&dis_file, kok.join("a.tmp-snap-1")).unwrap();

        write_atomic(&hedef, b"yeni").unwrap();
        assert_eq!(fs::read_to_string(&dis_file).unwrap(), "DOKUNULMAMALI");
        let md = fs::symlink_metadata(&hedef).unwrap();
        assert!(!md.file_type().is_symlink(), "hedef symlink'e dönüştü");
        assert_eq!(fs::read_to_string(&hedef).unwrap(), "yeni");

        // Geçici artık (`.mc-`) kalmamalı.
        let artik: Vec<String> = fs::read_dir(&kok)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".mc-"))
            .collect();
        assert!(artik.is_empty(), "geçici dosya artığı: {artik:?}");

        let _ = fs::remove_dir_all(&kok);
        let _ = fs::remove_dir_all(&dis);
    }
}
