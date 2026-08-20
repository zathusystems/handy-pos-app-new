// Shared receipt formatter used by desktop and Android print paths.
// Keep this module platform-neutral so both targets produce matching ESC/POS output.

pub const DEFAULT_RECEIPT_LINE_WIDTH: usize = 42;
pub const COMPACT_RECEIPT_LINE_WIDTH: usize = 32;

pub fn resolve_line_width(paper_size: Option<&str>) -> usize {
    match paper_size.map(|value| value.trim().to_ascii_lowercase()) {
        Some(value) if value == "58mm" || value == "58" => COMPACT_RECEIPT_LINE_WIDTH,
        _ => DEFAULT_RECEIPT_LINE_WIDTH,
    }
}

pub fn build_escpos_receipt(
    html: &str,
    paper_size: Option<&str>,
    printer_paper_width: Option<&str>,
) -> Vec<u8> {
    let (line_width, horizontal_offset) = resolve_receipt_layout(paper_size, printer_paper_width);

    html_to_escpos(html, line_width, horizontal_offset)
}

pub fn resolve_receipt_layout(
    paper_size: Option<&str>,
    printer_paper_width: Option<&str>,
) -> (usize, usize) {
    let line_width = resolve_line_width(paper_size);
    let printer_line_width = resolve_line_width(printer_paper_width);
    let horizontal_offset = printer_line_width.saturating_sub(line_width) / 2;

    (line_width, horizontal_offset)
}

#[derive(Clone, Copy)]
struct ReceiptTextStyle {
    size_mode: u8,
    bold: bool,
}

#[derive(Clone, Copy)]
struct ReceiptPrintStyles {
    business_name: ReceiptTextStyle,
    header_detail: ReceiptTextStyle,
    legal_marker: ReceiptTextStyle,
}

impl ReceiptPrintStyles {
    fn from_html(html: &str) -> Self {
        let business_size = escpos_size_mode(
            extract_data_attr_number(html, "data-receipt-business-name-font-size"),
            extract_data_attr_number(html, "data-receipt-business-name-scale-x"),
            18.0,
            1.28,
        );
        let legal_size = escpos_size_mode(
            extract_data_attr_number(html, "data-receipt-legal-marker-font-size"),
            extract_data_attr_number(html, "data-receipt-legal-marker-scale-x"),
            13.0,
            1.0,
        );
        let header_detail_size = escpos_size_mode(
            None,
            extract_data_attr_number(html, "data-receipt-header-detail-scale-x"),
            13.0,
            1.0,
        );

        Self {
            business_name: ReceiptTextStyle {
                size_mode: business_size,
                bold: receipt_weight_is_bold(
                    extract_data_attr_number(html, "data-receipt-business-name-font-weight"),
                    true,
                ),
            },
            header_detail: ReceiptTextStyle {
                size_mode: header_detail_size,
                bold: false,
            },
            legal_marker: ReceiptTextStyle {
                size_mode: legal_size,
                bold: receipt_weight_is_bold(
                    extract_data_attr_number(html, "data-receipt-legal-marker-font-weight"),
                    false,
                ),
            },
        }
    }
}

fn escpos_size_mode(
    font_size: Option<f64>,
    scale_x: Option<f64>,
    default_font_size: f64,
    default_scale_x: f64,
) -> u8 {
    let font_size = font_size.unwrap_or(default_font_size);
    let scale_x = scale_x.unwrap_or(default_scale_x);

    let width_multiplier = if scale_x >= 1.65 {
        3
    } else if scale_x >= 1.15 {
        2
    } else {
        1
    };
    let height_multiplier = if font_size >= 22.0 {
        3
    } else if font_size >= 15.0 {
        2
    } else {
        1
    };

    (((width_multiplier - 1) << 4) | (height_multiplier - 1)) as u8
}

fn receipt_weight_is_bold(weight: Option<f64>, fallback: bool) -> bool {
    weight.map(|value| value >= 600.0).unwrap_or(fallback)
}

fn extract_data_attr_number(html: &str, attr_name: &str) -> Option<f64> {
    extract_data_attr_value(html, attr_name)?
        .trim()
        .parse::<f64>()
        .ok()
}

fn extract_data_attr_value(html: &str, attr_name: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let needle = format!("{attr_name}={quote}");
        let Some(found) = html.find(&needle) else {
            continue;
        };
        let start = found + needle.len();
        let tail = &html[start..];
        if let Some(end) = tail.find(quote) {
            return Some(tail[..end].to_string());
        }
    }

    None
}

