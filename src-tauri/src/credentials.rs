use keyring::Entry;

const S3_CREDENTIAL_SERVICE: &str = "com.tie.knowledge.s3";

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
