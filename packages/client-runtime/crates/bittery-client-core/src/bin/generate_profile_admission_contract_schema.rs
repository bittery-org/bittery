fn main() {
    let schema = bittery_client_core::profile_admission_contract_schema();
    println!(
        "{}",
        serde_json::to_string_pretty(&schema).expect("profile admission schema must serialize")
    );
}
