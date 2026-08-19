use std::{fs, path::PathBuf};

use serde_json::Value;

use super::*;
use crate::{config::AuthConfig, error::AppErrorCode};

const NOT_CONFIGURED_MESSAGE: &str = "Auth email delivery is not configured. Set BITTERY_ENABLE_DEV_AUTH_STUBS=true for local development or configure a real email provider.";

fn auth_config(dev_stubs_enabled: bool, dev_mail_outbox: Option<PathBuf>) -> AuthConfig {
    AuthConfig {
        jwt_secret: "test-jwt-secret".to_string(),
        dev_stubs_enabled,
        dev_mail_outbox,
    }
}

/// Removes its file on drop so a failing assertion cannot leave the temp
/// directory littered, and so each test gets a path nothing else writes to.
struct OutboxFile {
    path: PathBuf,
}

impl OutboxFile {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "bittery-dev-mail-outbox-{label}-{:016x}.jsonl",
            rand::random::<u64>()
        ));
        Self { path }
    }

    fn lines(&self) -> Vec<Value> {
        fs::read_to_string(&self.path)
            .expect("outbox file should be readable")
            .lines()
            .map(|line| serde_json::from_str(line).expect("outbox line should be valid JSON"))
            .collect()
    }
}

impl Drop for OutboxFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[test]
fn deliver_code_fails_closed_when_dev_auth_stubs_are_disabled() {
    let outbox = OutboxFile::new("stubs-off");
    let config = auth_config(false, Some(outbox.path.clone()));

    let error = deliver_code(
        &config,
        &VerificationPurpose::Recovery,
        "recipient@test.bittery.com",
        "482913",
        "delivery_stubs_off",
    )
    .expect_err("delivery should fail without a configured provider");

    assert_eq!(error.code, AppErrorCode::InternalServerError);
    assert_eq!(error.message, NOT_CONFIGURED_MESSAGE);
    assert!(
        !outbox.path.exists(),
        "a failed delivery must not write a code to the outbox"
    );
}

#[test]
fn deliver_code_appends_one_json_line_per_purpose() {
    let outbox = OutboxFile::new("purposes");
    let config = auth_config(true, Some(outbox.path.clone()));

    deliver_code(
        &config,
        &VerificationPurpose::Signup {
            invitation_token: Some("invite_token_1"),
        },
        "signup@test.bittery.com",
        "100001",
        "delivery_signup_invited",
    )
    .expect("signup delivery should succeed");
    deliver_code(
        &config,
        &VerificationPurpose::Signup {
            invitation_token: None,
        },
        "public-signup@test.bittery.com",
        "100002",
        "delivery_signup_public",
    )
    .expect("public signup delivery should succeed");
    deliver_code(
        &config,
        &VerificationPurpose::Recovery,
        "recovery@test.bittery.com",
        "100003",
        "delivery_recovery",
    )
    .expect("recovery delivery should succeed");
    deliver_code(
        &config,
        &VerificationPurpose::ShareEmail {
            share_link_id: "share_link_abc",
        },
        "share@test.bittery.com",
        "100004",
        "delivery_share",
    )
    .expect("share email delivery should succeed");

    let lines = outbox.lines();
    assert_eq!(lines.len(), 4);

    assert_eq!(lines[0]["purpose"], "signup");
    assert_eq!(lines[0]["email"], "signup@test.bittery.com");
    assert_eq!(lines[0]["code"], "100001");
    assert_eq!(lines[0]["context"]["invitationToken"], "invite_token_1");

    assert_eq!(lines[1]["purpose"], "signup");
    assert_eq!(lines[1]["context"], serde_json::json!({}));

    assert_eq!(lines[2]["purpose"], "recovery");
    assert_eq!(lines[2]["email"], "recovery@test.bittery.com");
    assert_eq!(lines[2]["code"], "100003");
    assert_eq!(lines[2]["context"], serde_json::json!({}));

    assert_eq!(lines[3]["purpose"], "share_email");
    assert_eq!(lines[3]["email"], "share@test.bittery.com");
    assert_eq!(lines[3]["code"], "100004");
    assert_eq!(lines[3]["context"]["shareLinkId"], "share_link_abc");

    for line in &lines {
        let issued_at = line["issuedAt"]
            .as_str()
            .expect("issuedAt should be a string");
        OffsetDateTime::parse(issued_at, &Rfc3339).expect("issuedAt should be RFC3339");
        assert!(issued_at.ends_with('Z'), "issuedAt should be UTC");
    }
}

#[test]
fn deliver_code_succeeds_when_the_outbox_path_cannot_be_written() {
    let unwritable = std::env::temp_dir()
        .join(format!(
            "bittery-missing-dir-{:016x}",
            rand::random::<u64>()
        ))
        .join("outbox.jsonl");
    let config = auth_config(true, Some(unwritable));

    deliver_code(
        &config,
        &VerificationPurpose::Recovery,
        "recovery@test.bittery.com",
        "100005",
        "delivery_unwritable",
    )
    .expect("an unwritable outbox must not fail the request");
}

#[cfg(unix)]
#[test]
fn deliver_code_tightens_an_outbox_that_already_exists_world_readable() {
    use std::os::unix::fs::PermissionsExt;

    let outbox = OutboxFile::new("loose-permissions");
    fs::write(&outbox.path, "").expect("outbox should be creatable");
    fs::set_permissions(&outbox.path, fs::Permissions::from_mode(0o644))
        .expect("outbox permissions should be settable");
    let config = auth_config(true, Some(outbox.path.clone()));

    deliver_code(
        &config,
        &VerificationPurpose::Recovery,
        "recovery@test.bittery.com",
        "100007",
        "delivery_permissions",
    )
    .expect("recovery delivery should succeed");

    let mode = fs::metadata(&outbox.path)
        .expect("outbox should exist")
        .permissions()
        .mode();
    assert_eq!(
        mode & 0o777,
        0o600,
        "an existing outbox must be tightened before plaintext codes are appended"
    );
    assert_eq!(outbox.lines()[0]["code"], "100007");
}

#[test]
fn deliver_code_writes_nothing_when_the_outbox_is_unset() {
    let config = auth_config(true, None);

    deliver_code(
        &config,
        &VerificationPurpose::Recovery,
        "recovery@test.bittery.com",
        "100006",
        "delivery_no_outbox",
    )
    .expect("delivery should succeed without an outbox");
}

#[test]
fn emailed_code_capture_is_scoped_to_the_verification_delivery() {
    emailed_code_capture::record("verification_in_database_a", "100001");
    emailed_code_capture::record("verification_in_database_b", "200002");

    assert_eq!(
        emailed_code_capture::latest("verification_in_database_a").as_deref(),
        Some("100001")
    );
    assert_eq!(
        emailed_code_capture::latest("verification_in_database_b").as_deref(),
        Some("200002")
    );
}
