use keyring::Entry;
use std::sync::Mutex;

const S3_CREDENTIAL_SERVICE: &str = "com.tie.knowledge.s3";
const PAGE_CREDENTIAL_SERVICE: &str = "com.tie.knowledge.page-protection";
static PAGE_CREDENTIAL_ACCESS: Mutex<()> = Mutex::new(());

#[tauri::command]
pub(crate) async fn page_device_password_load(scope: String) -> Result<Option<String>, String> {
    with_page_credential(scope, read_page_password).await
}

#[tauri::command]
pub(crate) async fn page_device_password_save(scope: String, password: String) -> Result<(), String> {
    if password.is_empty() {
        return Err("解锁密码不能为空".to_owned());
    }
    with_page_credential(scope, move |entry| {
        entry.set_password(&password).map_err(|_| "无法保存到系统凭据库，请继续使用密码解锁".to_owned())
    }).await
}

#[tauri::command]
pub(crate) async fn page_device_password_forget(scope: String) -> Result<(), String> {
    with_page_credential(scope, forget_page_password).await
}

async fn with_page_credential<T: Send + 'static>(
    scope: String,
    operation: impl FnOnce(&Entry) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let username = page_credential_username(&scope)?;
    tauri::async_runtime::spawn_blocking(move || {
        // Native stores do not consistently serialize concurrent operations themselves.
        let _access = PAGE_CREDENTIAL_ACCESS.lock().map_err(|_| "系统凭据操作未完成，请重试".to_owned())?;
        let entry = Entry::new(PAGE_CREDENTIAL_SERVICE, &username)
            .map_err(|_| "无法访问系统凭据库，请使用密码解锁".to_owned())?;
        operation(&entry)
    }).await.map_err(|_| "系统凭据操作未完成，请重试".to_owned())?
}

fn page_credential_username(scope: &str) -> Result<String, String> {
    if scope.trim().is_empty() || scope.len() > 4096 || scope.chars().any(char::is_control) {
        return Err("页面解锁标识无效".to_owned());
    }
    Ok(minio::s3::utils::sha256_hash(scope.as_bytes()))
}

fn read_page_password(entry: &Entry) -> Result<Option<String>, String> {
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("无法读取系统凭据库，请使用密码解锁".to_owned()),
    }
}

fn forget_page_password(entry: &Entry) -> Result<(), String> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法移除本机解锁凭据，请检查系统凭据库后重试".to_owned()),
    }
}

pub fn s3_credential_entry(provider_id: &str) -> Result<Entry, String> {
    if provider_id.trim().is_empty() {
        return Err("S3 配置标识不能为空".to_owned());
    }
    Entry::new(S3_CREDENTIAL_SERVICE, provider_id).map_err(|error| error.to_string())
}

pub fn read_keyring_credential(provider_id: &str) -> Result<String, String> {
    s3_credential_entry(provider_id)?
        .get_password()
        .map_err(|_| "未找到此 S3 连接的本机密钥，请重新保存配置".to_owned())
}

pub fn write_keyring_credential(provider_id: &str, payload: &str) -> Result<(), String> {
    s3_credential_entry(provider_id)?
        .set_password(payload)
        .map_err(|error| format!("无法保存到系统凭据库：{error}"))
}

pub fn remove_keyring_credential(provider_id: &str) -> Result<(), String> {
    match s3_credential_entry(provider_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("无法从系统凭据库移除：{error}")),
    }
}

#[cfg(test)]
mod page_device_password_tests {
    use super::*;

    fn mock_entry() -> Entry {
        Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()))
    }

    #[test]
    fn page_scope_is_hashed_and_separates_accounts_and_pages() {
        let scope = r#"["https://example.test","user-a","source-a","page-a"]"#;
        let username = page_credential_username(scope).unwrap();
        assert_eq!(username, "eba85d479170d7b59c8ab5d7c55f5764a6d7d3a400b6ddc1eadcaae15fb62c87");
        assert_eq!(username, page_credential_username(scope).unwrap());
        assert_ne!(username, page_credential_username(&scope.replace("user-a", "user-b")).unwrap());
        assert_ne!(username, page_credential_username(&scope.replace("page-a", "page-b")).unwrap());
        assert_ne!(PAGE_CREDENTIAL_SERVICE, S3_CREDENTIAL_SERVICE);
    }

    #[test]
    fn page_scope_rejects_empty_control_and_oversized_input() {
        for scope in ["", "   ", "invalid\0scope", "invalid\nscope"] {
            assert!(page_credential_username(scope).is_err());
        }
        assert!(page_credential_username(&"a".repeat(4097)).is_err());
    }

    #[test]
    fn page_credential_can_be_loaded_and_forgotten_without_touching_system_store() {
        let entry = mock_entry();
        assert_eq!(read_page_password(&entry).unwrap(), None);
        entry.set_password("fixture-only-page-password").unwrap();
        assert_eq!(read_page_password(&entry).unwrap().as_deref(), Some("fixture-only-page-password"));
        forget_page_password(&entry).unwrap();
        assert_eq!(read_page_password(&entry).unwrap(), None);
        forget_page_password(&entry).unwrap();
    }

    #[test]
    fn store_errors_do_not_expose_password_bytes_or_treat_errors_as_missing() {
        let entry = mock_entry();
        let mock = entry.get_credential().downcast_ref::<keyring::mock::MockCredential>().unwrap();
        mock.set_error(keyring::Error::BadEncoding(b"fixture-private-password".to_vec()));
        let error = read_page_password(&entry).unwrap_err();
        assert!(!error.contains("fixture-private-password"));
        mock.set_error(keyring::Error::NoStorageAccess(Box::new(std::io::Error::other("fixture-private-password"))));
        let error = forget_page_password(&entry).unwrap_err();
        assert!(!error.contains("fixture-private-password"));
    }
}
