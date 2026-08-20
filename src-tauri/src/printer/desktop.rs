use rusb::{DeviceHandle, Direction, GlobalContext, TransferType};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::command;

#[derive(serde::Serialize, Clone)]
pub struct PrinterInfo {
    pub id: String,
    pub name: String,
    pub r#type: String,
    pub status: String,
    pub is_default: bool,
    pub description: Option<String>,
}

// Known thermal printer IDs
const EPSON_TM_T88V: (u16, u16) = (0x04b8, 0x0202);
const STAR_VID: u16 = 0x0519;
const SUNMI_VID: u16 = 0x0416;
const DISCOVERY_COMMAND_TIMEOUT: Duration = Duration::from_millis(1200);
const BLUETOOTH_DISCOVERY_TIMEOUT: Duration = Duration::from_millis(800);
const COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(40);

#[command]
pub fn get_printers() -> Vec<PrinterInfo> {
    let mut printers = Vec::new();

    if let Ok(devices) = rusb::devices() {
        for device in devices.iter() {
            if let Ok(desc) = device.device_descriptor() {
                let vid = desc.vendor_id();
                let pid = desc.product_id();

                let is_candidate = is_thermal_printer(vid, pid) || has_printer_interface(&device);
                if !is_candidate {
                    continue;
                }

                let printer_id = format!("{:04x}:{:04x}", vid, pid);
                let mut name = fallback_device_name(vid, pid);
                let mut status = "ready".to_string();
                let mut description =
                    format!("USB Thermal Printer - VID: {:04x}, PID: {:04x}", vid, pid);

                match device.open() {
                    Ok(handle) => {
                        // Discovery should never detach drivers; do that only during actual print.
                        name = get_device_name(&handle, &desc);
                        eprintln!("[Printer] Found: {} ({})", name, printer_id);
                    }
                    Err(e) => {
                        status = "offline".to_string();
                        description = format!(
                            "USB printer detected but access failed - VID: {:04x}, PID: {:04x}, error: {}",
                            vid, pid, e
                        );
                        eprintln!(
                            "[Printer] Detected but could not open device VID:{:04x} PID:{:04x}: {}",
                            vid, pid, e
                        );
                    }
                }

                printers.push(PrinterInfo {
                    id: printer_id,
                    name,
                    r#type: "usb_thermal".to_string(),
                    status,
                    is_default: printers.is_empty(),
                    description: Some(description),
                });
            }
        }
    }

    for cups_printer in get_cups_printers() {
        if !printers
            .iter()
            .any(|existing| existing.id == cups_printer.id)
        {
            printers.push(cups_printer);
        }
    }

    for bluetooth_device in get_paired_bluetooth_devices() {
        if !printers
            .iter()
            .any(|existing| existing.id == bluetooth_device.id)
        {
            printers.push(bluetooth_device);
        }
    }

    ensure_single_default(&mut printers);
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

    let printer_id = printer_id.trim().to_string();
    let escpos_data = super::receipt_formatter::build_escpos_receipt(
        &html,
        paper_size.as_deref(),
        printer_paper_width.as_deref(),
    );

    if let Some(queue_name) = printer_id.strip_prefix("cups:") {
        print_to_cups(queue_name, &escpos_data, copies)?;
        return Ok("success".into());
    }

    if let Some(address) = printer_id.strip_prefix("bt:") {
        print_to_paired_bluetooth(address, &escpos_data, copies)?;
        return Ok("success".into());
    }

    let parts: Vec<&str> = printer_id.split(':').collect();
    if parts.len() != 2 {
        return Err(
            "Invalid printer ID format. Expected USB id (vvvv:pppp), cups:<queue>, or bt:<MAC>"
                .to_string(),
        );
    }
    let vid = u16::from_str_radix(parts[0], 16).map_err(|_| "Invalid vendor ID")?;
    let pid = u16::from_str_radix(parts[1], 16).map_err(|_| "Invalid product ID")?;

    for i in 0..copies {
        print_to_usb(vid, pid, &escpos_data)?;
        eprintln!("[Printer] Printed copy {} of {}", i + 1, copies);
        if i < copies - 1 {
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    Ok("success".into())
}

fn ensure_single_default(printers: &mut [PrinterInfo]) {
    if printers.is_empty() {
        return;
    }

    let default_index = printers
        .iter()
        .position(|printer| printer.is_default)
        .unwrap_or(0);

    for (index, printer) in printers.iter_mut().enumerate() {
        printer.is_default = index == default_index;
    }
}

fn get_cups_printers() -> Vec<PrinterInfo> {
    let status_output = match run_command("lpstat", &["-p"]) {
        Ok(stdout) => stdout,
        Err(error) => {
            eprintln!("[Printer] CUPS discovery unavailable: {}", error);
            return Vec::new();
        }
    };

    let default_printer = run_command("lpstat", &["-d"])
        .ok()
        .and_then(|value| parse_default_printer_name(&value));

    let device_uri_map = run_command("lpstat", &["-v"])
        .ok()
        .map(|value| parse_cups_device_uris(&value))
        .unwrap_or_default();

    let mut printers = Vec::new();

    for line in status_output.lines() {
        let Some(queue_name) = parse_cups_printer_name(line) else {
            continue;
        };

        let queue_name = queue_name.trim();
        if queue_name.is_empty() {
            continue;
        }

        let uri = device_uri_map.get(queue_name).cloned().unwrap_or_default();
        let lower_uri = uri.to_ascii_lowercase();
        let status = if line.to_ascii_lowercase().contains("disabled") {
            "offline"
        } else {
            "ready"
        };

        let printer_type = classify_cups_printer_type(queue_name, &lower_uri);
        let description = if uri.is_empty() {
            format!("System print queue: {}", queue_name)
        } else {
            format!("System print queue ({})", uri)
        };

        printers.push(PrinterInfo {
            id: format!("cups:{}", queue_name),
            name: queue_name.to_string(),
            r#type: printer_type.to_string(),
            status: status.to_string(),
            is_default: default_printer.as_deref() == Some(queue_name),
            description: Some(description),
        });
    }

    printers
}

fn get_paired_bluetooth_devices() -> Vec<PrinterInfo> {
    let output = match run_command_with_timeout(
        "bluetoothctl",
        &["paired-devices"],
        BLUETOOTH_DISCOVERY_TIMEOUT,
    ) {
        Ok(stdout) => stdout,
        Err(error) => {
            eprintln!("[Printer] Bluetooth discovery unavailable: {}", error);
            return Vec::new();
        }
    };

    let device_uri_map = run_command("lpstat", &["-v"])
        .ok()
        .map(|value| parse_cups_device_uris(&value))
        .unwrap_or_default();

    let mut bluetooth_queue_map: HashMap<String, String> = HashMap::new();
    for (queue_name, uri) in device_uri_map {
        if let Some(address) = extract_bluetooth_address_from_uri(&uri) {
            bluetooth_queue_map.insert(normalize_bluetooth_address(&address), queue_name);
        }
    }

    let mut printers = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("Device ") {
            continue;
        }

        let rest = trimmed.trim_start_matches("Device ").trim();
        let mut parts = rest.splitn(2, ' ');
        let Some(address) = parts.next() else {
            continue;
        };
        let Some(name) = parts.next() else {
            continue;
        };

        let name = name.trim();
        if !is_likely_printer_name(name) {
            continue;
        }

        let normalized_address = normalize_bluetooth_address(address);
        let has_cups_queue = bluetooth_queue_map.contains_key(&normalized_address);

        printers.push(PrinterInfo {
            id: format!("bt:{}", address.to_ascii_uppercase()),
            name: name.to_string(),
            r#type: "bluetooth_paired".to_string(),
            status: if has_cups_queue {
                "ready".into()
            } else {
                "offline".into()
            },
            is_default: false,
            description: Some(if has_cups_queue {
                "Paired Bluetooth printer (system queue available)".to_string()
            } else {
                "Paired Bluetooth device. Add it as a system printer queue for direct printing."
                    .to_string()
            }),
        });
    }

    printers
}

fn parse_cups_printer_name(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    if !trimmed.starts_with("printer ") {
        return None;
    }

    trimmed
        .trim_start_matches("printer ")
        .split_whitespace()
        .next()
}

fn parse_default_printer_name(output: &str) -> Option<String> {
    output
        .lines()
        .find_map(|line| line.trim().strip_prefix("system default destination:"))
        .map(|value| value.trim().to_string())
}

fn parse_cups_device_uris(output: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();

    for line in output.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("device for ") else {
            continue;
        };

        let Some((queue_name, uri)) = rest.split_once(':') else {
            continue;
        };

        map.insert(queue_name.trim().to_string(), uri.trim().to_string());
    }

    map
}

