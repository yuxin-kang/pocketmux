use std::time::Duration;

use reqwest::StatusCode;

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command(rename_all = "camelCase")]
async fn validate_token(server_url: String, token: String) -> String {
    let Ok(base_url) = reqwest::Url::parse(&server_url) else {
        return "unknown".into();
    };
    if !matches!(base_url.scheme(), "http" | "https") || token.trim().is_empty() {
        return "unknown".into();
    }
    let Ok(health_url) = base_url.join("/api/health") else {
        return "unknown".into();
    };
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return "unknown".into();
    };

    match client.get(health_url).bearer_auth(token).send().await {
        Ok(response) => match response.status() {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => "invalid".into(),
            status if status.is_success() => "valid".into(),
            _ => "unknown".into(),
        },
        Err(_) => "unknown".into(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![exit_app, validate_token])
        .run(tauri::generate_context!())
        .expect("failed to run Pocketmux");
}
