use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
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
    #[serde(rename = "CONFLICT")]
    RetryableConflict,
    AttachmentStagingBusy,
    AttachmentStagingIncomplete,
    AttachmentStagingMismatch,
    AttachmentAuthorityStale,
    #[serde(rename = "TOO_MANY_REQUESTS")]
    TooManyRequests,
    #[serde(rename = "PAYLOAD_TOO_LARGE")]
    PayloadTooLarge,
    RotationStaleVaultVersion,
    RotationStaleMemberSet,
    RotationStaleItemState,
    RotationStaleAttachmentState,
}

#[derive(Clone, Debug, Serialize)]
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

    pub(crate) fn retryable_conflict(message: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::RetryableConflict,
            message: message.into(),
        }
    }

    pub(crate) fn attachment_staging_busy(message: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::AttachmentStagingBusy,
            message: message.into(),
        }
    }

    pub(crate) fn attachment_staging_incomplete(message: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::AttachmentStagingIncomplete,
            message: message.into(),
        }
    }

    pub(crate) fn attachment_staging_mismatch(message: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::AttachmentStagingMismatch,
            message: message.into(),
        }
    }

    pub(crate) fn attachment_authority_stale(message: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::AttachmentAuthorityStale,
            message: message.into(),
        }
    }

    pub(crate) fn rotation_stale(reason: crate::db::enums::VaultKeyRotationStaleReason) -> Self {
        use crate::db::enums::VaultKeyRotationStaleReason::*;
        Self {
            code: match reason {
                VaultVersion => AppErrorCode::RotationStaleVaultVersion,
                MemberSet => AppErrorCode::RotationStaleMemberSet,
                ItemState => AppErrorCode::RotationStaleItemState,
                AttachmentState => AppErrorCode::RotationStaleAttachmentState,
            },
            message: "Rotation plan is stale".to_owned(),
        }
    }

    pub fn too_many_requests(message: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::TooManyRequests,
            message: message.into(),
        }
    }

    pub fn payload_too_large(message: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::PayloadTooLarge,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}
