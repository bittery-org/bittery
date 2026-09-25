//! The closed preparation and exact-byte stage transport for a live Rotation attempt.
use super::*;
use crate::server_contract::{PreparationPage, StageRequest};

const ROTATION_PAGE_BYTES: u32 = 2 * 1024 * 1024;
const ROTATION_STAGE_RESPONSE_BYTES: u32 = 64 * 1024;

impl AuthHttpClient<'_> {
    pub(crate) async fn rotation_preparation_page(
        &self,
        token: &str,
        plan_id: &str,
        kind: &str,
        cursor: Option<&str>,
        cancellation: RequestCancellation,
    ) -> Result<AuthenticatedOutcome<PreparationPage>, RuntimeError> {
        let mut url = self.endpoint(&[
            "api",
            "v1",
            "vault-key-rotation-plans",
            plan_id,
            "preparation",
            kind,
        ])?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("limit", "100");
            if let Some(cursor) = cursor {
                query.append_pair("cursor", cursor);
            }
        }
        self.get_authenticated_json(url, ROTATION_PAGE_BYTES, token, cancellation)
            .await
            .map(|answer| answer.map(|page| page.value))
    }

    /// A stage response can be lost after the Server stores it. Keep one serialized body and
    /// resend only those identical bytes while this foreground attempt still owns them.
    pub(crate) async fn stage_rotation_outputs(
        &self,
        token: &str,
        plan_id: &str,
        kind: &str,
        stage: &StageRequest,
        cancellation: RequestCancellation,
    ) -> Result<(), RuntimeError> {
        let url = self.endpoint(&[
            "api",
            "v1",
            "vault-key-rotation-plans",
            plan_id,
            "staged",
            kind,
        ])?;
        let body =
            serde_json::to_vec(stage).map_err(|_| invariant("Rotation stage body is invalid"))?;
        let mut headers = self.headers(Some(token))?;
        headers.push(HttpHeader {
            name: "Content-Type".into(),
            value: "application/json".into(),
        });
        for _ in 0..2 {
            if cancellation.is_cancelled() {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::Cancelled,
                    "Rotation stage was cancelled",
                ));
            }
            let response = self
                .transport
                .execute(
                    HttpDispatch::new(
                        HttpMethod::Put,
                        url.as_str().into(),
                        headers.clone(),
                        body.clone(),
                        ROTATION_STAGE_RESPONSE_BYTES,
                    ),
                    cancellation.clone(),
                )
                .await?;
            match response {
                // Axum currently sends 200 for the Server's empty `Ok(())` stage
                // response; its OpenAPI contract advertises 204. Both are final
                // successes only when the response has no body.
                HttpResponse::Completed {
                    status: 200 | 204,
                    body,
                    ..
                } if body.is_empty() => return Ok(()),
                HttpResponse::Completed { status: 401, .. } => {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AuthenticationRequired,
                        "Rotation Session expired",
                    ))
                }
                HttpResponse::Completed {
                    status: 408 | 425 | 429 | 500..=599,
                    ..
                }
                | HttpResponse::NetworkFailure => continue,
                HttpResponse::Cancelled => {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::Cancelled,
                        "Rotation stage was cancelled",
                    ))
                }
                _ => {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AuthorityMissing,
                        "Rotation stage was refused",
                    ))
                }
            }
        }
        Err(RuntimeError::new(
            RuntimeErrorCode::RetryableTransport,
            "Rotation stage reply is uncertain",
        ))
    }

    pub(crate) async fn abandon_rotation_plan(
        &self,
        token: &str,
        plan_id: &str,
        cancellation: RequestCancellation,
    ) {
        let Ok(url) = self.endpoint(&["api", "v1", "vault-key-rotation-plans", plan_id]) else {
            return;
        };
        let Ok(headers) = self.headers(Some(token)) else {
            return;
        };
        let _ = self
            .transport
            .execute(
                HttpDispatch::new(
                    HttpMethod::Delete,
                    url.as_str().into(),
                    headers,
                    Vec::new(),
                    0,
                ),
                cancellation,
            )
            .await;
    }
}
