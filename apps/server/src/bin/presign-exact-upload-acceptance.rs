#[tokio::main]
async fn main() {
    let endpoint = std::env::args()
        .nth(1)
        .expect("usage: presign-exact-upload-acceptance <endpoint>");
    match bittery_server::exact_upload_chromium_acceptance_grant(&endpoint).await {
        Ok(grant) => println!("{grant}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
