use qubit::{
    builder::IntoResponse,
    server::{ErrorCode, RpcError},
};
use serde::Serialize;
use serde_json::json;
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
pub enum AppErrorCode {
    #[serde(rename = "INTERNAL_SERVER_ERROR")]
    InternalServerError,
    #[serde(rename = "BAD_REQUEST")]
    BadRequest,
    #[serde(rename = "NOT_FOUND")]
    NotFound,
    #[serde(rename = "FORBIDDEN")]
    Forbidden,
    #[serde(rename = "UNAUTHORIZED")]
    Unauthorized,
    #[serde(rename = "CONFLICT")]
    Conflict,
    #[serde(rename = "TOO_MANY_REQUESTS")]
    TooManyRequests,
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct AppError {
    pub code: AppErrorCode,
    pub message: String,
}

impl AppError {
    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::InternalServerError,
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::BadRequest,
            message: message.into(),
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::NotFound,
            message: message.into(),
        }
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::Forbidden,
            message: message.into(),
        }
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::Unauthorized,
            message: message.into(),
        }
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::Conflict,
            message: message.into(),
        }
    }

    pub fn too_many_requests(message: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::TooManyRequests,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl From<AppError> for RpcError {
    fn from(value: AppError) -> Self {
        let code = match value.code {
            AppErrorCode::Unauthorized => ErrorCode::ServerError(401),
            AppErrorCode::Forbidden => ErrorCode::ServerError(403),
            AppErrorCode::NotFound => ErrorCode::ServerError(404),
            AppErrorCode::Conflict => ErrorCode::ServerError(409),
            AppErrorCode::TooManyRequests => ErrorCode::ServerError(429),
            AppErrorCode::BadRequest => ErrorCode::InvalidParams,
            AppErrorCode::InternalServerError => ErrorCode::InternalError,
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
