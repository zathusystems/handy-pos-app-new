use std::sync::mpsc;
use std::time::Duration;

use jni::objects::{JObject, JString, JValue};
use tauri::{command, WebviewWindow};

const ANDROID_BRIDGE_TIMEOUT: Duration = Duration::from_secs(120);
const ANDROID_BLUETOOTH_PERMISSION_REQUEST_CODE: i32 = 4107;
const ANDROID_BLUETOOTH_WRITE_CHUNK_SIZE: usize = 512;
const ANDROID_BLUETOOTH_WRITE_DELAY_MS: u64 = 50;
const ANDROID_BLUETOOTH_COPY_DELAY_MS: u64 = 350;
const BLUETOOTH_SPP_UUID: &str = "00001101-0000-1000-8000-00805F9B34FB";
const BLUETOOTH_PRINTER_MAJOR_CLASS: i32 = 0x0600;
const BLUETOOTH_PRINTER_KEYWORDS: &[&str] = &[
    "printer", "thermal", "receipt", "epson", "star", "sunmi", "xprinter", "bixolon", "rongta",
    "gprinter", "pos",
];

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct PrinterInfo {
    pub id: String,
    pub name: String,
    pub r#type: String,
    pub status: String,
    pub is_default: bool,
    pub description: Option<String>,
}

fn jni_error_message(
    env: &mut jni::JNIEnv<'_>,
    context: &str,
    fallback_error: impl ToString,
) -> String {
    if env.exception_check().unwrap_or(false) {
        let throwable = env.exception_occurred().ok();
        let _ = env.exception_clear();
        if let Some(throwable) = throwable {
            let message: Option<String> = env
                .call_method(&throwable, "getMessage", "()Ljava/lang/String;", &[])
                .ok()
                .and_then(|value| value.l().ok())
                .and_then(|obj| {
                    if obj.is_null() {
                        None
                    } else {
                        let jstr = JString::from(obj);
                        env.get_string(&jstr).ok().map(Into::into)
                    }
                });
            let class_name: Option<String> = env
                .call_method(&throwable, "getClass", "()Ljava/lang/Class;", &[])
                .ok()
                .and_then(|value| value.l().ok())
                .and_then(|clazz| {
                    env.call_method(clazz, "getSimpleName", "()Ljava/lang/String;", &[])
                        .ok()
                })
                .and_then(|value| value.l().ok())
                .and_then(|obj| {
                    if obj.is_null() {
                        None
                    } else {
                        let jstr = JString::from(obj);
                        env.get_string(&jstr).ok().map(Into::into)
                    }
                });

            if let Some(message) = message {
                if let Some(class_name) = class_name {
                    return format!("{context}: {class_name}: {message}");
                }
                return format!("{context}: {message}");
            }
        }
    }

    format!("{context}: {}", fallback_error.to_string())
}

fn friendly_bluetooth_error(message: String, action: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if lower.contains("bluetooth_connect")
        || lower.contains("bluetooth_scan")
        || lower.contains("nearby devices")
    {
        return format!("Allow Nearby devices permission and retry {action}.");
    }

    message
}

fn read_java_string(
    env: &mut jni::JNIEnv<'_>,
    obj: JObject<'_>,
    context: &str,
) -> Result<String, String> {
    if obj.is_null() {
        return Err(format!("{context}: Android returned an empty value"));
    }
    let jstr = JString::from(obj);
    env.get_string(&jstr)
        .map(Into::into)
        .map_err(|error| format!("{context}: {error}"))
}

fn normalize_bluetooth_address(value: &str) -> String {
    let trimmed = value.trim();
    let without_prefix = if trimmed
        .get(..3)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("bt:"))
    {
        &trimmed[3..]
    } else {
        trimmed
    };

    let hex_only: String = without_prefix
        .chars()
        .filter(|ch| ch.is_ascii_hexdigit())
        .collect::<String>()
        .to_ascii_uppercase();

    if hex_only.len() == 12 {
        return hex_only
            .as_bytes()
            .chunks(2)
            .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
            .collect::<Vec<_>>()
            .join(":");
    }

    without_prefix.replace('-', ":").to_ascii_uppercase()
}

