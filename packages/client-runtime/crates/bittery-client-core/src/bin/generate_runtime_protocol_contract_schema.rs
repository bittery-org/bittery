fn main() {
    let schema = bittery_client_core::runtime_protocol_contract_schema();
    println!(
        "{}",
        serde_json::to_string_pretty(&schema).expect("Runtime protocol schema must serialize")
    );
}