// HTML -> ESC/POS conversion with basic layout preservation.
pub fn html_to_escpos(html: &str, line_width: usize, horizontal_offset: usize) -> Vec<u8> {
    let mut data = Vec::new();
    data.extend_from_slice(b"\x1B\x40"); // Initialize printer
    data.extend_from_slice(b"\x1B\x74\x00"); // Code page
    data.extend_from_slice(b"\x1B\x21\x00"); // Normal mode
    data.extend_from_slice(b"\x1B\x32"); // Restore default line spacing

    let print_styles = ReceiptPrintStyles::from_html(html);
    let printable_text = html_to_printable_text(html, line_width);
    let mut emphasized_company_name = false;
    let mut allow_company_name_detection = true;
    let mut in_header_details = false;
    let mut end_legal_receipt_marker: Option<String> = None;

    for line in printable_text.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();

        if is_start_legal_receipt_marker(trimmed) {
            append_styled_centered_text_line(
                &mut data,
                trimmed,
                line_width,
                horizontal_offset,
                print_styles.legal_marker,
            );
            continue;
        }

        if is_end_legal_receipt_marker(trimmed) {
            end_legal_receipt_marker = Some(trimmed.to_string());
            continue;
        }

        if is_vat_registration_marker(trimmed) {
            in_header_details = false;
            append_centered_text_line(&mut data, trimmed, line_width, horizontal_offset);
            continue;
        }

        if allow_company_name_detection
            && (lower.starts_with("order #:")
                || lower.starts_with("date:")
                || lower.starts_with("cashier:")
                || lower.starts_with("payment:")
                || lower.starts_with("fiscal invoice:"))
        {
            allow_company_name_detection = false;
        }

        if allow_company_name_detection
            && !emphasized_company_name
            && is_company_name_candidate(trimmed)
        {
            append_company_name_banner(&mut data, trimmed, line_width, print_styles.business_name);
            emphasized_company_name = true;
            in_header_details = true;
            continue;
        }

        if in_header_details {
            if lower.starts_with("**vat registered")
                || lower.starts_with("**non vat registered")
                || lower.starts_with("buyer")
                || lower.starts_with("receipt number")
                || is_dotted_rule(trimmed)
            {
                in_header_details = false;
            } else {
                append_styled_centered_text_line(
                    &mut data,
                    trimmed,
                    line_width,
                    horizontal_offset,
                    print_styles.header_detail,
                );
                continue;
            }
        }

        let line_with_offset = if horizontal_offset > 0 && !line.trim().is_empty() {
            format!("{}{}", " ".repeat(horizontal_offset), line)
        } else {
            line.to_string()
        };

        data.extend_from_slice(line_with_offset.as_bytes());
        data.extend_from_slice(b"\n");
    }

    let mut has_qr = false;
    if let Some(qr_payload) = extract_qr_payload(html) {
        append_qr_code(
            &mut data,
            &qr_payload,
            horizontal_offset,
            line_width,
            extract_data_attr_number(html, "data-receipt-qr-code-size"),
        );
        has_qr = true;
    }

    if let Some(marker) = end_legal_receipt_marker {
        append_styled_centered_text_line(
            &mut data,
            &marker,
            line_width,
            horizontal_offset,
            print_styles.legal_marker,
        );
    }

    append_feed_and_cut(&mut data, has_qr);
    data
}

fn is_receipt_section_title(line: &str) -> bool {
    matches!(
        line.trim().to_ascii_lowercase().as_str(),
        "company info"
            | "order info"
            | "eis compliance"
            | "item breakdown"
            | "tax breakdown"
            | "payment totals"
            | "footer"
    )
}

fn is_divider_line(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty() && trimmed.chars().all(|c| matches!(c, '-' | '=' | '*' | '.'))
}

fn is_dotted_rule(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty()
        && trimmed.chars().count() >= 8
        && trimmed.chars().all(|c| c == '.' || c == '-')
}

fn is_section_heading(line: &str) -> bool {
    matches!(
        line.trim().to_ascii_lowercase().as_str(),
        "invoice" | "buyer details" | "items" | "total amount" | "tax summary"
    )
}

fn is_copy_marker_line(line: &str) -> bool {
    let normalized = line.trim().trim_matches('*').trim().to_ascii_lowercase();

    normalized == "copy"
        || normalized.starts_with("copy #")
        || normalized == "original"
        || normalized.starts_with("original #")
}