fn get_android_sdk_int(env: &mut jni::JNIEnv<'_>) -> Result<i32, String> {
    env.get_static_field("android/os/Build$VERSION", "SDK_INT", "I")
        .map_err(|error| format!("Failed to read Android SDK version: {error}"))?
        .i()
        .map_err(|error| format!("Invalid Android SDK version response: {error}"))
}

fn get_required_bluetooth_permissions(sdk_int: i32) -> Vec<&'static str> {
    if sdk_int >= 31 {
        vec![
            "android.permission.BLUETOOTH_CONNECT",
            "android.permission.BLUETOOTH_SCAN",
        ]
    } else {
        vec![
            "android.permission.BLUETOOTH",
            "android.permission.BLUETOOTH_ADMIN",
            "android.permission.ACCESS_FINE_LOCATION",
        ]
    }
}

fn is_permission_granted(
    env: &mut jni::JNIEnv<'_>,
    activity: &JObject<'_>,
    permission: &str,
) -> Result<bool, String> {
    let permission_j = env
        .new_string(permission)
        .map_err(|error| format!("Failed to prepare Android permission {permission}: {error}"))?;
    let granted = env
        .get_static_field(
            "android/content/pm/PackageManager",
            "PERMISSION_GRANTED",
            "I",
        )
        .map_err(|error| format!("Failed to read Android permission state: {error}"))?
        .i()
        .map_err(|error| format!("Invalid Android permission state response: {error}"))?;
    let state = env
        .call_method(
            activity,
            "checkSelfPermission",
            "(Ljava/lang/String;)I",
            &[(&permission_j).into()],
        )
        .map_err(|error| {
            jni_error_message(
                env,
                &format!("Failed to check {permission} permission"),
                error,
            )
        })?
        .i()
        .map_err(|error| format!("Invalid {permission} permission response: {error}"))?;

    Ok(state == granted)
}

fn request_android_permissions(
    env: &mut jni::JNIEnv<'_>,
    activity: &JObject<'_>,
    permissions: &[&str],
) -> Result<(), String> {
    if permissions.is_empty() {
        return Ok(());
    }

    let permission_array = env
        .new_object_array(
            permissions.len() as i32,
            "java/lang/String",
            JObject::null(),
        )
        .map_err(|error| format!("Failed to prepare Android permission request: {error}"))?;

    for (index, permission) in permissions.iter().enumerate() {
        let permission_j = env.new_string(*permission).map_err(|error| {
            format!("Failed to prepare Android permission {permission}: {error}")
        })?;
        env.set_object_array_element(&permission_array, index as i32, &permission_j)
            .map_err(|error| format!("Failed to queue Android permission {permission}: {error}"))?;
    }

    env.call_method(
        activity,
        "requestPermissions",
        "([Ljava/lang/String;I)V",
        &[
            (&permission_array).into(),
            JValue::Int(ANDROID_BLUETOOTH_PERMISSION_REQUEST_CODE),
        ],
    )
    .map_err(|error| jni_error_message(env, "Failed to request Bluetooth permissions", error))?;

    Ok(())
}

fn ensure_bluetooth_permissions(
    env: &mut jni::JNIEnv<'_>,
    activity: &JObject<'_>,
    action: &str,
) -> Result<(), String> {
    let sdk_int = get_android_sdk_int(env)?;
    let required_permissions = get_required_bluetooth_permissions(sdk_int);
    let mut missing_permissions = Vec::new();

    for permission in required_permissions {
        if !is_permission_granted(env, activity, permission)? {
            missing_permissions.push(permission);
        }
    }

    if missing_permissions.is_empty() {
        return Ok(());
    }

    request_android_permissions(env, activity, &missing_permissions)?;

    Err(format!(
        "Bluetooth permission requested. Allow Nearby devices permission and retry {action}."
    ))
}

fn is_likely_printer_name(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    BLUETOOTH_PRINTER_KEYWORDS
        .iter()
        .any(|keyword| lower.contains(keyword))
}

fn get_bluetooth_adapter<'local>(env: &mut jni::JNIEnv<'local>) -> Result<JObject<'local>, String> {
    let adapter = env
        .call_static_method(
            "android/bluetooth/BluetoothAdapter",
            "getDefaultAdapter",
            "()Landroid/bluetooth/BluetoothAdapter;",
            &[],
        )
        .map_err(|error| jni_error_message(env, "Failed to access Bluetooth adapter", error))?
        .l()
        .map_err(|error| format!("Invalid Bluetooth adapter response: {error}"))?;

    if adapter.is_null() {
        return Err("Bluetooth is not supported on this device.".to_string());
    }

    Ok(adapter)
}

