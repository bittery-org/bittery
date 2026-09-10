fn main() {
    let value = if std::env::args().any(|argument| argument == "--fixture") {
        bittery_client_bindings::artifact_control_contract_fixture()
    } else {
        serde_json::to_value(bittery_client_bindings::artifact_control_contract_schema())
            .expect("Attachment artifact control schema must serialize")
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&value)
            .expect("Attachment artifact control output must serialize")
    );
}
