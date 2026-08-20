mod receipt_formatter;

#[cfg(all(not(target_os = "android"), target_os = "windows"))]
#[path = "printer/windows.rs"]
mod desktop;

#[cfg(all(not(target_os = "android"), not(target_os = "windows")))]
#[path = "printer/desktop.rs"]
mod desktop;

#[cfg(target_os = "android")]
#[path = "printer/android.rs"]
mod android;

#[cfg(not(target_os = "android"))]
pub use desktop::*;

#[cfg(target_os = "android")]
pub use android::*;