fn normalize_legal_marker(line: &str) -> String {
    line.trim().trim_matches('*').trim().to_ascii_lowercase()
}

fn is_start_legal_receipt_marker(line: &str) -> bool {
    normalize_legal_marker(line) == "start of legal receipt"
}

fn is_end_legal_receipt_marker(line: &str) -> bool {
    normalize_legal_marker(line) == "end of legal receipt"
}

fn is_legal_receipt_marker(line: &str) -> bool {
    is_start_legal_receipt_marker(line) || is_end_legal_receipt_marker(line)
}

fn is_vat_registration_marker(line: &str) -> bool {
    let lower = line.trim().to_ascii_lowercase();
    lower.starts_with("**vat registered") || lower.starts_with("**non vat registered")
}

fn is_receipt2_buyer_or_number_line(line: &str) -> bool {
    let lower = line.trim().to_ascii_lowercase();
    lower.starts_with("buyer's ")
        || lower.starts_with("buyers ")
        || lower.starts_with("buyer ")
        || lower.starts_with("receipt number")
}

fn is_company_name_candidate(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty()
        && !is_divider_line(trimmed)
        && !is_receipt_section_title(trimmed)
        && !is_copy_marker_line(trimmed)
        && !is_legal_receipt_marker(trimmed)
        && !trimmed.contains(':')
}

fn truncate_with_suffix(value: &str, max_chars: usize) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= max_chars {
        return value.to_string();
    }

    if max_chars <= 3 {
        return ".".repeat(max_chars);
    }

    let mut out: String = chars.into_iter().take(max_chars - 3).collect();
    out.push_str("...");
    out
}

fn append_company_name_banner(
    data: &mut Vec<u8>,
    name: &str,
    line_width: usize,
    style: ReceiptTextStyle,
) {
    let clean_name = collapse_spaces_preserve_tabs(name);
    if clean_name.is_empty() {
        return;
    }

    let name_len = clean_name.chars().count();

    let display_name: String = if name_len <= 20 {
        clean_name
    } else {
        truncate_with_suffix(&clean_name, line_width)
    };

    data.extend_from_slice(b"\x1B\x61\x01"); // center align
    if style.bold {
        data.extend_from_slice(b"\x1B\x45\x01"); // bold on
    }
    data.extend_from_slice(&[0x1D, 0x21, style.size_mode]); // text size
    data.extend_from_slice(display_name.as_bytes());
    data.extend_from_slice(b"\n");
    data.extend_from_slice(b"\x1D\x21\x00"); // normal size
    if style.bold {
        data.extend_from_slice(b"\x1B\x45\x00"); // bold off
    }
    data.extend_from_slice(b"\x1B\x61\x00"); // left align
}

fn append_centered_text_line(
    data: &mut Vec<u8>,
    text: &str,
    line_width: usize,
    horizontal_offset: usize,
) {
    let centered = center_text(text, line_width);
    let line = if horizontal_offset > 0 {
        format!("{}{}", " ".repeat(horizontal_offset), centered)
    } else {
        centered
    };

    data.extend_from_slice(line.as_bytes());
    data.extend_from_slice(b"\n");
}

fn append_styled_centered_text_line(
    data: &mut Vec<u8>,
    text: &str,
    line_width: usize,
    horizontal_offset: usize,
    style: ReceiptTextStyle,
) {
    if style.size_mode == 0 && !style.bold {
        append_centered_text_line(data, text, line_width, horizontal_offset);
        return;
    }

    data.extend_from_slice(b"\x1B\x61\x01"); // center align
    if style.bold {
        data.extend_from_slice(b"\x1B\x45\x01"); // bold on
    }
    data.extend_from_slice(&[0x1D, 0x21, style.size_mode]); // text size
    data.extend_from_slice(text.trim().as_bytes());
    data.extend_from_slice(b"\n");
    data.extend_from_slice(b"\x1D\x21\x00"); // normal size
    if style.bold {
        data.extend_from_slice(b"\x1B\x45\x00"); // bold off
    }
    data.extend_from_slice(b"\x1B\x61\x00"); // left align
}

fn append_feed_and_cut(data: &mut Vec<u8>, has_qr: bool) {
    // Keep feed short so the cutter triggers soon after the last printed block.
    // QR codes still need a little trailing paper to avoid clipping.
    let feed_lines: u8 = if has_qr { 3 } else { 2 };
    data.extend_from_slice(&[0x1B, 0x64, feed_lines]); // Print buffer and feed n lines
    data.extend_from_slice(b"\x1D\x56\x00"); // Full cut
}

