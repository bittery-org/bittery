//! Device-local recipient verification. Server authority can never create trust records.
use crate::{AccountId, Incarnation, RuntimeError, RuntimeErrorCode};
use bittery_crypto_core::rsa::rsa_public_key_fingerprint;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VerifiedRecipientKeys {
    version: u32,
    pub(crate) account_id: AccountId,
    pub(crate) incarnation: Incarnation,
    server_url: String,
    user_id: String,
    #[serde(deserialize_with = "deserialize_recipients")]
    recipients: BTreeMap<String, String>,
}

impl VerifiedRecipientKeys {
    pub(crate) fn new(
        account_id: AccountId,
        incarnation: Incarnation,
        server_url: String,
        user_id: String,
    ) -> Self {
        Self {
            version: 1,
            account_id,
            incarnation,
            server_url,
            user_id,
            recipients: BTreeMap::new(),
        }
    }

    pub(crate) fn validate(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
        server_url: &str,
        user_id: &str,
    ) -> Result<(), RuntimeError> {
        if self.version != 1
            || &self.account_id != account_id
            || &self.incarnation != incarnation
            || self.server_url != server_url
            || self.user_id != user_id
            || self.recipients.len() > 4096
            || self
                .recipients
                .iter()
                .any(|(user, fingerprint)| !valid_user(user) || !valid_fingerprint(fingerprint))
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::StorageUnavailable,
                "Recipient verification storage is invalid",
            ));
        }
        Ok(())
    }

    pub(crate) fn verify(
        &mut self,
        user: &str,
        public_key: &str,
        expected: &str,
    ) -> Result<(), RuntimeError> {
        let fingerprint = candidate_fingerprint(user, public_key)?;
        let expected: String = expected
            .chars()
            .filter(|c| !c.is_ascii_whitespace())
            .collect::<String>()
            .to_ascii_uppercase();
        if expected != fingerprint {
            return Err(RuntimeError::new(
                RuntimeErrorCode::RecipientFingerprintMismatch,
                "Recipient fingerprint does not match",
            ));
        }
        if !self.recipients.contains_key(user) && self.recipients.len() >= 4096 {
            return Err(RuntimeError::new(
                RuntimeErrorCode::SizeRejected,
                "Recipient verification storage is full",
            ));
        }
        self.recipients.insert(user.to_owned(), fingerprint);
        Ok(())
    }

    pub(crate) fn approved_key(
        &self,
        user: &str,
        public_key: String,
    ) -> Result<String, RuntimeError> {
        let fingerprint = candidate_fingerprint(user, &public_key)?;
        match self.recipients.get(user) {
            None => Err(RuntimeError::new(
                RuntimeErrorCode::RecipientKeyUnverified,
                "Recipient key requires out-of-band verification",
            )),
            Some(verified) if verified != &fingerprint => Err(RuntimeError::new(
                RuntimeErrorCode::RecipientKeyChanged,
                "Recipient key changed; verify it again",
            )),
            Some(_) => Ok(public_key),
        }
    }
}

fn valid_user(user: &str) -> bool {
    !user.is_empty() && user.len() <= 256 && !user.contains('\0')
}

