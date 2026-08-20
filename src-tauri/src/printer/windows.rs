use std::ffi::OsStr;
use std::iter::once;
use std::os::windows::ffi::OsStrExt;
use tauri::command;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::GetLastError;
use windows::Win32::Graphics::Printing::{
    ClosePrinter, EndDocPrinter, EndPagePrinter, EnumPrintersW, GetDefaultPrinterW, OpenPrinterW,
    StartDocPrinterW, StartPagePrinter, WritePrinter, DOC_INFO_1W, PRINTER_ATTRIBUTE_WORK_OFFLINE,
    PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_HANDLE, PRINTER_INFO_4W,
};

#[derive(serde::Serialize, Clone)]
pub struct PrinterInfo {
    pub id: String,
    pub name: String,
    pub r#type: String,
    pub status: String,
    pub is_default: bool,
    pub description: Option<String>,
}

#[command]
pub fn get_printers() -> Vec<PrinterInfo> {
    let default_printer = get_default_printer_name();
    let mut printers = Vec::new();

    match enumerate_printers() {
        Ok(entries) => {
            for entry in entries {
                let name = entry.name.trim().to_string();
                if name.is_empty() {
                    continue;
                }

                let is_default = default_printer
                    .as_deref()
                    .map(|default_name| default_name.eq_ignore_ascii_case(&name))
                    .unwrap_or(false);

                printers.push(PrinterInfo {
                    id: format!("win:{}", name),
                    name: name.clone(),
                    r#type: "system_printer".to_string(),
                    status: if entry.is_offline {
                        "offline".to_string()
                    } else {
                        "ready".to_string()
                    },
                    is_default,
                    description: Some("Windows system printer queue".to_string()),
                });
            }
        }
        Err(error) => {
            eprintln!("[Printer] Windows printer discovery failed: {}", error);
        }
    }

    printers
}

#[command]
pub fn print_receipt(
    html: String,
    printer_id: String,
    copies: i32,
    paper_size: Option<String>,
    printer_paper_width: Option<String>,
) -> Result<String, String> {
    if copies <= 0 {
        return Err("Copies must be greater than 0".to_string());
    }

    let printer_name = resolve_windows_printer_name(&printer_id)?;

    let escpos_data = super::receipt_formatter::build_escpos_receipt(
        &html,
        paper_size.as_deref(),
        printer_paper_width.as_deref(),
    );

    for _ in 0..copies {
        print_raw_windows(&printer_name, &escpos_data)?;
    }

    Ok("success".into())
}

struct WinPrinterEntry {
    name: String,
    is_offline: bool,
}

fn enumerate_printers() -> Result<Vec<WinPrinterEntry>, String> {
    unsafe {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let mut bytes_needed: u32 = 0;
        let mut count: u32 = 0;

        let _ = EnumPrintersW(
            flags,
            PCWSTR::null(),
            4,
            None,
            &mut bytes_needed,
            &mut count,
        );

        if bytes_needed == 0 {
            return Ok(Vec::new());
        }

        let mut buffer = vec![0u8; bytes_needed as usize];
        if let Err(err) = EnumPrintersW(
            flags,
            PCWSTR::null(),
            4,
            Some(buffer.as_mut_slice()),
            &mut bytes_needed,
            &mut count,
        ) {
            return Err(format!("EnumPrintersW failed: {}", err));
        }

        let entries =
            std::slice::from_raw_parts(buffer.as_ptr() as *const PRINTER_INFO_4W, count as usize);

        let mut printers = Vec::new();
        for entry in entries {
            let name = pwstr_to_string(entry.pPrinterName);
            let is_offline = (entry.Attributes & PRINTER_ATTRIBUTE_WORK_OFFLINE) != 0;

            printers.push(WinPrinterEntry { name, is_offline });
        }

        Ok(printers)
    }
}

fn get_default_printer_name() -> Option<String> {
    unsafe {
        let mut needed: u32 = 0;
        let _ = GetDefaultPrinterW(None, &mut needed);
        if needed == 0 {
            return None;
        }

        let mut buffer = vec![0u16; needed as usize];
        let success = GetDefaultPrinterW(Some(PWSTR(buffer.as_mut_ptr())), &mut needed);
        if !success.as_bool() {
            return None;
        }

        let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..len]))
    }
}

fn resolve_windows_printer_name(printer_id: &str) -> Result<String, String> {
    let trimmed = printer_id.trim();
    if trimmed.is_empty() {
        return Err("Printer ID is required".to_string());
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("cups:") || lower.starts_with("bt:") {
        return Err("CUPS/Bluetooth printer IDs are not supported on Windows".to_string());
    }

    if is_vid_pid_id(trimmed) {
        return Err(
            "USB VID:PID printing is not supported on Windows. Configure a system printer instead."
                .to_string(),
        );
    }

    if lower.starts_with("win:") {
        let cleaned = trimmed[4..].trim();
        if cleaned.is_empty() {
            return Err("Printer name is empty".to_string());
        }
        return Ok(cleaned.to_string());
    }

    Ok(trimmed.to_string())
}

fn is_vid_pid_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 9 || bytes[4] != b':' {
        return false;
    }

    bytes.iter().enumerate().all(|(idx, b)| {
        if idx == 4 {
            return true;
        }
        b.is_ascii_hexdigit()
    })
}

fn print_raw_windows(printer_name: &str, data: &[u8]) -> Result<(), String> {
    if printer_name.trim().is_empty() {
        return Err("Printer name is empty".to_string());
    }

    unsafe {
        let name_w = to_wide(printer_name);
        let mut handle = PRINTER_HANDLE::default();
        if let Err(err) = OpenPrinterW(PCWSTR(name_w.as_ptr()), &mut handle, None) {
            return Err(format!("Failed to open printer: {}", err));
        }

        let doc_name = to_wide("Handy POS Receipt");
        let data_type = to_wide("RAW");
        let doc_info = DOC_INFO_1W {
            pDocName: PWSTR(doc_name.as_ptr() as *mut _),
            pOutputFile: PWSTR::null(),
            pDatatype: PWSTR(data_type.as_ptr() as *mut _),
        };

        let job_id = StartDocPrinterW(handle, 1, &doc_info);
        if job_id == 0 {
            let _ = ClosePrinter(handle);
            return Err(last_error("Failed to start print job"));
        }

        if !StartPagePrinter(handle).as_bool() {
            let _ = EndDocPrinter(handle);
            let _ = ClosePrinter(handle);
            return Err(last_error("Failed to start print page"));
        }

        let mut bytes_written: u32 = 0;
        let write_ok = WritePrinter(
            handle,
            data.as_ptr() as *const _,
            data.len() as u32,
            &mut bytes_written,
        );

        let _ = EndPagePrinter(handle);
        let _ = EndDocPrinter(handle);
        let _ = ClosePrinter(handle);

        if !write_ok.as_bool() {
            return Err(last_error("Failed to write print data"));
        }

        if bytes_written as usize != data.len() {
            return Err("Incomplete write to printer spooler".to_string());
        }
    }

    Ok(())
}

fn pwstr_to_string(ptr: PWSTR) -> String {
    if ptr.0.is_null() {
        return String::new();
    }

    unsafe {
        let mut len = 0usize;
        let mut cursor = ptr.0;
        while *cursor != 0 {
            len += 1;
            cursor = cursor.add(1);
        }
        let slice = std::slice::from_raw_parts(ptr.0, len);
        String::from_utf16_lossy(slice)
    }
}

fn to_wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(once(0)).collect()
}

fn last_error(context: &str) -> String {
    let code = unsafe { GetLastError().0 };
    format!("{} (error {})", context, code)
}