fn ensure_bluetooth_enabled(
    env: &mut jni::JNIEnv<'_>,
    adapter: &JObject<'_>,
) -> Result<(), String> {
    let is_enabled = env
        .call_method(adapter, "isEnabled", "()Z", &[])
        .map_err(|error| {
            friendly_bluetooth_error(
                jni_error_message(env, "Failed to read Bluetooth state", error),
                "printer scan",
            )
        })?
        .z()
        .map_err(|error| format!("Invalid Bluetooth state response: {error}"))?;

    if !is_enabled {
        return Err("Bluetooth is turned off. Turn it on and retry printer scan.".to_string());
    }

    Ok(())
}

fn is_likely_printer_device(
    env: &mut jni::JNIEnv<'_>,
    device: &JObject<'_>,
    name: &str,
) -> Result<bool, String> {
    if is_likely_printer_name(name) {
        return Ok(true);
    }

    let bluetooth_class = env
        .call_method(
            device,
            "getBluetoothClass",
            "()Landroid/bluetooth/BluetoothClass;",
            &[],
        )
        .map_err(|error| jni_error_message(env, "Failed to inspect Bluetooth device class", error))?
        .l()
        .map_err(|error| format!("Invalid Bluetooth class response: {error}"))?;

    if bluetooth_class.is_null() {
        return Ok(false);
    }

    let major_class = env
        .call_method(&bluetooth_class, "getMajorDeviceClass", "()I", &[])
        .map_err(|error| {
            jni_error_message(env, "Failed to inspect Bluetooth major device class", error)
        })?
        .i()
        .map_err(|error| format!("Invalid Bluetooth major class response: {error}"))?;

    Ok(major_class == BLUETOOTH_PRINTER_MAJOR_CLASS)
}

fn close_java_resource(env: &mut jni::JNIEnv<'_>, object: &JObject<'_>) {
    if object.is_null() {
        return;
    }

    let _ = env.call_method(object, "close", "()V", &[]);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
    }
}

fn create_bluetooth_socket<'local>(
    env: &mut jni::JNIEnv<'local>,
    device: &JObject<'local>,
    uuid: &JObject<'local>,
    insecure: bool,
) -> Result<JObject<'local>, String> {
    let method_name = if insecure {
        "createInsecureRfcommSocketToServiceRecord"
    } else {
        "createRfcommSocketToServiceRecord"
    };

    env.call_method(
        device,
        method_name,
        "(Ljava/util/UUID;)Landroid/bluetooth/BluetoothSocket;",
        &[uuid.into()],
    )
    .map_err(|error| jni_error_message(env, "Failed to create Bluetooth socket", error))?
    .l()
    .map_err(|error| format!("Invalid Bluetooth socket response: {error}"))
}

fn write_escpos_to_socket(
    env: &mut jni::JNIEnv<'_>,
    socket: &JObject<'_>,
    payload: &jni::objects::JByteArray<'_>,
    payload_len: usize,
    copies: i32,
) -> Result<(), String> {
    env.call_method(socket, "connect", "()V", &[])
        .map_err(|error| jni_error_message(env, "Failed to connect to Bluetooth printer", error))?;

    let output_stream = env
        .call_method(socket, "getOutputStream", "()Ljava/io/OutputStream;", &[])
        .map_err(|error| {
            jni_error_message(env, "Failed to access Bluetooth printer stream", error)
        })?
        .l()
        .map_err(|error| format!("Invalid Bluetooth output stream response: {error}"))?;

    let write_result = (|| {
        for copy_index in 0..copies.max(1) {
            let mut offset = 0usize;
            while offset < payload_len {
                let chunk_len =
                    ANDROID_BLUETOOTH_WRITE_CHUNK_SIZE.min(payload_len.saturating_sub(offset));

                env.call_method(
                    &output_stream,
                    "write",
                    "([BII)V",
                    &[
                        payload.into(),
                        JValue::Int(offset as i32),
                        JValue::Int(chunk_len as i32),
                    ],
                )
                .map_err(|error| {
                    jni_error_message(env, "Failed to write receipt to Bluetooth printer", error)
                })?;
                env.call_method(&output_stream, "flush", "()V", &[])
                    .map_err(|error| {
                        jni_error_message(env, "Failed to flush Bluetooth printer output", error)
                    })?;

                offset += chunk_len;
                if offset < payload_len {
                    std::thread::sleep(Duration::from_millis(ANDROID_BLUETOOTH_WRITE_DELAY_MS));
                }
            }

            if copy_index < copies.max(1) - 1 {
                std::thread::sleep(Duration::from_millis(ANDROID_BLUETOOTH_COPY_DELAY_MS));
            }
        }

        Ok(())
    })();

    close_java_resource(env, &output_stream);
    write_result
}

