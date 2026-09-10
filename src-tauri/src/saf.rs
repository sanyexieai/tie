use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

pub fn is_content_uri(path: &str) -> bool {
    path.trim().starts_with("content://")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafPickResult {
    pub uri: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub mime: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub cancelled: bool,
}

#[derive(Debug, Clone)]
pub struct ContentStat {
    pub exists: bool,
    pub is_directory: bool,
    pub size: u64,
    pub name: String,
    pub mime: String,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("tie-saf")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = api.register_android_plugin("com.tie.knowledge", "SafPlugin")?;
                app.manage(SafApi(handle));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = (app, api);
            }
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
struct SafApi<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[tauri::command]
pub fn pick_native_resource(app: AppHandle, kind: String) -> Result<Option<SafPickResult>, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let api = app
            .try_state::<SafApi<tauri::Wry>>()
            .ok_or_else(|| "Android SAF 未初始化".to_owned())?;
        let picked: SafPickResult = api
            .0
            .run_mobile_plugin("pick", serde_json::json!({ "kind": kind }))
            .map_err(|error| error.to_string())?;
        if picked.cancelled || picked.uri.trim().is_empty() {
            return Ok(None);
        }
        Ok(Some(picked))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, kind);
        Err("仅 Android 支持系统文档选择器".into())
    }
}

#[tauri::command]
pub fn open_native_resource(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("路径不能为空".into());
    }
    if is_content_uri(trimmed) {
        return android_open(trimmed);
    }
    Err("请使用系统打开器打开本机路径".into())
}

pub fn uri_exists(uri: &str) -> bool {
    android_stat(uri).map(|stat| stat.exists).unwrap_or(false)
}

pub fn uri_stat(uri: &str) -> Result<ContentStat, String> {
    android_stat(uri)
}

pub fn materialize_content_uri(uri: &str) -> Result<std::path::PathBuf, String> {
    android_materialize(uri)
}

#[cfg(target_os = "android")]
fn android_open(uri: &str) -> Result<(), String> {
    android_jni::open(uri)
}

#[cfg(not(target_os = "android"))]
fn android_open(_uri: &str) -> Result<(), String> {
    Err("content URI 仅 Android 支持".into())
}

#[cfg(target_os = "android")]
fn android_stat(uri: &str) -> Result<ContentStat, String> {
    android_jni::stat(uri)
}

#[cfg(not(target_os = "android"))]
fn android_stat(_uri: &str) -> Result<ContentStat, String> {
    Err("content URI 仅 Android 支持".into())
}

#[cfg(target_os = "android")]
fn android_materialize(uri: &str) -> Result<std::path::PathBuf, String> {
    android_jni::read_to_temp(uri)
}

#[cfg(not(target_os = "android"))]
fn android_materialize(_uri: &str) -> Result<std::path::PathBuf, String> {
    Err("content URI 仅 Android 支持".into())
}

#[cfg(target_os = "android")]
mod android_jni {
    use super::ContentStat;
    use jni::objects::{JObject, JString, JValue};
    use jni::JNIEnv;
    use std::path::PathBuf;

    const BRIDGE: &str = "com/tie/knowledge/SafBridge";

