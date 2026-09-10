use serde_json::{json, Map, Value};

/// Fill `sourceId` / `locator` while keeping legacy `sourcePath` / `storedPath`.
pub fn normalize_file_meta(raw: &Value, source_id: Option<&str>) -> Value {
    let mut meta = match raw {
        Value::Object(map) => Value::Object(map.clone()),
        _ => json!({}),
    };
    let source_path = string_field(&meta, "sourcePath")
        .or_else(|| locator_string(&meta, "desktopPath"))
        .unwrap_or_default();
    let stored_path = string_field(&meta, "storedPath").unwrap_or_else(|| {
        if string_field(&meta, "mode").as_deref() != Some("copy") {
            source_path.clone()
        } else {
            String::new()
        }
    });
    let display_path = locator_string(&meta, "displayPath")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if source_path.is_empty() {
                stored_path.clone()
            } else {
                source_path.clone()
            }
        });
    if meta.get("sourcePath").and_then(Value::as_str).unwrap_or("").is_empty() && !source_path.is_empty() {
        meta["sourcePath"] = json!(source_path);
    }
    if meta.get("storedPath").and_then(Value::as_str).unwrap_or("").is_empty() && !stored_path.is_empty() {
        meta["storedPath"] = json!(stored_path);
    }
    let resolved_source = string_field(&meta, "sourceId")
        .filter(|value| !value.is_empty())
        .or_else(|| source_id.map(str::trim).filter(|value| !value.is_empty()).map(str::to_string));
    if let Some(id) = resolved_source {
        meta["sourceId"] = json!(id);
    }
    if meta.get("locator").is_none() {
        let mut locator = Map::new();
        let is_android = source_path.starts_with("content://");
        locator.insert("type".into(), json!(if is_android { "android" } else { "desktop" }));
        if is_android {
            locator.insert("androidUri".into(), json!(source_path));
        } else if !source_path.is_empty() {
            locator.insert("desktopPath".into(), json!(source_path));
        }
        locator.insert("displayPath".into(), json!(display_path));
        meta["locator"] = Value::Object(locator);
    }
    if meta.get("contentHash").is_none() {
        if let Some(hash) = string_field(&meta, "sha256") {
            meta["contentHash"] = json!(hash);
        }
    }
    meta
}

pub fn source_path_from_meta(meta: &Value) -> String {
    string_field(meta, "sourcePath")
        .or_else(|| locator_string(meta, "desktopPath"))
        .or_else(|| locator_string(meta, "androidUri"))
        .unwrap_or_default()
}

fn string_field(meta: &Value, key: &str) -> Option<String> {
    meta.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn locator_string(meta: &Value, key: &str) -> Option<String> {
    meta.get("locator")
        .and_then(Value::as_object)
        .and_then(|locator| locator.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}