fn html_to_printable_text(html: &str, line_width: usize) -> String {
    let prepared = html
        .replace("</span><span", "</span>\t<span")
        .replace("</span> <span", "</span>\t<span")
        .replace("</span>\n<span", "</span>\t<span");

    let mut out = String::new();
    let mut chars = prepared.chars().peekable();
    let mut skip_tag_contents: Option<String> = None;

    while let Some(ch) = chars.next() {
        if ch == '<' {
            let mut tag_raw = String::new();
            for next in chars.by_ref() {
                if next == '>' {
                    break;
                }
                tag_raw.push(next);
            }

            let tag_trimmed = tag_raw.trim().to_lowercase();
            let is_closing = tag_trimmed.starts_with('/');
            let tag_name = if is_closing {
                tag_trimmed
                    .trim_start_matches('/')
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
            } else {
                tag_trimmed.split_whitespace().next().unwrap_or("")
            };

            if let Some(skipped) = skip_tag_contents.as_ref() {
                if is_closing && tag_name == skipped {
                    skip_tag_contents = None;
                }
                continue;
            }

            if !is_closing && (tag_name == "style" || tag_name == "script" || tag_name == "svg") {
                skip_tag_contents = Some(tag_name.to_string());
                continue;
            }

            if tag_name == "br" {
                push_newline(&mut out);
                continue;
            }

            if !is_closing && tag_name == "div" && tag_trimmed.contains("receipt2-break") {
                push_blank_line(&mut out);
                continue;
            }

            if matches!(
                tag_name,
                "div"
                    | "p"
                    | "h1"
                    | "h2"
                    | "h3"
                    | "h4"
                    | "h5"
                    | "h6"
                    | "li"
                    | "tr"
                    | "table"
                    | "section"
                    | "header"
                    | "footer"
                    | "ul"
                    | "ol"
            ) {
                push_newline(&mut out);
                continue;
            }

            if tag_name == "td" || tag_name == "th" {
                push_tab(&mut out);
                continue;
            }

            if tag_name == "hr" {
                push_newline(&mut out);
                out.push_str(&"-".repeat(line_width));
                push_newline(&mut out);
            }
        } else if skip_tag_contents.is_none() {
            out.push(ch);
        }
    }

    let decoded = decode_html_entities(&out);
    normalize_receipt_text_with_width(&decoded, line_width)
}

fn push_newline(out: &mut String) {
    if !out.ends_with('\n') {
        out.push('\n');
    }
}

fn push_blank_line(out: &mut String) {
    if out.is_empty() {
        return;
    }
    if out.ends_with("\n\n") {
        return;
    }
    if out.ends_with('\n') {
        out.push('\n');
    } else {
        out.push_str("\n\n");
    }
}

fn push_tab(out: &mut String) {
    if out.ends_with('\n') || out.ends_with('\t') {
        return;
    }
    if out.ends_with(' ') {
        let _ = out.pop();
    }
    out.push('\t');
}

fn decode_html_entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

fn collapse_spaces_preserve_tabs(input: &str) -> String {
    let mut out = String::new();
    let mut prev_space = false;

    for ch in input.chars() {
        if ch == '\t' {
            if out.ends_with(' ') {
                let _ = out.pop();
            }
            if !out.ends_with('\t') {
                out.push('\t');
            }
            prev_space = false;
        } else if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }

    out.trim().to_string()
}

fn align_left_right(left: &str, right: &str, width: usize) -> String {
    let left = left.trim();
    let right = right.trim();

    if left.is_empty() {
        return right.to_string();
    }
    if right.is_empty() {
        return left.to_string();
    }

    let left_len = left.chars().count();
    let right_len = right.chars().count();
    if left_len + right_len + 1 >= width {
        format!("{} {}", left, right)
    } else {
        let spaces = " ".repeat(width - left_len - right_len);
        format!("{}{}{}", left, spaces, right)
    }
}

fn center_text(text: &str, width: usize) -> String {
    let value = text.trim();
    let len = value.chars().count();
    if len >= width {
        return value.to_string();
    }
    let pad_left = (width - len) / 2;
    format!("{}{}", " ".repeat(pad_left), value)
}