    fn with_env<T>(f: impl FnOnce(&mut JNIEnv, JObject) -> Result<T, String>) -> Result<T, String> {
        let ctx = ndk_context::android_context();
        if ctx.vm().is_null() || ctx.context().is_null() {
            return Err("Android 上下文不可用".into());
        }
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|error| error.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|error| error.to_string())?;
        let context = unsafe { JObject::from_raw(ctx.context() as jni::sys::jobject) };
        let result = f(&mut env, context);
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_describe();
            let _ = env.exception_clear();
            return Err("Android SAF 调用失败".into());
        }
        result
    }

    fn string_arg<'a>(env: &mut JNIEnv<'a>, value: &str) -> Result<JObject<'a>, String> {
        let java: JString = env.new_string(value).map_err(|error| error.to_string())?;
        Ok(java.into())
    }

    pub fn stat(uri: &str) -> Result<ContentStat, String> {
        with_env(|env, context| {
            let class = env.find_class(BRIDGE).map_err(|error| error.to_string())?;
            let uri_obj = string_arg(env, uri)?;
            let exists = env
                .call_static_method(
                    &class,
                    "exists",
                    "(Landroid/content/Context;Ljava/lang/String;)Z",
                    &[JValue::Object(&context), JValue::Object(&uri_obj)],
                )
                .map_err(|error| error.to_string())?
                .z()
                .map_err(|error| error.to_string())?;
            if !exists {
                return Ok(ContentStat {
                    exists: false,
                    is_directory: false,
                    size: 0,
                    name: String::new(),
                    mime: String::new(),
                });
            }
            let is_directory = env
                .call_static_method(
                    &class,
                    "isDirectory",
                    "(Landroid/content/Context;Ljava/lang/String;)Z",
                    &[JValue::Object(&context), JValue::Object(&uri_obj)],
                )
                .map_err(|error| error.to_string())?
                .z()
                .map_err(|error| error.to_string())?;
            let size = env
                .call_static_method(
                    &class,
                    "size",
                    "(Landroid/content/Context;Ljava/lang/String;)J",
                    &[JValue::Object(&context), JValue::Object(&uri_obj)],
                )
                .map_err(|error| error.to_string())?
                .j()
                .map_err(|error| error.to_string())? as u64;
            let name = jstring_method(env, &class, &context, &uri_obj, "displayName")?;
            let mime = jstring_method(env, &class, &context, &uri_obj, "mime")?;
            Ok(ContentStat {
                exists: true,
                is_directory,
                size,
                name,
                mime,
            })
        })
    }

    fn jstring_method(
        env: &mut JNIEnv,
        class: &jni::objects::JClass,
        context: &JObject,
        uri: &JObject,
        name: &str,
    ) -> Result<String, String> {
        let value = env
            .call_static_method(
                class,
                name,
                "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(context), JValue::Object(uri)],
            )
            .map_err(|error| error.to_string())?
            .l()
            .map_err(|error| error.to_string())?;
        if value.is_null() {
            return Ok(String::new());
        }
        let java = JString::from(value);
        env.get_string(&java)
            .map(|text| text.into())
            .map_err(|error| error.to_string())
    }

    pub fn open(uri: &str) -> Result<(), String> {
        with_env(|env, context| {
            let class = env.find_class(BRIDGE).map_err(|error| error.to_string())?;
            let uri_obj = string_arg(env, uri)?;
            env.call_static_method(
                &class,
                "open",
                "(Landroid/content/Context;Ljava/lang/String;)V",
                &[JValue::Object(&context), JValue::Object(&uri_obj)],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    pub fn read_to_temp(uri: &str) -> Result<PathBuf, String> {
        let stat = stat(uri)?;
        if !stat.exists {
            return Err("找不到所选文档".into());
        }
        if stat.is_directory {
            return Err("Android 不能导入目录副本，请改用登记".into());
        }
        if stat.size > 20 * 1024 * 1024 {
            return Err("远程导入不能超过 20 MB，请改用登记或缩小文件".into());
        }
        let name = if stat.name.trim().is_empty() {
            "upload.bin".to_owned()
        } else {
            stat.name.replace(['/', '\\'], "_")
        };
        let dest = std::env::temp_dir().join("tie-saf").join(format!(
            "{}_{name}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(dest.parent().unwrap_or(&dest)).map_err(|error| error.to_string())?;
        let dest_text = dest.to_string_lossy().into_owned();
        with_env(|env, context| {
            let class = env.find_class(BRIDGE).map_err(|error| error.to_string())?;
            let uri_obj = string_arg(env, uri)?;
            let dest_obj = string_arg(env, &dest_text)?;
            env.call_static_method(
                &class,
                "readToPath",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)V",
                &[
                    JValue::Object(&context),
                    JValue::Object(&uri_obj),
                    JValue::Object(&dest_obj),
                ],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })?;
        Ok(dest)
    }
}
