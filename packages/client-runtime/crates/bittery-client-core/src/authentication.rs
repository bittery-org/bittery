use crate::{
    auth_http::AuthHttpClient,
    server_contract::{
        AuthVaultKeyResponse, FinishLoginRequest, LoginUserResponse, StartLoginRequest,
        TravelModeResponse,
    },
    RequestCancellation, RuntimeError, RuntimeErrorCode,
};
use bittery_crypto_core::{
    derive_keys,
    srp6a::{HashAlgorithm, PrimeGroup},
    validate_kdf_profile, validate_secret_key, KdfProfile, SrpClient,
};
use zeroize::Zeroizing;

const SRP_USERNAME: &str = "";

/// Credentials and local downgrade evidence for one complete authentication ceremony.
pub(crate) struct AuthenticationInput<'input> {
    pub(crate) email: &'input str,
    pub(crate) master_password: &'input str,
    pub(crate) secret_key: &'input str,
    pub(crate) pinned_kdf_profile: Option<&'input KdfProfile>,
}

/// A result is constructible only after every remote proof and authenticated follow-up succeeds.
/// It deliberately has no `Debug` implementation because it owns live key and Session material.
pub(crate) struct VerifiedAuthentication {
    pub(crate) normalized_server_url: String,
    pub(crate) kdf_profile: KdfProfile,
    pub(crate) master_unlock_key: Zeroizing<[u8; 32]>,
    pub(crate) token: Zeroizing<String>,
    pub(crate) session_id: String,
    pub(crate) expires_at: String,
    pub(crate) user: LoginUserResponse,
    pub(crate) vault_keys: Vec<AuthVaultKeyResponse>,
    pub(crate) travel_mode: TravelModeResponse,
}

/// Performs the existing full SRP/KDF ceremony without installing or publishing an Account.
pub(crate) async fn authenticate(
    http: &AuthHttpClient<'_>,
    input: AuthenticationInput<'_>,
    cancellation: RequestCancellation,
) -> Result<VerifiedAuthentication, RuntimeError> {
    // Secret Key validation intentionally precedes both random SRP work and the first request.
    if !validate_secret_key(input.secret_key) {
        return Err(authentication_failure("Secret Key is invalid"));
    }
    ensure_not_cancelled(&cancellation)?;

    let srp = SrpClient::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
    let client_ephemeral = srp.generate_ephemeral();
    let attempt = http
        .start_login(
            &StartLoginRequest {
                email: input.email.to_owned(),
                client_public_key: client_ephemeral.public.clone(),
            },
            cancellation.clone(),
        )
        .await?;
    ensure_not_cancelled(&cancellation)?;

    // Checked conversion is part of treating the Server profile as untrusted wire input.
    let kdf_profile = KdfProfile {
        schema_version: u32::try_from(attempt.kdf_params.schema_version)
            .map_err(|_| authentication_failure("Server KDF profile is invalid"))?,
        algorithm: attempt.kdf_params.algorithm,
        iterations: u32::try_from(attempt.kdf_params.iterations)
            .map_err(|_| authentication_failure("Server KDF profile is invalid"))?,
    };
    validate_kdf_profile(&kdf_profile, input.pinned_kdf_profile)
        .map_err(|_| authentication_failure("Server KDF profile is invalid"))?;
    ensure_not_cancelled(&cancellation)?;

    let derived = derive_keys(
        input.master_password,
        input.secret_key,
        input.email,
        &kdf_profile,
    )
    .map_err(|_| authentication_failure("Account keys could not be derived"))?;
    ensure_not_cancelled(&cancellation)?;

    // The legacy Web path decoded arbitrary auth-key bytes lossily before SRP.
    let srp_password = Zeroizing::new(String::from_utf8_lossy(&derived.auth_key).into_owned());
    // `None` retains SHA-256's legacy default of 310,000 PBKDF2 iterations.
    let private_key = Zeroizing::new(
        srp.derive_safe_private_key(&attempt.salt, &srp_password, None)
            .map_err(|_| authentication_failure("SRP challenge is invalid"))?,
    );
    let client_session = srp
        .derive_session(
            &client_ephemeral.secret,
            &attempt.server_public_key,
            &attempt.salt,
            SRP_USERNAME,
            &private_key,
        )
        .map_err(|_| authentication_failure("SRP challenge is invalid"))?;
    ensure_not_cancelled(&cancellation)?;

    let finish = http
        .finish_login(
            &attempt.attempt_id,
            &FinishLoginRequest {
                client_public_key: client_ephemeral.public.clone(),
                client_proof: client_session.proof.clone(),
            },
            cancellation.clone(),
        )
        .await?;
    ensure_not_cancelled(&cancellation)?;

    srp.verify_session(
        &client_ephemeral.public,
        &client_session,
        &finish.server_proof,
    )
    .map_err(|_| authentication_failure("Server SRP proof is invalid"))?;
    ensure_not_cancelled(&cancellation)?;

    let vault_keys = http
        .drain_vault_keys(&finish.token, finish.vault_keys, cancellation.clone())
        .await?;
    let travel_mode = http
        .get_travel_mode(&finish.token, cancellation.clone())
        .await?;
    ensure_not_cancelled(&cancellation)?;

    Ok(VerifiedAuthentication {
        normalized_server_url: http.normalized_server_url(),
        kdf_profile,
        master_unlock_key: Zeroizing::new(derived.master_unlock_key),
        token: Zeroizing::new(finish.token),
        session_id: finish.session_id,
        expires_at: finish.expires_at,
        user: finish.user,
        vault_keys,
        travel_mode,
    })
}

