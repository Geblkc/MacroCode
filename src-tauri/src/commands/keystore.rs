use std::collections::BTreeMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_store::{Store, StoreExt};

// Birincil depo: işletim sistemi anahtar zinciri (Windows Credential Manager,
// macOS Keychain, Linux Secret Service). `keys.json` yalnızca geri dönüşüm
// (keychain yoksa) ve eski sürümlerden tek seferlik geçiş için kullanılır.
// Asla anahtar DEĞERİ frontend'e toplu döndürülmez; sadece istenen sağlayıcının
// değeri ya da var/yok bilgisi verilir.

const STORE_PATH: &str = "keys.json";
const KEYRING_SERVICE: &str = "com.macrocode.app";
const KEYRING_ACCOUNT_PREFIX: &str = "api-key:";

const VALID_PROVIDERS: [&str; 12] = [
    "anthropic",
    "openai",
    "gemini",
    "ollamaUrl",
    "openrouter",
    "deepseek",
    "xai",
    "minimax",
    "moonshotai",
    "zhipuai",
    "nvidia",
    "evren",
];

/// "Ollama" / "ollamaurl" gibi varyantlari kanonik forma cevirir.
/// `custom_<slug>` adlari özel uçlara aittir (harf/rakam/`-`/`_`, en fazla 48 karakter).
fn normalize_provider(raw: &str) -> Result<String, String> {
    let lowered = raw.trim().to_lowercase();
    let canonical = if lowered == "ollama" || lowered == "ollamaurl" {
        "ollamaUrl".to_string()
    } else {
        lowered
    };
    if VALID_PROVIDERS.contains(&canonical.as_str()) {
        return Ok(canonical);
    }
    if let Some(rest) = canonical.strip_prefix("custom_") {
        if !rest.is_empty()
            && rest.len() <= 48
            && rest
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Ok(canonical);
        }
    }
    Err(format!(
        "bilinmeyen saglayici: {raw} · anthropic/openai/gemini/ollama/openrouter/deepseek/xai/minimax/moonshotai/zhipuai/nvidia/evren kullan"
    ))
}

/// Anahtar zinciri erişimi. Zincir yoksa/erişilemezse `Err` döner ve çağıran
/// yerel dosyaya (eski davranış) düşer — uygulama çalışmaya devam eder.
trait SecretBackend: Send + Sync {
    fn get(&self, provider: &str) -> Result<Option<String>, String>;
    fn set(&self, provider: &str, value: &str) -> Result<(), String>;
    fn delete(&self, provider: &str) -> Result<(), String>;
}

struct KeychainBackend;

impl KeychainBackend {
    fn entry(provider: &str) -> Result<keyring::Entry, String> {
        let account = format!("{KEYRING_ACCOUNT_PREFIX}{provider}");
        keyring::Entry::new(KEYRING_SERVICE, &account)
            .map_err(|e| format!("anahtar zinciri acilamadi: {e}"))
    }

    /// Tek bir okuma ile zincirin erişilebilir olup olmadığını sınar.
    /// Kayıt yoksa (`NoEntry`) zincir erişilebilir sayılır.
    fn available() -> bool {
        match Self::entry("__probe__").and_then(|entry| match entry.get_password() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("anahtar zinciri okunamadi: {e}")),
        }) {
            Ok(()) => true,
            Err(e) => {
                eprintln!("[keystore] anahtar zinciri kullanilamiyor: {e}");
                false
            }
        }
    }
}

impl SecretBackend for KeychainBackend {
    fn get(&self, provider: &str) -> Result<Option<String>, String> {
        match Self::entry(provider)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("anahtar zinciri okunamadi: {e}")),
        }
    }

    fn set(&self, provider: &str, value: &str) -> Result<(), String> {
        Self::entry(provider)?
            .set_password(value)
            .map_err(|e| format!("anahtar zincirine yazilamadi: {e}"))
    }

    fn delete(&self, provider: &str) -> Result<(), String> {
        match Self::entry(provider)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("anahtar zincirinden silinemedi: {e}")),
        }
    }
}

