#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use std::process::{Child, Command, Stdio};
#[cfg(target_os = "windows")]
use std::sync::Mutex;
#[cfg(target_os = "windows")]
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn should_spawn_bundled_backend() -> bool {
    // Bundled backend is disabled by default. Opt-in explicitly if needed.
    if !env_flag("HANDYPOS_ENABLE_BUNDLED_BACKEND") {
        return false;
    }

    if env_flag("HANDYPOS_DISABLE_BACKEND") {
        return false;
    }

    true
}

#[cfg(target_os = "windows")]
pub struct BackendState {
    child: Mutex<Option<Child>>,
}

#[cfg(target_os = "windows")]
impl BackendState {
    pub fn new(child: Child) -> Self {
        Self {
            child: Mutex::new(Some(child)),
        }
    }

    pub fn stop(&self) {
        let mut guard = self.child.lock().expect("backend child mutex poisoned");
        if let Some(mut child) = guard.take() {
            let pid = child.id();
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output();
            let _ = child.kill();
        }
    }
}

#[cfg(target_os = "windows")]
pub fn maybe_spawn_backend(app: &AppHandle) -> Option<BackendState> {
    if cfg!(debug_assertions) {
        return None;
    }

    if !should_spawn_bundled_backend() {
        return None;
    }

    let resource_dir = app.path().resource_dir().ok()?;
    let script_path = resource_dir.join("backend-bundle").join("run_server.bat");
    if !script_path.exists() {
        return None;
    }

    let working_dir = script_path.parent().unwrap_or(resource_dir.as_path());
    let mut command = Command::new("cmd");
    command
        .arg("/C")
        .arg(&script_path)
        .current_dir(working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);

    match command.spawn() {
        Ok(child) => Some(BackendState::new(child)),
        Err(_) => None,
    }
}

#[cfg(not(target_os = "windows"))]
pub struct BackendState;

#[cfg(not(target_os = "windows"))]
impl BackendState {
    pub fn stop(&self) {}
}

#[cfg(not(target_os = "windows"))]
pub fn maybe_spawn_backend(_: &tauri::AppHandle) -> Option<BackendState> {
    None
}