fn looks_like_amount(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }

    let has_digit = trimmed.chars().any(|c| c.is_ascii_digit());
    let has_money_marker = trimmed.contains('.')
        || trimmed.contains(',')
        || trimmed.contains('$')
        || trimmed.contains('€')
        || trimmed.contains('£')
        || trimmed.contains('R');

    has_digit && has_money_marker
}

fn align_label_value(line: &str, width: usize) -> Option<String> {
    let colon_index = line.find(':')?;
    let label = line[..=colon_index].trim();
    let value = line[colon_index + 1..].trim();
    if label.is_empty() || value.is_empty() {
        return None;
    }
    Some(align_left_right(label, value, width))
}

fn looks_like_item_detail(line: &str) -> bool {
    let trimmed = line.trim();
    let mut chars = trimmed.chars();
    let first_is_digit = chars.next().map(|c| c.is_ascii_digit()).unwrap_or(false);
    first_is_digit && trimmed.contains('x')
}

fn is_amount_chunk(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() || !trimmed.chars().any(|c| c.is_ascii_digit()) {
        return false;
    }

    trimmed.chars().all(|c| {
        c.is_ascii_digit()
            || c.is_whitespace()
            || matches!(
                c,
                '.' | ',' | '$' | '€' | '£' | '-' | '+' | '(' | ')' | ':' | '%'
            )
            || matches!(c, 'R' | 'r' | 'S' | 's' | 'M' | 'm' | 'U' | 'u')
    })
}

fn split_trailing_amount(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    let mut best: Option<(String, String, usize)> = None;

    for (idx, ch) in trimmed.char_indices() {
        if !ch.is_whitespace() {
            continue;
        }

        let left = trimmed[..idx].trim();
        let right = trimmed[idx + ch.len_utf8()..].trim();
        if left.is_empty() || right.is_empty() || !is_amount_chunk(right) {
            continue;
        }

        let score = right.chars().count();
        match &best {
            Some((_, _, best_score)) if *best_score >= score => {}
            _ => best = Some((left.to_string(), right.to_string(), score)),
        }
    }

    best.map(|(left, right, _)| (left, right))
}

fn split_item_count_tail(line: &str) -> Option<(String, String)> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    if tokens.len() < 2 {
        return None;
    }

    let last = tokens[tokens.len() - 1];
    let prev = tokens[tokens.len() - 2];
    let last_lower = last.to_lowercase();
    if !(last_lower == "item" || last_lower == "items") {
        return None;
    }
    if !prev.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }

    let left = tokens[..tokens.len() - 2].join(" ");
    if left.trim().is_empty() {
        return None;
    }

    Some((left, format!("{} {}", prev, last)))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReceiptSection {
    Copy,
    Company,
    OrderInfo,
    Eis,
    Items,
    Tax,
    Totals,
    Footer,
    Other,
}

fn infer_section(line: &str, current: ReceiptSection) -> ReceiptSection {
    let lower = line.trim().to_lowercase();

    if lower.is_empty() {
        return current;
    }
    if lower.contains("*** copy #") || is_copy_marker_line(&lower) {
        return ReceiptSection::Copy;
    }
    if is_receipt2_buyer_or_number_line(line) || is_vat_registration_marker(line) {
        return ReceiptSection::Other;
    }
    if lower.starts_with("order #:")
        || lower.starts_with("receipt no:")
        || lower.starts_with("date:")
        || lower.starts_with("cashier:")
        || lower.starts_with("payment:")
        || lower == "invoice"
    {
        return ReceiptSection::OrderInfo;
    }
    if lower == "buyer details" {
        return ReceiptSection::Other;
    }
    if lower.starts_with("fiscal invoice:")
        || lower.starts_with("transmission:")
        || lower.starts_with("eis status:")
        || lower.starts_with("eis uuid:")
        || lower.starts_with("submitted at:")
        || lower.starts_with("seller tin:")
        || lower.starts_with("signature:")
    {
        return ReceiptSection::Eis;
    }
    if lower == "item total" || lower == "item" || lower == "total item" {
        return ReceiptSection::Items;
    }
    if lower == "items" {
        return ReceiptSection::Items;
    }
    if lower.starts_with("tax breakdown")
        || lower.starts_with("vat summary")
        || lower == "tax summary"
        || lower.starts_with("vat @")
        || lower.starts_with("vat ")
        || lower.starts_with("taxable ")
        || lower.starts_with("taxable value:")
        || lower.starts_with("taxable:")
        || lower.starts_with("vat amount:")
        || lower.starts_with("total vat")
    {
        return ReceiptSection::Tax;
    }
    if lower.starts_with("subtotal:")
        || lower.starts_with("vat (")
        || lower.starts_with("total vat:")
        || lower == "total amount"
        || lower.starts_with("tip:")
        || lower.starts_with("total payable:")
        || lower.starts_with("total:")
        || lower.starts_with("amount tendered")
        || lower.starts_with("change")
    {
        return ReceiptSection::Totals;
    }
    if lower.starts_with("thank you")
        || lower.starts_with("powered by")
        || lower.starts_with("scan:")
    {
        return ReceiptSection::Footer;
    }

    if current == ReceiptSection::Copy {
        return ReceiptSection::Company;
    }

    match current {
        ReceiptSection::Items => {
            if looks_like_item_detail(line)
                || line.contains('\t')
                || looks_like_amount(line)
                || split_trailing_amount(line).is_some()
            {
                ReceiptSection::Items
            } else {
                ReceiptSection::Other
            }
        }
        _ => current,
    }
}

