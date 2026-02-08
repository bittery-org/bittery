/**
 * Automatic Native Messaging Host Installer
 * 
 * This module handles automatic installation of the native messaging host
 * manifest when the Tauri app is launched. No manual user setup required!
 */

use std::fs;
use std::path::PathBuf;
use serde_json::json;
use tauri::Manager;

#[cfg(target_os = "macos")]
const CHROME_MANIFEST_DIR: &str = "Library/Application Support/Google/Chrome/NativeMessagingHosts";
#[cfg(target_os = "macos")]
const EDGE_MANIFEST_DIR: &str = "Library/Application Support/Microsoft/Edge/NativeMessagingHosts";
#[cfg(target_os = "macos")]
const BRAVE_MANIFEST_DIR: &str = "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts";

#[cfg(target_os = "linux")]
const CHROME_MANIFEST_DIR: &str = ".config/google-chrome/NativeMessagingHosts";
#[cfg(target_os = "linux")]
const EDGE_MANIFEST_DIR: &str = ".config/microsoft-edge/NativeMessagingHosts";
#[cfg(target_os = "linux")]
const BRAVE_MANIFEST_DIR: &str = ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts";

#[cfg(target_os = "windows")]
const CHROME_REG_KEY: &str = r"Software\Google\Chrome\NativeMessagingHosts\com.bittery.desktop";
#[cfg(target_os = "windows")]
const EDGE_REG_KEY: &str = r"Software\Microsoft\Edge\NativeMessagingHosts\com.bittery.desktop";
#[cfg(target_os = "windows")]
const BRAVE_REG_KEY: &str = r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.bittery.desktop";

const MANIFEST_NAME: &str = "com.bittery.desktop.json";
const NATIVE_HOST_NAME: &str = "bittery-native-host";

/// Install native messaging host manifest for all detected browsers
pub fn install_native_messaging_host(app_handle: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    eprintln!("🔧 Installing native messaging host...");
    
    // Get path to the native host binary
    let native_host_path = get_native_host_path(app_handle)?;
    
    eprintln!("📍 Native host binary: {:?}", native_host_path);
    
    // Verify binary exists
    if !native_host_path.exists() {
        return Err(format!("Native host binary not found: {:?}", native_host_path).into());
    }
    
    // Install for each browser
    let mut installed_count = 0;
    
    if let Ok(_) = install_for_chrome(&native_host_path) {
        eprintln!("✅ Installed for Chrome");
        installed_count += 1;
    }
    
    if let Ok(_) = install_for_edge(&native_host_path) {
        eprintln!("✅ Installed for Edge");
        installed_count += 1;
    }
    
    if let Ok(_) = install_for_brave(&native_host_path) {
        eprintln!("✅ Installed for Brave");
        installed_count += 1;
    }
    
    if installed_count > 0 {
        eprintln!("🎉 Native messaging host installed for {} browser(s)", installed_count);
        Ok(())
    } else {
        Err("Failed to install native messaging host for any browser".into())
    }
}

/// Get the path to the native host binary bundled with the app
fn get_native_host_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    #[cfg(target_os = "windows")]
    let binary_name = format!("{}.exe", NATIVE_HOST_NAME);
    #[cfg(not(target_os = "windows"))]
    let binary_name = NATIVE_HOST_NAME.to_string();
    
    // Try development mode first (src-tauri/target/release)
    if let Ok(current_dir) = std::env::current_dir() {
        // Try from current directory (workspace root)
        let dev_paths = vec![
            current_dir.join("apps/desktop/src-tauri/target/release").join(&binary_name),
            current_dir.join("src-tauri/target/release").join(&binary_name),
            current_dir.join("target/release").join(&binary_name),
        ];
        
        for path in dev_paths {
            if path.exists() {
                return Ok(path);
            }
        }
    }
    
    // Try bundled resources (production)
    let resource_path = app_handle.path().resource_dir()?;
    let native_host_path = resource_path.join(&binary_name);
    
    if native_host_path.exists() {
        return Ok(native_host_path);
    }
    
    Err(format!("Native host binary '{}' not found. Build it first with: cargo build --release --bin bittery-native-host", binary_name).into())
}

/// Create the manifest JSON content
///
/// Note: Chrome doesn't support wildcards in allowed_origins, but DOES support multiple IDs.
/// We include both dev (unpacked) and production (Chrome Web Store) extension IDs.
fn create_manifest_json(native_host_path: &PathBuf) -> serde_json::Value {
    // Development extension ID (unpacked extension)
    const DEV_EXTENSION_ID: &str = "blnkglankmihhigfnediedhhighfajei";

    // Production extension ID from compile-time environment (Chrome Web Store)
    let prod_extension_id = option_env!("BITTERY_EXTENSION_ID");

    // Build allowed_origins list with both dev and production IDs
    let mut allowed_origins = vec![
        format!("chrome-extension://{}/", DEV_EXTENSION_ID),
    ];

    // Add production ID if it's set and different from dev
    if let Some(prod_id) = prod_extension_id {
        if prod_id != DEV_EXTENSION_ID && !prod_id.is_empty() && prod_id != "YOUR_PRODUCTION_EXTENSION_ID_HERE" {
            allowed_origins.push(format!("chrome-extension://{}/", prod_id));
            eprintln!("📝 Using extension IDs: {} (dev), {} (prod)", DEV_EXTENSION_ID, prod_id);
        } else {
            eprintln!("📝 Using extension ID: {} (dev only)", DEV_EXTENSION_ID);
        }
    } else {
        eprintln!("📝 Using extension ID: {} (dev only)", DEV_EXTENSION_ID);
    }

    json!({
        "name": "com.bittery.desktop",
        "description": "Bittery Desktop Native Messaging Host",
        "path": native_host_path.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": allowed_origins,
    })
}