fn classify_cups_printer_type(queue_name: &str, uri_lower: &str) -> &'static str {
    if uri_lower.starts_with("bluetooth://") {
        return "bluetooth_thermal";
    }

    if uri_lower.starts_with("socket://")
        || uri_lower.starts_with("ipp://")
        || uri_lower.starts_with("ipps://")
        || uri_lower.starts_with("lpd://")
        || uri_lower.starts_with("dnssd://")
        || uri_lower.starts_with("http://")
        || uri_lower.starts_with("https://")
    {
        return "network_thermal";
    }

    if uri_lower.starts_with("usb://") || uri_lower.starts_with("serial:") {
        return "usb_thermal";
    }

    if is_likely_printer_name(queue_name) {
        "usb_thermal"
    } else {
        "system_printer"
    }
}

fn extract_bluetooth_address_from_uri(uri: &str) -> Option<String> {
    let lower = uri.to_ascii_lowercase();
    if !lower.starts_with("bluetooth://") {
        return None;
    }

    let rest = &uri["bluetooth://".len()..];
    let address = rest.split('/').next()?.trim();
    if address.is_empty() {
        return None;
    }
    Some(address.to_string())
}

fn normalize_bluetooth_address(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn is_likely_printer_name(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    let keywords = [
        "printer", "thermal", "receipt", "epson", "star", "sunmi", "xprinter", "pos", "bixolon",
    ];

    keywords.iter().any(|keyword| normalized.contains(keyword))
}

fn run_command(program: &str, args: &[&str]) -> Result<String, String> {
    run_command_with_timeout(program, args, DISCOVERY_COMMAND_TIMEOUT)
}

fn run_command_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to execute {}: {}", program, error))?;

    let start = Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let (stdout, stderr) = read_child_output(&mut child);
                if !status.success() {
                    let details = if !stderr.is_empty() {
                        stderr
                    } else {
                        stdout.clone()
                    };
                    return Err(format!(
                        "{} {:?} failed with status {}: {}",
                        program, args, status, details
                    ));
                }
                return Ok(stdout);
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "{} {:?} timed out after {}ms",
                        program,
                        args,
                        timeout.as_millis()
                    ));
                }
                thread::sleep(COMMAND_POLL_INTERVAL);
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Failed waiting for {}: {}", program, error));
            }
        }
    }
}