fn format_line_by_section(
    line: &str,
    section: ReceiptSection,
    line_width: usize,
) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    if section == ReceiptSection::Copy {
        return Some(center_text(trimmed, line_width));
    }

    if section == ReceiptSection::Company {
        return Some(center_text(trimmed, line_width));
    }

    if is_dotted_rule(trimmed) || is_section_heading(trimmed) {
        return Some(center_text(trimmed, line_width));
    }

    // Normalize item heading rows produced by browser-rendered HTML.
    if matches!(section, ReceiptSection::Items)
        && (trimmed.eq_ignore_ascii_case("item total")
            || trimmed.eq_ignore_ascii_case("item")
            || trimmed.eq_ignore_ascii_case("total item"))
    {
        return Some(align_left_right("ITEM", "TOTAL", line_width));
    }
    if matches!(section, ReceiptSection::Tax)
        && (trimmed.to_lowercase().starts_with("tax breakdown")
            || trimmed.eq_ignore_ascii_case("vat summary"))
    {
        return None;
    }

    if trimmed.contains('\t') {
        let mut parts = trimmed
            .split('\t')
            .map(|p| p.trim())
            .filter(|p| !p.is_empty());
        let left = parts.next().unwrap_or("");
        let right = parts.next().unwrap_or("");
        if !left.is_empty() && !right.is_empty() {
            return Some(align_left_right(left, right, line_width));
        }
    }

    if section == ReceiptSection::Items {
        if let Some((left, right)) = split_trailing_amount(trimmed) {
            return Some(align_left_right(&left, &right, line_width));
        }
    }

    if section == ReceiptSection::Tax {
        if let Some((left, right)) = split_item_count_tail(trimmed) {
            return Some(align_left_right(&left, &right, line_width));
        }
        if let Some((left, right)) = split_trailing_amount(trimmed) {
            return Some(align_left_right(&left, &right, line_width));
        }
    }

    if section == ReceiptSection::Totals {
        if let Some((left, right)) = split_trailing_amount(trimmed) {
            return Some(align_left_right(&left, &right, line_width));
        }
    }

    if is_receipt2_buyer_or_number_line(trimmed) {
        return Some(trimmed.to_string());
    }

    if is_vat_registration_marker(trimmed) {
        return Some(center_text(trimmed, line_width));
    }

    if let Some(aligned) = align_label_value(trimmed, line_width) {
        return Some(aligned);
    }

    if section == ReceiptSection::Items && looks_like_item_detail(trimmed) {
        return Some(format!("  {}", trimmed));
    }

    if section == ReceiptSection::Totals && looks_like_amount(trimmed) {
        return Some(align_left_right("", trimmed, line_width));
    }

    if section == ReceiptSection::Footer {
        return Some(center_text(trimmed, line_width));
    }

    Some(trimmed.to_string())
}

fn apply_professional_grouping(lines: Vec<String>, line_width: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = ReceiptSection::Company;

    for line in lines {
        if line.trim().is_empty() {
            if out
                .last()
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
            {
                out.push(String::new());
            }
            continue;
        }

        let next = infer_section(&line, current);
        current = next;

        if let Some(formatted) = format_line_by_section(&line, current, line_width) {
            out.push(formatted);
        }
    }

    out
}

