use qubit::{
    builder::IntoResponse,
    server::{ErrorCode, RpcError},
};
use serde::Serialize;
use serde_json::json;
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, TS)]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
}

impl AppError {
    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            code: "INTERNAL_SERVER_ERROR",
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            code: "BAD_REQUEST",
            message: message.into(),
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            code: "NOT_FOUND",
            message: message.into(),
        }
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self {
            code: "FORBIDDEN",
            message: message.into(),
        }
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            code: "UNAUTHORIZED",
            message: message.into(),
        }
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self {
            code: "CONFLICT",
            message: message.into(),
        }
    }

    pub fn too_many_requests(message: impl Into<String>) -> Self {
        Self {
            code: "TOO_MANY_REQUESTS",
            message: message.into(),
        }
    }
}

impl From<AppError> for RpcError {
    fn from(value: AppError) -> Self {
        let code = match value.code {
            "UNAUTHORIZED" => ErrorCode::ServerError(401),
            "FORBIDDEN" => ErrorCode::ServerError(403),
            "NOT_FOUND" => ErrorCode::ServerError(404),
            "CONFLICT" => ErrorCode::ServerError(409),
            "TOO_MANY_REQUESTS" => ErrorCode::ServerError(429),
            "BAD_REQUEST" => ErrorCode::InvalidParams,
            _ => ErrorCode::InternalError,
        };

        RpcError {
            code,
            message: value.message,
            data: Some(json!({ "code": value.code })),
        }
    }
}

impl IntoResponse for AppError {
    type Output = <RpcError as IntoResponse>::Output;

    fn into_response(self) -> jsonrpsee::ResponsePayload<'static, Self::Output> {
        RpcError::from(self).into_response()
    }
}