// keyring çağrıları engelleyicidir (D-Bus / Credential Manager / Keychain).
// Tauri'nin async runtime'ını bloklamamak için hepsi spawn_blocking içinde.
async fn keychain_get(provider: &str) -> Result<Option<String>, String> {
    let provider = provider.to_owned();
    tauri::async_runtime::spawn_blocking(move || KeychainBackend.get(&provider))
        .await
        .map_err(|e| format!("anahtar zinciri gorevi basarisiz: {e}"))?
}

async fn keychain_set(provider: &str, value: &str) -> Result<(), String> {
    let provider = provider.to_owned();
    let value = value.to_owned();
    tauri::async_runtime::spawn_blocking(move || KeychainBackend.set(&provider, &value))
        .await
        .map_err(|e| format!("anahtar zinciri gorevi basarisiz: {e}"))?
}

async fn keychain_delete(provider: &str) -> Result<(), String> {
    let provider = provider.to_owned();
    tauri::async_runtime::spawn_blocking(move || KeychainBackend.delete(&provider))
        .await
        .map_err(|e| format!("anahtar zinciri gorevi basarisiz: {e}"))?
}

fn open_store(app: &AppHandle) -> Result<Arc<Store<Wry>>, String> {
    app.store(STORE_PATH)
        .map_err(|e| format!("depolama acilamadi: {e} · uygulamayi yeniden baslatmayi dene"))
}

/// Eski `keys.json` dosyasını yalnızca sahibi okuyabilsin (`0600`).
/// Anahtar zinciri kullanılamadığında yazılan geri dönüşüm dosyası için geçerli.
fn harden_store_file(app: &AppHandle) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let Ok(dir) = app.path().app_data_dir() else {
            return;
        };
        let path = dir.join(STORE_PATH);
        if !path.exists() {
            return;
        }
        if let Err(e) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)) {
            eprintln!("[keystore] izinler daraltilamadi (0600): {e}");
        }
    }
    #[cfg(not(unix))]
    {
        let _ = app;
    }
}

fn legacy_get(store: &Arc<Store<Wry>>, provider: &str) -> String {
    store
        .get(provider)
        .and_then(|v| v.get("key").and_then(|k| k.as_str()).map(|s| s.to_owned()))
        .unwrap_or_default()
}

fn legacy_write(store: &Arc<Store<Wry>>, provider: &str, value: &str) -> Result<(), String> {
    store.set(provider, json!({ "key": value }));
    store
        .save()
        .map_err(|e| format!("anahtar kaydedilemedi: {e} · disk yazma iznini kontrol et"))
}

/// Sağlayıcıyı geri dönüşüm dosyasından çıkarır. `true` = kayıt vardı.
fn legacy_remove(app: &AppHandle, provider: &str) -> Result<bool, String> {
    let store = open_store(app)?;
    if !store.delete(provider) {
        return Ok(false);
    }
    store
        .save()
        .map_err(|e| format!("anahtar silinemedi: {e} · disk yazma iznini kontrol et"))?;
    remove_legacy_file_if_empty(app, &store);
    Ok(true)
}

/// Tüm anahtarlar zincire taşındıysa düz metin dosyayı fiziksel olarak sil.
fn remove_legacy_file_if_empty(app: &AppHandle, store: &Arc<Store<Wry>>) {
    if !store.is_empty() {
        return;
    }
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    if let Err(e) = std::fs::remove_file(dir.join(STORE_PATH)) {
        if e.kind() != std::io::ErrorKind::NotFound {
            eprintln!("[keystore] eski keys.json silinemedi: {e}");
        }
    }
}

fn legacy_entries(store: &Arc<Store<Wry>>) -> BTreeMap<String, String> {
    store
        .entries()
        .into_iter()
        .filter_map(|(provider, value)| {
            value
                .get("key")
                .and_then(|k| k.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|s| (provider, s.to_owned()))
        })
        .collect()
}

#[derive(Debug, Default, PartialEq, Eq)]
struct MigrationReport {
    migrated: usize,
    failed: Vec<String>,
}