fn wrap_line_hard(line: &str, line_width: usize) -> Vec<String> {
    if line_width == 0 {
        return vec![line.to_string()];
    }

    let line_len = line.chars().count();
    if line_len <= line_width {
        return vec![line.to_string()];
    }

    let mut wrapped: Vec<String> = Vec::new();
    let mut chunk = String::new();
    let mut chunk_len = 0usize;

    for ch in line.chars() {
        chunk.push(ch);
        chunk_len += 1;

        if chunk_len >= line_width {
            wrapped.push(chunk);
            chunk = String::new();
            chunk_len = 0;
        }
    }

    if !chunk.is_empty() {
        wrapped.push(chunk);
    }

    wrapped
}

fn wrap_receipt_lines(lines: Vec<String>, line_width: usize) -> Vec<String> {
    let mut wrapped: Vec<String> = Vec::new();

    for line in lines {
        if line.trim().is_empty() {
            if wrapped
                .last()
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
            {
                wrapped.push(String::new());
            }
            continue;
        }

        wrapped.extend(wrap_line_hard(&line, line_width));
    }

    wrapped
}

#[cfg(test)]
fn normalize_receipt_text(raw: &str) -> String {
    normalize_receipt_text_with_width(raw, DEFAULT_RECEIPT_LINE_WIDTH)
}

fn normalize_receipt_text_with_width(raw: &str, line_width: usize) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut pending_blank = false;

    for raw_line in raw.replace('\r', "").lines() {
        let collapsed = collapse_spaces_preserve_tabs(raw_line);

        if collapsed.is_empty() {
            pending_blank = true;
            continue;
        }

        if pending_blank && !lines.is_empty() {
            lines.push(String::new());
        }
        pending_blank = false;

        let parts: Vec<&str> = collapsed
            .split('\t')
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
            .collect();

        if parts.len() >= 2 {
            lines.push(align_left_right(parts[0], parts[1], line_width));
        } else {
            lines.push(collapsed);
        }
    }

    let grouped = apply_professional_grouping(lines, line_width);
    let wrapped = wrap_receipt_lines(grouped, line_width);
    wrapped.join("\n")
}

fn extract_qr_payload(html: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let needle = format!("src={}", quote);
        let mut offset = 0usize;

        while let Some(found) = html[offset..].find(&needle) {
            let start = offset + found + needle.len();
            let tail = &html[start..];
            let Some(end) = tail.find(quote) else {
                break;
            };
            let src = &tail[..end];

            if let Some(payload) = extract_qr_payload_from_src(src) {
                return Some(payload);
            }

            offset = start + end + 1;
        }
    }

    None
}

fn extract_qr_payload_from_src(src: &str) -> Option<String> {
    let src_lower = src.to_lowercase();
    if !src_lower.contains("qr") {
        return None;
    }

    if let Some(data_pos) = src.find("data=") {
        let encoded = &src[data_pos + 5..];
        let encoded_value = encoded.split('&').next().unwrap_or("").trim();
        if !encoded_value.is_empty() {
            if let Ok(decoded) = urlencoding::decode(encoded_value) {
                let value = decoded.trim().to_string();
                if !value.is_empty() {
                    return Some(value);
                }
            }
        }
    }

    None
}

fn append_qr_code(
    data: &mut Vec<u8>,
    payload: &str,
    horizontal_offset: usize,
    line_width: usize,
    qr_size_px: Option<f64>,
) {
    let value = payload.trim();
    if value.is_empty() {
        return;
    }

    let bytes = value.as_bytes();
    if bytes.is_empty() {
        return;
    }

    // ESC/POS QR payload max is bounded by pL/pH command packet size.
    let max_len = 7089usize;
    let qr_bytes = if bytes.len() > max_len {
        &bytes[..max_len]
    } else {
        bytes
    };

    data.extend_from_slice(b"\n");
    data.extend_from_slice(b"\x1B\x61\x01"); // center align
    data.extend_from_slice(&[0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]); // model 2
    let qr_module_size = resolve_qr_module_size(qr_size_px, line_width);
    data.extend_from_slice(&[0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, qr_module_size]); // size
    data.extend_from_slice(&[0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x31]); // error correction: M

    let payload_len = qr_bytes.len() + 3;
    let p_l = (payload_len & 0xFF) as u8;
    let p_h = ((payload_len >> 8) & 0xFF) as u8;
    data.extend_from_slice(&[0x1D, 0x28, 0x6B, p_l, p_h, 0x31, 0x50, 0x30]); // store data
    data.extend_from_slice(qr_bytes);
    data.extend_from_slice(&[0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30]); // print
    data.extend_from_slice(b"\n");
    data.extend_from_slice(b"\x1B\x61\x00"); // left align
    let _ = horizontal_offset;
}

