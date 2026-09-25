use super::*;
use crate::server_contract::{AddVaultMemberBody, SuccessResponse};

impl AuthHttpClient<'_> {
    pub(crate) async fn add_vault_member(
        &self,
        token: &str,
        vault_id: &str,
        user_id: &str,
        body: &AddVaultMemberBody,
        cancellation: RequestCancellation,
    ) -> Result<InvitationMutationAnswer<SuccessResponse>, RuntimeError> {
        let url = self.endpoint(&["api", "v1", "vaults", vault_id, "members", user_id])?;
        let body = serde_json::to_vec(body).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Vault member request is invalid",
            )
        })?;
        self.non_idempotent_mutation(HttpMethod::Put, url, body, token, cancellation)
            .await
    }
}