/// Saf bir geçiş yardımcı fonksiyonu: başarılı olan kayıtlar zincire yazılır ve
/// geri dönüşüm haritasından çıkarılır; başarısız/ geçersiz kayıtlar korunur
/// (veri kaybı olmaz). Testler bu fonksiyonu gerçek OS servisleri olmadan sınar.
fn migrate_legacy_entries(
    legacy: BTreeMap<String, String>,
    keychain: &dyn SecretBackend,
) -> (BTreeMap<String, String>, MigrationReport) {
    let mut remaining = BTreeMap::new();
    let mut report = MigrationReport::default();
    for (provider, value) in legacy {
        if value.trim().is_empty() {
            continue;
        }
        let canonical = match normalize_provider(&provider) {
            Ok(p) => p,
            Err(_) => {
                remaining.insert(provider, value);
                continue;
            }
        };
        match keychain.set(&canonical, &value) {
            Ok(()) => report.migrated += 1,
            Err(e) => {
                eprintln!("[keystore] {canonical} zincire tasinamadi: {e}");
                report.failed.push(canonical.clone());
                remaining.insert(canonical, value);
            }
        }
    }
    (remaining, report)
}

/// Açılışta eski `keys.json` kayıtlarını anahtar zincirine taşı.
/// Kısmi başarıda taşınamayanlar dosyada kalır; sonraki açılışta yeniden denenir.
pub(crate) fn migrate_legacy_keys(app: &AppHandle) {
    let Ok(store) = open_store(app) else {
        return;
    };
    let entries = legacy_entries(&store);
    if entries.is_empty() {
        return;
    }
    if !KeychainBackend::available() {
        eprintln!(
            "[keystore] anahtar zinciri yok — {} anahtar yerel dosyada kaldı",
            entries.len()
        );
        return;
    }
    let (remaining, report) = migrate_legacy_entries(entries, &KeychainBackend);
    store.clear();
    for (provider, value) in remaining {
        store.set(provider, json!({ "key": value }));
    }
    // clear() sonrası kayıt kalmadıysa dosyayı boş olarak yazıp hemen sileriz;
    // yazma hatası olsa bile düz metin sırrı kalmaz.
    if store.save().is_ok() {
        remove_legacy_file_if_empty(app, &store);
    }
    if report.migrated > 0 {
        eprintln!(
            "[keystore] {} anahtar anahtar zincirine tasindi{}",
            report.migrated,
            if report.failed.is_empty() {
                ""
            } else {
                " (bazılari dosyada kaldı)"
            }
        );
    }
}

/// Zincirdeki değeri döndürür; yoksa/erişilemezse eski dosyaya bakar.
/// Zincir erişilebilir ama kayıt yoksa bu kaydı zincire taşır ve dosyadan siler.
async fn resolve_secret(app: &AppHandle, provider: &str) -> String {
    match keychain_get(provider).await {
        Ok(Some(value)) if !value.trim().is_empty() => return value,
        Ok(_) => {}
        Err(e) => {
            eprintln!("[keystore] {provider} zincirden okunamadi, yerel dosyaya dusuldu: {e}");
            return match open_store(app) {
                Ok(store) => legacy_get(&store, provider),
                Err(_) => String::new(),
            };
        }
    }

    let Ok(store) = open_store(app) else {
        return String::new();
    };
    let value = legacy_get(&store, provider);
    if value.trim().is_empty() {
        return String::new();
    }
    if let Err(e) = keychain_set(provider, &value).await {
        eprintln!("[keystore] {provider} zincire tasinamadi: {e}");
        return value;
    }
    if let Err(e) = legacy_remove(app, provider) {
        eprintln!("[keystore] {provider} yerel dosyadan silinemedi: {e}");
    }
    value
}

/// `key_status` için zincir + dosya birleşik var/yok kontrolü (yazma yapmaz).
async fn has_secret(app: &AppHandle, provider: &str) -> bool {
    match keychain_get(provider).await {
        Ok(Some(value)) => !value.trim().is_empty(),
        Ok(None) => match open_store(app) {
            Ok(store) => !legacy_get(&store, provider).trim().is_empty(),
            Err(_) => false,
        },
        Err(e) => {
            eprintln!("[keystore] {provider} zincirden okunamadi: {e}");
            match open_store(app) {
                Ok(store) => !legacy_get(&store, provider).trim().is_empty(),
                Err(_) => false,
            }
        }
    }
}

