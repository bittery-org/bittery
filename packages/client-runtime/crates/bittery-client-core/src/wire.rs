//! Wire spellings shared by every serialized Client Runtime contract.

/// Carries a `u64` as a canonical decimal string, because JSON numbers lose precision above 2^53
/// and every revision on the wire is compared for equality.
pub(crate) mod decimal_u64 {
    use serde::{Deserialize, Deserializer, Serializer};

    #[cfg(any(
        feature = "persistence-contract-schema",
        feature = "runtime-protocol-contract-schema"
    ))]
    pub fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "type": "string",
            "pattern": canonical_pattern()
        })
    }

    #[cfg(any(
        feature = "persistence-contract-schema",
        feature = "runtime-protocol-contract-schema"
    ))]
    fn canonical_pattern() -> String {
        let maximum = u64::MAX.to_string();
        let mut maximum_length_alternatives = Vec::new();
        for (index, digit) in maximum.bytes().enumerate() {
            let lower = if index == 0 { b'1' } else { b'0' };
            if digit <= lower {
                continue;
            }
            let prefix = &maximum[..index];
            let upper = digit - 1;
            let range = if lower == upper {
                char::from(lower).to_string()
            } else {
                format!("[{}-{}]", char::from(lower), char::from(upper))
            };
            let remaining = maximum.len() - index - 1;
            maximum_length_alternatives.push(format!("{prefix}{range}[0-9]{{{remaining}}}"));
        }
        maximum_length_alternatives.push(maximum.clone());
        format!(
            "^(?:0|[1-9][0-9]{{0,{}}}|(?:{}))$",
            maximum.len() - 2,
            maximum_length_alternatives.join("|")
        )
    }

    pub fn serialize<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<u64, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        let parsed: u64 = value.parse().map_err(serde::de::Error::custom)?;
        if parsed.to_string() != value {
            return Err(serde::de::Error::custom(
                "expected a canonical unsigned decimal string",
            ));
        }
        Ok(parsed)
    }
}
