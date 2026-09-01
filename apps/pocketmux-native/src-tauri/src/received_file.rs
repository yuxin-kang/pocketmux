#[cfg(any(target_os = "ios", test))]
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

#[cfg(any(target_os = "ios", test))]
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;

#[cfg(any(target_os = "ios", test))]
pub const MAX_RECEIVED_FILE_BYTES: usize = 50 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES: &[&str] = &[
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/heic",
    "image/heif",
    "image/bmp",
    "image/tiff",
    "video/mp4",
    "video/x-m4v",
    "video/quicktime",
    "video/webm",
    "video/x-matroska",
    "video/x-msvideo",
    "video/3gpp",
    "video/mpeg",
    "video/x-ms-wmv",
    "video/ogg",
    "text/markdown",
    "text/plain",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceivedFileResult {
    pub ok: bool,
    pub code: &'static str,
}

pub fn unavailable_result() -> ReceivedFileResult {
    ReceivedFileResult {
        ok: false,
        code: "native-file-bridge-unavailable",
    }
}

pub fn validate_content_type(content_type: &str) -> Result<(), String> {
    if ALLOWED_CONTENT_TYPES.contains(&content_type) {
        Ok(())
    } else {
        Err("unsupported received file type".into())
    }
}

#[cfg(any(target_os = "ios", test))]
pub fn sanitize_file_name(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|character| {
            if character == '/' || character == '\\' || character.is_control() {
                '_'
            } else {
                character
            }
        })
        .collect();
    let trimmed: String = sanitized.trim().chars().take(180).collect();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "pocketmux-file".into()
    } else {
        trimmed
    }
}

#[cfg(any(target_os = "ios", test))]
pub fn decode_base64_file(data_base64: &str) -> Result<Vec<u8>, String> {
    if !encoded_size_within_limit(data_base64.len()) {
        return Err("invalid received file data".into());
    }
    let bytes = STANDARD
        .decode(data_base64)
        .map_err(|_| "invalid received file data".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_RECEIVED_FILE_BYTES {
        return Err("invalid received file data".into());
    }
    Ok(bytes)
}

#[cfg(any(target_os = "ios", test))]
fn encoded_size_within_limit(length: usize) -> bool {
    length > 0 && length <= MAX_RECEIVED_FILE_BYTES.div_ceil(3) * 4
}

#[cfg(any(target_os = "ios", test))]
fn collision_name(file_name: &str, index: usize) -> String {
    if index == 0 {
        return file_name.into();
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("pocketmux-file");
    match path.extension().and_then(|value| value.to_str()) {
        Some(extension) if !extension.is_empty() => format!("{stem} ({index}).{extension}"),
        _ => format!("{stem} ({index})"),
    }
}

#[cfg(any(target_os = "ios", test))]
pub fn write_received_file(
    documents_dir: &Path,
    file_name: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let destination_dir = documents_dir.join("Pocketmux");
    fs::create_dir_all(&destination_dir)
        .map_err(|error| format!("received file directory is unavailable: {error}"))?;

    for index in 0..10_000 {
        let path = destination_dir.join(collision_name(file_name, index));
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("received file could not be created: {error}")),
        };
        if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
            let _ = fs::remove_file(&path);
            return Err(format!("received file could not be saved: {error}"));
        }
        return Ok(path);
    }

    Err("received file name is unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_paths_and_control_characters() {
        assert_eq!(
            sanitize_file_name(" ../folder\\report\n.pdf "),
            ".._folder_report_.pdf"
        );
        assert_eq!(sanitize_file_name("\n\t"), "__");
        assert_eq!(sanitize_file_name(""), "pocketmux-file");
        assert_eq!(sanitize_file_name(".."), "pocketmux-file");
    }

    #[test]
    fn validates_supported_file_types() {
        assert!(validate_content_type("application/pdf").is_ok());
        assert!(validate_content_type("image/heic").is_ok());
        assert!(validate_content_type("application/octet-stream").is_err());
    }

    #[test]
    fn creates_collision_names_without_losing_extensions() {
        assert_eq!(collision_name("report.pdf", 0), "report.pdf");
        assert_eq!(collision_name("report.pdf", 2), "report (2).pdf");
        assert_eq!(collision_name("notes", 1), "notes (1)");
    }

    #[test]
    fn writes_received_files_without_overwriting_existing_files() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "pocketmux-received-file-{}-{unique}",
            std::process::id()
        ));
        let first = write_received_file(&root, "report.pdf", b"first").unwrap();
        let second = write_received_file(&root, "report.pdf", b"second").unwrap();

        assert_eq!(first.file_name().unwrap(), "report.pdf");
        assert_eq!(second.file_name().unwrap(), "report (1).pdf");
        assert_eq!(std::fs::read(first).unwrap(), b"first");
        assert_eq!(std::fs::read(second).unwrap(), b"second");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_empty_and_oversized_encoded_data_before_decoding() {
        assert!(decode_base64_file("").is_err());
        assert!(!encoded_size_within_limit(
            MAX_RECEIVED_FILE_BYTES.div_ceil(3) * 4 + 1
        ));
    }
}