fn read_child_output(child: &mut Child) -> (String, String) {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();

    if let Some(mut out) = child.stdout.take() {
        let _ = out.read_to_end(&mut stdout);
    }
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_end(&mut stderr);
    }

    (
        String::from_utf8_lossy(&stdout).to_string(),
        String::from_utf8_lossy(&stderr).to_string(),
    )
}

fn print_to_cups(queue_name: &str, data: &[u8], copies: i32) -> Result<(), String> {
    if queue_name.trim().is_empty() {
        return Err("Invalid CUPS queue name".to_string());
    }

    let mut child = Command::new("lp")
        .args([
            "-d",
            queue_name.trim(),
            "-n",
            &copies.to_string(),
            "-o",
            "raw",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to start lp command: {}", error))?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(data)
            .map_err(|error| format!("Failed to send print data to lp: {}", error))?;
    } else {
        return Err("Could not open lp stdin".to_string());
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("Failed waiting for lp command: {}", error))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let details = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!(
            "CUPS print failed for queue '{}': {}",
            queue_name, details
        ));
    }

    Ok(())
}

fn print_to_paired_bluetooth(address: &str, data: &[u8], copies: i32) -> Result<(), String> {
    let normalized_target = normalize_bluetooth_address(address);
    if normalized_target.is_empty() {
        return Err("Invalid Bluetooth address".to_string());
    }

    let uri_map = run_command("lpstat", &["-v"])
        .ok()
        .map(|value| parse_cups_device_uris(&value))
        .unwrap_or_default();

    for (queue_name, uri) in uri_map {
        let Some(uri_address) = extract_bluetooth_address_from_uri(&uri) else {
            continue;
        };

        if normalize_bluetooth_address(&uri_address) == normalized_target {
            return print_to_cups(&queue_name, data, copies);
        }
    }

    Err(format!(
        "Bluetooth printer {} is paired but not configured as a system print queue. Add it in your OS printer settings and retry.",
        address
    ))
}

fn is_thermal_printer(vid: u16, pid: u16) -> bool {
    match (vid, pid) {
        EPSON_TM_T88V => true,
        (0x04b8, 0x0203) => true, // TM-T88IV
        (0x04b8, 0x0204) => true, // TM-T20
        (0x04b8, 0x0205) => true, // TM-T70
        (STAR_VID, _) => true,
        (SUNMI_VID, _) => true,
        _ => false,
    }
}