fn print_to_bluetooth_printer(
    env: &mut jni::JNIEnv<'_>,
    printer_id: &str,
    escpos_data: &[u8],
    copies: i32,
) -> Result<(), String> {
    let adapter = get_bluetooth_adapter(env)?;
    ensure_bluetooth_enabled(env, &adapter)?;

    let normalized_address = normalize_bluetooth_address(printer_id);
    if normalized_address.is_empty() {
        return Err("Bluetooth printer address is empty.".to_string());
    }

    let address_j = env
        .new_string(normalized_address.clone())
        .map_err(|error| format!("Failed to prepare Bluetooth printer address: {error}"))?;
    let device = env
        .call_method(
            &adapter,
            "getRemoteDevice",
            "(Ljava/lang/String;)Landroid/bluetooth/BluetoothDevice;",
            &[(&address_j).into()],
        )
        .map_err(|error| {
            friendly_bluetooth_error(
                jni_error_message(env, "Failed to resolve Bluetooth printer", error),
                "printing",
            )
        })?
        .l()
        .map_err(|error| format!("Invalid Bluetooth printer response: {error}"))?;

    if device.is_null() {
        return Err(format!(
            "Bluetooth printer {normalized_address} could not be resolved."
        ));
    }

    let uuid_j = env
        .new_string(BLUETOOTH_SPP_UUID)
        .map_err(|error| format!("Failed to prepare Bluetooth printer UUID: {error}"))?;
    let uuid = env
        .call_static_method(
            "java/util/UUID",
            "fromString",
            "(Ljava/lang/String;)Ljava/util/UUID;",
            &[(&uuid_j).into()],
        )
        .map_err(|error| jni_error_message(env, "Failed to prepare Bluetooth printer UUID", error))?
        .l()
        .map_err(|error| format!("Invalid Bluetooth UUID response: {error}"))?;

    let _ = env.call_method(&adapter, "cancelDiscovery", "()Z", &[]);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
    }

    let payload = env
        .byte_array_from_slice(escpos_data)
        .map_err(|error| format!("Failed to prepare ESC/POS payload: {error}"))?;
    let payload_len = escpos_data.len();

    let mut last_error: Option<String> = None;

    for insecure in [false, true] {
        let socket = match create_bluetooth_socket(env, &device, &uuid, insecure) {
            Ok(socket) => socket,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };

        let print_result = write_escpos_to_socket(env, &socket, &payload, payload_len, copies);
        close_java_resource(env, &socket);

        match print_result {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "Bluetooth print failed.".to_string()))
}

fn run_with_android_context<T, F>(window: WebviewWindow, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut jni::JNIEnv<'_>, &JObject<'_>, &JObject<'_>) -> Result<T, String>
        + Send
        + 'static,
{
    let (tx, rx) = mpsc::channel();

    window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, webview| {
                let result = operation(env, activity, webview);
                let _ = tx.send(result);
            });
        })
        .map_err(|error| format!("Failed to access Android webview context: {error}"))?;

    rx.recv_timeout(ANDROID_BRIDGE_TIMEOUT)
        .map_err(|_| "Timed out waiting for Android Bluetooth operation".to_string())?
}

