fn main() {
    let schema = bittery_client_core::http_transport_contract_schema();
    println!(
        "{}",
        serde_json::to_string_pretty(&schema).expect("HTTP transport schema must serialize")
    );
}
