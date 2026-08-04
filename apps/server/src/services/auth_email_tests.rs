use std::{fs, path::PathBuf};

use serde_json::Value;

use super::*;
use crate::{
    error::AppErrorCode,
    test_support::{acquire_env_lock, EnvVarGuard},
};

const NOT_CONFIGURED_MESSAGE: &str = "Auth email delivery is not configured. Set BITTERY_ENABLE_DEV_AUTH_STUBS=true for local development or configure a real email provider.";
const DEV_MAIL_OUTBOX_ENV: &str = "BITTERY_DEV_MAIL_OUTBOX";

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

    fn as_str(&self) -> &str {
        self.path.to_str().expect("outbox path should be utf-8")
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
    let _lock = acquire_env_lock();
    let outbox = OutboxFile::new("stubs-off");
    let _env = EnvVarGuard::set(&[
        ("BITTERY_ENABLE_DEV_AUTH_STUBS", "false"),
        ("NODE_ENV", "development"),
        (DEV_MAIL_OUTBOX_ENV, outbox.as_str()),
    ]);

    let error = deliver_code(
        &VerificationPurpose::Recovery,
        "recipient@test.bittery.com",
        "482913",
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
    let _lock = acquire_env_lock();
    let outbox = OutboxFile::new("purposes");
    let _env = EnvVarGuard::set(&[
        ("BITTERY_ENABLE_DEV_AUTH_STUBS", "true"),
        ("NODE_ENV", "development"),
        (DEV_MAIL_OUTBOX_ENV, outbox.as_str()),
    ]);

    deliver_code(
        &VerificationPurpose::Signup {
            invitation_token: Some("invite_token_1"),
        },
        "signup@test.bittery.com",
        "100001",
    )
    .expect("signup delivery should succeed");
    deliver_code(
        &VerificationPurpose::Signup {
            invitation_token: None,
        },
        "public-signup@test.bittery.com",
        "100002",
    )
    .expect("public signup delivery should succeed");
    deliver_code(
        &VerificationPurpose::Recovery,
        "recovery@test.bittery.com",
        "100003",
    )
    .expect("recovery delivery should succeed");
    deliver_code(
        &VerificationPurpose::ShareEmail {
            share_link_id: "share_link_abc",
        },
        "share@test.bittery.com",
        "100004",
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
    let _lock = acquire_env_lock();
    let unwritable = std::env::temp_dir()
        .join(format!(
            "bittery-missing-dir-{:016x}",
            rand::random::<u64>()
        ))
        .join("outbox.jsonl");
    let _env = EnvVarGuard::set(&[
        ("BITTERY_ENABLE_DEV_AUTH_STUBS", "true"),
        ("NODE_ENV", "development"),
        (
            DEV_MAIL_OUTBOX_ENV,
            unwritable.to_str().expect("path should be utf-8"),
        ),
    ]);

    deliver_code(
        &VerificationPurpose::Recovery,
        "recovery@test.bittery.com",
        "100005",
    )
    .expect("an unwritable outbox must not fail the request");
}

#[test]
fn deliver_code_writes_nothing_when_the_outbox_is_unset() {
    let _lock = acquire_env_lock();
    let _env = EnvVarGuard::set(&[
        ("BITTERY_ENABLE_DEV_AUTH_STUBS", "true"),
        ("NODE_ENV", "development"),
        (DEV_MAIL_OUTBOX_ENV, ""),
    ]);

    assert_eq!(dev_outbox_path(), None);
    deliver_code(
        &VerificationPurpose::Recovery,
        "recovery@test.bittery.com",
        "100006",
    )
    .expect("delivery should succeed without an outbox");
}