#[tauri::command]
pub async fn set_api_key(provider: String, key: String, app: AppHandle) -> Result<(), String> {
    let provider = normalize_provider(&provider)?;
    let key = key.trim().to_owned();
    if key.is_empty() {
        return Err("api anahtari bos olamaz".to_string());
    }
    match keychain_set(&provider, &key).await {
        Ok(()) => {
            // Zincir birincil kayıt; düz metin kopya kalmasın.
            if let Err(e) = legacy_remove(&app, &provider) {
                eprintln!("[keystore] {provider} yerel kopya silinemedi: {e}");
            }
            Ok(())
        }
        Err(e) => {
            // Keychain yoksa (ör. headless Linux) eski davranışa güvenli şekilde düş.
            eprintln!("[keystore] {provider} zincire yazilamadi, yerel dosya kullanilacak: {e}");
            let store = open_store(&app)?;
            legacy_write(&store, &provider, &key)?;
            harden_store_file(&app);
            Ok(())
        }
    }
}

/// L6/L7 (A) — **sağlayıcı-kapsamlı erişim:** her çağrı yalnızca `provider`
/// parametresindeki tek anahtarı döndürür; tüm anahtarları toplu döken bir
/// komut yoktur. Frontend anahtarı sağlayıcı isteğinde kullanmak zorunda
/// olduğundan bu mimari korunur; kalan XSS riski export/log/audit
/// redaksiyonu ve dokümentasyonla azaltılır (bkz. `docs/ARCHITECTURE.md` §13.2).
#[tauri::command]
pub async fn get_api_key(provider: String, app: AppHandle) -> Result<String, String> {
    let provider = normalize_provider(&provider)?;
    Ok(resolve_secret(&app, &provider).await)
}

#[tauri::command]
pub async fn delete_api_key(provider: String, app: AppHandle) -> Result<(), String> {
    let provider = normalize_provider(&provider)?;
    let keychain = keychain_delete(&provider).await;
    let legacy = legacy_remove(&app, &provider);
    match (keychain, legacy) {
        (Ok(()), Ok(_)) => Ok(()),
        // Zincir erişilemiyorsa yerel kopya silinebildiyse işlem başarılı sayılır.
        (Err(e), Ok(true)) => {
            eprintln!("[keystore] {provider} zincirden silinemedi (yerel kopya silindi): {e}");
            Ok(())
        }
        (Err(e), Ok(false)) => Err(format!("{provider} anahtari silinemedi: {e}")),
        (_, Err(e)) => Err(e),
    }
}

/// Boot sequence icin: hangi saglayicilar bagli? (degerler degil, sadece var/yok)
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub anthropic: bool,
    pub openai: bool,
    pub gemini: bool,
    pub ollama_url: bool,
    pub openrouter: bool,
    pub deepseek: bool,
    pub xai: bool,
    pub minimax: bool,
    pub moonshotai: bool,
    pub zhipuai: bool,
    pub nvidia: bool,
    pub evren: bool,
}

#[tauri::command]
pub async fn key_status(app: AppHandle) -> Result<KeyStatus, String> {
    Ok(KeyStatus {
        anthropic: has_secret(&app, "anthropic").await,
        openai: has_secret(&app, "openai").await,
        gemini: has_secret(&app, "gemini").await,
        ollama_url: has_secret(&app, "ollamaUrl").await,
        openrouter: has_secret(&app, "openrouter").await,
        deepseek: has_secret(&app, "deepseek").await,
        xai: has_secret(&app, "xai").await,
        minimax: has_secret(&app, "minimax").await,
        moonshotai: has_secret(&app, "moonshotai").await,
        zhipuai: has_secret(&app, "zhipuai").await,
        nvidia: has_secret(&app, "nvidia").await,
        evren: has_secret(&app, "evren").await,
    })
}

/// Hic anahtar yoksa boot mesaji uyarı gosterecek.
#[tauri::command]
pub async fn has_any_key(app: AppHandle) -> Result<bool, String> {
    let status = key_status(app).await?;
    Ok(status.anthropic
        || status.openai
        || status.gemini
        || status.ollama_url
        || status.openrouter
        || status.deepseek
        || status.xai
        || status.minimax
        || status.moonshotai
        || status.zhipuai
        || status.nvidia
        || status.evren)
}

/// Maskeli ipucu (`••••a1b2`): tam değer ASLA dönmez.
/// Boş/kayıtsız anahtarda boş string döner.
#[tauri::command]
pub async fn key_hint(provider: String, app: AppHandle) -> Result<String, String> {
    let provider = normalize_provider(&provider)?;
    Ok(mask_hint(&resolve_secret(&app, &provider).await))
}