fn get_device_name(handle: &DeviceHandle<GlobalContext>, desc: &rusb::DeviceDescriptor) -> String {
    if let Ok(langs) = handle.read_languages(Duration::from_secs(1)) {
        if let Some(lang) = langs.first() {
            if let Ok(product) = handle.read_product_string(*lang, desc, Duration::from_secs(1)) {
                return product;
            }
        }
    }

    let vid = desc.vendor_id();
    let pid = desc.product_id();
    fallback_device_name(vid, pid)
}

fn fallback_device_name(vid: u16, pid: u16) -> String {
    match (vid, pid) {
        EPSON_TM_T88V => "Epson TM-T88V".into(),
        (0x04b8, 0x0203) => "Epson TM-T88IV".into(),
        (0x04b8, 0x0204) => "Epson TM-T20".into(),
        (0x04b8, 0x0205) => "Epson TM-T70".into(),
        (STAR_VID, _) => "Star Thermal Printer".into(),
        (SUNMI_VID, _) => "Sunmi Thermal Printer".into(),
        _ => format!("USB Thermal Printer {:04x}:{:04x}", vid, pid),
    }
}

fn has_printer_interface(device: &rusb::Device<GlobalContext>) -> bool {
    if let Ok(active_config) = device.active_config_descriptor() {
        if config_has_printer_interface(&active_config) {
            return true;
        }
    }

    if let Ok(device_desc) = device.device_descriptor() {
        for config_index in 0..device_desc.num_configurations() {
            if let Ok(config) = device.config_descriptor(config_index) {
                if config_has_printer_interface(&config) {
                    return true;
                }
            }
        }
    }

    false
}

fn config_has_printer_interface(config: &rusb::ConfigDescriptor) -> bool {
    for iface in config.interfaces() {
        for desc in iface.descriptors() {
            let class_code = desc.class_code();
            if class_code == 0x07 {
                // USB printer class
                return true;
            }

            if class_code == 0xff {
                // Many ESC/POS devices use vendor-specific class with bulk OUT endpoints.
                for ep in desc.endpoint_descriptors() {
                    if ep.direction() == Direction::Out && ep.transfer_type() == TransferType::Bulk
                    {
                        return true;
                    }
                }
            }
        }
    }

    false
}

fn print_to_usb(vid: u16, pid: u16, data: &[u8]) -> Result<(), String> {
    let handle = rusb::open_device_with_vid_pid(vid, pid)
        .ok_or_else(|| format!("Printer not found VID:{:04x} PID:{:04x}", vid, pid))?;

    let targets = find_bulk_out_targets(&handle)?;
    let mut last_error: Option<String> = None;

    for (interface, endpoint) in targets {
        if let Ok(active) = handle.kernel_driver_active(interface) {
            if active {
                eprintln!(
                    "[Printer] Detaching kernel driver on interface {}",
                    interface
                );
                let _ = handle.detach_kernel_driver(interface);
            }
        }

        if let Err(e) = handle.claim_interface(interface) {
            last_error = Some(format!("Failed to claim interface {}: {}", interface, e));
            continue;
        }

        let write_result = handle.write_bulk(endpoint, data, Duration::from_secs(5));
        let _ = handle.release_interface(interface);

        match write_result {
            Ok(bytes_written) => {
                eprintln!(
                    "[Printer] {} bytes sent via interface {} endpoint 0x{:02x}",
                    bytes_written, interface, endpoint
                );
                return Ok(());
            }
            Err(e) => {
                last_error = Some(format!(
                    "Failed to write to interface {} endpoint 0x{:02x}: {}",
                    interface, endpoint, e
                ));
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "No usable USB interface/endpoint found".to_string()))
}

fn find_bulk_out_targets(handle: &DeviceHandle<GlobalContext>) -> Result<Vec<(u8, u8)>, String> {
    let device = handle.device();
    let config = device
        .active_config_descriptor()
        .map_err(|e| format!("Failed to get config descriptor: {}", e))?;

    let mut targets: Vec<(u8, u8)> = Vec::new();

    for iface in config.interfaces() {
        for desc in iface.descriptors() {
            let interface_number = desc.interface_number();
            for ep in desc.endpoint_descriptors() {
                if ep.direction() == Direction::Out && ep.transfer_type() == TransferType::Bulk {
                    let candidate = (interface_number, ep.address());
                    if !targets.contains(&candidate) {
                        targets.push(candidate);
                    }
                }
            }
        }
    }

    if targets.is_empty() {
        // Conservative fallback for printers with incomplete descriptors.
        for ep in [0x01, 0x02, 0x03, 0x04] {
            targets.push((0, ep));
        }
    }

    Ok(targets)
}