fn ensure_not_cancelled(cancellation: &RequestCancellation) -> Result<(), RuntimeError> {
    if cancellation.is_cancelled() {
        Err(RuntimeError::new(
            RuntimeErrorCode::Cancelled,
            "Authentication request was cancelled",
        ))
    } else {
        Ok(())
    }
}

fn authentication_failure(message: &'static str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::AuthenticationUnavailable, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        auth_http::{AuthClientMetadata, ClientPlatform},
        http_transport::{HttpTransport, SerializedHttpExecutor},
    };
    use async_trait::async_trait;
    use bittery_crypto_core::{current_kdf_profile, SrpServer};
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};

    const EMAIL: &str = "alice@example.test";
    const PASSWORD: &str = "correct horse battery staple";
    const SECRET_KEY: &str = "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2";
    const SALT: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    struct ScriptedExecutor {
        responses: Mutex<Vec<String>>,
        requests: Mutex<Vec<Value>>,
    }

    impl ScriptedExecutor {
        fn new(responses: Vec<String>) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().rev().collect()),
                requests: Mutex::new(Vec::new()),
            }
        }

        fn requests(&self) -> Vec<Value> {
            self.requests.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl SerializedHttpExecutor for ScriptedExecutor {
        async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
            self.requests
                .lock()
                .unwrap()
                .push(serde_json::from_str(&request_json).unwrap());
            self.responses.lock().unwrap().pop().ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "test script exhausted",
                )
            })
        }

        fn cancel(&self, _dispatch_id: &str) {}
    }

    struct RealSrpExecutor {
        state: Mutex<RealSrpState>,
        kdf_profile: KdfProfile,
        bad_server_proof: bool,
    }

    struct RealSrpState {
        requests: Vec<Value>,
        server: SrpServer,
        verifier: String,
        server_ephemeral: bittery_crypto_core::srp6a::Ephemeral,
    }

    impl RealSrpExecutor {
        fn new(kdf_profile: KdfProfile, bad_server_proof: bool) -> Self {
            let srp = SrpClient::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
            let server = SrpServer::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
            let derived = derive_keys(PASSWORD, SECRET_KEY, EMAIL, &kdf_profile).unwrap();
            let password = Zeroizing::new(String::from_utf8_lossy(&derived.auth_key).into_owned());
            let private_key =
                Zeroizing::new(srp.derive_safe_private_key(SALT, &password, None).unwrap());
            let verifier = srp.derive_verifier(&private_key).unwrap();
            let server_ephemeral = server.generate_ephemeral(&verifier).unwrap();
            Self {
                state: Mutex::new(RealSrpState {
                    requests: Vec::new(),
                    server,
                    verifier,
                    server_ephemeral,
                }),
                kdf_profile,
                bad_server_proof,
            }
        }

        fn requests(&self) -> Vec<Value> {
            self.state.lock().unwrap().requests.clone()
        }
    }

    #[async_trait]
    impl SerializedHttpExecutor for RealSrpExecutor {
        async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
            let request: Value = serde_json::from_str(&request_json).unwrap();
            let url = request["url"].as_str().unwrap().to_owned();
            let mut state = self.state.lock().unwrap();
            state.requests.push(request);

            if url.ends_with("/api/v1/auth/login-attempts") {
                let body = request_body(state.requests.last().unwrap());
                assert_eq!(body["email"], EMAIL);
                return Ok(completed(
                    201,
                    json!({
                        "attemptId": "attempt-1",
                        "kdfParams": {
                            "algorithm": self.kdf_profile.algorithm,
                            "iterations": self.kdf_profile.iterations,
                            "schemaVersion": self.kdf_profile.schema_version
                        },
                        "salt": SALT,
                        "serverPublicKey": state.server_ephemeral.public
                    }),
                ));
            }

            if url.ends_with("/api/v1/auth/login-attempts/attempt-1/finish") {
                let body = request_body(state.requests.last().unwrap());
                let public = body["clientPublicKey"].as_str().unwrap();
                let proof = body["clientProof"].as_str().unwrap();
                let session = state
                    .server
                    .derive_session(
                        &state.server_ephemeral.secret,
                        public,
                        SALT,
                        SRP_USERNAME,
                        &state.verifier,
                        proof,
                    )
                    .expect("the real Server must accept the client's unchanged proof");
                let server_proof = if self.bad_server_proof {
                    "00".to_owned()
                } else {
                    session.proof.clone()
                };
                return Ok(completed(200, finish_response(server_proof)));
            }

            if url.ends_with("/api/v1/travel-mode") {
                return Ok(completed(
                    200,
                    json!({
                        "enabled": true,
                        "enabledAt": "2026-08-23T10:00:00Z",
                        "hiddenVaultIds": ["vault-hidden"],
                        "updatedAt": "2026-08-23T10:00:00Z"
                    }),
                ));
            }

            Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "unexpected test request",
            ))
        }

        fn cancel(&self, _dispatch_id: &str) {}
    }

    fn metadata() -> AuthClientMetadata {
        AuthClientMetadata {
            client_id: "client-7".into(),
            platform: ClientPlatform::Web,
            version: "0.5.2".into(),
        }
    }

    fn client(executor: Arc<dyn SerializedHttpExecutor>) -> (HttpTransport, String) {
        (
            HttpTransport::new(executor),
            "https://vault.example.test".into(),
        )
    }

    fn input<'a>(pinned_kdf_profile: Option<&'a KdfProfile>) -> AuthenticationInput<'a> {
        AuthenticationInput {
            email: EMAIL,
            master_password: PASSWORD,
            secret_key: SECRET_KEY,
            pinned_kdf_profile,
        }
    }

    fn completed(status: u16, body: Value) -> String {
        serde_json::to_string(&json!({
            "type": "completed",
            "status": status,
            "headers": [{ "name": "Content-Type", "value": "application/json" }],
            "body": serde_json::to_vec(&body).unwrap()
        }))
        .unwrap()
    }

    fn start_response(kdf: Value) -> String {
        completed(
            201,
            json!({
                "attemptId": "attempt-1",
                "kdfParams": kdf,
                "salt": SALT,
                "serverPublicKey": "02"
            }),
        )
    }

    fn finish_response(server_proof: String) -> Value {
        json!({
            "expiresAt": "2026-08-23T12:00:00Z",
            "serverProof": server_proof,
            "sessionId": "session-1",
            "token": "fresh-token",
            "user": {
                "email": EMAIL,
                "encryptedPrivateKey": "encrypted-private-key",
                "id": "user-1",
                "name": "Alice",
                "publicKey": "public-key",
                "secretKeyHint": "A3-ABCDEF",
                "teamAvatarUrl": null,
                "teamName": "Alice"
            },
            "vaultKeys": {
                "hasMore": false,
                "items": [],
                "nextCursor": null
            }
        })
    }

    fn request_body(request: &Value) -> Value {
        let bytes: Vec<u8> = serde_json::from_value(request["body"].clone()).unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn request_body_text(request: &Value) -> String {
        let bytes: Vec<u8> = serde_json::from_value(request["body"].clone()).unwrap();
        String::from_utf8(bytes).unwrap()
    }

    fn expect_error(result: Result<VerifiedAuthentication, RuntimeError>) -> RuntimeError {
        match result {
            Ok(_) => panic!("expected authentication to fail"),
            Err(error) => error,
        }
    }

    #[tokio::test]
    async fn unchanged_real_srp_ceremony_verifies_before_returning_zeroizing_muk() {
        let executor = Arc::new(RealSrpExecutor::new(current_kdf_profile(), false));
        let (transport, server_url) = client(executor.clone());
        let http = AuthHttpClient::new(&transport, &server_url, false, metadata()).unwrap();

        let verified = authenticate(&http, input(None), RequestCancellation::new())
            .await
            .unwrap();

        fn requires_zeroizing_muk(_: &Zeroizing<[u8; 32]>) {}
        requires_zeroizing_muk(&verified.master_unlock_key);
        let independently_derived =
            derive_keys(PASSWORD, SECRET_KEY, EMAIL, &current_kdf_profile()).unwrap();
        assert_eq!(
            &*verified.master_unlock_key,
            &independently_derived.master_unlock_key
        );
        assert_eq!(verified.normalized_server_url, server_url);
        assert_eq!(&*verified.token, "fresh-token");
        assert_eq!(verified.session_id, "session-1");
        assert_eq!(verified.expires_at, "2026-08-23T12:00:00Z");
        assert_eq!(verified.user.id, "user-1");
        assert!(verified.vault_keys.is_empty());
        assert!(verified.travel_mode.enabled);

        let requests = executor.requests();
        assert_eq!(requests.len(), 3);
        let start_body = request_body(&requests[0]);
        let finish_body = request_body(&requests[1]);
        assert_eq!(
            request_body_text(&requests[1]),
            format!(
                r#"{{"clientPublicKey":"{}","clientProof":"{}"}}"#,
                start_body["clientPublicKey"].as_str().unwrap(),
                finish_body["clientProof"].as_str().unwrap()
            )
        );
    }

    #[tokio::test]
    async fn invalid_secret_key_and_pre_cancelled_request_contact_no_server() {
        for (secret_key, cancelled) in [("not-a-secret-key", false), (SECRET_KEY, true)] {
            let executor = Arc::new(ScriptedExecutor::new(vec![]));
            let (transport, server_url) = client(executor.clone());
            let http = AuthHttpClient::new(&transport, &server_url, false, metadata()).unwrap();
            let cancellation = RequestCancellation::new();
            if cancelled {
                cancellation.cancel();
            }
            let error = expect_error(
                authenticate(
                    &http,
                    AuthenticationInput {
                        secret_key,
                        ..input(None)
                    },
                    cancellation,
                )
                .await,
            );
            assert_eq!(
                error.code,
                if cancelled {
                    RuntimeErrorCode::Cancelled
                } else {
                    RuntimeErrorCode::AuthenticationUnavailable
                }
            );
            assert!(executor.requests().is_empty());
        }
    }

    #[tokio::test]
    async fn transport_cancellation_stops_the_ceremony_after_start() {
        let executor = Arc::new(ScriptedExecutor::new(vec![
            r#"{"type":"cancelled"}"#.to_owned()
        ]));
        let (transport, server_url) = client(executor.clone());
        let http = AuthHttpClient::new(&transport, &server_url, false, metadata()).unwrap();

        let error =
            expect_error(authenticate(&http, input(None), RequestCancellation::new()).await);

        assert_eq!(error.code, RuntimeErrorCode::Cancelled);
        assert_eq!(executor.requests().len(), 1);
    }

    #[tokio::test]
    async fn invalid_or_downgraded_kdf_stops_before_finish() {
        let pinned = current_kdf_profile();
        for kdf in [
            json!({
                "algorithm": "pbkdf2-sha256",
                "iterations": -1,
                "schemaVersion": 1
            }),
            json!({
                "algorithm": "pbkdf2-sha256",
                "iterations": 600000,
                "schemaVersion": -1
            }),
        ] {
            let executor = Arc::new(ScriptedExecutor::new(vec![start_response(kdf)]));
            let (transport, server_url) = client(executor.clone());
            let http = AuthHttpClient::new(&transport, &server_url, false, metadata()).unwrap();
            let error = expect_error(
                authenticate(&http, input(Some(&pinned)), RequestCancellation::new()).await,
            );
            assert_eq!(error.code, RuntimeErrorCode::AuthenticationUnavailable);
            assert_eq!(executor.requests().len(), 1);
        }

        let stronger_pin = KdfProfile {
            iterations: pinned.iterations + 1,
            ..pinned.clone()
        };
        let executor = Arc::new(ScriptedExecutor::new(vec![start_response(json!({
            "algorithm": pinned.algorithm,
            "iterations": pinned.iterations,
            "schemaVersion": pinned.schema_version
        }))]));
        let (transport, server_url) = client(executor.clone());
        let http = AuthHttpClient::new(&transport, &server_url, false, metadata()).unwrap();
        let error = expect_error(
            authenticate(
                &http,
                input(Some(&stronger_pin)),
                RequestCancellation::new(),
            )
            .await,
        );
        assert_eq!(error.code, RuntimeErrorCode::AuthenticationUnavailable);
        assert_eq!(executor.requests().len(), 1);
    }

    #[tokio::test]
    async fn invalid_server_proof_prevents_authenticated_followups() {
        let executor = Arc::new(RealSrpExecutor::new(current_kdf_profile(), true));
        let (transport, server_url) = client(executor.clone());
        let http = AuthHttpClient::new(&transport, &server_url, false, metadata()).unwrap();

        let error =
            expect_error(authenticate(&http, input(None), RequestCancellation::new()).await);

        assert_eq!(error.code, RuntimeErrorCode::AuthenticationUnavailable);
        assert_eq!(executor.requests().len(), 2);
    }

    #[tokio::test]
    async fn server_profile_stronger_than_valid_pin_is_accepted() {
        let pinned = current_kdf_profile();
        let stronger = KdfProfile {
            iterations: pinned.iterations + 1,
            ..pinned.clone()
        };
        let executor = Arc::new(RealSrpExecutor::new(stronger.clone(), false));
        let (transport, server_url) = client(executor.clone());
        let http = AuthHttpClient::new(&transport, &server_url, false, metadata()).unwrap();

        let verified = authenticate(&http, input(Some(&pinned)), RequestCancellation::new())
            .await
            .unwrap();

        assert_eq!(verified.kdf_profile, stronger);
        assert_eq!(executor.requests().len(), 3);
    }
}
