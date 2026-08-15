use std::sync::LazyLock;

use regex::Regex;

// This is the only user-agent parser implementation: the TypeScript original it once mirrored
// was deleted with no consumers. Clients render the fields derived here.
pub(super) struct ParsedDeviceInfo {
    pub(super) device_name: String,
    pub(super) browser_name: Option<String>,
    pub(super) browser_version: Option<String>,
    pub(super) os_name: Option<String>,
    pub(super) os_version: Option<String>,
}

pub(super) fn parse_user_agent(user_agent: &str, app_platform: Option<&str>) -> ParsedDeviceInfo {
    let ua = user_agent.to_ascii_lowercase();

    let (os_name, os_version) = detect_os(user_agent, &ua);
    let (browser_name, browser_version) = detect_browser(user_agent, &ua);
    let platform = detect_platform(&ua, app_platform);

    let device_name = build_device_name(
        &platform,
        os_name.as_deref(),
        os_version.as_deref(),
        browser_name.as_deref(),
    );

    ParsedDeviceInfo {
        device_name,
        browser_name,
        browser_version,
        os_name,
        os_version,
    }
}

fn detect_os(user_agent: &str, ua: &str) -> (Option<String>, Option<String>) {
    static RE_IOS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)OS (\d+[._]\d+(?:[._]\d+)?)").unwrap());
    static RE_WINDOWS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)Windows NT (\d+\.?\d*)").unwrap());
    static RE_MACOS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)Mac OS X (\d+[._]\d+(?:[._]\d+)?)").unwrap());
    static RE_ANDROID: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)Android (\d+\.?\d*\.?\d*)").unwrap());

    if ua.contains("iphone") || ua.contains("ipad") {
        let os_name = if ua.contains("ipad") { "iPadOS" } else { "iOS" };
        let version = RE_IOS
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().replace('_', "."));
        return (Some(os_name.to_string()), version);
    }
    if ua.contains("windows") {
        let version = RE_WINDOWS
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| match m.as_str() {
                "10.0" => "10/11".to_string(),
                "6.3" => "8.1".to_string(),
                "6.2" => "8".to_string(),
                "6.1" => "7".to_string(),
                "6.0" => "Vista".to_string(),
                "5.1" => "XP".to_string(),
                other => other.to_string(),
            });
        return (Some("Windows".to_string()), version);
    }
    if ua.contains("mac os x") || ua.contains("macos") {
        let version = RE_MACOS
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().replace('_', "."));
        return (Some("macOS".to_string()), version);
    }
    if ua.contains("android") {
        let version = RE_ANDROID
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Android".to_string()), version);
    }
    if ua.contains("linux") {
        return (Some("Linux".to_string()), None);
    }
    if ua.contains("cros") {
        return (Some("Chrome OS".to_string()), None);
    }
    (None, None)
}

fn detect_browser(user_agent: &str, ua: &str) -> (Option<String>, Option<String>) {
    static RE_EDGE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)Edg/(\d+\.?\d*\.?\d*)").unwrap());
    static RE_OPERA: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)(?:OPR|Opera)/(\d+\.?\d*\.?\d*)").unwrap());
    static RE_BRAVE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)Brave/(\d+\.?\d*\.?\d*)").unwrap());
    static RE_VIVALDI: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)Vivaldi/(\d+\.?\d*\.?\d*)").unwrap());
    static RE_FIREFOX: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)(?:Firefox|FxiOS)/(\d+\.?\d*\.?\d*)").unwrap());
    static RE_SAFARI_VER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)Version/(\d+\.?\d*\.?\d*)").unwrap());
    static RE_CHROME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)(?:Chrome|CriOS)/(\d+\.?\d*\.?\d*)").unwrap());

    if ua.contains("edg/") {
        let ver = RE_EDGE
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Edge".to_string()), ver);
    }
    if ua.contains("opr/") || ua.contains("opera") {
        let ver = RE_OPERA
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Opera".to_string()), ver);
    }
    if ua.contains("brave") {
        let ver = RE_BRAVE
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Brave".to_string()), ver);
    }
    if ua.contains("vivaldi") {
        let ver = RE_VIVALDI
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Vivaldi".to_string()), ver);
    }
    if ua.contains("firefox") || ua.contains("fxios") {
        let ver = RE_FIREFOX
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Firefox".to_string()), ver);
    }
    if ua.contains("safari") && !ua.contains("chrome") && !ua.contains("chromium") {
        let ver = RE_SAFARI_VER
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Safari".to_string()), ver);
    }
    if ua.contains("chrome") || ua.contains("crios") {
        let ver = RE_CHROME
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Chrome".to_string()), ver);
    }
    (None, None)
}

pub(super) fn detect_platform(ua: &str, app_platform: Option<&str>) -> String {
    match app_platform {
        Some("desktop") => return "desktop".to_string(),
        Some("ios") => return "ios".to_string(),
        Some("android") => return "android".to_string(),
        Some("extension") => return "extension".to_string(),
        _ => {}
    }
    if ua.contains("iphone") || ua.contains("ipad") || (ua.contains("ios") && ua.contains("mobile"))
    {
        return "ios".to_string();
    }
    if ua.contains("android") {
        return "android".to_string();
    }
    "web".to_string()
}

pub(super) fn build_device_name(
    platform: &str,
    os_name: Option<&str>,
    os_version: Option<&str>,
    browser_name: Option<&str>,
) -> String {
    match platform {
        "desktop" => {
            if let Some(os) = os_name {
                format!("Bittery Desktop on {os}")
            } else {
                "Bittery Desktop".to_string()
            }
        }
        "extension" => {
            let browser_label = browser_name.unwrap_or("Browser");
            let os_label = os_name.map(|os| format!(" on {os}")).unwrap_or_default();
            format!("Bittery Extension ({browser_label}{os_label})")
        }
        "ios" => {
            let os_label = os_name.unwrap_or("iOS");
            if let Some(ver) = os_version {
                format!("Bittery on {os_label} {ver}")
            } else {
                format!("Bittery on {os_label}")
            }
        }
        "android" => {
            let os_label = if let Some(ver) = os_version {
                format!("Android {ver}")
            } else {
                "Android".to_string()
            };
            format!("Bittery on {os_label}")
        }
        _ => {
            let mut parts = Vec::new();
            if let Some(browser) = browser_name {
                parts.push(browser.to_string());
            }
            if let Some(os) = os_name {
                parts.push(format!("on {os}"));
            }
            if parts.is_empty() {
                "Unknown Device".to_string()
            } else {
                parts.join(" ")
            }
        }
    }
}
