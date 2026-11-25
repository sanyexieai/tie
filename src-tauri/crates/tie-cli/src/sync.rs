use std::{thread, time::Duration};
use tie_local::LocalWorkspace;

use tie_cli::backend_sync;

pub use backend_sync::BackendSyncReport;

pub fn account(
    login: bool,
    register: bool,
    logout: bool,
    url: Option<&str>,
    email: Option<&str>,
    password: Option<&str>,
    name: Option<&str>,
) -> Result<(), String> {
    if logout {
        return print_status(&Some(backend_sync::logout()?));
    }
    if login && register {
        return Err("登录和注册不能同时进行".into());
    }
    let url = url.ok_or("请用 --backend-url 指定后台地址")?;
    let email = email.ok_or(if register { "请用 --email 指定邮箱" } else { "请用 --email 指定用户名或邮箱" })?;
    let password = password.ok_or("请用 --password 指定密码")?;
    let value = if register {
        backend_sync::register(url, email, password, name.unwrap_or(""))?
    } else {
        backend_sync::login(url, email, password)?
    };
    print_status(&Some(value))
}

pub fn once(ws: &LocalWorkspace) -> Result<BackendSyncReport, String> {
    backend_sync::sync_workspace(ws)
}

pub fn enable(ws: &LocalWorkspace, url: &str, workspace_id: &str) -> Result<BackendSyncReport, String> {
    backend_sync::enable(ws, url, workspace_id)
}

pub fn status(root: &std::path::Path) -> Result<Option<serde_json::Value>, String> {
    let path = root.join(".tie").join("sync-status.json");
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    Ok(Some(serde_json::from_str(&raw).map_err(|error| error.to_string())?))
}

pub fn watch(ws: &LocalWorkspace, interval_secs: u64) -> Result<(), String> {
    let interval = Duration::from_secs(interval_secs.max(1));
    eprintln!(
        "[tie] sync watching {} · peer=backend",
        ws.root().display()
    );
    loop {
        match backend_sync::sync_workspace(ws) {
            Ok(report) => eprintln!(
                "[tie] sync {} pushed={} pulled={} conflicts={}",
                report.mode,
                report.pushed,
                report.pulled,
                report.conflicts.len()
            ),
            Err(error) => eprintln!("[tie] sync {error}"),
        }
        thread::sleep(interval);
    }
}

pub fn print_report(report: &BackendSyncReport) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string_pretty(report).map_err(|error| error.to_string())?
    );
    Ok(())
}

pub fn print_status(value: &Option<impl serde::Serialize>) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string_pretty(value).map_err(|error| error.to_string())?
    );
    Ok(())
}
