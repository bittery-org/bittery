fn main() {
    let schema = bittery_client_core::persistence_contract_schema();
    println!(
        "{}",
        serde_json::to_string_pretty(&schema).expect("persistence schema must serialize")
    );
}