fn mask_hint(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let last4: String = trimmed
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("••••{last4}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeKeychain {
        values: Mutex<BTreeMap<String, String>>,
        fail: bool,
    }

    impl SecretBackend for FakeKeychain {
        fn get(&self, provider: &str) -> Result<Option<String>, String> {
            Ok(self.values.lock().unwrap().get(provider).cloned())
        }

        fn set(&self, provider: &str, value: &str) -> Result<(), String> {
            if self.fail {
                return Err("zincir kapali".to_string());
            }
            self.values
                .lock()
                .unwrap()
                .insert(provider.to_owned(), value.to_owned());
            Ok(())
        }

        fn delete(&self, provider: &str) -> Result<(), String> {
            self.values.lock().unwrap().remove(provider);
            Ok(())
        }
    }

    #[test]
    fn yerlesik_saglayicilar_kabul_edilir() {
        assert_eq!(normalize_provider("anthropic").unwrap(), "anthropic");
        assert_eq!(normalize_provider("Ollama").unwrap(), "ollamaUrl");
        assert_eq!(normalize_provider("ollamaurl").unwrap(), "ollamaUrl");
        assert_eq!(normalize_provider("NVIDIA").unwrap(), "nvidia");
        assert_eq!(normalize_provider("evren").unwrap(), "evren");
    }

    #[test]
    fn custom_oneki_kabul_edilir() {
        assert_eq!(
            normalize_provider("custom_benim-proxy").unwrap(),
            "custom_benim-proxy"
        );
        assert_eq!(
            normalize_provider("CUSTOM_ABC123").unwrap(),
            "custom_abc123"
        );
    }

    #[test]
    fn custom_kurallari_reddedilir() {
        assert!(normalize_provider("custom_").is_err());
        assert!(normalize_provider("custom_a b").is_err());
        assert!(normalize_provider("custom_çokbaytlı").is_err());
        assert!(normalize_provider("custom_x").is_ok());
        assert!(normalize_provider("bilinmeyen").is_err());
    }

    #[test]
    fn goc_basarisinda_yerel_kopya_kalmaz() {
        let zincir = FakeKeychain::default();
        let eski = BTreeMap::from([
            ("anthropic".to_string(), "sk-ant-123".to_string()),
            ("ollama".to_string(), "http://localhost:11434".to_string()),
        ]);
        let (kalan, rapor) = migrate_legacy_entries(eski, &zincir);
        assert!(kalan.is_empty());
        assert_eq!(rapor.migrated, 2);
        assert!(rapor.failed.is_empty());
        assert_eq!(
            zincir.values.lock().unwrap().get("ollamaUrl").unwrap(),
            "http://localhost:11434"
        );
    }

    #[test]
    fn goc_hatasinda_yerel_kopya_korunur() {
        let zincir = FakeKeychain {
            fail: true,
            ..Default::default()
        };
        let eski = BTreeMap::from([("openai".to_string(), "sk-456".to_string())]);
        let (kalan, rapor) = migrate_legacy_entries(eski, &zincir);
        assert_eq!(kalan.get("openai").unwrap(), "sk-456");
        assert_eq!(rapor.failed, vec!["openai".to_string()]);
    }

    #[test]
    fn gecersiz_ve_bos_kayitlar_yazilmaz() {
        let zincir = FakeKeychain::default();
        let eski = BTreeMap::from([
            ("bos".to_string(), "   ".to_string()),
            ("custom_a b".to_string(), "sir".to_string()),
        ]);
        let (kalan, rapor) = migrate_legacy_entries(eski, &zincir);
        assert_eq!(rapor.migrated, 0);
        assert!(kalan.contains_key("custom_a b"));
        assert!(!kalan.contains_key("bos"));
        assert!(zincir.values.lock().unwrap().is_empty());
    }

    #[test]
    fn ipucu_son_dort_karakteri_gosterir() {
        assert_eq!(mask_hint("sk-ant-abcdef12"), "••••ef12");
        assert_eq!(mask_hint("abc"), "••••abc");
        assert_eq!(mask_hint("  "), "");
    }
}
