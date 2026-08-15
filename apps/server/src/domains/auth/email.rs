#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::Path,
};

use serde::Serialize;
use serde_json::{json, Value};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tracing::{info, warn};

use crate::{
    config::AuthConfig, domains::auth::verification_code::VerificationPurpose, error::AppError,
};

/// The single sink every emailed verification code passes through, so a new
/// purpose cannot be added that issues a code and forgets to send it.
pub(crate) fn deliver_code(
    config: &AuthConfig,
    purpose: &VerificationPurpose<'_>,
    email: &str,
    code: &str,
    _delivery_id: &str,
) -> Result<(), AppError> {
    if !config.dev_stubs_enabled {
        return Err(AppError::internal(
			"Auth email delivery is not configured. Set BITTERY_ENABLE_DEV_AUTH_STUBS=true for local development or configure a real email provider.",
		));
    }

    #[cfg(test)]
    emailed_code_capture::record(_delivery_id, code);

    log_delivery(purpose, email, code);
    append_to_dev_outbox(config.dev_mail_outbox.as_deref(), purpose, email, code);

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
fn append_to_dev_outbox(
    path: Option<&Path>,
    purpose: &VerificationPurpose<'_>,
    email: &str,
    code: &str,
) {
    let Some(path) = path else {
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
    let write = options.open(path).and_then(|mut file| {
        restrict_to_owner(&file)?;
        // One `writeln!` per record: a tailing reader must never see a torn line.
        writeln!(file, "{line}")
    });
    if let Err(error) = write {
        warn!(error = %error, path = %path.display(), "[auth-email] Failed to append to dev mail outbox");
    }
}

/// `OpenOptions::mode` only covers a file this call creates, so an outbox left behind
/// with looser bits would hand every local account the plaintext codes. Tighten the
/// open handle, and let a failure abort the append rather than leak.
#[cfg(unix)]
fn restrict_to_owner(file: &File) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = file.metadata()?.permissions();
    if permissions.mode() & 0o077 == 0 {
        return Ok(());
    }
    permissions.set_mode(0o600);
    file.set_permissions(permissions)
}

#[cfg(not(unix))]
fn restrict_to_owner(_file: &File) -> std::io::Result<()> {
    Ok(())
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

/// Codes are persisted as digests, so a test can only act as the recipient by
/// capturing the plaintext on its way out. The production-generated delivery ID
/// scopes each entry to one verification row, including across parallel test databases.
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

    pub(crate) fn record(delivery_id: &str, code: &str) {
        store()
            .lock()
            .expect("emailed code capture should not be poisoned")
            .insert(delivery_id.to_string(), code.to_string());
    }

    pub(crate) fn latest(delivery_id: &str) -> Option<String> {
        store()
            .lock()
            .expect("emailed code capture should not be poisoned")
            .get(delivery_id)
            .cloned()
    }
}

#[cfg(test)]
#[path = "email_tests.rs"]
mod tests;
