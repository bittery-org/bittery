//! Wire spellings shared by every serialized Client Runtime contract.

pub(crate) mod import;

// Serde's normal struct and internally tagged derives also accept positional arrays. Pair this
// with `serde(remote = "Self")` to retain one wire definition and every typed field check.
macro_rules! map_only_serde {
    ($($name:ident),+ $(,)?) => {$(
        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                $name::serialize(self, serializer)
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                struct ObjectVisitor;
                impl<'de> serde::de::Visitor<'de> for ObjectVisitor {
                    type Value = $name;
                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        formatter.write_str("a control object")
                    }
                    fn visit_map<A: serde::de::MapAccess<'de>>(self, map: A) -> Result<$name, A::Error> {
                        $name::deserialize(serde::de::value::MapAccessDeserializer::new(map))
                    }
                }
                deserializer.deserialize_map(ObjectVisitor)
            }
        }
    )+};
}

pub(crate) use map_only_serde;

/// A field must be present even when its value is null. Serde otherwise treats Option as omitted.
pub(crate) fn required_nullable<'de, T: serde::Deserialize<'de>, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    <Option<T> as serde::Deserialize>::deserialize(deserializer)
}

/// Carries a `u64` as a canonical decimal string, because JSON numbers lose precision above 2^53
/// and every revision on the wire is compared for equality.
pub(crate) mod decimal_u64 {
    use serde::{Deserialize, Deserializer, Serializer};

    #[cfg(any(
        feature = "persistence-contract-schema",
        feature = "profile-admission-contract-schema",
        feature = "runtime-protocol-contract-schema"
    ))]
    pub fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({ "type": "string", "pattern": format!("^(?:0|{})$", super::positive_decimal_pattern(u64::MAX)) })
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

/// Optional timestamps retain the same canonical decimal spelling as required revisions.
pub(crate) mod optional_decimal_u64 {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    #[derive(Serialize, Deserialize)]
    struct Value(#[serde(with = "super::decimal_u64")] u64);
    pub fn serialize<S: Serializer>(value: &Option<u64>, serializer: S) -> Result<S::Ok, S::Error> {
        value.map(Value).serialize(serializer)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<u64>, D::Error> {
        Ok(Option::<Value>::deserialize(deserializer)?.map(|value| value.0))
    }
    #[cfg(feature = "runtime-protocol-contract-schema")]
    pub fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        let value = super::decimal_u64::json_schema(generator);
        schemars::json_schema!({ "anyOf": [value, { "type": "null" }] })
    }
}

/// Signed durations use the same lossless wire representation as unsigned revisions.
pub(crate) mod decimal_i64 {
    use serde::{Deserialize, Deserializer, Serializer};
    #[cfg(feature = "runtime-protocol-contract-schema")]
    pub fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({ "type": "string", "pattern": format!("^(?:0|{}|-(?:{}))$", super::positive_decimal_pattern(i64::MAX as u64), super::positive_decimal_pattern(i64::MIN.unsigned_abs())) })
    }
    pub fn serialize<S: Serializer>(value: &i64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
        let value = String::deserialize(deserializer)?;
        let parsed: i64 = value.parse().map_err(serde::de::Error::custom)?;
        if parsed.to_string() != value {
            return Err(serde::de::Error::custom(
                "expected a canonical signed decimal string",
            ));
        }
        Ok(parsed)
    }
}

#[cfg(any(
    feature = "persistence-contract-schema",
    feature = "profile-admission-contract-schema",
    feature = "runtime-protocol-contract-schema"
))]
fn positive_decimal_pattern(maximum: u64) -> String {
    let maximum = maximum.to_string();
    let mut alternatives = Vec::new();
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
        alternatives.push(format!("{prefix}{range}[0-9]{{{remaining}}}"));
    }
    alternatives.push(maximum.clone());
    format!(
        "[1-9][0-9]{{0,{}}}|(?:{})",
        maximum.len() - 2,
        alternatives.join("|")
    )
}
