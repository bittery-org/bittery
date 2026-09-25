fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&bittery_client_core::native_authority_contract_schema())
            .expect("native authority schema")
    );
}
