//! SQLite oturum snapshot'ı için atomik yazma komutu.
//!
//! `tauri-plugin-sql` bağlantı havuzu kullanır. Frontend'de ayrı `execute`
//! çağrılarıyla `BEGIN`/`COMMIT` göndermek transaction'ın farklı bağlantılara
//! dağılmasına ve kilitli bağlantının havuzda kalmasına yol açıyordu. Bu komut
//! plugin'in aynı SQLite havuzundan tek bir bağlantı üzerinde transaction
//! açar; tüm snapshot yazımı atomik olur.

use serde::Deserialize;
use sqlx::SqlitePool;
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};

const META_ID: &str = "__meta__";

#[derive(Debug, Deserialize)]
pub struct SessionRow {
    pub id: String,
    pub data: String,
}

/// Snapshot yazımının transaction kısmı (testte doğrudan da çağrılabilir).
async fn save_sessions(
    pool: &SqlitePool,
    sessions: &[SessionRow],
    active_session_id: Option<&str>,
) -> Result<(), String> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("veritabanı transaction'ı başlatılamadı: {e}"))?;

    // SQLx'in varsayılan busy timeout'u 5 saniyedir. Uygulama içi yazmalar
    // FIFO kuyruğunda olduğundan aynı süre korunur; kalıcı bir dış kilitte
    // agent akışı sonsuza kadar beklemez.
    sqlx::query("PRAGMA busy_timeout = 5000")
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("busy timeout ayarlanamadı: {e}"))?;

    for row in sessions {
        sqlx::query("INSERT OR REPLACE INTO sessions (id, data) VALUES (?, ?)")
            .bind(&row.id)
            .bind(&row.data)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("oturum yazılamadı ({}): {e}", row.id))?;
    }

    let meta = serde_json::json!({ "activeSessionId": active_session_id }).to_string();
    sqlx::query("INSERT OR REPLACE INTO sessions (id, data) VALUES (?, ?)")
        .bind(META_ID)
        .bind(meta)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("aktif oturum meta verisi yazılamadı: {e}"))?;

    // Silme işlemi de aynı transaction'da yapılır; eski oturum satırları
    // snapshot'ın yarısında kalıp "database is locked" bırakmaz.
    let mut delete_sql = String::from("DELETE FROM sessions WHERE id != ?");
    let mut delete_values: Vec<String> = vec![META_ID.to_string()];
    for row in sessions {
        delete_sql.push_str(" AND id != ?");
        delete_values.push(row.id.clone());
    }
    let mut delete_query = sqlx::query(&delete_sql);
    for value in &delete_values {
        delete_query = delete_query.bind(value);
    }
    delete_query
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("eski oturumlar temizlenemedi: {e}"))?;

    tx.commit()
        .await
        .map_err(|e| format!("veritabanı transaction'ı kapatılamadı: {e}"))
}

/// Oturum snapshot'ını tek transaction'da yazar.
#[tauri::command]
pub async fn db_save_sessions(
    db_instances: State<'_, DbInstances>,
    db: String,
    sessions: Vec<SessionRow>,
    active_session_id: Option<String>,
) -> Result<(), String> {
    let instances = db_instances.0.read().await;
    let pool = instances
        .get(&db)
        .ok_or_else(|| format!("veritabanı yüklenmedi: {db}"))?;

    let pool = match pool {
        DbPool::Sqlite(pool) => pool,
        #[allow(unreachable_patterns)]
        _ => return Err("bu komut yalnızca SQLite veritabanı için kullanılabilir".to_string()),
    };

    save_sessions(pool, &sessions, active_session_id.as_deref()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    #[tokio::test]
    async fn snapshot_atomik_olarak_yazilir_ve_eski_satirlar_silinir() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("sqlite pool");
        sqlx::query("CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);")
            .execute(&pool)
            .await
            .expect("schema");

        let rows = vec![
            SessionRow {
                id: "s1".to_string(),
                data: "{\"id\":\"s1\"}".to_string(),
            },
            SessionRow {
                id: "s2".to_string(),
                data: "{\"id\":\"s2\"}".to_string(),
            },
        ];
        save_sessions(&pool, &rows, Some("s2"))
            .await
            .expect("snapshot");

        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM sessions ORDER BY id")
            .fetch_all(&pool)
            .await
            .expect("ids");
        assert_eq!(ids, vec!["__meta__", "s1", "s2"]);

        let meta: String = sqlx::query_scalar("SELECT data FROM sessions WHERE id = '__meta__'")
            .fetch_one(&pool)
            .await
            .expect("meta");
        assert!(meta.contains("s2"));

        // Eski satırlar aynı transaction'da temizlenir.
        save_sessions(&pool, &rows[..1], Some("s1"))
            .await
            .expect("second snapshot");
        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM sessions ORDER BY id")
            .fetch_all(&pool)
            .await
            .expect("ids");
        assert_eq!(ids, vec!["__meta__", "s1"]);
    }
}
