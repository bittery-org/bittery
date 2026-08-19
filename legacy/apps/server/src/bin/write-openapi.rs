use std::{path::PathBuf, process::ExitCode};

use bittery_server::openapi_json;

fn main() -> ExitCode {
    let mut arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    let check = arguments.first().is_some_and(|value| value == "--check");
    if check {
        arguments.remove(0);
    }
    let output_path = arguments
        .first()
        .map(PathBuf::from)
        .unwrap_or_else(default_output_path);

    if arguments.len() > 1 {
        eprintln!("usage: write-openapi [--check] [output-path]");
        return ExitCode::FAILURE;
    }

    let generated = openapi_json();
    if check {
        return match std::fs::read_to_string(&output_path) {
            Ok(current) if current == generated => ExitCode::SUCCESS,
            Ok(_) => {
                eprintln!("{} is not current", output_path.display());
                ExitCode::FAILURE
            }
            Err(error) => {
                eprintln!("failed to read {}: {error}", output_path.display());
                ExitCode::FAILURE
            }
        };
    }

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).expect("failed to create OpenAPI output directory");
    }
    std::fs::write(&output_path, generated).expect("failed to write OpenAPI document");
    println!("wrote OpenAPI document to {}", output_path.display());
    ExitCode::SUCCESS
}

fn default_output_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("packages/api-contract/openapi.v1.json")
}
