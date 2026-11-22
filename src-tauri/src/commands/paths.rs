use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Uygulama veri konumlari (About sekmesi icin).
///
/// Anahtarlar OS anahtar zincirinde; `keys.json` yalnızca zincir yoksa kullanılan
/// geri dönüşüm dosyasıdır. Oturumlar `sessions.db` — ikisi de `app_data_dir`
/// altindadir ve cihazdan cikmaz.
#[derive(Serialize, Clone)]
pub struct AppPaths {
    /// Veri dizini (anahtarlarin ve veritabaninin bulundugu klasor).
    pub data_dir: String,
    /// Geri dönüşüm API anahtarlari dosyasi (`keys.json`; normalde mevcut olmaz).
    pub keys_file: String,
    /// Oturum veritabani (`sessions.db`).
    pub sessions_db: String,
}

/// Uygulama veri konumlarini dondurur.
#[tauri::command]
pub fn get_app_paths(app: AppHandle) -> Result<AppPaths, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("veri dizini bulunamadi: {e}"))?;
    Ok(AppPaths {
        keys_file: dir.join("keys.json").to_string_lossy().to_string(),
        sessions_db: dir.join("sessions.db").to_string_lossy().to_string(),
        data_dir: dir.to_string_lossy().to_string(),
    })
}
