pub mod db;
pub mod exec;
pub mod fs;
pub mod git;
pub mod keystore;
pub mod mcp;
pub mod paths;
mod proc_tree;
pub mod proxy;
pub mod snapshots;
pub mod stream;
pub mod tool_output;
pub mod updater;

/// Faz 4: async Tauri komutlarındaki engelleme yapan dosya işlemlerini
/// tokio'nun bloklayıcı işçi havuzuna taşır. Komutlar yine `async` kalır;
/// yalnızca gövde worker thread'de çalışır (UI/async runtime bloklanmaz).
pub(crate) async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("dosya görevi başarısız: {e}"))?
}

pub use db::db_save_sessions;
pub use exec::{exec_cancel, exec_cmd, exec_cmd_stream, ExecState};
pub use fs::{
    apply_patch, glob_files, grep_files, list_dir, list_tree, memory_append, memory_read,
    read_file, read_file_full, undo_patch, write_file,
};
pub use git::{
    git_branches, git_commit, git_detect, git_diff, git_discard, git_fetch, git_init, git_log,
    git_pull, git_push, git_remotes, git_show, git_stage, git_status, git_switch, git_unstage,
};
pub use keystore::{delete_api_key, get_api_key, has_any_key, key_hint, key_status, set_api_key};
pub use mcp::{mcp_kill, mcp_read, mcp_spawn, mcp_write, McpState};
pub use paths::get_app_paths;
pub use proxy::{proxy_abort, proxy_fetch, ProxyState};
pub use snapshots::{create_snapshot, delete_snapshot, list_snapshots, restore_snapshot};
pub use stream::stream_anthropic;
pub use tool_output::store_tool_output;
pub use updater::update_support;