#[cfg(not(target_os = "windows"))]
fn install_for_chrome(native_host_path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let home = dirs::home_dir().ok_or("Could not get home directory")?;
    let manifest_dir = home.join(CHROME_MANIFEST_DIR);
    
    // Check if Chrome is installed
    if !manifest_dir.parent().map(|p| p.exists()).unwrap_or(false) {
        return Err("Chrome not installed".into());
    }
    
    fs::create_dir_all(&manifest_dir)?;
    
    let manifest_path = manifest_dir.join(MANIFEST_NAME);
    let manifest_json = create_manifest_json(native_host_path);
    
    fs::write(&manifest_path, serde_json::to_string_pretty(&manifest_json)?)?;
    
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn install_for_edge(native_host_path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let home = dirs::home_dir().ok_or("Could not get home directory")?;
    let manifest_dir = home.join(EDGE_MANIFEST_DIR);
    
    // Check if Edge is installed
    if !manifest_dir.parent().map(|p| p.exists()).unwrap_or(false) {
        return Err("Edge not installed".into());
    }
    
    fs::create_dir_all(&manifest_dir)?;
    
    let manifest_path = manifest_dir.join(MANIFEST_NAME);
    let manifest_json = create_manifest_json(native_host_path);
    
    fs::write(&manifest_path, serde_json::to_string_pretty(&manifest_json)?)?;
    
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn install_for_brave(native_host_path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let home = dirs::home_dir().ok_or("Could not get home directory")?;
    let manifest_dir = home.join(BRAVE_MANIFEST_DIR);
    
    // Check if Brave is installed
    if !manifest_dir.parent().map(|p| p.exists()).unwrap_or(false) {
        return Err("Brave not installed".into());
    }
    
    fs::create_dir_all(&manifest_dir)?;
    
    let manifest_path = manifest_dir.join(MANIFEST_NAME);
    let manifest_json = create_manifest_json(native_host_path);
    
    fs::write(&manifest_path, serde_json::to_string_pretty(&manifest_json)?)?;
    
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_for_chrome(native_host_path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    use winreg::enums::*;
    use winreg::RegKey;
    
    // Create a temporary manifest file
    let temp_dir = std::env::temp_dir();
    let manifest_path = temp_dir.join("bittery-chrome-manifest.json");
    
    let manifest_json = create_manifest_json(native_host_path);
    fs::write(&manifest_path, serde_json::to_string_pretty(&manifest_json)?)?;
    
    // Write to registry
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu.create_subkey(CHROME_REG_KEY)?;
    key.0.set_value("", &manifest_path.to_string_lossy().to_string())?;
    
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_for_edge(native_host_path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    use winreg::enums::*;
    use winreg::RegKey;
    
    // Create a temporary manifest file
    let temp_dir = std::env::temp_dir();
    let manifest_path = temp_dir.join("bittery-edge-manifest.json");
    
    let manifest_json = create_manifest_json(native_host_path);
    fs::write(&manifest_path, serde_json::to_string_pretty(&manifest_json)?)?;
    
    // Write to registry
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu.create_subkey(EDGE_REG_KEY)?;
    key.0.set_value("", &manifest_path.to_string_lossy().to_string())?;
    
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_for_brave(native_host_path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    use winreg::enums::*;
    use winreg::RegKey;
    
    // Create a temporary manifest file
    let temp_dir = std::env::temp_dir();
    let manifest_path = temp_dir.join("bittery-brave-manifest.json");
    
    let manifest_json = create_manifest_json(native_host_path);
    fs::write(&manifest_path, serde_json::to_string_pretty(&manifest_json)?)?;
    
    // Write to registry
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu.create_subkey(BRAVE_REG_KEY)?;
    key.0.set_value("", &manifest_path.to_string_lossy().to_string())?;
    
    Ok(())
}

/// Check if native messaging host is already installed
pub fn is_installed() -> bool {
    #[cfg(not(target_os = "windows"))]
    {
        let home = match dirs::home_dir() {
            Some(h) => h,
            None => return false,
        };
        
        let chrome_path = home.join(CHROME_MANIFEST_DIR).join(MANIFEST_NAME);
        let edge_path = home.join(EDGE_MANIFEST_DIR).join(MANIFEST_NAME);
        let brave_path = home.join(BRAVE_MANIFEST_DIR).join(MANIFEST_NAME);
        
        chrome_path.exists() || edge_path.exists() || brave_path.exists()
    }
    
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        
        hkcu.open_subkey(CHROME_REG_KEY).is_ok() ||
        hkcu.open_subkey(EDGE_REG_KEY).is_ok() ||
        hkcu.open_subkey(BRAVE_REG_KEY).is_ok()
    }
}
