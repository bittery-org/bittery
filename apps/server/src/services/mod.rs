pub(crate) mod access;
pub(crate) mod audit;
pub(crate) mod auth;
pub(crate) mod auth_email;
pub(crate) mod billing;
pub(crate) mod connection_registry;
pub(crate) mod idempotency;
pub(crate) mod member_departure;
pub(crate) mod rate_limit;
pub(crate) mod redis;
pub(crate) mod session;
pub(crate) mod session_control;
pub(crate) mod share;
pub(crate) mod sync;
pub(crate) mod sync_pubsub;
pub(crate) mod team;
pub(crate) mod team_admin;
pub(crate) mod team_billing;
pub(crate) mod transaction;
pub(crate) mod travel_mode;
pub(crate) mod vault;
pub(crate) mod vault_key;
pub(crate) mod vault_key_rotation;
pub(crate) mod vault_membership;
pub(crate) mod verification_code;
pub(crate) mod waitlist;

use std::sync::LazyLock;

use rand::RngExt;
use regex::Regex;

use crate::error::AppError;

pub(crate) fn generate_secure_token() -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut rng = rand::rng();
    (0..32)
        .map(|_| {
            let index = rng.random_range(0..ALPHABET.len());
            ALPHABET[index] as char
        })
        .collect()
}

pub(crate) fn validate_resource_id(value: &str) -> Result<(), AppError> {
    static RESOURCE_ID: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|[A-Za-z0-9_-]{10,64})$",
        )
        .expect("resource id regex should be valid")
    });

    if value.len() <= 64 && RESOURCE_ID.is_match(value) {
        Ok(())
    } else {
        Err(AppError::bad_request("Invalid resource ID"))
    }
}
