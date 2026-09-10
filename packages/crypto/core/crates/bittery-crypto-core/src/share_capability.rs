use crate::{
    encryption::{decrypt_with_raw_aad, encrypt_with_raw_aad},
    CryptoError, EncryptedData,
};

const AAD_DOMAIN: &[u8] = b"bittery.share-capability.v1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShareCapabilityAadContext {
    account_id: String,
    operation_id: String,
}

impl ShareCapabilityAadContext {
    pub fn new(account_id: String, operation_id: String) -> Result<Self, CryptoError> {
        for (name, value) in [
            ("accountId", account_id.as_str()),
            ("operationId", operation_id.as_str()),
        ] {
            if value.is_empty() || value.contains('\0') {
                return Err(CryptoError::InvalidInput(format!(
                    "Share capability AAD {name} is invalid"
                )));
            }
        }
        Ok(Self {
            account_id,
            operation_id,
        })
    }

    pub fn to_aad_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(
            AAD_DOMAIN.len() + self.account_id.len() + self.operation_id.len() + 2,
        );
        out.extend_from_slice(AAD_DOMAIN);
        out.push(0);
        out.extend_from_slice(self.account_id.as_bytes());
        out.push(0);
        out.extend_from_slice(self.operation_id.as_bytes());
        out
    }
}

pub fn encrypt_share_capability(
    plaintext: &str,
    master_unlock_key: &[u8],
    context: &ShareCapabilityAadContext,
) -> Result<EncryptedData, CryptoError> {
    encrypt_with_raw_aad(plaintext, master_unlock_key, &context.to_aad_bytes())
}

pub fn decrypt_share_capability(
    encrypted: &EncryptedData,
    master_unlock_key: &[u8],
    context: &ShareCapabilityAadContext,
) -> Result<String, CryptoError> {
    decrypt_with_raw_aad(encrypted, master_unlock_key, &context.to_aad_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_cross_language_account_operation_aad_vector_is_stable() {
        let context =
            ShareCapabilityAadContext::new("account-vector".into(), "operation-vector".into())
                .unwrap();
        assert_eq!(
            context.to_aad_bytes(),
            b"bittery.share-capability.v1\0account-vector\0operation-vector"
        );
        let encrypted = EncryptedData {
            // Produced independently with Node's `crypto.createCipheriv("aes-256-gcm", ...)`.
            ciphertext: "Dpb5ZCzpWdK6FGp0YxAdKvcmK21vrSUQq1uNKGocUdR4F61+pkZN".into(),
            iv: "EBESExQVFhcYGRob".into(),
            algorithm: "AES-GCM-AAD-V1".into(),
        };
        let key: Vec<u8> = (0..32).collect();
        assert_eq!(
            decrypt_share_capability(&encrypted, &key, &context).unwrap(),
            "share capability vector"
        );
        let foreign =
            ShareCapabilityAadContext::new("account-vector".into(), "operation-foreign".into())
                .unwrap();
        assert!(decrypt_share_capability(&encrypted, &key, &foreign).is_err());
    }
}
