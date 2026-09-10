fn main() {
    let schema = bittery_client_core::platform_storage_contract_schema();
    println!(
        "{}",
        serde_json::to_string_pretty(&schema).expect("platform storage schema must serialize")
    );
}