#[command]
pub fn get_printers(window: WebviewWindow) -> Result<Vec<PrinterInfo>, String> {
    run_with_android_context(window, |env, activity, _| {
        ensure_bluetooth_permissions(env, activity, "printer scan")
            .map_err(|error| friendly_bluetooth_error(error, "printer scan"))?;

        let adapter = get_bluetooth_adapter(env)?;
        ensure_bluetooth_enabled(env, &adapter)?;

        let bonded_devices = env
            .call_method(&adapter, "getBondedDevices", "()Ljava/util/Set;", &[])
            .map_err(|error| {
                friendly_bluetooth_error(
                    jni_error_message(env, "Failed to query paired Bluetooth devices", error),
                    "printer scan",
                )
            })?
            .l()
            .map_err(|error| format!("Invalid paired Bluetooth device response: {error}"))?;

        if bonded_devices.is_null() {
            return Ok(Vec::new());
        }

        let iterator = env
            .call_method(&bonded_devices, "iterator", "()Ljava/util/Iterator;", &[])
            .map_err(|error| jni_error_message(env, "Failed to iterate Bluetooth devices", error))?
            .l()
            .map_err(|error| format!("Invalid Bluetooth iterator response: {error}"))?;

        let mut printers = Vec::new();

        loop {
            let has_next = env
                .call_method(&iterator, "hasNext", "()Z", &[])
                .map_err(|error| {
                    jni_error_message(env, "Failed to inspect Bluetooth device iterator", error)
                })?
                .z()
                .map_err(|error| format!("Invalid Bluetooth iterator state: {error}"))?;

            if !has_next {
                break;
            }

            let device = env
                .call_method(&iterator, "next", "()Ljava/lang/Object;", &[])
                .map_err(|error| jni_error_message(env, "Failed to read Bluetooth device", error))?
                .l()
                .map_err(|error| format!("Invalid Bluetooth device response: {error}"))?;

            if device.is_null() {
                continue;
            }

            let name = env
                .call_method(&device, "getName", "()Ljava/lang/String;", &[])
                .map_err(|error| {
                    friendly_bluetooth_error(
                        jni_error_message(env, "Failed to read Bluetooth device name", error),
                        "printer scan",
                    )
                })
                .and_then(|value| {
                    read_java_string(
                        env,
                        value
                            .l()
                            .map_err(|error| format!("Invalid Bluetooth device name: {error}"))?,
                        "Failed to read Bluetooth device name",
                    )
                })?;

            if !is_likely_printer_device(env, &device, &name)? {
                continue;
            }

            let address = env
                .call_method(&device, "getAddress", "()Ljava/lang/String;", &[])
                .map_err(|error| {
                    friendly_bluetooth_error(
                        jni_error_message(env, "Failed to read Bluetooth device address", error),
                        "printer scan",
                    )
                })
                .and_then(|value| {
                    read_java_string(
                        env,
                        value.l().map_err(|error| {
                            format!("Invalid Bluetooth device address response: {error}")
                        })?,
                        "Failed to read Bluetooth device address",
                    )
                })?;

            let normalized_address = normalize_bluetooth_address(&address);
            if normalized_address.is_empty() {
                continue;
            }

            let display_name = if name.trim().is_empty() {
                format!("Bluetooth Printer {normalized_address}")
            } else {
                name.trim().to_string()
            };

            printers.push(PrinterInfo {
                id: format!("bt:{normalized_address}"),
                name: display_name,
                r#type: "bluetooth_thermal".to_string(),
                status: "ready".to_string(),
                is_default: printers.is_empty(),
                description: Some("Paired Bluetooth printer".to_string()),
            });
        }

        Ok(printers)
    })
}

#[command]
pub fn print_receipt(
    window: WebviewWindow,
    html: String,
    printer_id: String,
    copies: i32,
    paper_size: Option<String>,
    printer_paper_width: Option<String>,
) -> Result<String, String> {
    run_with_android_context(window, move |env, activity, _| {
        ensure_bluetooth_permissions(env, activity, "printing")
            .map_err(|error| friendly_bluetooth_error(error, "printing"))?;

        let escpos_data = super::receipt_formatter::build_escpos_receipt(
            &html,
            paper_size.as_deref(),
            printer_paper_width.as_deref(),
        );
        let normalized_printer_id = normalize_bluetooth_address(&printer_id);

        print_to_bluetooth_printer(env, &normalized_printer_id, &escpos_data, copies)
            .map_err(|error| friendly_bluetooth_error(error, "printing"))?;

        Ok("success".to_string())
    })
}
