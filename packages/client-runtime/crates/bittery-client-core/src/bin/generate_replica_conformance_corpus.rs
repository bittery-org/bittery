use bittery_client_core::generate_replica_conformance_corpus;
use std::{env, fs, path::PathBuf, process::ExitCode};

fn output_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../generated/replica-conformance/history-corpus.json")
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let check = env::args().skip(1).any(|argument| argument == "--check");
    let corpus = match generate_replica_conformance_corpus().await {
        Ok(corpus) => corpus,
        Err(error) => {
            eprintln!("failed to generate Replica conformance corpus: {error}");
            return ExitCode::FAILURE;
        }
    };
    let path = output_path();
    if check {
        match fs::read_to_string(&path) {
            Ok(checked_in) if checked_in == corpus => ExitCode::SUCCESS,
            Ok(_) => {
                eprintln!("{} is stale; regenerate it", path.display());
                ExitCode::FAILURE
            }
            Err(error) => {
                eprintln!("cannot read {}: {error}", path.display());
                ExitCode::FAILURE
            }
        }
    } else {
        if let Some(parent) = path.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                eprintln!("cannot create {}: {error}", parent.display());
                return ExitCode::FAILURE;
            }
        }
        match fs::write(&path, corpus) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("cannot write {}: {error}", path.display());
                ExitCode::FAILURE
            }
        }
    }
}