fn deserialize_recipients<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<BTreeMap<String, String>, D::Error> {
    struct Recipients;
    impl<'de> serde::de::Visitor<'de> for Recipients {
        type Value = BTreeMap<String, String>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("unique verified recipients")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> Result<Self::Value, M::Error> {
            let mut recipients = BTreeMap::new();
            while let Some((user, fingerprint)) = map.next_entry::<String, String>()? {
                if recipients.len() >= 4096
                    || !valid_user(&user)
                    || !valid_fingerprint(&fingerprint)
                    || recipients.insert(user, fingerprint).is_some()
                {
                    return Err(serde::de::Error::custom(
                        "invalid or duplicate verified recipient",
                    ));
                }
            }
            Ok(recipients)
        }
    }
    deserializer.deserialize_map(Recipients)
}
fn valid_fingerprint(value: &str) -> bool {
    value.len() == 69
        && value.starts_with("BVK1-")
        && value[5..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
}
fn candidate_fingerprint(user: &str, public_key: &str) -> Result<String, RuntimeError> {
    if !valid_user(user) {
        return Err(RuntimeError::new(
            RuntimeErrorCode::AccessDenied,
            "Recipient identity is invalid",
        ));
    }
    rsa_public_key_fingerprint(public_key).map_err(|_| {
        RuntimeError::new(
            RuntimeErrorCode::AccessDenied,
            "Recipient public key is invalid",
        )
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    #[test]
    fn malformed_or_duplicate_recipient_keys_never_deserialize() {
        let fingerprint = format!("BVK1-{}", "A".repeat(64));
        let document = |recipients: &str| {
            format!(
                r#"{{"version":1,"accountId":"a","incarnation":"i","serverUrl":"https://one","userId":"self","recipients":{recipients}}}"#
            )
        };
        for recipients in [
            format!(r#"{{"recipient":"{fingerprint}","recipient":"{fingerprint}"}}"#),
            r#"{"recipient":"BVK1-bad"}"#.into(),
            format!(r#"{{"":"{fingerprint}"}}"#),
        ] {
            assert!(serde_json::from_str::<VerifiedRecipientKeys>(&document(&recipients)).is_err());
        }
    }
    pub(crate) fn identities() -> &'static (
        bittery_crypto_core::RsaKeyPair,
        bittery_crypto_core::RsaKeyPair,
    ) {
        static KEYS: std::sync::OnceLock<(
            bittery_crypto_core::RsaKeyPair,
            bittery_crypto_core::RsaKeyPair,
        )> = std::sync::OnceLock::new();
        KEYS.get_or_init(|| {
            (
                bittery_crypto_core::generate_rsa_key_pair().unwrap(),
                bittery_crypto_core::generate_rsa_key_pair().unwrap(),
            )
        })
    }
    #[test]
    fn substitution_requires_independent_verification_on_first_use_and_key_change() {
        let (real, attacker) = identities();
        let mut trust = VerifiedRecipientKeys::new(
            AccountId::from("a"),
            Incarnation::from("i"),
            "https://one".into(),
            "self".into(),
        );
        let real_fingerprint = rsa_public_key_fingerprint(&real.public_key).unwrap();
        assert_eq!(
            trust
                .approved_key("recipient", attacker.public_key.clone())
                .unwrap_err()
                .code,
            RuntimeErrorCode::RecipientKeyUnverified
        );
        assert_eq!(
            trust
                .verify("recipient", &attacker.public_key, &real_fingerprint)
                .unwrap_err()
                .code,
            RuntimeErrorCode::RecipientFingerprintMismatch
        );
        assert!(trust.recipients.is_empty());
        trust
            .verify("recipient", &real.public_key, &real_fingerprint)
            .unwrap();
        assert_eq!(
            trust
                .approved_key("recipient", real.public_key.clone())
                .unwrap(),
            real.public_key
        );
        assert_eq!(
            trust
                .approved_key("recipient", attacker.public_key.clone())
                .unwrap_err()
                .code,
            RuntimeErrorCode::RecipientKeyChanged
        );
        assert_eq!(
            trust
                .approved_key("other-user", real.public_key.clone())
                .unwrap_err()
                .code,
            RuntimeErrorCode::RecipientKeyUnverified
        );
        trust
            .verify(
                "recipient",
                &attacker.public_key,
                &rsa_public_key_fingerprint(&attacker.public_key).unwrap(),
            )
            .unwrap();
        assert!(trust
            .approved_key("recipient", real.public_key.clone())
            .is_err());
        assert!(trust
            .validate(
                &AccountId::from("a"),
                &Incarnation::from("i"),
                "https://two",
                "self"
            )
            .is_err());
        assert!(trust
            .validate(
                &AccountId::from("a"),
                &Incarnation::from("other"),
                "https://one",
                "self"
            )
            .is_err());
    }
}
