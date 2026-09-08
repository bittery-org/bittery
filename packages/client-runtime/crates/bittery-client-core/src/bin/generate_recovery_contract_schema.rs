fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&bittery_client_core::recovery_contract_schema())
            .expect("recovery schema must serialize")
    );
}
