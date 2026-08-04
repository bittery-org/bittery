#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{fs::OpenOptions, io::Write};

use serde::Serialize;
use serde_json::{json, Value};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tracing::{info, warn};

use crate::{
    error::AppError,
    services::{auth::is_dev_auth_stub_enabled, verification_code::VerificationPurpose},
};

/// The single sink every emailed verification code passes through, so a new
/// purpose cannot be added that issues a code and forgets to send it.
pub(crate) fn deliver_code(
    purpose: &VerificationPurpose<'_>,
    email: &str,
    code: &str,
) -> Result<(), AppError> {
    if !is_dev_auth_stub_enabled() {
        return Err(AppError::internal(
			"Auth email delivery is not configured. Set BITTERY_ENABLE_DEV_AUTH_STUBS=true for local development or configure a real email provider.",
		));
    }

    #[cfg(test)]
    emailed_code_capture::record(capture_key(purpose, email), code);

    log_delivery(purpose, email, code);
    append_to_dev_outbox(purpose, email, code);

    Ok(())
}

fn log_delivery(purpose: &VerificationPurpose<'_>, email: &str, code: &str) {
    match purpose {
        VerificationPurpose::Signup { invitation_token } => info!(
            email = %email,
            code = %code,
            invitation_token = invitation_token.unwrap_or("<none>"),
            "[auth-email] Signup verification code"
        ),
        VerificationPurpose::Recovery => info!(
            email = %email,
            code = %code,
            "[auth-email] Recovery code"
        ),
        VerificationPurpose::ShareEmail { share_link_id } => info!(
            email = %email,
            code = %code,
            share_link_id = %share_link_id,
            "[auth-email] Share link verification code"
        ),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DevOutboxEntry<'a> {
    purpose: &'a str,
    email: &'a str,
    code: &'a str,
    context: Value,
    issued_at: String,
}

/// An env-var opt-in behind the already-open dev stub gate keeps plaintext codes off
/// every network surface; an endpoint serving them would be a takeover primitive.
fn append_to_dev_outbox(purpose: &VerificationPurpose<'_>, email: &str, code: &str) {
    let Some(path) = dev_outbox_path() else {
        return;
    };
    let Ok(issued_at) = OffsetDateTime::now_utc().format(&Rfc3339) else {
        return;
    };
    let entry = DevOutboxEntry {
        purpose: purpose_slug(purpose),
        email,
        code,
        context: purpose_context(purpose),
        issued_at,
    };
    let Ok(line) = serde_json::to_string(&entry) else {
        return;
    };

    let mut options = OpenOptions::new();
    options.create(true).append(true);
    // The file holds plaintext codes, so no other account on the box may read it.
    #[cfg(unix)]
    options.mode(0o600);
    let write = options
        .open(&path)
        // One `writeln!` per record: a tailing reader must never see a torn line.
        .and_then(|mut file| writeln!(file, "{line}"));
    if let Err(error) = write {
        warn!(error = %error, path = %path, "[auth-email] Failed to append to dev mail outbox");
    }
}

fn dev_outbox_path() -> Option<String> {
    std::env::var("BITTERY_DEV_MAIL_OUTBOX")
        .ok()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
}

fn purpose_slug(purpose: &VerificationPurpose<'_>) -> &'static str {
    match purpose {
        VerificationPurpose::Signup { .. } => "signup",
        VerificationPurpose::Recovery => "recovery",
        VerificationPurpose::ShareEmail { .. } => "share_email",
    }
}

fn purpose_context(purpose: &VerificationPurpose<'_>) -> Value {
    match purpose {
        VerificationPurpose::Signup {
            invitation_token: Some(invitation_token),
        } => json!({ "invitationToken": invitation_token }),
        VerificationPurpose::Signup {
            invitation_token: None,
        }
        | VerificationPurpose::Recovery => json!({}),
        VerificationPurpose::ShareEmail { share_link_id } => {
            json!({ "shareLinkId": share_link_id })
        }
    }
}

#[cfg(test)]
fn capture_key(purpose: &VerificationPurpose<'_>, email: &str) -> String {
    match purpose {
        VerificationPurpose::Signup { invitation_token } => {
            emailed_code_capture::signup_key(email, *invitation_token)
        }
        VerificationPurpose::Recovery => emailed_code_capture::recovery_key(email),
        VerificationPurpose::ShareEmail { share_link_id } => {
            emailed_code_capture::share_key(share_link_id, email)
        }
    }
}

/// Codes are persisted as digests, so a test can only act as the recipient by
/// capturing the plaintext on its way out.
#[cfg(test)]
pub(crate) mod emailed_code_capture {
    use std::{
        collections::HashMap,
        sync::{Mutex, OnceLock},
    };

    fn store() -> &'static Mutex<HashMap<String, String>> {
        static STORE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
        STORE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub(crate) fn signup_key(email: &str, invitation_token: Option<&str>) -> String {
        format!(
            "signup|{}|{}",
            email.to_ascii_lowercase(),
            invitation_token.unwrap_or("")
        )
    }

    pub(crate) fn recovery_key(email: &str) -> String {
        format!("recovery|{}", email.to_ascii_lowercase())
    }

    pub(crate) fn share_key(share_link_id: &str, email: &str) -> String {
        format!("share_email|{share_link_id}|{}", email.to_ascii_lowercase())
    }

    pub(crate) fn record(key: String, code: &str) {
        store()
            .lock()
            .expect("emailed code capture should not be poisoned")
            .insert(key, code.to_string());
    }

    pub(crate) fn latest(key: &str) -> Option<String> {
        store()
            .lock()
            .expect("emailed code capture should not be poisoned")
            .get(key)
            .cloned()
    }
}

#[cfg(test)]
#[path = "auth_email_tests.rs"]
mod tests;
