use rand::Rng;

use crate::system_rng;

/// Generate a RFC 4122 version 4 UUID using cryptographically secure randomness.
pub fn generate_uuid() -> String {
    let mut bytes = [0u8; 16];
    system_rng().fill_bytes(&mut bytes);

    // Set version (0100 for v4) and variant (10xx for RFC 4122).
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::generate_uuid;

    #[test]
    fn uuid_has_expected_format() {
        let id = generate_uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[8..9], "-");
        assert_eq!(&id[13..14], "-");
        assert_eq!(&id[18..19], "-");
        assert_eq!(&id[23..24], "-");
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
    }

    #[test]
    fn uuids_are_unique_in_sample() {
        let mut seen = HashSet::new();
        for _ in 0..100 {
            let id = generate_uuid();
            assert!(seen.insert(id));
        }
    }
}