fn resolve_qr_module_size(qr_size_px: Option<f64>, line_width: usize) -> u8 {
    let (default_px, default_module) = if line_width <= COMPACT_RECEIPT_LINE_WIDTH {
        (76.0, 4.0)
    } else {
        (90.0, 5.0)
    };
    let requested_px = qr_size_px.unwrap_or(default_px).clamp(48.0, 140.0);
    ((requested_px / default_px) * default_module)
        .round()
        .clamp(3.0, 8.0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_line_does_not_swallow_company_section() {
        let raw = "COPY #2\nMy Test Store\nOrder #: 1001";
        let normalized = normalize_receipt_text(raw);

        assert!(normalized.contains("My Test Store"));
        assert!(normalized.contains("Order #:"));
    }

    #[test]
    fn aligns_label_values_and_trailing_amounts() {
        let raw = "Subtotal:\tRs 75.00\nBread Rs 30.00\nTOTAL:\tRs 75.00";
        let normalized = normalize_receipt_text(raw);
        let lines: Vec<&str> = normalized.lines().collect();

        assert!(lines
            .iter()
            .any(|line| line.contains("Subtotal:") && line.ends_with("Rs 75.00")));
        assert!(lines
            .iter()
            .any(|line| line.contains("Bread") && line.ends_with("Rs 30.00")));
        assert!(lines
            .iter()
            .any(|line| line.contains("TOTAL:") && line.ends_with("Rs 75.00")));
    }

    #[test]
    fn receipt2_header_details_center_as_whole_lines_and_buyer_stays_left() {
        let raw = concat!(
            "*** START OF LEGAL RECEIPT ***\n",
            "Mkisi Enterprise\n",
            "MOB: 0999202015\n",
            "EMAIL: catherine@example.com\n",
            "TIN: 30253908\n",
            "BLANTYRE MTO\n",
            "**VAT REGISTERED**\n",
            "BUYER'S TIN : 12345\n",
            "BUYER'S NAME : thocco mvola\n",
            "RECEIPT NUMBER : CrL-D-JY3f-F\n"
        );
        let normalized = normalize_receipt_text_with_width(raw, COMPACT_RECEIPT_LINE_WIDTH);
        let lines: Vec<&str> = normalized.lines().collect();

        assert!(lines.iter().any(|line| line.contains("MOB: 0999202015")));
        assert!(lines.iter().any(|line| line.contains("TIN: 30253908")));
        assert!(lines
            .iter()
            .any(|line| line.starts_with("BUYER'S NAME : thocco")));
        assert!(lines
            .iter()
            .any(|line| line.starts_with("RECEIPT NUMBER : CrL")));
    }

    #[test]
    fn receipt2_break_div_creates_printed_blank_line() {
        let html = r#"<div>HEADER</div><div class="receipt2-break"></div><div>NEXT</div>"#;
        let normalized = html_to_printable_text(html, COMPACT_RECEIPT_LINE_WIDTH);
        let lines: Vec<&str> = normalized.lines().collect();

        assert_eq!(lines.get(0).map(|line| line.trim()), Some("HEADER"));
        assert_eq!(lines.get(1), Some(&""));
        assert_eq!(lines.get(2).map(|line| line.trim()), Some("NEXT"));
    }

    #[test]
    fn build_escpos_receipt_centers_compact_layout_on_wider_roll() {
        let (line_width, horizontal_offset) = resolve_receipt_layout(Some("58mm"), Some("80mm"));

        assert_eq!(line_width, COMPACT_RECEIPT_LINE_WIDTH);
        assert_eq!(horizontal_offset, 5);
    }

    #[test]
    fn qr_module_size_follows_receipt_qr_setting() {
        assert_eq!(
            resolve_qr_module_size(Some(48.0), COMPACT_RECEIPT_LINE_WIDTH),
            3
        );
        assert_eq!(
            resolve_qr_module_size(Some(76.0), COMPACT_RECEIPT_LINE_WIDTH),
            4
        );
        assert_eq!(
            resolve_qr_module_size(Some(120.0), COMPACT_RECEIPT_LINE_WIDTH),
            6
        );
        assert_eq!(
            resolve_qr_module_size(Some(140.0), DEFAULT_RECEIPT_LINE_WIDTH),
            8
        );
    }
}
