//! Shallow projections of `bittery-client-core` for native UniFFI and Web WASM hosts.

use bittery_client_core as core;
use std::fmt;
use std::sync::Arc;
#[cfg(not(target_arch = "wasm32"))]
use zeroize::Zeroizing;
use zeroize::{Zeroize, ZeroizeOnDrop};

uniffi::setup_scaffolding!();

/// Canonicalizes and validates an Account email through the Runtime's shared Rust policy.
#[uniffi::export]
pub fn normalize_account_email(input: String) -> Result<String, BindingError> {
    core::normalize_account_email(&input)
        .map(core::NormalizedAccountEmail::into_string)
        .map_err(Into::into)
}

#[cfg(test)]
static SENSITIVE_RUST_BUFFER_FREE_OBSERVATIONS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
fn take_sensitive_rust_buffer_free_observations() -> usize {
    SENSITIVE_RUST_BUFFER_FREE_OBSERVATIONS.swap(0, std::sync::atomic::Ordering::SeqCst)
}

/// Wipes a Rust-owned buffer carrying a native secret before returning it to UniFFI's allocator.
///
/// # Safety
///
/// `buffer` must be the uniquely owned `RustBuffer` returned by this component. The foreign
/// caller must not read it or free it again after this call.
#[no_mangle]
#[cfg(not(target_arch = "wasm32"))]
pub unsafe extern "C" fn ffi_bittery_client_bindings_sensitive_rustbuffer_free(
    buffer: uniffi::RustBuffer,
    call_status: &mut uniffi::RustCallStatus,
) {
    if !buffer.data_pointer().is_null() && !buffer.is_empty() {
        let bytes = unsafe {
            std::slice::from_raw_parts_mut(buffer.data_pointer().cast_mut(), buffer.len())
        };
        bytes.zeroize();
        #[cfg(test)]
        if bytes.iter().all(|byte| *byte == 0) {
            SENSITIVE_RUST_BUFFER_FREE_OBSERVATIONS
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
    uniffi::ffi::uniffi_rustbuffer_free(buffer, call_status);
}

#[derive(uniffi::Object, Zeroize, ZeroizeOnDrop)]
pub struct SecretString {
    value: String,
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretString([redacted])")
    }
}

#[uniffi::export]
impl SecretString {
    #[uniffi::constructor]
    pub fn new(value: String) -> Arc<Self> {
        Arc::new(Self { value })
    }

    /// Opens this already-delivered secret container for its explicit presentation caller.
    /// Account authorization occurs in Core's transient request and guarded response delivery.
    pub fn reveal(&self) -> String {
        self.value.clone()
    }
}

/// Native-only opaque plaintext input for Attachment Rename.
///
/// UniFFI enum payloads synthesize host-language stringification, so the plaintext cannot be a
/// `String` field directly on `RuntimeRequest::RenameAttachment`.
#[derive(uniffi::Object)]
pub struct AttachmentName {
    value: String,
}

impl fmt::Debug for AttachmentName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AttachmentName([redacted])")
    }
}

#[uniffi::export]
impl AttachmentName {
    #[uniffi::constructor]
    pub fn new(value: String) -> Arc<Self> {
        Arc::new(Self { value })
    }
}

/// Native-only opaque plaintext metadata for Attachment Upload.
#[derive(uniffi::Object)]
pub struct AttachmentUploadMetadata {
    name: String,
    content_type: String,
}

impl fmt::Debug for AttachmentUploadMetadata {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AttachmentUploadMetadata([redacted])")
    }
}

#[uniffi::export]
impl AttachmentUploadMetadata {
    #[uniffi::constructor]
    pub fn new(name: String, content_type: String) -> Arc<Self> {
        Arc::new(Self { name, content_type })
    }
}

#[derive(uniffi::Object)]
pub struct CustomField {
    id: String,
    label: String,
    value: String,
    field_type: CustomFieldKind,
}

impl fmt::Debug for CustomField {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CustomField")
            .field("plaintext", &"[redacted]")
            .field("field_type", &self.field_type)
            .finish()
    }
}

#[uniffi::export]
impl CustomField {
    #[uniffi::constructor]
    pub fn new(id: String, label: String, value: String, field_type: CustomFieldKind) -> Arc<Self> {
        Arc::new(Self {
            id,
            label,
            value,
            field_type,
        })
    }

    pub fn id(&self) -> String {
        self.id.clone()
    }

    pub fn label(&self) -> String {
        self.label.clone()
    }

    pub fn value(&self) -> String {
        self.value.clone()
    }

    pub fn field_type(&self) -> CustomFieldKind {
        self.field_type
    }
}

impl CustomField {
    fn to_core(&self) -> core::CustomField {
        core::CustomField {
            id: self.id.clone(),
            label: self.label.clone(),
            value: self.value.clone(),
            field_type: self.field_type.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum CustomFieldKind {
    Text,
    Password,
    Email,
    Url,
}

#[derive(uniffi::Object)]
pub struct PasswordHistoryEntry {
    password: String,
    changed_at: String,
}

#[derive(Clone, Copy, uniffi::Enum)]
pub enum PasskeyStatus {
    Active,
    Suspect,
}

#[derive(Clone, Copy, uniffi::Enum)]
pub enum PasskeyStatusReason {
    Manual,
    UnknownCredential,
    SigningError,
    Other,
}

#[derive(uniffi::Object)]
pub struct Passkey {
    credential_id: String,
    rp_id: String,
    rp_name: String,
    user_handle: String,
    user_name: String,
    user_display_name: String,
    private_key: String,
    public_key: String,
    algorithm: i32,
    sign_count: u32,
    transports: Vec<String>,
    created_at: String,
    last_used_at: Option<String>,
    status: Option<PasskeyStatus>,
    status_reason: Option<PasskeyStatusReason>,
    status_updated_at: Option<String>,
}

#[derive(Clone, Copy, uniffi::Enum)]
pub enum TotpAlgorithm {
    Sha1,
    Sha256,
    Sha512,
}

#[derive(Clone, Copy, uniffi::Enum)]
pub enum TotpDigits {
    Six,
    Seven,
    Eight,
}

#[derive(uniffi::Object)]
pub struct LoginItemData {
    title: String,
    url: Option<String>,
    urls: Vec<String>,
    username: Option<String>,
    password: Option<String>,
    password_history: Vec<Arc<PasswordHistoryEntry>>,
    passkeys: Vec<Arc<Passkey>>,
    notes: Option<String>,
    note: Option<String>,
    custom_fields: Vec<Arc<CustomField>>,
    tags: Vec<String>,
    totp_secret: Option<String>,
    totp_issuer: Option<String>,
    totp_account_name: Option<String>,
    totp_algorithm: Option<TotpAlgorithm>,
    totp_digits: Option<TotpDigits>,
    totp_period: Option<u32>,
}

#[derive(uniffi::Object)]
pub struct SecureNoteItemData {
    title: String,
    note: String,
    notes: Option<String>,
    custom_fields: Vec<Arc<CustomField>>,
    tags: Vec<String>,
}

#[derive(uniffi::Object)]
pub struct CreditCardItemData {
    title: String,
    cardholder_name: Option<String>,
    card_number: Option<String>,
    cvv: Option<String>,
    expiry_date: Option<String>,
    billing_address: Option<String>,
    notes: Option<String>,
    custom_fields: Vec<Arc<CustomField>>,
    totp_secret: Option<String>,
    totp_issuer: Option<String>,
    totp_account_name: Option<String>,
    totp_algorithm: Option<TotpAlgorithm>,
    totp_digits: Option<TotpDigits>,
    totp_period: Option<u32>,
    tags: Vec<String>,
}

#[derive(uniffi::Object)]
pub struct Address {
    id: String,
    street: String,
    city: String,
    state: String,
    zip: String,
    country: String,
}

#[derive(uniffi::Object)]
pub struct PhoneNumber {
    id: String,
    label: String,
    number: String,
}

#[derive(uniffi::Object)]
pub struct IdentityItemData {
    title: String,
    first_name: Option<String>,
    middle_name: Option<String>,
    last_name: Option<String>,
    email: Option<String>,
    addresses: Vec<Arc<Address>>,
    phone_numbers: Vec<Arc<PhoneNumber>>,
    ssn: Option<String>,
    passport_number: Option<String>,
    drivers_license: Option<String>,
    date_of_birth: Option<String>,
    notes: Option<String>,
    custom_fields: Vec<Arc<CustomField>>,
    totp_secret: Option<String>,
    totp_issuer: Option<String>,
    totp_account_name: Option<String>,
    totp_algorithm: Option<TotpAlgorithm>,
    totp_digits: Option<TotpDigits>,
    totp_period: Option<u32>,
    tags: Vec<String>,
}

#[derive(uniffi::Object)]
pub struct AuthenticatorItemData {
    title: String,
    totp_secret: String,
    totp_issuer: Option<String>,
    totp_account_name: Option<String>,
    totp_algorithm: Option<TotpAlgorithm>,
    totp_digits: Option<TotpDigits>,
    totp_period: Option<u32>,
    linked_item_id: Option<String>,
    notes: Option<String>,
    custom_fields: Vec<Arc<CustomField>>,
    tags: Vec<String>,
}

#[derive(Clone, uniffi::Enum)]
pub enum ItemDraft {
    Login { value: Arc<LoginItemData> },
    SecureNote { value: Arc<SecureNoteItemData> },
    CreditCard { value: Arc<CreditCardItemData> },
    Identity { value: Arc<IdentityItemData> },
    Authenticator { value: Arc<AuthenticatorItemData> },
}

/// Ordinary native observations expose credential metadata with no signing material.
#[derive(Clone, uniffi::Record)]
pub struct PublicPasskey {
    pub credential_id: String,
    pub rp_id: String,
    pub rp_name: String,
    pub user_handle: String,
    pub user_name: String,
    pub user_display_name: String,
    pub public_key: String,
    pub public_key_fingerprint: String,
    pub algorithm: i32,
    pub sign_count: u32,
    pub transports: Vec<String>,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub status: Option<PasskeyStatus>,
    pub status_reason: Option<PasskeyStatusReason>,
    pub status_updated_at: Option<String>,
}

#[derive(Clone, uniffi::Object)]
pub struct EditableLoginItemData {
    title: String,
    url: Option<String>,
    urls: Vec<String>,
    username: Option<String>,
    password: Option<String>,
    password_history: Vec<Arc<PasswordHistoryEntry>>,
    notes: Option<String>,
    note: Option<String>,
    custom_fields: Vec<Arc<CustomField>>,
    tags: Vec<String>,
    totp_secret: Option<String>,
    totp_issuer: Option<String>,
    totp_account_name: Option<String>,
    totp_algorithm: Option<TotpAlgorithm>,
    totp_digits: Option<TotpDigits>,
    totp_period: Option<u32>,
}

#[derive(uniffi::Object)]
pub struct PublicLoginItemData {
    editable: Arc<EditableLoginItemData>,
    passkeys: Vec<PublicPasskey>,
}

#[derive(Clone, uniffi::Enum)]
pub enum PublicItemDraft {
    Login { value: Arc<PublicLoginItemData> },
    SecureNote { value: Arc<SecureNoteItemData> },
    CreditCard { value: Arc<CreditCardItemData> },
    Identity { value: Arc<IdentityItemData> },
    Authenticator { value: Arc<AuthenticatorItemData> },
}

#[derive(Clone, uniffi::Enum)]
pub enum EditableItemDraft {
    Login { value: Arc<EditableLoginItemData> },
    SecureNote { value: Arc<SecureNoteItemData> },
    CreditCard { value: Arc<CreditCardItemData> },
    Identity { value: Arc<IdentityItemData> },
    Authenticator { value: Arc<AuthenticatorItemData> },
}

impl fmt::Debug for EditableItemDraft {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let category = match self {
            Self::Login { .. } => "login",
            Self::SecureNote { .. } => "secure-note",
            Self::CreditCard { .. } => "credit-card",
            Self::Identity { .. } => "identity",
            Self::Authenticator { .. } => "authenticator",
        };
        f.debug_struct("EditableItemDraft")
            .field("category", &category)
            .field("plaintext", &"[redacted]")
            .finish()
    }
}

#[derive(Clone, uniffi::Record)]
pub struct ItemEditGuard {
    pub account_id: String,
    pub incarnation: String,
    pub lock_epoch: u64,
    pub item_id: String,
    pub vault_id: String,
    pub item_version: i32,
}

#[derive(Clone, uniffi::Enum)]
pub enum DuplicateSourceGuard {
    Authoritative { item_version: i32 },
    AcceptedOverlay { operation_id: String },
}

#[derive(Clone, uniffi::Record)]
pub struct ItemDuplicateGuard {
    pub account_id: String,
    pub incarnation_id: String,
    pub lock_epoch: u64,
    pub source_item_id: String,
    pub vault_id: String,
    pub replica_revision: u64,
    pub source: DuplicateSourceGuard,
}

#[uniffi::export]
impl PasswordHistoryEntry {
    #[uniffi::constructor]
    pub fn new(password: String, changed_at: String) -> Arc<Self> {
        Arc::new(Self {
            password,
            changed_at,
        })
    }
    pub fn password(&self) -> String {
        self.password.clone()
    }
    pub fn changed_at(&self) -> String {
        self.changed_at.clone()
    }
}

#[uniffi::export]
impl Passkey {
    #[uniffi::constructor]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        credential_id: String,
        rp_id: String,
        rp_name: String,
        user_handle: String,
        user_name: String,
        user_display_name: String,
        private_key: String,
        public_key: String,
        algorithm: i32,
        sign_count: u32,
        transports: Vec<String>,
        created_at: String,
        last_used_at: Option<String>,
        status: Option<PasskeyStatus>,
        status_reason: Option<PasskeyStatusReason>,
        status_updated_at: Option<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            credential_id,
            rp_id,
            rp_name,
            user_handle,
            user_name,
            user_display_name,
            private_key,
            public_key,
            algorithm,
            sign_count,
            transports,
            created_at,
            last_used_at,
            status,
            status_reason,
            status_updated_at,
        })
    }
    pub fn credential_id(&self) -> String {
        self.credential_id.clone()
    }
    pub fn rp_id(&self) -> String {
        self.rp_id.clone()
    }
    pub fn rp_name(&self) -> String {
        self.rp_name.clone()
    }
    pub fn user_handle(&self) -> String {
        self.user_handle.clone()
    }
    pub fn user_name(&self) -> String {
        self.user_name.clone()
    }
    pub fn user_display_name(&self) -> String {
        self.user_display_name.clone()
    }
    pub fn private_key(&self) -> String {
        self.private_key.clone()
    }
    pub fn public_key(&self) -> String {
        self.public_key.clone()
    }
    pub fn algorithm(&self) -> i32 {
        self.algorithm
    }
    pub fn sign_count(&self) -> u32 {
        self.sign_count
    }
    pub fn transports(&self) -> Vec<String> {
        self.transports.clone()
    }
    pub fn created_at(&self) -> String {
        self.created_at.clone()
    }
    pub fn last_used_at(&self) -> Option<String> {
        self.last_used_at.clone()
    }
    pub fn status(&self) -> Option<PasskeyStatus> {
        self.status
    }
    pub fn status_reason(&self) -> Option<PasskeyStatusReason> {
        self.status_reason
    }
    pub fn status_updated_at(&self) -> Option<String> {
        self.status_updated_at.clone()
    }
}

#[uniffi::export]
impl LoginItemData {
    #[uniffi::constructor]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        title: String,
        url: Option<String>,
        urls: Vec<String>,
        username: Option<String>,
        password: Option<String>,
        password_history: Vec<Arc<PasswordHistoryEntry>>,
        passkeys: Vec<Arc<Passkey>>,
        notes: Option<String>,
        note: Option<String>,
        custom_fields: Vec<Arc<CustomField>>,
        tags: Vec<String>,
        totp_secret: Option<String>,
        totp_issuer: Option<String>,
        totp_account_name: Option<String>,
        totp_algorithm: Option<TotpAlgorithm>,
        totp_digits: Option<TotpDigits>,
        totp_period: Option<u32>,
    ) -> Arc<Self> {
        Arc::new(Self {
            title,
            url,
            urls,
            username,
            password,
            password_history,
            passkeys,
            notes,
            note,
            custom_fields,
            tags,
            totp_secret,
            totp_issuer,
            totp_account_name,
            totp_algorithm,
            totp_digits,
            totp_period,
        })
    }
    pub fn title(&self) -> String {
        self.title.clone()
    }
    pub fn url(&self) -> Option<String> {
        self.url.clone()
    }
    pub fn urls(&self) -> Vec<String> {
        self.urls.clone()
    }
    pub fn username(&self) -> Option<String> {
        self.username.clone()
    }
    pub fn password(&self) -> Option<String> {
        self.password.clone()
    }
    pub fn password_history(&self) -> Vec<Arc<PasswordHistoryEntry>> {
        self.password_history.clone()
    }
    pub fn passkeys(&self) -> Vec<Arc<Passkey>> {
        self.passkeys.clone()
    }
    pub fn notes(&self) -> Option<String> {
        self.notes.clone()
    }
    pub fn note(&self) -> Option<String> {
        self.note.clone()
    }
    pub fn custom_fields(&self) -> Vec<Arc<CustomField>> {
        self.custom_fields.clone()
    }
    pub fn tags(&self) -> Vec<String> {
        self.tags.clone()
    }
    pub fn totp_secret(&self) -> Option<String> {
        self.totp_secret.clone()
    }
    pub fn totp_issuer(&self) -> Option<String> {
        self.totp_issuer.clone()
    }
    pub fn totp_account_name(&self) -> Option<String> {
        self.totp_account_name.clone()
    }
    pub fn totp_algorithm(&self) -> Option<TotpAlgorithm> {
        self.totp_algorithm
    }
    pub fn totp_digits(&self) -> Option<TotpDigits> {
        self.totp_digits
    }
    pub fn totp_period(&self) -> Option<u32> {
        self.totp_period
    }
}

#[uniffi::export]
impl EditableLoginItemData {
    #[uniffi::constructor]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        title: String,
        url: Option<String>,
        urls: Vec<String>,
        username: Option<String>,
        password: Option<String>,
        password_history: Vec<Arc<PasswordHistoryEntry>>,
        notes: Option<String>,
        note: Option<String>,
        custom_fields: Vec<Arc<CustomField>>,
        tags: Vec<String>,
        totp_secret: Option<String>,
        totp_issuer: Option<String>,
        totp_account_name: Option<String>,
        totp_algorithm: Option<TotpAlgorithm>,
        totp_digits: Option<TotpDigits>,
        totp_period: Option<u32>,
    ) -> Arc<Self> {
        Arc::new(Self {
            title,
            url,
            urls,
            username,
            password,
            password_history,
            notes,
            note,
            custom_fields,
            tags,
            totp_secret,
            totp_issuer,
            totp_account_name,
            totp_algorithm,
            totp_digits,
            totp_period,
        })
    }

    pub fn title(&self) -> String {
        self.title.clone()
    }
    pub fn url(&self) -> Option<String> {
        self.url.clone()
    }
    pub fn urls(&self) -> Vec<String> {
        self.urls.clone()
    }
    pub fn username(&self) -> Option<String> {
        self.username.clone()
    }
    pub fn password(&self) -> Option<String> {
        self.password.clone()
    }
    pub fn password_history(&self) -> Vec<Arc<PasswordHistoryEntry>> {
        self.password_history.clone()
    }
    pub fn notes(&self) -> Option<String> {
        self.notes.clone()
    }
    pub fn note(&self) -> Option<String> {
        self.note.clone()
    }
    pub fn custom_fields(&self) -> Vec<Arc<CustomField>> {
        self.custom_fields.clone()
    }
    pub fn tags(&self) -> Vec<String> {
        self.tags.clone()
    }
    pub fn totp_secret(&self) -> Option<String> {
        self.totp_secret.clone()
    }
    pub fn totp_issuer(&self) -> Option<String> {
        self.totp_issuer.clone()
    }
    pub fn totp_account_name(&self) -> Option<String> {
        self.totp_account_name.clone()
    }
    pub fn totp_algorithm(&self) -> Option<TotpAlgorithm> {
        self.totp_algorithm
    }
    pub fn totp_digits(&self) -> Option<TotpDigits> {
        self.totp_digits
    }
    pub fn totp_period(&self) -> Option<u32> {
        self.totp_period
    }
}

#[uniffi::export]
impl PublicLoginItemData {
    pub fn editable(&self) -> Arc<EditableLoginItemData> {
        self.editable.clone()
    }
    pub fn passkeys(&self) -> Vec<PublicPasskey> {
        self.passkeys.clone()
    }
}

#[uniffi::export]
impl SecureNoteItemData {
    #[uniffi::constructor]
    pub fn new(
        title: String,
        note: String,
        notes: Option<String>,
        custom_fields: Vec<Arc<CustomField>>,
        tags: Vec<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            title,
            note,
            notes,
            custom_fields,
            tags,
        })
    }
    pub fn title(&self) -> String {
        self.title.clone()
    }
    pub fn note(&self) -> String {
        self.note.clone()
    }
    pub fn notes(&self) -> Option<String> {
        self.notes.clone()
    }
    pub fn custom_fields(&self) -> Vec<Arc<CustomField>> {
        self.custom_fields.clone()
    }
    pub fn tags(&self) -> Vec<String> {
        self.tags.clone()
    }
}

#[uniffi::export]
impl CreditCardItemData {
    #[uniffi::constructor]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        title: String,
        cardholder_name: Option<String>,
        card_number: Option<String>,
        cvv: Option<String>,
        expiry_date: Option<String>,
        billing_address: Option<String>,
        notes: Option<String>,
        custom_fields: Vec<Arc<CustomField>>,
        totp_secret: Option<String>,
        totp_issuer: Option<String>,
        totp_account_name: Option<String>,
        totp_algorithm: Option<TotpAlgorithm>,
        totp_digits: Option<TotpDigits>,
        totp_period: Option<u32>,
        tags: Vec<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            title,
            cardholder_name,
            card_number,
            cvv,
            expiry_date,
            billing_address,
            notes,
            custom_fields,
            totp_secret,
            totp_issuer,
            totp_account_name,
            totp_algorithm,
            totp_digits,
            totp_period,
            tags,
        })
    }
    pub fn title(&self) -> String {
        self.title.clone()
    }
    pub fn cardholder_name(&self) -> Option<String> {
        self.cardholder_name.clone()
    }
    pub fn card_number(&self) -> Option<String> {
        self.card_number.clone()
    }
    pub fn cvv(&self) -> Option<String> {
        self.cvv.clone()
    }
    pub fn expiry_date(&self) -> Option<String> {
        self.expiry_date.clone()
    }
    pub fn billing_address(&self) -> Option<String> {
        self.billing_address.clone()
    }
    pub fn notes(&self) -> Option<String> {
        self.notes.clone()
    }
    pub fn custom_fields(&self) -> Vec<Arc<CustomField>> {
        self.custom_fields.clone()
    }
    pub fn totp_secret(&self) -> Option<String> {
        self.totp_secret.clone()
    }
    pub fn totp_issuer(&self) -> Option<String> {
        self.totp_issuer.clone()
    }
    pub fn totp_account_name(&self) -> Option<String> {
        self.totp_account_name.clone()
    }
    pub fn totp_algorithm(&self) -> Option<TotpAlgorithm> {
        self.totp_algorithm
    }
    pub fn totp_digits(&self) -> Option<TotpDigits> {
        self.totp_digits
    }
    pub fn totp_period(&self) -> Option<u32> {
        self.totp_period
    }
    pub fn tags(&self) -> Vec<String> {
        self.tags.clone()
    }
}

#[uniffi::export]
impl Address {
    #[uniffi::constructor]
    pub fn new(
        id: String,
        street: String,
        city: String,
        state: String,
        zip: String,
        country: String,
    ) -> Arc<Self> {
        Arc::new(Self {
            id,
            street,
            city,
            state,
            zip,
            country,
        })
    }
    pub fn id(&self) -> String {
        self.id.clone()
    }
    pub fn street(&self) -> String {
        self.street.clone()
    }
    pub fn city(&self) -> String {
        self.city.clone()
    }
    pub fn state(&self) -> String {
        self.state.clone()
    }
    pub fn zip(&self) -> String {
        self.zip.clone()
    }
    pub fn country(&self) -> String {
        self.country.clone()
    }
}

#[uniffi::export]
impl PhoneNumber {
    #[uniffi::constructor]
    pub fn new(id: String, label: String, number: String) -> Arc<Self> {
        Arc::new(Self { id, label, number })
    }
    pub fn id(&self) -> String {
        self.id.clone()
    }
    pub fn label(&self) -> String {
        self.label.clone()
    }
    pub fn number(&self) -> String {
        self.number.clone()
    }
}

#[uniffi::export]
impl IdentityItemData {
    #[uniffi::constructor]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        title: String,
        first_name: Option<String>,
        middle_name: Option<String>,
        last_name: Option<String>,
        email: Option<String>,
        addresses: Vec<Arc<Address>>,
        phone_numbers: Vec<Arc<PhoneNumber>>,
        ssn: Option<String>,
        passport_number: Option<String>,
        drivers_license: Option<String>,
        date_of_birth: Option<String>,
        notes: Option<String>,
        custom_fields: Vec<Arc<CustomField>>,
        totp_secret: Option<String>,
        totp_issuer: Option<String>,
        totp_account_name: Option<String>,
        totp_algorithm: Option<TotpAlgorithm>,
        totp_digits: Option<TotpDigits>,
        totp_period: Option<u32>,
        tags: Vec<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            title,
            first_name,
            middle_name,
            last_name,
            email,
            addresses,
            phone_numbers,
            ssn,
            passport_number,
            drivers_license,
            date_of_birth,
            notes,
            custom_fields,
            totp_secret,
            totp_issuer,
            totp_account_name,
            totp_algorithm,
            totp_digits,
            totp_period,
            tags,
        })
    }
    pub fn title(&self) -> String {
        self.title.clone()
    }
    pub fn first_name(&self) -> Option<String> {
        self.first_name.clone()
    }
    pub fn middle_name(&self) -> Option<String> {
        self.middle_name.clone()
    }
    pub fn last_name(&self) -> Option<String> {
        self.last_name.clone()
    }
    pub fn email(&self) -> Option<String> {
        self.email.clone()
    }
    pub fn addresses(&self) -> Vec<Arc<Address>> {
        self.addresses.clone()
    }
    pub fn phone_numbers(&self) -> Vec<Arc<PhoneNumber>> {
        self.phone_numbers.clone()
    }
    pub fn ssn(&self) -> Option<String> {
        self.ssn.clone()
    }
    pub fn passport_number(&self) -> Option<String> {
        self.passport_number.clone()
    }
    pub fn drivers_license(&self) -> Option<String> {
        self.drivers_license.clone()
    }
    pub fn date_of_birth(&self) -> Option<String> {
        self.date_of_birth.clone()
    }
    pub fn notes(&self) -> Option<String> {
        self.notes.clone()
    }
    pub fn custom_fields(&self) -> Vec<Arc<CustomField>> {
        self.custom_fields.clone()
    }
    pub fn totp_secret(&self) -> Option<String> {
        self.totp_secret.clone()
    }
    pub fn totp_issuer(&self) -> Option<String> {
        self.totp_issuer.clone()
    }
    pub fn totp_account_name(&self) -> Option<String> {
        self.totp_account_name.clone()
    }
    pub fn totp_algorithm(&self) -> Option<TotpAlgorithm> {
        self.totp_algorithm
    }
    pub fn totp_digits(&self) -> Option<TotpDigits> {
        self.totp_digits
    }
    pub fn totp_period(&self) -> Option<u32> {
        self.totp_period
    }
    pub fn tags(&self) -> Vec<String> {
        self.tags.clone()
    }
}

#[uniffi::export]
impl AuthenticatorItemData {
    #[uniffi::constructor]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        title: String,
        totp_secret: String,
        totp_issuer: Option<String>,
        totp_account_name: Option<String>,
        totp_algorithm: Option<TotpAlgorithm>,
        totp_digits: Option<TotpDigits>,
        totp_period: Option<u32>,
        linked_item_id: Option<String>,
        notes: Option<String>,
        custom_fields: Vec<Arc<CustomField>>,
        tags: Vec<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            title,
            totp_secret,
            totp_issuer,
            totp_account_name,
            totp_algorithm,
            totp_digits,
            totp_period,
            linked_item_id,
            notes,
            custom_fields,
            tags,
        })
    }
    pub fn title(&self) -> String {
        self.title.clone()
    }
    pub fn totp_secret(&self) -> String {
        self.totp_secret.clone()
    }
    pub fn totp_issuer(&self) -> Option<String> {
        self.totp_issuer.clone()
    }
    pub fn totp_account_name(&self) -> Option<String> {
        self.totp_account_name.clone()
    }
    pub fn totp_algorithm(&self) -> Option<TotpAlgorithm> {
        self.totp_algorithm
    }
    pub fn totp_digits(&self) -> Option<TotpDigits> {
        self.totp_digits
    }
    pub fn totp_period(&self) -> Option<u32> {
        self.totp_period
    }
    pub fn linked_item_id(&self) -> Option<String> {
        self.linked_item_id.clone()
    }
    pub fn notes(&self) -> Option<String> {
        self.notes.clone()
    }
    pub fn custom_fields(&self) -> Vec<Arc<CustomField>> {
        self.custom_fields.clone()
    }
    pub fn tags(&self) -> Vec<String> {
        self.tags.clone()
    }
}

impl fmt::Debug for ItemDraft {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let category = match self {
            Self::Login { .. } => "login",
            Self::SecureNote { .. } => "secure-note",
            Self::CreditCard { .. } => "credit-card",
            Self::Identity { .. } => "identity",
            Self::Authenticator { .. } => "authenticator",
        };
        formatter
            .debug_struct("ItemDraft")
            .field("category", &category)
            .field("plaintext", &"[redacted]")
            .finish()
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct CreateShareDraft {
    pub access_mode: ShareAccessMode,
    pub expires_in: ShareExpiration,
    pub is_one_time_use: bool,
    pub allowed_emails: Vec<String>,
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum ShareAccessMode {
    Anyone,
    EmailRestricted,
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum ShareExpiration {
    OneHour,
    OneDay,
    SevenDays,
    FourteenDays,
    ThirtyDays,
}

impl ItemDraft {
    fn to_core(&self) -> core::ItemDraft {
        item_draft_to_core(self)
    }
}

#[derive(Clone, uniffi::Record)]
pub struct ImportItemDraft {
    pub draft: ItemDraft,
    pub favorite: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum BiometricKind {
    TouchId,
    FaceId,
    WindowsHello,
    Fingerprint,
    Face,
    Other,
}
impl From<core::BiometricKind> for BiometricKind {
    fn from(value: core::BiometricKind) -> Self {
        match value {
            core::BiometricKind::TouchId => Self::TouchId,
            core::BiometricKind::FaceId => Self::FaceId,
            core::BiometricKind::WindowsHello => Self::WindowsHello,
            core::BiometricKind::Fingerprint => Self::Fingerprint,
            core::BiometricKind::Face => Self::Face,
            core::BiometricKind::Other => Self::Other,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum BiometricFailure {
    Unavailable,
    NotEnrolled,
    NotEnabled,
    PasswordRequired,
    Cancelled,
    Failed,
    LockedOut,
    AccountChanged,
    TravelUnverified,
    StorageUnavailable,
}
impl From<core::BiometricFailure> for BiometricFailure {
    fn from(value: core::BiometricFailure) -> Self {
        match value {
            core::BiometricFailure::Unavailable => Self::Unavailable,
            core::BiometricFailure::NotEnrolled => Self::NotEnrolled,
            core::BiometricFailure::NotEnabled => Self::NotEnabled,
            core::BiometricFailure::PasswordRequired => Self::PasswordRequired,
            core::BiometricFailure::Cancelled => Self::Cancelled,
            core::BiometricFailure::Failed => Self::Failed,
            core::BiometricFailure::LockedOut => Self::LockedOut,
            core::BiometricFailure::AccountChanged => Self::AccountChanged,
            core::BiometricFailure::TravelUnverified => Self::TravelUnverified,
            core::BiometricFailure::StorageUnavailable => Self::StorageUnavailable,
        }
    }
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct BiometricHardware {
    pub has_hardware: bool,
    pub is_enrolled: bool,
    pub kind: Option<BiometricKind>,
}
impl From<core::BiometricHardware> for BiometricHardware {
    fn from(value: core::BiometricHardware) -> Self {
        Self {
            has_hardware: value.has_hardware,
            is_enrolled: value.is_enrolled,
            kind: value.kind.map(Into::into),
        }
    }
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct BiometricAccountAvailability {
    pub account_id: String,
    pub enabled: bool,
    pub failure: Option<BiometricFailure>,
}
impl From<core::BiometricAccountAvailability> for BiometricAccountAvailability {
    fn from(value: core::BiometricAccountAvailability) -> Self {
        Self {
            account_id: value.account_id.into(),
            enabled: value.enabled,
            failure: value.failure.map(Into::into),
        }
    }
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct BiometricAccountUnlock {
    pub account_id: String,
    pub failure: Option<BiometricFailure>,
}
impl From<core::BiometricAccountUnlock> for BiometricAccountUnlock {
    fn from(value: core::BiometricAccountUnlock) -> Self {
        Self {
            account_id: value.account_id.into(),
            failure: value.failure.map(Into::into),
        }
    }
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum TeamRole {
    Owner,
    Admin,
    Member,
}
impl From<core::server_contract::TeamRole> for TeamRole {
    fn from(value: core::server_contract::TeamRole) -> Self {
        match value {
            core::server_contract::TeamRole::Owner => Self::Owner,
            core::server_contract::TeamRole::Admin => Self::Admin,
            core::server_contract::TeamRole::Member => Self::Member,
        }
    }
}

impl From<TeamRole> for core::server_contract::TeamRole {
    fn from(value: TeamRole) -> Self {
        match value {
            TeamRole::Owner => Self::Owner,
            TeamRole::Admin => Self::Admin,
            TeamRole::Member => Self::Member,
        }
    }
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum VaultRole {
    Owner,
    Admin,
    Member,
    ReadOnly,
}
impl From<core::server_contract::VaultRole> for VaultRole {
    fn from(value: core::server_contract::VaultRole) -> Self {
        match value {
            core::server_contract::VaultRole::Owner => Self::Owner,
            core::server_contract::VaultRole::Admin => Self::Admin,
            core::server_contract::VaultRole::Member => Self::Member,
            core::server_contract::VaultRole::ReadOnly => Self::ReadOnly,
        }
    }
}
impl From<VaultRole> for core::server_contract::VaultRole {
    fn from(value: VaultRole) -> Self {
        match value {
            VaultRole::Owner => Self::Owner,
            VaultRole::Admin => Self::Admin,
            VaultRole::Member => Self::Member,
            VaultRole::ReadOnly => Self::ReadOnly,
        }
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct AvailableVaultMember {
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub public_key: String,
}
impl From<core::AvailableVaultMember> for AvailableVaultMember {
    fn from(value: core::AvailableVaultMember) -> Self {
        Self {
            user_id: value.user_id,
            name: value.name,
            email: value.email,
            public_key: value.public_key,
        }
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct CurrentVaultMember {
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub role: VaultRole,
}
impl From<core::CurrentVaultMember> for CurrentVaultMember {
    fn from(value: core::CurrentVaultMember) -> Self {
        Self {
            user_id: value.user_id,
            name: value.name,
            email: value.email,
            role: value.role.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum MyInvitationAction {
    Accept,
    Decline,
}
impl From<core::MyInvitationAction> for MyInvitationAction {
    fn from(value: core::MyInvitationAction) -> Self {
        match value {
            core::MyInvitationAction::Accept => Self::Accept,
            core::MyInvitationAction::Decline => Self::Decline,
        }
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct MyTeamInvitation {
    pub id: String,
    pub team_id: String,
    pub team_name: String,
    pub role: TeamRole,
    pub invited_by: String,
    pub expires_at: String,
}
impl From<core::MyTeamInvitation> for MyTeamInvitation {
    fn from(value: core::MyTeamInvitation) -> Self {
        let core::MyTeamInvitation {
            id,
            team_id,
            team_name,
            role,
            invited_by,
            expires_at,
        } = value;
        Self {
            id,
            team_id,
            team_name,
            role: role.into(),
            invited_by,
            expires_at,
        }
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct InvitationComposerVault {
    pub id: String,
    pub name: String,
}
impl From<core::InvitationComposerVault> for InvitationComposerVault {
    fn from(value: core::InvitationComposerVault) -> Self {
        let core::InvitationComposerVault { id, name } = value;
        Self { id, name }
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct InvitationSeatPreviewLine {
    pub id: String,
    pub description: String,
    pub amount_cents: String,
    pub currency: String,
    pub period_start: String,
    pub period_end: String,
    pub quantity: Option<String>,
    pub unit_amount_cents: Option<String>,
    pub is_proration: bool,
}
impl From<core::InvitationSeatPreviewLine> for InvitationSeatPreviewLine {
    fn from(value: core::InvitationSeatPreviewLine) -> Self {
        let core::InvitationSeatPreviewLine {
            id,
            description,
            amount_cents,
            currency,
            period_start,
            period_end,
            quantity,
            unit_amount_cents,
            is_proration,
        } = value;
        Self {
            id,
            description,
            amount_cents,
            currency,
            period_start,
            period_end,
            quantity,
            unit_amount_cents,
            is_proration,
        }
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct InvitationSeatPreview {
    pub currency: String,
    pub current_quantity: String,
    pub next_quantity: String,
    pub estimated_next_payment_cents: String,
    pub total_line_items_cents: String,
    pub lines: Vec<InvitationSeatPreviewLine>,
}
impl From<core::InvitationSeatPreview> for InvitationSeatPreview {
    fn from(value: core::InvitationSeatPreview) -> Self {
        let core::InvitationSeatPreview {
            currency,
            current_quantity,
            next_quantity,
            estimated_next_payment_cents,
            total_line_items_cents,
            lines,
        } = value;
        Self {
            currency,
            current_quantity,
            next_quantity,
            estimated_next_payment_cents,
            total_line_items_cents,
            lines: lines.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct InvitationComposerData {
    pub team_id: String,
    pub vaults: Vec<InvitationComposerVault>,
    pub billing_enabled: bool,
    pub team_plan_active: bool,
    pub seat_preview: Option<InvitationSeatPreview>,
}
impl From<core::InvitationComposerData> for InvitationComposerData {
    fn from(value: core::InvitationComposerData) -> Self {
        let core::InvitationComposerData {
            team_id,
            vaults,
            billing_enabled,
            team_plan_active,
            seat_preview,
        } = value;
        Self {
            team_id,
            vaults: vaults.into_iter().map(Into::into).collect(),
            billing_enabled,
            team_plan_active,
            seat_preview: seat_preview.map(Into::into),
        }
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct InvitationCandidate {
    pub recipient_user_id: String,
    pub public_key: String,
    pub fingerprint: String,
}
impl From<core::InvitationCandidate> for InvitationCandidate {
    fn from(value: core::InvitationCandidate) -> Self {
        let core::InvitationCandidate {
            recipient_user_id,
            public_key,
            fingerprint,
        } = value;
        Self {
            recipient_user_id,
            public_key,
            fingerprint,
        }
    }
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum InvitationUncertainPhase {
    FirstSend,
    CancelOriginal,
    ReplacementSend,
}
impl From<core::InvitationUncertainPhase> for InvitationUncertainPhase {
    fn from(value: core::InvitationUncertainPhase) -> Self {
        match value {
            core::InvitationUncertainPhase::FirstSend => Self::FirstSend,
            core::InvitationUncertainPhase::CancelOriginal => Self::CancelOriginal,
            core::InvitationUncertainPhase::ReplacementSend => Self::ReplacementSend,
        }
    }
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum InvitationAdminAction {
    Cancel,
    Resend,
}
impl From<core::InvitationAdminAction> for InvitationAdminAction {
    fn from(value: core::InvitationAdminAction) -> Self {
        match value {
            core::InvitationAdminAction::Cancel => Self::Cancel,
            core::InvitationAdminAction::Resend => Self::Resend,
        }
    }
}

#[derive(Clone, Debug, uniffi::Enum)]
pub enum RotationIntent {
    VaultMemberRemoval { vault_id: String, user_id: String },
    TeamLeave { team_id: String },
    TeamMemberRemoval { team_id: String, user_id: String },
}
impl From<RotationIntent> for core::RotationIntent {
    fn from(value: RotationIntent) -> Self {
        match value {
            RotationIntent::VaultMemberRemoval { vault_id, user_id } => {
                Self::VaultMemberRemoval { vault_id, user_id }
            }
            RotationIntent::TeamLeave { team_id } => Self::TeamLeave { team_id },
            RotationIntent::TeamMemberRemoval { team_id, user_id } => {
                Self::TeamMemberRemoval { team_id, user_id }
            }
        }
    }
}
impl From<core::RotationIntent> for RotationIntent {
    fn from(value: core::RotationIntent) -> Self {
        match value {
            core::RotationIntent::VaultMemberRemoval { vault_id, user_id } => {
                Self::VaultMemberRemoval { vault_id, user_id }
            }
            core::RotationIntent::TeamLeave { team_id } => Self::TeamLeave { team_id },
            core::RotationIntent::TeamMemberRemoval { team_id, user_id } => {
                Self::TeamMemberRemoval { team_id, user_id }
            }
        }
    }
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct RotationPlanSelection {
    pub plan_id: String,
    pub vault_id: String,
    pub expected_key_version: i32,
}
impl From<core::RotationPlanSelection> for RotationPlanSelection {
    fn from(value: core::RotationPlanSelection) -> Self {
        Self {
            plan_id: value.plan_id,
            vault_id: value.vault_id,
            expected_key_version: value.expected_key_version,
        }
    }
}
impl From<RotationPlanSelection> for core::RotationPlanSelection {
    fn from(value: RotationPlanSelection) -> Self {
        Self {
            plan_id: value.plan_id,
            vault_id: value.vault_id,
            expected_key_version: value.expected_key_version,
        }
    }
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct RotationCandidate {
    pub user_id: String,
    pub public_key: String,
    pub fingerprint: String,
}
impl From<core::RotationCandidate> for RotationCandidate {
    fn from(value: core::RotationCandidate) -> Self {
        Self {
            user_id: value.user_id,
            public_key: value.public_key,
            fingerprint: value.fingerprint,
        }
    }
}
impl From<RotationCandidate> for core::RotationCandidate {
    fn from(value: RotationCandidate) -> Self {
        Self {
            user_id: value.user_id,
            public_key: value.public_key,
            fingerprint: value.fingerprint,
        }
    }
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct RotationSelection {
    pub account_id: String,
    pub incarnation_id: String,
    pub lock_epoch: String,
    pub authority_generation_id: String,
    pub intent: RotationIntent,
    pub start_operation_id: String,
    pub plans: Vec<RotationPlanSelection>,
    pub candidates: Vec<RotationCandidate>,
}
impl From<core::RotationSelection> for RotationSelection {
    fn from(value: core::RotationSelection) -> Self {
        Self {
            account_id: value.account_id.into(),
            incarnation_id: value.incarnation_id.into(),
            lock_epoch: value.lock_epoch,
            authority_generation_id: value.authority_generation_id,
            intent: value.intent.into(),
            start_operation_id: value.start_operation_id,
            plans: value.plans.into_iter().map(Into::into).collect(),
            candidates: value.candidates.into_iter().map(Into::into).collect(),
        }
    }
}
impl From<RotationSelection> for core::RotationSelection {
    fn from(value: RotationSelection) -> Self {
        Self {
            account_id: value.account_id.into(),
            incarnation_id: value.incarnation_id.into(),
            lock_epoch: value.lock_epoch,
            authority_generation_id: value.authority_generation_id,
            intent: value.intent.into(),
            start_operation_id: value.start_operation_id,
            plans: value.plans.into_iter().map(Into::into).collect(),
            candidates: value.candidates.into_iter().map(Into::into).collect(),
        }
    }
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct TeamLeaveAttempt {
    pub team_id: String,
    pub start_operation_id: String,
}
impl From<core::TeamLeaveAttempt> for TeamLeaveAttempt {
    fn from(value: core::TeamLeaveAttempt) -> Self {
        Self {
            team_id: value.team_id,
            start_operation_id: value.start_operation_id,
        }
    }
}
#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum RotationStartRejectionCode {
    TeamMemberNotFound,
    PersonalTeamDepartureForbidden,
    TeamOwnerLeaveForbidden,
}
impl From<core::RotationStartRejectionCode> for RotationStartRejectionCode {
    fn from(value: core::RotationStartRejectionCode) -> Self {
        match value {
            core::RotationStartRejectionCode::TeamMemberNotFound => Self::TeamMemberNotFound,
            core::RotationStartRejectionCode::PersonalTeamDepartureForbidden => {
                Self::PersonalTeamDepartureForbidden
            }
            core::RotationStartRejectionCode::TeamOwnerLeaveForbidden => {
                Self::TeamOwnerLeaveForbidden
            }
        }
    }
}
#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum RotationFinalizeRejectionCode {
    TeamMembershipChanged,
    PersonalTeamDepartureForbidden,
    TeamOwnerLeaveForbidden,
    RotationPlanUnavailable,
    RotationPlanMismatch,
    RotationPlanIncomplete,
    RotationPlanStale,
    RotationPlanSetMismatch,
}
impl From<core::RotationFinalizeRejectionCode> for RotationFinalizeRejectionCode {
    fn from(value: core::RotationFinalizeRejectionCode) -> Self {
        match value {
            core::RotationFinalizeRejectionCode::TeamMembershipChanged => {
                Self::TeamMembershipChanged
            }
            core::RotationFinalizeRejectionCode::PersonalTeamDepartureForbidden => {
                Self::PersonalTeamDepartureForbidden
            }
            core::RotationFinalizeRejectionCode::TeamOwnerLeaveForbidden => {
                Self::TeamOwnerLeaveForbidden
            }
            core::RotationFinalizeRejectionCode::RotationPlanUnavailable => {
                Self::RotationPlanUnavailable
            }
            core::RotationFinalizeRejectionCode::RotationPlanMismatch => Self::RotationPlanMismatch,
            core::RotationFinalizeRejectionCode::RotationPlanIncomplete => {
                Self::RotationPlanIncomplete
            }
            core::RotationFinalizeRejectionCode::RotationPlanStale => Self::RotationPlanStale,
            core::RotationFinalizeRejectionCode::RotationPlanSetMismatch => {
                Self::RotationPlanSetMismatch
            }
        }
    }
}
#[derive(Clone, Debug, uniffi::Enum)]
pub enum RotationTerminalOutcome {
    Applied { personal_team_id: String },
    Rejected { code: RotationFinalizeRejectionCode },
}
impl From<core::RotationTerminalOutcome> for RotationTerminalOutcome {
    fn from(value: core::RotationTerminalOutcome) -> Self {
        match value {
            core::RotationTerminalOutcome::Applied { personal_team_id } => {
                Self::Applied { personal_team_id }
            }
            core::RotationTerminalOutcome::Rejected { code } => {
                Self::Rejected { code: code.into() }
            }
        }
    }
}

#[derive(Clone, uniffi::Enum)]
pub enum RuntimeRequest {
    ListAvailableVaultMembers {
        account_id: String,
        vault_id: String,
    },
    ListVaultMembers {
        account_id: String,
        vault_id: String,
    },
    AddVaultMember {
        account_id: String,
        vault_id: String,
        user_id: String,
        role: VaultRole,
    },
    PrepareRotation {
        account_id: String,
        intent: RotationIntent,
        start_operation_id: Option<String>,
    },
    CompleteRotation {
        account_id: String,
        selection: RotationSelection,
    },
    InspectRotation {
        account_id: String,
        start_operation_id: String,
    },
    ListTeamLeaveAttempts {
        account_id: String,
    },
    AcknowledgeTeamLeaveAttempt {
        account_id: String,
        start_operation_id: String,
    },
    ListMyTeamInvitations {
        account_id: String,
    },
    AcceptMyTeamInvitation {
        account_id: String,
        invitation_id: String,
    },
    DeclineMyTeamInvitation {
        account_id: String,
        invitation_id: String,
    },
    ReadInvitationComposer {
        account_id: String,
        team_id: String,
    },
    CreateTeamInvitation {
        account_id: String,
        team_id: String,
        email: String,
        role: TeamRole,
    },
    ProvisionTeamInvitation {
        account_id: String,
        continuation_id: String,
    },
    ReleaseInvitationContinuation {
        account_id: String,
        continuation_id: String,
    },
    CancelTeamInvitation {
        account_id: String,
        team_id: String,
        invitation_id: String,
    },
    ResendTeamInvitation {
        account_id: String,
        team_id: String,
        invitation_id: String,
    },
    InspectProfileAdmission,
    AbortProfileAdmission {
        admission_id: String,
    },
    RecipientKeyScope {
        account_id: String,
    },
    OwnKeyFingerprint {
        account_id: String,
    },
    VerifyRecipientKey {
        account_id: String,
        recipient_user_id: String,
        public_key: String,
        expected_fingerprint: String,
        scope: String,
    },
    VerifiedRecipientKey {
        account_id: String,
        recipient_user_id: String,
        public_key: String,
        scope: String,
    },
    RefreshTravelMode {
        account_id: String,
    },
    SetTravelModeHiddenVaults {
        account_id: String,
        hidden_vault_ids: Vec<String>,
    },
    EnableTravelMode {
        account_id: String,
        hidden_vault_ids: Vec<String>,
    },
    DisableTravelMode {
        account_id: String,
        master_password: Arc<SecretString>,
    },
    RebootstrapAccountRecovery {
        account_id: String,
    },
    InspectRecovery {
        account_id: Option<String>,
    },
    ExportAccountRecovery {
        account_id: String,
        password: Arc<SecretString>,
        sink_capability_id: String,
    },
    RepairAccountRecovery {
        account_id: String,
        password: Arc<SecretString>,
        source_capability_id: String,
    },
    SignIn {
        server_url: String,
        email: String,
        master_password: Arc<SecretString>,
        secret_key: Arc<SecretString>,
        insecure_transport_confirmed: bool,
    },
    BiometricAvailability {
        account_ids: Vec<String>,
    },
    SetBiometricEnabled {
        account_id: String,
        enabled: bool,
    },
    BiometricUnlock {
        account_id: String,
        prompt_message: String,
    },
    BiometricUnlockAccounts {
        account_ids: Vec<String>,
        prompt_message: String,
    },
    SetMasterPasswordReentryPeriod {
        period_ms: i64,
    },
    LocalSecuritySettings {
        account_id: String,
    },
    SetInactivityTimeout {
        account_id: String,
        timeout_ms: i64,
    },
    RecordActivity {
        account_id: String,
        kind: ActivityKind,
    },
    DeviceSetup {
        account_id: String,
    },
    QuickUnlockAccounts {
        account_ids: Vec<String>,
        master_password: Arc<SecretString>,
    },
    QuickUnlock {
        account_id: String,
        master_password: Arc<SecretString>,
    },
    Lock {
        account_id: String,
    },
    SignOut {
        account_id: String,
    },
    RemoveAccount {
        account_id: String,
    },
    DeleteServerAccount {
        account_id: String,
        confirm_email: String,
        request_id: String,
    },
    Wipe,
    UpdateVault {
        account_id: String,
        vault_id: String,
        name: Option<String>,
        icon: VaultIconPatch,
        image: VaultImageChange,
    },
    DeleteVault {
        account_id: String,
        vault_id: String,
    },
    CreateVault {
        account_id: String,
        name: String,
        vault_type: CreateVaultType,
        icon: String,
        image_source: Option<VaultImageSourceInput>,
    },
    CreateItem {
        account_id: String,
        vault_id: String,
        draft: EditableItemDraft,
    },
    ImportItems {
        account_id: String,
        vault_id: String,
        items: Vec<ImportItemDraft>,
    },
    UpdateItem {
        account_id: String,
        item_id: String,
        guard: ItemEditGuard,
        draft: EditableItemDraft,
    },
    RemovePasskey {
        account_id: String,
        item_id: String,
        guard: ItemEditGuard,
        rp_id: String,
        credential_id: String,
        public_key_fingerprint: String,
    },
    DuplicateItem {
        account_id: String,
        source_item_id: String,
        source_guard: ItemDuplicateGuard,
        title: String,
    },
    SetItemFavorite {
        account_id: String,
        item_id: String,
        favorite: bool,
    },
    TrashItem {
        account_id: String,
        item_id: String,
    },
    RestoreItem {
        account_id: String,
        item_id: String,
    },
    MoveItem {
        account_id: String,
        item_id: String,
        target_vault_id: String,
        target_account_id: Option<String>,
    },
    PrepareCrossAccountMoveResume {
        account_id: String,
        operation_id: String,
        target_account_id: String,
        expected_binding_revision: u64,
    },
    ResumeCrossAccountMove {
        guard: CrossAccountMoveResumeGuard,
    },
    PermanentlyDeleteItem {
        account_id: String,
        item_id: String,
    },
    CreateShare {
        account_id: String,
        item_id: String,
        draft: CreateShareDraft,
    },
    AcknowledgeShareResult {
        account_id: String,
        operation_id: String,
    },
    ListItemShareLinks {
        account_id: String,
        item_id: String,
    },
    ListShareAccessLogs {
        account_id: String,
        item_id: String,
        link_id: String,
    },
    RevokeShareLink {
        account_id: String,
        item_id: String,
        link_id: String,
    },
    RenameAttachment {
        account_id: String,
        attachment_id: String,
        name: Arc<AttachmentName>,
    },
    DeleteAttachment {
        account_id: String,
        attachment_id: String,
    },
    DownloadAttachment {
        account_id: String,
        attachment_id: String,
        sink_capability_id: String,
    },
    UploadAttachment {
        account_id: String,
        item_id: String,
        metadata: Arc<AttachmentUploadMetadata>,
        file_size: u64,
        source_capability_id: String,
    },
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct ShareAllowedEmail {
    pub email: String,
    pub verified: bool,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct ShareLinkSummary {
    pub id: String,
    pub status: ShareLinkStatus,
    pub access_mode: ShareAccessMode,
    pub is_one_time_use: bool,
    pub access_count: i32,
    pub max_access_count: Option<i32>,
    pub allowed_emails: Vec<ShareAllowedEmail>,
    pub expires_at: String,
    pub created_at: String,
    pub last_accessed_at: Option<String>,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct ShareAccessLog {
    pub id: String,
    pub accessed_by_email: Option<String>,
    pub ip_address: Option<String>,
    pub user_agent: Option<String>,
    pub success: bool,
    pub failure_reason: Option<String>,
    pub accessed_at: String,
}
#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum ShareLinkStatus {
    Active,
    Expired,
    Exhausted,
    Revoked,
}
impl From<core::ShareLinkSummary> for ShareLinkSummary {
    fn from(value: core::ShareLinkSummary) -> Self {
        Self {
            id: value.id,
            status: match value.status {
                core::ShareLinkStatus::Active => ShareLinkStatus::Active,
                core::ShareLinkStatus::Expired => ShareLinkStatus::Expired,
                core::ShareLinkStatus::Exhausted => ShareLinkStatus::Exhausted,
                core::ShareLinkStatus::Revoked => ShareLinkStatus::Revoked,
            },
            access_mode: match value.access_mode {
                core::ShareAccessMode::Anyone => ShareAccessMode::Anyone,
                core::ShareAccessMode::EmailRestricted => ShareAccessMode::EmailRestricted,
            },
            is_one_time_use: value.is_one_time_use,
            access_count: value.access_count,
            max_access_count: value.max_access_count,
            allowed_emails: value
                .allowed_emails
                .into_iter()
                .map(|email| ShareAllowedEmail {
                    email: email.email,
                    verified: email.verified,
                })
                .collect(),
            expires_at: value.expires_at,
            created_at: value.created_at,
            last_accessed_at: value.last_accessed_at,
        }
    }
}
impl From<core::ShareAccessLog> for ShareAccessLog {
    fn from(value: core::ShareAccessLog) -> Self {
        Self {
            id: value.id,
            accessed_by_email: value.accessed_by_email,
            ip_address: value.ip_address,
            user_agent: value.user_agent,
            success: value.success,
            failure_reason: value.failure_reason,
            accessed_at: value.accessed_at,
        }
    }
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum CreateVaultType {
    Personal,
    Shared,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct VaultImageSourceInput {
    pub capability_id: String,
    pub byte_length: u64,
    pub content_type: String,
}

#[derive(Clone, Debug, uniffi::Enum)]
pub enum VaultIconPatch {
    Unchanged,
    Clear,
    Set { value: String },
}
#[derive(Clone, uniffi::Enum)]
pub enum VaultImageChange {
    Unchanged,
    Remove,
    Source { source: VaultImageSourceInput },
}
impl fmt::Debug for VaultImageChange {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unchanged => formatter.write_str("Unchanged"),
            Self::Remove => formatter.write_str("Remove"),
            Self::Source { .. } => formatter.write_str("Source([redacted])"),
        }
    }
}
impl From<VaultImageSourceInput> for core::VaultImageSourceInput {
    fn from(source: VaultImageSourceInput) -> Self {
        Self {
            capability_id: source.capability_id,
            byte_length: source.byte_length,
            content_type: source.content_type,
        }
    }
}

impl fmt::Debug for RuntimeRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ListAvailableVaultMembers { .. }
            | Self::ListVaultMembers { .. }
            | Self::AddVaultMember { .. } => {
                formatter.write_str("VaultMembership([redacted Account scope])")
            }
            Self::PrepareRotation { .. }
            | Self::CompleteRotation { .. }
            | Self::InspectRotation { .. }
            | Self::ListTeamLeaveAttempts { .. }
            | Self::AcknowledgeTeamLeaveAttempt { .. } => {
                formatter.write_str("Rotation([redacted Account scope])")
            }
            Self::ListMyTeamInvitations { .. }
            | Self::AcceptMyTeamInvitation { .. }
            | Self::DeclineMyTeamInvitation { .. }
            | Self::ReadInvitationComposer { .. }
            | Self::CreateTeamInvitation { .. }
            | Self::ProvisionTeamInvitation { .. }
            | Self::ReleaseInvitationContinuation { .. }
            | Self::CancelTeamInvitation { .. }
            | Self::ResendTeamInvitation { .. } => {
                formatter.write_str("TeamInvitation([redacted Account scope])")
            }
            Self::InspectProfileAdmission => formatter.write_str("InspectProfileAdmission"),
            Self::AbortProfileAdmission { .. } => formatter.write_str("AbortProfileAdmission"),
            Self::RecipientKeyScope { .. }
            | Self::OwnKeyFingerprint { .. }
            | Self::VerifyRecipientKey { .. }
            | Self::VerifiedRecipientKey { .. } => {
                formatter.write_str("RecipientKey([redacted scope])")
            }
            Self::RefreshTravelMode { .. } => {
                formatter.write_str("RefreshTravelMode([redacted scope])")
            }
            Self::SetTravelModeHiddenVaults { .. } => {
                formatter.write_str("SetTravelModeHiddenVaults([redacted scope])")
            }
            Self::EnableTravelMode { .. } => {
                formatter.write_str("EnableTravelMode([redacted scope])")
            }
            Self::DisableTravelMode { .. } => formatter.write_str("DisableTravelMode([redacted])"),
            Self::RebootstrapAccountRecovery { .. } => {
                formatter.write_str("RebootstrapAccountRecovery([redacted scope])")
            }
            Self::InspectRecovery { .. } => {
                formatter.write_str("InspectRecovery([redacted scope])")
            }
            Self::ExportAccountRecovery { .. } => {
                formatter.write_str("ExportAccountRecovery([redacted])")
            }
            Self::RepairAccountRecovery { .. } => {
                formatter.write_str("RepairAccountRecovery([redacted])")
            }
            Self::SignIn {
                server_url, email, ..
            } => formatter
                .debug_struct("SignIn")
                .field("server_url", server_url)
                .field("email", email)
                .field("credentials", &"[redacted]")
                .finish(),
            Self::BiometricAvailability { .. }
            | Self::SetBiometricEnabled { .. }
            | Self::BiometricUnlock { .. }
            | Self::BiometricUnlockAccounts { .. }
            | Self::SetMasterPasswordReentryPeriod { .. } => {
                formatter.write_str("LocalAccess([redacted scope and prompt])")
            }
            Self::LocalSecuritySettings { .. } => {
                formatter.write_str("LocalSecuritySettings([redacted])")
            }
            Self::SetInactivityTimeout { .. } => {
                formatter.write_str("SetInactivityTimeout([redacted])")
            }
            Self::RecordActivity { .. } => formatter.write_str("RecordActivity([redacted])"),
            Self::DeviceSetup { .. } => formatter.write_str("DeviceSetup([redacted])"),
            Self::QuickUnlockAccounts { .. } => {
                formatter.write_str("QuickUnlockAccounts([redacted])")
            }
            Self::QuickUnlock { account_id, .. } => formatter
                .debug_struct("QuickUnlock")
                .field("account_id", account_id)
                .field("credentials", &"[redacted]")
                .finish(),
            Self::Lock { account_id } => formatter
                .debug_struct("Lock")
                .field("account_id", account_id)
                .finish(),
            Self::SignOut { account_id } => formatter
                .debug_struct("SignOut")
                .field("account_id", account_id)
                .finish(),
            Self::RemoveAccount { .. } => formatter.write_str("RemoveAccount([redacted scope])"),
            Self::DeleteServerAccount { .. } => {
                formatter.write_str("DeleteServerAccount([redacted scope and confirmation])")
            }
            Self::Wipe => formatter.write_str("Wipe"),
            Self::UpdateVault {
                account_id,
                vault_id,
                ..
            } => formatter
                .debug_struct("UpdateVault")
                .field("account_id", account_id)
                .field("vault_id", vault_id)
                .finish(),
            Self::DeleteVault {
                account_id,
                vault_id,
            } => formatter
                .debug_struct("DeleteVault")
                .field("account_id", account_id)
                .field("vault_id", vault_id)
                .finish(),
            Self::CreateVault {
                account_id,
                name,
                vault_type,
                icon,
                ..
            } => formatter
                .debug_struct("CreateVault")
                .field("account_id", account_id)
                .field("name", name)
                .field("vault_type", vault_type)
                .field("icon", icon)
                .field("image_source_capability", &"[redacted]")
                .finish(),
            Self::CreateItem {
                account_id,
                vault_id,
                draft,
            } => formatter
                .debug_struct("CreateItem")
                .field("account_id", account_id)
                .field("vault_id", vault_id)
                .field("draft", draft)
                .finish(),
            Self::ImportItems {
                account_id,
                vault_id,
                items,
            } => formatter
                .debug_struct("ImportItems")
                .field("account_id", account_id)
                .field("vault_id", vault_id)
                .field("item_count", &items.len())
                .field("plaintext", &"[redacted]")
                .finish(),
            Self::UpdateItem {
                account_id,
                item_id,
                draft,
                ..
            } => formatter
                .debug_struct("UpdateItem")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("draft", draft)
                .finish(),
            Self::RemovePasskey {
                account_id,
                item_id,
                ..
            } => formatter
                .debug_struct("RemovePasskey")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .finish(),
            Self::DuplicateItem {
                account_id,
                source_item_id,
                ..
            } => formatter
                .debug_struct("DuplicateItem")
                .field("account_id", account_id)
                .field("source_item_id", source_item_id)
                .field("plaintext", &"[redacted]")
                .finish(),
            Self::SetItemFavorite {
                account_id,
                item_id,
                favorite,
            } => formatter
                .debug_struct("SetItemFavorite")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("favorite", favorite)
                .finish(),
            Self::TrashItem {
                account_id,
                item_id,
            } => formatter
                .debug_struct("TrashItem")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .finish(),
            Self::RestoreItem {
                account_id,
                item_id,
            } => formatter
                .debug_struct("RestoreItem")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .finish(),
            Self::MoveItem {
                account_id,
                item_id,
                target_vault_id,
                target_account_id,
            } => formatter
                .debug_struct("MoveItem")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("target_vault_id", target_vault_id)
                .field("target_account_id", target_account_id)
                .finish(),
            Self::PrepareCrossAccountMoveResume {
                account_id,
                operation_id,
                target_account_id,
                expected_binding_revision,
            } => formatter
                .debug_struct("PrepareCrossAccountMoveResume")
                .field("account_id", account_id)
                .field("operation_id", operation_id)
                .field("target_account_id", target_account_id)
                .field("expected_binding_revision", expected_binding_revision)
                .finish(),
            Self::ResumeCrossAccountMove { guard } => formatter
                .debug_struct("ResumeCrossAccountMove")
                .field("guard", guard)
                .finish(),
            Self::PermanentlyDeleteItem {
                account_id,
                item_id,
            } => formatter
                .debug_struct("PermanentlyDeleteItem")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .finish(),
            Self::CreateShare {
                account_id,
                item_id,
                draft,
            } => formatter
                .debug_struct("CreateShare")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("draft", draft)
                .finish(),
            Self::AcknowledgeShareResult {
                account_id,
                operation_id,
            } => formatter
                .debug_struct("AcknowledgeShareResult")
                .field("account_id", account_id)
                .field("operation_id", operation_id)
                .finish(),
            Self::ListItemShareLinks {
                account_id,
                item_id,
            } => formatter
                .debug_struct("ListItemShareLinks")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .finish(),
            Self::ListShareAccessLogs {
                account_id,
                item_id,
                link_id,
            } => formatter
                .debug_struct("ListShareAccessLogs")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("link_id", link_id)
                .finish(),
            Self::RevokeShareLink {
                account_id,
                item_id,
                link_id,
            } => formatter
                .debug_struct("RevokeShareLink")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("link_id", link_id)
                .finish(),
            Self::RenameAttachment {
                account_id,
                attachment_id,
                ..
            } => formatter
                .debug_struct("RenameAttachment")
                .field("account_id", account_id)
                .field("attachment_id", attachment_id)
                .field("plaintext", &"[redacted]")
                .finish(),
            Self::DeleteAttachment {
                account_id,
                attachment_id,
            } => formatter
                .debug_struct("DeleteAttachment")
                .field("account_id", account_id)
                .field("attachment_id", attachment_id)
                .finish(),
            Self::DownloadAttachment {
                account_id,
                attachment_id,
                ..
            } => formatter
                .debug_struct("DownloadAttachment")
                .field("account_id", account_id)
                .field("attachment_id", attachment_id)
                .field("sink_capability", &"[redacted]")
                .finish(),
            Self::UploadAttachment {
                account_id,
                item_id,
                file_size,
                ..
            } => formatter
                .debug_struct("UploadAttachment")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("file_size", file_size)
                .field("plaintext_and_source_capability", &"[redacted]")
                .finish(),
        }
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct TravelModePolicy {
    pub enabled: bool,
    pub hidden_vault_ids: Vec<String>,
    pub server_enabled_at_ms: Option<String>,
    pub server_updated_at_ms: Option<String>,
    pub verified_at_ms: Option<String>,
}
impl From<core::TravelModePolicy> for TravelModePolicy {
    fn from(value: core::TravelModePolicy) -> Self {
        Self {
            enabled: value.enabled,
            hidden_vault_ids: value.hidden_vault_ids,
            server_enabled_at_ms: value.server_enabled_at_ms,
            server_updated_at_ms: value.server_updated_at_ms,
            verified_at_ms: value.verified_at_ms,
        }
    }
}
#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum TravelModeEnforcement {
    Unverified,
    Retiring,
    Ready,
    Refreshing,
}
impl From<core::TravelModeEnforcement> for TravelModeEnforcement {
    fn from(value: core::TravelModeEnforcement) -> Self {
        match value {
            core::TravelModeEnforcement::Unverified => Self::Unverified,
            core::TravelModeEnforcement::Retiring => Self::Retiring,
            core::TravelModeEnforcement::Ready => Self::Ready,
            core::TravelModeEnforcement::Refreshing => Self::Refreshing,
        }
    }
}
#[derive(Clone, Debug, uniffi::Enum)]
pub enum TravelModeCommandResult {
    Confirmed {
        policy: TravelModePolicy,
        enforcement: TravelModeEnforcement,
    },
    RetryRequired {
        policy: TravelModePolicy,
    },
    Uncertain {
        last_verified_policy: Option<TravelModePolicy>,
    },
}
impl From<core::TravelModeCommandResult> for TravelModeCommandResult {
    fn from(value: core::TravelModeCommandResult) -> Self {
        match value {
            core::TravelModeCommandResult::Confirmed {
                policy,
                enforcement,
            } => Self::Confirmed {
                policy: policy.into(),
                enforcement: enforcement.into(),
            },
            core::TravelModeCommandResult::RetryRequired { policy } => Self::RetryRequired {
                policy: policy.into(),
            },
            core::TravelModeCommandResult::Uncertain {
                last_verified_policy,
            } => Self::Uncertain {
                last_verified_policy: last_verified_policy.map(Into::into),
            },
        }
    }
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct TravelModeProjection {
    pub account_id: String,
    pub revision: u64,
    pub last_verified_policy: Option<TravelModePolicy>,
    pub enforcement: TravelModeEnforcement,
}
impl From<core::TravelModeProjection> for TravelModeProjection {
    fn from(value: core::TravelModeProjection) -> Self {
        Self {
            account_id: value.account_id.into(),
            revision: value.revision,
            last_verified_policy: value.last_verified_policy.map(Into::into),
            enforcement: value.enforcement.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum ProfileAdmissionImportPhase {
    Preparing,
    Aborting,
    Aborted,
    Committed,
    Complete,
}

impl From<core::ProfileAdmissionImportPhase> for ProfileAdmissionImportPhase {
    fn from(value: core::ProfileAdmissionImportPhase) -> Self {
        match value {
            core::ProfileAdmissionImportPhase::Preparing => Self::Preparing,
            core::ProfileAdmissionImportPhase::Aborting => Self::Aborting,
            core::ProfileAdmissionImportPhase::Aborted => Self::Aborted,
            core::ProfileAdmissionImportPhase::Committed => Self::Committed,
            core::ProfileAdmissionImportPhase::Complete => Self::Complete,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum ProfileAdmissionResetPhase {
    Wiping,
    Wiped,
}

impl From<core::ProfileAdmissionResetPhase> for ProfileAdmissionResetPhase {
    fn from(value: core::ProfileAdmissionResetPhase) -> Self {
        match value {
            core::ProfileAdmissionResetPhase::Wiping => Self::Wiping,
            core::ProfileAdmissionResetPhase::Wiped => Self::Wiped,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum ProfileAdmissionInspectionState {
    NotStarted,
    Import {
        admission_id: String,
        phase: ProfileAdmissionImportPhase,
    },
    Reset {
        wipe_id: String,
        phase: ProfileAdmissionResetPhase,
    },
}

impl From<core::ProfileAdmissionInspectionState> for ProfileAdmissionInspectionState {
    fn from(value: core::ProfileAdmissionInspectionState) -> Self {
        match value {
            core::ProfileAdmissionInspectionState::NotStarted {} => Self::NotStarted,
            core::ProfileAdmissionInspectionState::Import {
                admission_id,
                phase,
            } => Self::Import {
                admission_id,
                phase: phase.into(),
            },
            core::ProfileAdmissionInspectionState::Reset { wipe_id, phase } => Self::Reset {
                wipe_id,
                phase: phase.into(),
            },
        }
    }
}

#[derive(Clone, Debug, uniffi::Enum)]
pub enum RuntimeResponse {
    AvailableVaultMembers {
        members: Vec<AvailableVaultMember>,
    },
    VaultMembers {
        members: Vec<CurrentVaultMember>,
    },
    VaultMemberAdded {
        vault_id: String,
        user_id: String,
    },
    VaultMemberAddUncertain {
        vault_id: String,
        user_id: String,
        current_role: Option<VaultRole>,
    },
    RotationPrepared {
        selection: RotationSelection,
    },
    RotationStartPending {
        start_operation_id: String,
    },
    RotationStartRejected {
        code: RotationStartRejectionCode,
    },
    RotationPreparationRequiresCrypto {
        start_operation_id: String,
        plans: Vec<RotationPlanSelection>,
    },
    RotationAttemptConsumed {
        start_operation_id: String,
    },
    RotationFinalizePending {
        finalize_operation_id: String,
    },
    RotationRefreshRequired {
        finalize_operation_id: String,
        outcome: RotationTerminalOutcome,
    },
    RotationCompleted {
        personal_team_id: String,
    },
    RotationRejected {
        code: RotationFinalizeRejectionCode,
    },
    TeamLeaveAttempts {
        attempts: Vec<TeamLeaveAttempt>,
    },
    TeamLeaveAttemptAcknowledged,
    MyTeamInvitations {
        invitations: Vec<MyTeamInvitation>,
    },
    MyTeamInvitationAccepted {
        team_id: String,
        team_name: String,
    },
    MyTeamInvitationAcceptRefreshRequired {
        team_id: String,
        team_name: String,
    },
    MyTeamInvitationDeclined,
    MyTeamInvitationUncertain {
        action: MyInvitationAction,
        invitation_id: String,
        pending: Option<bool>,
        current_team_id: Option<String>,
    },
    InvitationComposer {
        composer: InvitationComposerData,
    },
    TeamInvitationCreated {
        invitation_id: String,
        token: Arc<SecretString>,
        candidate: Option<InvitationCandidate>,
        continuation_id: Option<String>,
    },
    TeamInvitationProvisioned {
        invitation_id: String,
        token: Arc<SecretString>,
    },
    TeamInvitationProvisioningNotRequired {
        invitation_id: String,
    },
    TeamInvitationUncertain {
        phase: InvitationUncertainPhase,
        original_invitation_id: Option<String>,
    },
    InvitationContinuationReleased,
    TeamInvitationCancelled {
        invitation_id: String,
    },
    TeamInvitationResent {
        invitation_id: String,
        token: Arc<SecretString>,
    },
    TeamInvitationAdminUncertain {
        action: InvitationAdminAction,
        invitation_id: String,
        pending: Option<bool>,
    },
    ProfileAdmissionAborted {
        admission_id: String,
    },
    ProfileAdmissionInspection {
        state: ProfileAdmissionInspectionState,
    },
    CrossAccountMoveResumePrepared {
        guard: CrossAccountMoveResumeGuard,
    },
    RecipientKeyScope {
        scope: String,
    },
    OwnKeyFingerprint {
        user_id: String,
        fingerprint: String,
    },
    RecipientKeyVerified,
    VerifiedRecipientKey {
        public_key: String,
    },
    TravelMode {
        account_id: String,
        result: TravelModeCommandResult,
    },
    ActivityRecorded,
    LocalSecuritySettings {
        account_id: String,
        inactivity_timeout_ms: i64,
        master_password_reentry_period_ms: i64,
    },
    DeviceSetup {
        disclosure: DeviceSetupDisclosure,
    },
    AccountsUnlocked {
        accounts: Vec<AccountUnlockResult>,
    },
    RecoveryDiagnosed {
        diagnostics: StorageRecoveryDiagnostics,
    },
    RecoveryExported {
        account_id: String,
        classification: RecoveryClassification,
        byte_length: u64,
    },
    RecoveryRepaired {
        account_id: String,
        replica_revision: u64,
    },
    BiometricAvailability {
        hardware: BiometricHardware,
        accounts: Vec<BiometricAccountAvailability>,
        master_password_reentry_period_ms: i64,
    },
    BiometricEnabled {
        account_id: String,
        enabled: bool,
    },
    BiometricUnlock {
        accounts: Vec<BiometricAccountUnlock>,
    },
    MasterPasswordReentryPeriod {
        period_ms: i64,
    },
    SignedIn {
        account_id: String,
        user_id: String,
    },
    AccessChanged {
        account_id: String,
        access: AccountAccessState,
    },
    ServerAccountDeletion {
        account_id: String,
        request_id: String,
        outcome: ServerAccountDeletionOutcome,
    },
    Accepted {
        operation_id: String,
        item_id: String,
        replica_revision: u64,
    },
    VaultUpdateAccepted {
        operation_id: String,
        vault_id: String,
        replica_revision: u64,
    },
    VaultDeletionAccepted {
        operation_id: String,
        vault_id: String,
        replica_revision: u64,
    },
    VaultCreationAccepted {
        operation_id: String,
        vault_id: String,
        replica_revision: u64,
    },
    ImportBatchAccepted {
        operation_id: String,
        vault_id: String,
        item_ids: Vec<String>,
        replica_revision: u64,
    },
    ShareResultAcknowledged {
        account_id: String,
        operation_id: String,
    },
    ItemShareLinks {
        account_id: String,
        item_id: String,
        links: Vec<ShareLinkSummary>,
        base_share_url: String,
    },
    ShareAccessLogs {
        account_id: String,
        link_id: String,
        logs: Vec<ShareAccessLog>,
    },
    ShareLinkRevoked {
        account_id: String,
        link_id: String,
    },
    AttachmentRenamed {
        account_id: String,
        attachment_id: String,
    },
    AttachmentDeleted {
        account_id: String,
        attachment_id: String,
    },
    AttachmentDownloaded {
        account_id: String,
        attachment_id: String,
    },
    AttachmentUploaded {
        attachment_id: String,
        replica_revision: u64,
    },
    Teardown {
        scope: TeardownScope,
        status: TeardownStatus,
        failures: Vec<TeardownPhase>,
    },
}

#[derive(Clone, Debug, uniffi::Enum)]
pub enum TeardownScope {
    Account { account_id: String },
    Device,
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum TeardownStatus {
    Complete,
    Incomplete,
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum ServerAccountDeletionOutcome {
    Deleted,
    ConfirmationEmailMismatch,
    Blocked,
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum TeardownPhase {
    AttachmentArtifacts,
    HostCleanup,
    PlatformStorage,
    Replica,
}

#[derive(Clone, Debug, uniffi::Enum)]
pub enum ObservationRequest {
    TravelMode {
        account_id: String,
    },
    WritableVaultCatalog,
    Items {
        account_id: String,
    },
    VaultExport {
        account_id: String,
        vault_ids: Vec<String>,
    },
    PendingShareResults {
        account_id: String,
    },
    Operations {
        account_id: String,
    },
    RuntimeStatus {
        account_id: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum ItemProjectionStatus {
    Pending,
    Authoritative,
    Failed,
}

#[derive(uniffi::Object)]
pub struct ItemProjection {
    account_id: String,
    item_id: String,
    vault_id: String,
    data: PublicItemDraft,
    favorite: bool,
    deleted_at: Option<String>,
    attachments: Vec<Arc<AttachmentProjection>>,
    created_at: String,
    updated_at: String,
    status: ItemProjectionStatus,
    edit_guard: Option<ItemEditGuard>,
    duplicate_source_guard: Option<ItemDuplicateGuard>,
}

impl fmt::Debug for ItemProjection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ItemProjection")
            .field("account_id", &self.account_id)
            .field("item_id", &self.item_id)
            .field("vault_id", &self.vault_id)
            .field("plaintext", &"[redacted]")
            .field("status", &self.status)
            .finish()
    }
}

#[uniffi::export]
impl ItemProjection {
    pub fn account_id(&self) -> String {
        self.account_id.clone()
    }
    pub fn item_id(&self) -> String {
        self.item_id.clone()
    }
    pub fn vault_id(&self) -> String {
        self.vault_id.clone()
    }
    pub fn data(&self) -> PublicItemDraft {
        self.data.clone()
    }
    pub fn edit_guard(&self) -> Option<ItemEditGuard> {
        self.edit_guard.clone()
    }
    pub fn duplicate_source_guard(&self) -> Option<ItemDuplicateGuard> {
        self.duplicate_source_guard.clone()
    }
    pub fn favorite(&self) -> bool {
        self.favorite
    }
    pub fn deleted_at(&self) -> Option<String> {
        self.deleted_at.clone()
    }
    pub fn attachments(&self) -> Vec<Arc<AttachmentProjection>> {
        self.attachments.clone()
    }
    pub fn created_at(&self) -> String {
        self.created_at.clone()
    }
    pub fn updated_at(&self) -> String {
        self.updated_at.clone()
    }
    pub fn status(&self) -> ItemProjectionStatus {
        self.status
    }
}

#[derive(uniffi::Object)]
pub struct AttachmentProjection {
    account_id: String,
    attachment_id: String,
    item_id: String,
    vault_id: String,
    name: String,
    content_type: String,
    file_size: i32,
    uploaded_by: String,
    created_at: String,
}

impl fmt::Debug for AttachmentProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AttachmentProjection")
            .field("account_id", &self.account_id)
            .field("attachment_id", &self.attachment_id)
            .field("plaintext", &"[redacted]")
            .finish()
    }
}

#[uniffi::export]
impl AttachmentProjection {
    pub fn account_id(&self) -> String {
        self.account_id.clone()
    }
    pub fn attachment_id(&self) -> String {
        self.attachment_id.clone()
    }
    pub fn item_id(&self) -> String {
        self.item_id.clone()
    }
    pub fn vault_id(&self) -> String {
        self.vault_id.clone()
    }
    pub fn name(&self) -> String {
        self.name.clone()
    }
    pub fn content_type(&self) -> String {
        self.content_type.clone()
    }
    pub fn file_size(&self) -> i32 {
        self.file_size
    }
    pub fn uploaded_by(&self) -> String {
        self.uploaded_by.clone()
    }
    pub fn created_at(&self) -> String {
        self.created_at.clone()
    }
}

#[derive(Clone, uniffi::Record)]
pub struct ItemsProjection {
    pub account_id: String,
    pub replica_revision: u64,
    pub items: Vec<Arc<ItemProjection>>,
    pub vaults: Vec<VaultProjection>,
}

#[derive(Clone, uniffi::Record)]
pub struct VaultExportItem {
    pub account_id: String,
    pub item_id: String,
    pub vault_id: String,
    pub data: ItemDraft,
    pub favorite: bool,
    pub deleted_at: Option<String>,
    pub attachments: Vec<Arc<AttachmentProjection>>,
    pub created_at: String,
    pub updated_at: String,
    pub status: ItemProjectionStatus,
}

#[derive(Clone, uniffi::Record)]
pub struct VaultExportProjection {
    pub account_id: String,
    pub replica_revision: u64,
    pub items: Vec<VaultExportItem>,
    pub vaults: Vec<VaultProjection>,
}

impl fmt::Debug for VaultExportProjection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VaultExportProjection")
            .field("account_id", &self.account_id)
            .field("replica_revision", &self.replica_revision)
            .field("item_count", &self.items.len())
            .finish()
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct WritableVaultCatalogProjection {
    pub revision: u64,
    pub vaults: Vec<WritableVaultProjection>,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct WritableVaultProjection {
    pub account_id: String,
    pub vault_id: String,
    pub name: String,
    pub vault_type: VaultProjectionType,
    pub icon: Option<String>,
    pub image_url: Option<String>,
    pub role: VaultProjectionRole,
}

#[derive(Zeroize, ZeroizeOnDrop, uniffi::Object)]
pub struct PendingShareResult {
    operation_id: String,
    item_id: String,
    share_link_id: String,
    share_url: String,
    expires_at: String,
}

impl fmt::Debug for PendingShareResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingShareResult")
            .field("operation_id", &self.operation_id)
            .field("item_id", &self.item_id)
            .field("share_link_id", &self.share_link_id)
            .field("share_url", &"[redacted]")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[uniffi::export]
impl PendingShareResult {
    pub fn operation_id(&self) -> String {
        self.operation_id.clone()
    }

    pub fn item_id(&self) -> String {
        self.item_id.clone()
    }

    pub fn share_link_id(&self) -> String {
        self.share_link_id.clone()
    }

    pub fn share_url(&self) -> String {
        self.share_url.clone()
    }

    pub fn expires_at(&self) -> String {
        self.expires_at.clone()
    }
}

#[derive(Clone, uniffi::Record)]
pub struct PendingShareResultsProjection {
    pub account_id: String,
    pub replica_revision: u64,
    pub results: Vec<Arc<PendingShareResult>>,
}

impl fmt::Debug for PendingShareResultsProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingShareResultsProjection")
            .field("account_id", &self.account_id)
            .field("replica_revision", &self.replica_revision)
            .field("result_count", &self.results.len())
            .finish()
    }
}

/// One Vault as an Items reader needs it. Plain data: a Vault name has never been ciphertext.
#[derive(Clone, Debug, uniffi::Record)]
pub struct VaultProjection {
    pub vault_id: String,
    pub name: String,
    pub vault_type: VaultProjectionType,
    pub icon: Option<String>,
    pub image_url: Option<String>,
    /// This Account's membership in the Vault. Anything but `ReadOnly` may write an Item here.
    pub role: VaultProjectionRole,
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum VaultProjectionType {
    Personal,
    Team,
}

/// One Account's membership in one Vault, in the Server's own closed set.
#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum VaultProjectionRole {
    Owner,
    Admin,
    Member,
    ReadOnly,
}

impl fmt::Debug for ItemsProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ItemsProjection")
            .field("account_id", &self.account_id)
            .field("replica_revision", &self.replica_revision)
            .field("item_count", &self.items.len())
            .finish()
    }
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum RuntimeErrorCode {
    RecipientKeyUnverified,
    RecipientKeyChanged,
    RecipientFingerprintMismatch,
    RuntimeClosed,
    Cancelled,
    AccountMissing,
    AccountAlreadyInstalled,
    AccountFailed,
    AuthenticationRequired,
    AuthenticationUnavailable,
    CredentialUnavailable,
    StorageUnavailable,
    RetryableTransport,
    VersionEvidenceUnavailable,
    AuthorityMissing,
    AccessDenied,
    ReadOnly,
    QuotaExceeded,
    SizeRejected,
    SourceFailure,
    SinkFailure,
    InvariantViolation,
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum RecoveryBound {
    RecordBytes,
    ArchiveBytes,
    RecordCount,
    ArtifactCount,
    ReportBytes,
    SummaryBytes,
    ControlBytes,
    CursorBytes,
    ChunkBytes,
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum AccountAccessState {
    SignedOut,
    Locked,
    Unlocked,
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum AccountWaitingReason {
    ReauthenticationRequired,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct AccountUnlockResult {
    pub account_id: String,
    pub failure: Option<RuntimeErrorCode>,
}
impl From<core::AccountUnlockResult> for AccountUnlockResult {
    fn from(value: core::AccountUnlockResult) -> Self {
        Self {
            account_id: value.account_id.into(),
            failure: value.failure.map(Into::into),
        }
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct AccountDisplayIdentity {
    pub email: String,
    pub name: String,
    pub team_name: Option<String>,
    pub team_avatar_url: Option<String>,
    pub server_url: String,
    pub secret_key_hint: String,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct AccountUnlockCapabilities {
    pub password: bool,
    pub desktop: bool,
    pub sign_in: bool,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct AccountStatus {
    pub account_id: String,
    pub replica_revision: u64,
    pub access: AccountAccessState,
    pub unlock_capabilities: AccountUnlockCapabilities,
    pub waiting_reason: Option<AccountWaitingReason>,
    pub failure: Option<RuntimeErrorCode>,
    pub display_identity: Option<AccountDisplayIdentity>,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum ProfileAdmissionCleanupStatus {
    Pending { pending_obligations: u64 },
}

impl From<core::ProfileAdmissionCleanupStatus> for ProfileAdmissionCleanupStatus {
    fn from(value: core::ProfileAdmissionCleanupStatus) -> Self {
        match value {
            core::ProfileAdmissionCleanupStatus::Pending {
                pending_obligations,
            } => Self::Pending {
                pending_obligations,
            },
        }
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct RuntimeStatusProjection {
    pub account_id: Option<String>,
    pub revision: u64,
    pub accounts: Vec<AccountStatus>,
    pub closed: bool,
    pub profile_admission_cleanup: Option<ProfileAdmissionCleanupStatus>,
}

#[derive(Clone, uniffi::Enum)]
pub enum RuntimeProjection {
    TravelMode {
        value: TravelModeProjection,
    },
    WritableVaultCatalog {
        value: WritableVaultCatalogProjection,
    },
    Items {
        value: ItemsProjection,
    },
    VaultExport {
        value: VaultExportProjection,
    },
    Operations {
        value: OperationsProjection,
    },
    PendingShareResults {
        value: PendingShareResultsProjection,
    },
    RuntimeStatus {
        value: RuntimeStatusProjection,
    },
}

impl fmt::Debug for RuntimeProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TravelMode { value } => formatter.debug_tuple("TravelMode").field(value).finish(),
            Self::WritableVaultCatalog { value } => formatter
                .debug_tuple("WritableVaultCatalog")
                .field(value)
                .finish(),
            Self::Items { value } => formatter.debug_tuple("Items").field(value).finish(),
            Self::VaultExport { value } => {
                formatter.debug_tuple("VaultExport").field(value).finish()
            }
            Self::Operations { value } => formatter.debug_tuple("Operations").field(value).finish(),
            Self::PendingShareResults { value } => formatter
                .debug_tuple("PendingShareResults")
                .field(value)
                .finish(),
            Self::RuntimeStatus { value } => {
                formatter.debug_tuple("RuntimeStatus").field(value).finish()
            }
        }
    }
}

#[derive(Clone, Debug, uniffi::Enum)]
pub enum VaultExportRetirementReason {
    ScopeRetired,
    RuntimeClosed,
    ConnectionClosed,
}

#[derive(Clone, Debug, uniffi::Enum)]
pub enum ObservationControl {
    VaultExportRetired { reason: VaultExportRetirementReason },
}

impl From<core::ObservationControl> for ObservationControl {
    fn from(value: core::ObservationControl) -> Self {
        match value {
            core::ObservationControl::VaultExportRetired { reason } => Self::VaultExportRetired {
                reason: match reason {
                    core::VaultExportRetirementReason::ScopeRetired => {
                        VaultExportRetirementReason::ScopeRetired
                    }
                    core::VaultExportRetirementReason::RuntimeClosed => {
                        VaultExportRetirementReason::RuntimeClosed
                    }
                    core::VaultExportRetirementReason::ConnectionClosed => {
                        VaultExportRetirementReason::ConnectionClosed
                    }
                },
            },
        }
    }
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum BindingError {
    #[error("Runtime request failed: {message}")]
    Runtime {
        code: RuntimeErrorCode,
        message: String,
        recovery_bound: Option<RecoveryBound>,
    },
}

#[cfg(not(target_arch = "wasm32"))]
#[uniffi::export(with_foreign)]
pub trait ObservationSink: Send + Sync {
    fn publish(&self, projection: RuntimeProjection);
    fn control(&self, control: ObservationControl);
}

/// A shallow native answer handle. Its sensitive payload is transferred as one canonical Base64
/// String allocation instead of an ordinary UniFFI record/sequence buffer whose temporary
/// serialization could not be wiped.
#[cfg(not(target_arch = "wasm32"))]
#[uniffi::export(with_foreign)]
pub trait VaultImagePortAnswer: Send + Sync {
    fn control_response_json(&self) -> String;

    /// Transfers a canonical Base64 representation to Rust. Empty means that this answer carries
    /// no binary chunk; valid Vault-image chunks are never empty. The generated native lowering
    /// writes this String directly into its RustBuffer, avoiding an ordinary record/sequence lift.
    fn take_binary_chunk_base64(&self) -> SensitiveVaultImageChunk;
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone)]
pub struct SensitiveVaultImageChunk(pub(crate) Zeroizing<String>);

#[cfg(not(target_arch = "wasm32"))]
impl From<SensitiveVaultImageChunk> for String {
    fn from(mut value: SensitiveVaultImageChunk) -> Self {
        std::mem::take(&mut *value.0)
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl From<String> for SensitiveVaultImageChunk {
    fn from(value: String) -> Self {
        Self(Zeroizing::new(value))
    }
}

#[cfg(not(target_arch = "wasm32"))]
uniffi::custom_type!(SensitiveVaultImageChunk, String);

#[cfg(not(target_arch = "wasm32"))]
#[uniffi::export(with_foreign)]
pub trait VaultImageArtifactExecutor: Send + Sync {
    fn invoke(
        &self,
        control_request_json: String,
        // Canonical Base64, or empty when the request carries no chunk.
        binary_chunk_base64: SensitiveVaultImageChunk,
    ) -> Result<Arc<dyn VaultImagePortAnswer>, BindingError>;
}

#[cfg(not(target_arch = "wasm32"))]
#[uniffi::export(with_foreign)]
pub trait VaultImageSourceExecutor: Send + Sync {
    fn invoke(
        &self,
        control_request_json: String,
    ) -> Result<Arc<dyn VaultImagePortAnswer>, BindingError>;
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone, uniffi::Record)]
pub struct VaultImagePreparationRequest {
    pub runtime_incarnation: String,
    pub account_id: String,
    pub operation_id: String,
    pub vault_id: String,
    pub capability_id: String,
    pub content_type: String,
    pub byte_length: u64,
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone, uniffi::Record)]
pub struct PreparedVaultImage {
    pub account_id: String,
    pub operation_id: String,
    pub vault_id: String,
    pub content_type: String,
    pub byte_length: u64,
    pub sha256: String,
}

#[cfg(not(target_arch = "wasm32"))]
struct NativeSink(Arc<dyn ObservationSink>);

#[cfg(not(target_arch = "wasm32"))]
impl core::ObservationSink for NativeSink {
    fn publish(&self, projection: core::RuntimeProjection) {
        self.0.publish(projection.into());
    }

    fn control(&self, control: core::ObservationControl) {
        self.0.control(control.into());
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(uniffi::Object)]
pub struct ClientRuntime {
    inner: Arc<core::Runtime>,
}

#[cfg(not(target_arch = "wasm32"))]
impl ClientRuntime {
    /// A native Runtime with no Server identity, no transport, and no Device storage yet.
    ///
    /// It deliberately does not drive `run_operation_dispatch`. That loop returns immediately
    /// without an authentication client configuration, and no native constructor supplies one or
    /// the executors it would need, so spawning it here would only look like ownership. The
    /// native host that gains those constructors drives the loop from its own executor, the way
    /// the Web binding drives it from the Worker's.
    fn headless() -> Arc<Self> {
        Arc::new(Self {
            inner: core::Runtime::new(),
        })
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[uniffi::export(async_runtime = "tokio")]
impl ClientRuntime {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Self::headless()
    }

    pub async fn open(&self) -> Result<(), BindingError> {
        self.inner.open().await.map_err(Into::into)
    }

    pub async fn request(&self, request: RuntimeRequest) -> Result<RuntimeResponse, BindingError> {
        let response = self
            .inner
            .request(request.into(), core::RequestCancellation::new())
            .await?;
        self.inner
            .deliver_response(response, Into::into)
            .map_err(Into::into)
    }

    pub fn observe(
        self: &Arc<Self>,
        request: ObservationRequest,
        sink: Arc<dyn ObservationSink>,
    ) -> Result<Arc<ObservationHandle>, BindingError> {
        self.inner
            .observe(request.into(), Arc::new(NativeSink(sink)))
            .map(|inner| Arc::new(ObservationHandle { inner }))
            .map_err(Into::into)
    }

    // UniFFI's Kotlin object wrapper reserves `close()` for synchronous handle disposal. The native
    // facade projects this transport name back to the Runtime protocol's asynchronous `close()`.
    pub async fn shutdown(&self) {
        self.inner.close().await;
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(uniffi::Object)]
pub struct ObservationHandle {
    inner: Arc<core::ObservationHandle>,
}

#[cfg(not(target_arch = "wasm32"))]
#[uniffi::export]
impl ObservationHandle {
    pub fn begin_vault_export_output(&self) -> Result<String, BindingError> {
        self.inner.begin_vault_export_output().map_err(Into::into)
    }

    pub fn finish_vault_export_output(&self, lease_id: String) -> Result<(), BindingError> {
        self.inner
            .finish_vault_export_output(&lease_id)
            .map_err(Into::into)
    }

    pub fn close(&self) {
        self.inner.close();
    }
}

impl From<RuntimeRequest> for core::RuntimeRequest {
    fn from(value: RuntimeRequest) -> Self {
        match value {
            RuntimeRequest::ListAvailableVaultMembers {
                account_id,
                vault_id,
            } => Self::ListAvailableVaultMembers {
                account_id: account_id.into(),
                vault_id,
            },
            RuntimeRequest::ListVaultMembers {
                account_id,
                vault_id,
            } => Self::ListVaultMembers {
                account_id: account_id.into(),
                vault_id,
            },
            RuntimeRequest::AddVaultMember {
                account_id,
                vault_id,
                user_id,
                role,
            } => Self::AddVaultMember {
                account_id: account_id.into(),
                vault_id,
                user_id,
                role: role.into(),
            },
            RuntimeRequest::PrepareRotation {
                account_id,
                intent,
                start_operation_id,
            } => Self::PrepareRotation {
                account_id: account_id.into(),
                intent: intent.into(),
                start_operation_id,
            },
            RuntimeRequest::CompleteRotation {
                account_id,
                selection,
            } => Self::CompleteRotation {
                account_id: account_id.into(),
                selection: selection.into(),
            },
            RuntimeRequest::InspectRotation {
                account_id,
                start_operation_id,
            } => Self::InspectRotation {
                account_id: account_id.into(),
                start_operation_id,
            },
            RuntimeRequest::ListTeamLeaveAttempts { account_id } => Self::ListTeamLeaveAttempts {
                account_id: account_id.into(),
            },
            RuntimeRequest::AcknowledgeTeamLeaveAttempt {
                account_id,
                start_operation_id,
            } => Self::AcknowledgeTeamLeaveAttempt {
                account_id: account_id.into(),
                start_operation_id,
            },
            RuntimeRequest::ListMyTeamInvitations { account_id } => Self::ListMyTeamInvitations {
                account_id: account_id.into(),
            },
            RuntimeRequest::AcceptMyTeamInvitation {
                account_id,
                invitation_id,
            } => Self::AcceptMyTeamInvitation {
                account_id: account_id.into(),
                invitation_id,
            },
            RuntimeRequest::DeclineMyTeamInvitation {
                account_id,
                invitation_id,
            } => Self::DeclineMyTeamInvitation {
                account_id: account_id.into(),
                invitation_id,
            },
            RuntimeRequest::ReadInvitationComposer {
                account_id,
                team_id,
            } => Self::ReadInvitationComposer {
                account_id: account_id.into(),
                team_id,
            },
            RuntimeRequest::CreateTeamInvitation {
                account_id,
                team_id,
                email,
                role,
            } => Self::CreateTeamInvitation {
                account_id: account_id.into(),
                team_id,
                email,
                role: role.into(),
            },
            RuntimeRequest::ProvisionTeamInvitation {
                account_id,
                continuation_id,
            } => Self::ProvisionTeamInvitation {
                account_id: account_id.into(),
                continuation_id,
            },
            RuntimeRequest::ReleaseInvitationContinuation {
                account_id,
                continuation_id,
            } => Self::ReleaseInvitationContinuation {
                account_id: account_id.into(),
                continuation_id,
            },
            RuntimeRequest::CancelTeamInvitation {
                account_id,
                team_id,
                invitation_id,
            } => Self::CancelTeamInvitation {
                account_id: account_id.into(),
                team_id,
                invitation_id,
            },
            RuntimeRequest::ResendTeamInvitation {
                account_id,
                team_id,
                invitation_id,
            } => Self::ResendTeamInvitation {
                account_id: account_id.into(),
                team_id,
                invitation_id,
            },
            RuntimeRequest::InspectProfileAdmission => Self::InspectProfileAdmission {},
            RuntimeRequest::AbortProfileAdmission { admission_id } => {
                Self::AbortProfileAdmission { admission_id }
            }
            RuntimeRequest::OwnKeyFingerprint { account_id } => Self::OwnKeyFingerprint {
                account_id: account_id.into(),
            },
            RuntimeRequest::RecipientKeyScope { account_id } => Self::RecipientKeyScope {
                account_id: account_id.into(),
            },
            RuntimeRequest::VerifyRecipientKey {
                account_id,
                recipient_user_id,
                public_key,
                expected_fingerprint,
                scope,
            } => Self::VerifyRecipientKey {
                account_id: account_id.into(),
                recipient_user_id,
                public_key,
                expected_fingerprint,
                scope,
            },
            RuntimeRequest::VerifiedRecipientKey {
                account_id,
                recipient_user_id,
                public_key,
                scope,
            } => Self::VerifiedRecipientKey {
                account_id: account_id.into(),
                recipient_user_id,
                public_key,
                scope,
            },
            RuntimeRequest::RefreshTravelMode { account_id } => Self::RefreshTravelMode {
                account_id: account_id.into(),
            },
            RuntimeRequest::SetTravelModeHiddenVaults {
                account_id,
                hidden_vault_ids,
            } => Self::SetTravelModeHiddenVaults {
                account_id: account_id.into(),
                hidden_vault_ids,
            },
            RuntimeRequest::EnableTravelMode {
                account_id,
                hidden_vault_ids,
            } => Self::EnableTravelMode {
                account_id: account_id.into(),
                hidden_vault_ids,
            },
            RuntimeRequest::DisableTravelMode {
                account_id,
                master_password,
            } => Self::DisableTravelMode {
                account_id: account_id.into(),
                master_password: master_password.value.clone().into(),
            },
            RuntimeRequest::RebootstrapAccountRecovery { account_id } => {
                Self::RebootstrapAccountRecovery {
                    account_id: account_id.into(),
                }
            }
            RuntimeRequest::InspectRecovery { account_id } => Self::InspectRecovery {
                account_id: account_id.map(Into::into),
            },
            RuntimeRequest::ExportAccountRecovery {
                account_id,
                password,
                sink_capability_id,
            } => Self::ExportAccountRecovery {
                account_id: account_id.into(),
                password: password.value.clone(),
                sink_capability_id,
            },
            RuntimeRequest::RepairAccountRecovery {
                account_id,
                password,
                source_capability_id,
            } => Self::RepairAccountRecovery {
                account_id: account_id.into(),
                password: password.value.clone(),
                source_capability_id,
            },
            RuntimeRequest::SignIn {
                server_url,
                email,
                master_password,
                secret_key,
                insecure_transport_confirmed,
            } => Self::SignIn {
                server_url,
                email,
                master_password: master_password.value.clone(),
                secret_key: secret_key.value.clone(),
                insecure_transport_confirmed,
            },
            RuntimeRequest::BiometricAvailability { account_ids } => Self::BiometricAvailability {
                account_ids: account_ids.into_iter().map(Into::into).collect(),
            },
            RuntimeRequest::SetBiometricEnabled {
                account_id,
                enabled,
            } => Self::SetBiometricEnabled {
                account_id: account_id.into(),
                enabled,
            },
            RuntimeRequest::BiometricUnlock {
                account_id,
                prompt_message,
            } => Self::BiometricUnlock {
                account_id: account_id.into(),
                prompt_message,
            },
            RuntimeRequest::BiometricUnlockAccounts {
                account_ids,
                prompt_message,
            } => Self::BiometricUnlockAccounts {
                account_ids: account_ids.into_iter().map(Into::into).collect(),
                prompt_message,
            },
            RuntimeRequest::SetMasterPasswordReentryPeriod { period_ms } => {
                Self::SetMasterPasswordReentryPeriod { period_ms }
            }
            RuntimeRequest::LocalSecuritySettings { account_id } => Self::LocalSecuritySettings {
                account_id: account_id.into(),
            },
            RuntimeRequest::SetInactivityTimeout {
                account_id,
                timeout_ms,
            } => Self::SetInactivityTimeout {
                account_id: account_id.into(),
                timeout_ms,
            },
            RuntimeRequest::RecordActivity { account_id, kind } => Self::RecordActivity {
                account_id: account_id.into(),
                kind: kind.into(),
            },
            RuntimeRequest::DeviceSetup { account_id } => Self::DeviceSetup {
                account_id: account_id.into(),
            },
            RuntimeRequest::QuickUnlockAccounts {
                account_ids,
                master_password,
            } => Self::QuickUnlockAccounts {
                account_ids: account_ids.into_iter().map(Into::into).collect(),
                master_password: master_password.value.clone(),
            },
            RuntimeRequest::QuickUnlock {
                account_id,
                master_password,
            } => Self::QuickUnlock {
                account_id: account_id.into(),
                master_password: master_password.value.clone(),
            },
            RuntimeRequest::Lock { account_id } => Self::Lock {
                account_id: account_id.into(),
            },
            RuntimeRequest::SignOut { account_id } => Self::SignOut {
                account_id: account_id.into(),
            },
            RuntimeRequest::RemoveAccount { account_id } => Self::RemoveAccount {
                account_id: account_id.into(),
            },
            RuntimeRequest::DeleteServerAccount {
                account_id,
                confirm_email,
                request_id,
            } => Self::DeleteServerAccount {
                account_id: account_id.into(),
                confirm_email,
                request_id,
            },
            RuntimeRequest::Wipe => Self::Wipe,
            RuntimeRequest::DeleteVault {
                account_id,
                vault_id,
            } => Self::DeleteVault {
                account_id: account_id.into(),
                vault_id,
            },
            RuntimeRequest::UpdateVault {
                account_id,
                vault_id,
                name,
                icon,
                image,
            } => Self::UpdateVault {
                account_id: account_id.into(),
                vault_id,
                name,
                icon: match icon {
                    VaultIconPatch::Unchanged => core::VaultIconPatch::Unchanged,
                    VaultIconPatch::Clear => core::VaultIconPatch::Clear,
                    VaultIconPatch::Set { value } => core::VaultIconPatch::Set { value },
                },
                image: match image {
                    VaultImageChange::Unchanged => core::VaultImageChange::Unchanged,
                    VaultImageChange::Remove => core::VaultImageChange::Remove,
                    VaultImageChange::Source { source } => core::VaultImageChange::Source {
                        source: source.into(),
                    },
                },
            },
            RuntimeRequest::CreateVault {
                account_id,
                name,
                vault_type,
                icon,
                image_source,
            } => Self::CreateVault {
                account_id: account_id.into(),
                name,
                vault_type: match vault_type {
                    CreateVaultType::Personal => core::CreateVaultType::Personal,
                    CreateVaultType::Shared => core::CreateVaultType::Shared,
                },
                icon,
                image_source: image_source.map(Into::into),
            },
            RuntimeRequest::CreateItem {
                account_id,
                vault_id,
                draft,
            } => Self::CreateItem {
                account_id: account_id.into(),
                vault_id,
                draft: editable_draft_to_core(draft),
            },
            RuntimeRequest::ImportItems {
                account_id,
                vault_id,
                items,
            } => Self::ImportItems {
                account_id: account_id.into(),
                vault_id,
                items: items
                    .into_iter()
                    .map(|item| core::ImportItemDraft {
                        draft: item.draft.to_core(),
                        favorite: item.favorite,
                    })
                    .collect(),
            },
            RuntimeRequest::UpdateItem {
                account_id,
                item_id,
                guard,
                draft,
            } => Self::UpdateItem {
                account_id: account_id.into(),
                item_id,
                guard: guard.into(),
                draft: editable_draft_to_core(draft),
            },
            RuntimeRequest::RemovePasskey {
                account_id,
                item_id,
                guard,
                rp_id,
                credential_id,
                public_key_fingerprint,
            } => Self::RemovePasskey {
                account_id: account_id.into(),
                item_id,
                guard: guard.into(),
                rp_id,
                credential_id,
                public_key_fingerprint,
            },
            RuntimeRequest::DuplicateItem {
                account_id,
                source_item_id,
                source_guard,
                title,
            } => Self::DuplicateItem {
                account_id: account_id.into(),
                source_item_id,
                source_guard: source_guard.into(),
                title,
            },
            RuntimeRequest::SetItemFavorite {
                account_id,
                item_id,
                favorite,
            } => Self::SetItemFavorite {
                account_id: account_id.into(),
                item_id,
                favorite,
            },
            RuntimeRequest::TrashItem {
                account_id,
                item_id,
            } => Self::TrashItem {
                account_id: account_id.into(),
                item_id,
            },
            RuntimeRequest::RestoreItem {
                account_id,
                item_id,
            } => Self::RestoreItem {
                account_id: account_id.into(),
                item_id,
            },
            RuntimeRequest::MoveItem {
                account_id,
                item_id,
                target_vault_id,
                target_account_id,
            } => Self::MoveItem {
                account_id: account_id.into(),
                item_id,
                target_vault_id,
                target_account_id: target_account_id.map(Into::into),
            },
            RuntimeRequest::PrepareCrossAccountMoveResume {
                account_id,
                operation_id,
                target_account_id,
                expected_binding_revision,
            } => Self::PrepareCrossAccountMoveResume {
                account_id: account_id.into(),
                operation_id,
                target_account_id: target_account_id.into(),
                expected_binding_revision,
            },
            RuntimeRequest::ResumeCrossAccountMove { guard } => Self::ResumeCrossAccountMove {
                guard: guard.into(),
            },
            RuntimeRequest::PermanentlyDeleteItem {
                account_id,
                item_id,
            } => Self::PermanentlyDeleteItem {
                account_id: account_id.into(),
                item_id,
            },
            RuntimeRequest::CreateShare {
                account_id,
                item_id,
                draft,
            } => Self::CreateShare {
                account_id: account_id.into(),
                item_id,
                draft: core::CreateShareDraft {
                    access_mode: draft.access_mode.into(),
                    expires_in: draft.expires_in.into(),
                    is_one_time_use: draft.is_one_time_use,
                    allowed_emails: draft.allowed_emails,
                },
            },
            RuntimeRequest::AcknowledgeShareResult {
                account_id,
                operation_id,
            } => Self::AcknowledgeShareResult {
                account_id: account_id.into(),
                operation_id,
            },
            RuntimeRequest::ListItemShareLinks {
                account_id,
                item_id,
            } => Self::ListItemShareLinks {
                account_id: account_id.into(),
                item_id,
            },
            RuntimeRequest::ListShareAccessLogs {
                account_id,
                item_id,
                link_id,
            } => Self::ListShareAccessLogs {
                account_id: account_id.into(),
                item_id,
                link_id,
            },
            RuntimeRequest::RevokeShareLink {
                account_id,
                item_id,
                link_id,
            } => Self::RevokeShareLink {
                account_id: account_id.into(),
                item_id,
                link_id,
            },
            RuntimeRequest::RenameAttachment {
                account_id,
                attachment_id,
                name,
            } => Self::RenameAttachment {
                account_id: account_id.into(),
                attachment_id,
                name: name.value.clone(),
            },
            RuntimeRequest::DeleteAttachment {
                account_id,
                attachment_id,
            } => Self::DeleteAttachment {
                account_id: account_id.into(),
                attachment_id,
            },
            RuntimeRequest::DownloadAttachment {
                account_id,
                attachment_id,
                sink_capability_id,
            } => Self::DownloadAttachment {
                account_id: account_id.into(),
                attachment_id,
                sink_capability_id,
            },
            RuntimeRequest::UploadAttachment {
                account_id,
                item_id,
                metadata,
                file_size,
                source_capability_id,
            } => Self::UploadAttachment {
                account_id: account_id.into(),
                item_id,
                name: metadata.name.clone(),
                content_type: metadata.content_type.clone(),
                file_size,
                source_capability_id,
            },
        }
    }
}

impl From<ShareAccessMode> for core::ShareAccessMode {
    fn from(value: ShareAccessMode) -> Self {
        match value {
            ShareAccessMode::Anyone => Self::Anyone,
            ShareAccessMode::EmailRestricted => Self::EmailRestricted,
        }
    }
}

impl From<ShareExpiration> for core::ShareExpiration {
    fn from(value: ShareExpiration) -> Self {
        match value {
            ShareExpiration::OneHour => Self::OneHour,
            ShareExpiration::OneDay => Self::OneDay,
            ShareExpiration::SevenDays => Self::SevenDays,
            ShareExpiration::FourteenDays => Self::FourteenDays,
            ShareExpiration::ThirtyDays => Self::ThirtyDays,
        }
    }
}

impl From<CustomFieldKind> for core::CustomFieldKind {
    fn from(value: CustomFieldKind) -> Self {
        match value {
            CustomFieldKind::Text => Self::Text,
            CustomFieldKind::Password => Self::Password,
            CustomFieldKind::Email => Self::Email,
            CustomFieldKind::Url => Self::Url,
        }
    }
}

impl From<ObservationRequest> for core::ObservationRequest {
    fn from(value: ObservationRequest) -> Self {
        match value {
            ObservationRequest::TravelMode { account_id } => Self::TravelMode {
                account_id: account_id.into(),
            },
            ObservationRequest::WritableVaultCatalog => Self::WritableVaultCatalog,
            ObservationRequest::Items { account_id } => Self::Items {
                account_id: account_id.into(),
            },
            ObservationRequest::VaultExport {
                account_id,
                vault_ids,
            } => Self::VaultExport {
                account_id: account_id.into(),
                vault_ids,
            },
            ObservationRequest::Operations { account_id } => Self::Operations {
                account_id: account_id.into(),
            },
            ObservationRequest::PendingShareResults { account_id } => Self::PendingShareResults {
                account_id: account_id.into(),
            },
            ObservationRequest::RuntimeStatus { account_id } => Self::RuntimeStatus {
                account_id: account_id.map(Into::into),
            },
        }
    }
}

fn delivered_invitation_token(token: core::InvitationToken) -> Arc<SecretString> {
    SecretString::new(token.expose_for_delivery().to_owned())
}

impl From<core::RuntimeResponse> for RuntimeResponse {
    fn from(value: core::RuntimeResponse) -> Self {
        match value {
            core::RuntimeResponse::AvailableVaultMembers { members } => {
                Self::AvailableVaultMembers {
                    members: members.into_iter().map(Into::into).collect(),
                }
            }
            core::RuntimeResponse::VaultMembers { members } => Self::VaultMembers {
                members: members.into_iter().map(Into::into).collect(),
            },
            core::RuntimeResponse::VaultMemberAdded { vault_id, user_id } => {
                Self::VaultMemberAdded { vault_id, user_id }
            }
            core::RuntimeResponse::VaultMemberAddUncertain {
                vault_id,
                user_id,
                current_role,
            } => Self::VaultMemberAddUncertain {
                vault_id,
                user_id,
                current_role: current_role.map(Into::into),
            },
            core::RuntimeResponse::RotationPrepared { selection } => Self::RotationPrepared {
                selection: selection.into(),
            },
            core::RuntimeResponse::RotationStartPending { start_operation_id } => {
                Self::RotationStartPending { start_operation_id }
            }
            core::RuntimeResponse::RotationStartRejected { code } => {
                Self::RotationStartRejected { code: code.into() }
            }
            core::RuntimeResponse::RotationPreparationRequiresCrypto {
                start_operation_id,
                plans,
            } => Self::RotationPreparationRequiresCrypto {
                start_operation_id,
                plans: plans.into_iter().map(Into::into).collect(),
            },
            core::RuntimeResponse::RotationAttemptConsumed { start_operation_id } => {
                Self::RotationAttemptConsumed { start_operation_id }
            }
            core::RuntimeResponse::RotationFinalizePending {
                finalize_operation_id,
            } => Self::RotationFinalizePending {
                finalize_operation_id,
            },
            core::RuntimeResponse::RotationRefreshRequired {
                finalize_operation_id,
                outcome,
            } => Self::RotationRefreshRequired {
                finalize_operation_id,
                outcome: outcome.into(),
            },
            core::RuntimeResponse::RotationCompleted { personal_team_id } => {
                Self::RotationCompleted { personal_team_id }
            }
            core::RuntimeResponse::RotationRejected { code } => {
                Self::RotationRejected { code: code.into() }
            }
            core::RuntimeResponse::TeamLeaveAttempts { attempts } => Self::TeamLeaveAttempts {
                attempts: attempts.into_iter().map(Into::into).collect(),
            },
            core::RuntimeResponse::TeamLeaveAttemptAcknowledged => {
                Self::TeamLeaveAttemptAcknowledged
            }
            core::RuntimeResponse::MyTeamInvitations { invitations } => Self::MyTeamInvitations {
                invitations: invitations.into_iter().map(Into::into).collect(),
            },
            core::RuntimeResponse::MyTeamInvitationAccepted { team_id, team_name } => {
                Self::MyTeamInvitationAccepted { team_id, team_name }
            }
            core::RuntimeResponse::MyTeamInvitationAcceptRefreshRequired { team_id, team_name } => {
                Self::MyTeamInvitationAcceptRefreshRequired { team_id, team_name }
            }
            core::RuntimeResponse::MyTeamInvitationDeclined => Self::MyTeamInvitationDeclined,
            core::RuntimeResponse::MyTeamInvitationUncertain {
                action,
                invitation_id,
                pending,
                current_team_id,
            } => Self::MyTeamInvitationUncertain {
                action: action.into(),
                invitation_id,
                pending,
                current_team_id,
            },
            core::RuntimeResponse::InvitationComposer { composer } => Self::InvitationComposer {
                composer: (*composer).into(),
            },
            core::RuntimeResponse::TeamInvitationCreated {
                invitation_id,
                token,
                candidate,
                continuation_id,
            } => Self::TeamInvitationCreated {
                invitation_id,
                token: delivered_invitation_token(token),
                candidate: candidate.map(Into::into),
                continuation_id,
            },
            core::RuntimeResponse::TeamInvitationProvisioned {
                invitation_id,
                token,
            } => Self::TeamInvitationProvisioned {
                invitation_id,
                token: delivered_invitation_token(token),
            },
            core::RuntimeResponse::TeamInvitationProvisioningNotRequired { invitation_id } => {
                Self::TeamInvitationProvisioningNotRequired { invitation_id }
            }
            core::RuntimeResponse::TeamInvitationUncertain {
                phase,
                original_invitation_id,
            } => Self::TeamInvitationUncertain {
                phase: phase.into(),
                original_invitation_id,
            },
            core::RuntimeResponse::InvitationContinuationReleased => {
                Self::InvitationContinuationReleased
            }
            core::RuntimeResponse::TeamInvitationCancelled { invitation_id } => {
                Self::TeamInvitationCancelled { invitation_id }
            }
            core::RuntimeResponse::TeamInvitationResent {
                invitation_id,
                token,
            } => Self::TeamInvitationResent {
                invitation_id,
                token: delivered_invitation_token(token),
            },
            core::RuntimeResponse::TeamInvitationAdminUncertain {
                action,
                invitation_id,
                pending,
            } => Self::TeamInvitationAdminUncertain {
                action: action.into(),
                invitation_id,
                pending,
            },
            // This native request enum has no ReadTeamPage variant. Ticket 105 exposes the
            // authenticated Team read through the Web JSON protocol only.
            core::RuntimeResponse::TeamPage { .. } => {
                unreachable!("native binding cannot issue ReadTeamPage")
            }
            core::RuntimeResponse::ProfileAdmissionAborted { admission_id } => {
                Self::ProfileAdmissionAborted { admission_id }
            }
            core::RuntimeResponse::ProfileAdmissionInspection { state } => {
                Self::ProfileAdmissionInspection {
                    state: state.into(),
                }
            }
            core::RuntimeResponse::CrossAccountMoveResumePrepared { guard } => {
                Self::CrossAccountMoveResumePrepared {
                    guard: guard.into(),
                }
            }
            core::RuntimeResponse::OwnKeyFingerprint {
                user_id,
                fingerprint,
            } => Self::OwnKeyFingerprint {
                user_id,
                fingerprint,
            },
            core::RuntimeResponse::RecipientKeyScope { scope } => Self::RecipientKeyScope { scope },
            core::RuntimeResponse::RecipientKeyVerified => Self::RecipientKeyVerified,
            core::RuntimeResponse::VerifiedRecipientKey { public_key } => {
                Self::VerifiedRecipientKey { public_key }
            }
            core::RuntimeResponse::TravelMode { account_id, result } => Self::TravelMode {
                account_id: account_id.into(),
                result: result.into(),
            },
            core::RuntimeResponse::RecoveryDiagnosed { diagnostics } => Self::RecoveryDiagnosed {
                diagnostics: diagnostics.into(),
            },
            core::RuntimeResponse::RecoveryExported {
                account_id,
                classification,
                byte_length,
            } => Self::RecoveryExported {
                account_id: account_id.into(),
                classification: classification.into(),
                byte_length,
            },
            core::RuntimeResponse::RecoveryRepaired {
                account_id,
                replica_revision,
            } => Self::RecoveryRepaired {
                account_id: account_id.into(),
                replica_revision,
            },
            core::RuntimeResponse::ActivityRecorded => Self::ActivityRecorded,
            core::RuntimeResponse::LocalSecuritySettings {
                account_id,
                inactivity_timeout_ms,
                master_password_reentry_period_ms,
            } => Self::LocalSecuritySettings {
                account_id: account_id.into(),
                inactivity_timeout_ms,
                master_password_reentry_period_ms,
            },
            core::RuntimeResponse::DeviceSetup { disclosure } => Self::DeviceSetup {
                disclosure: disclosure.into(),
            },
            core::RuntimeResponse::AccountsUnlocked { accounts } => Self::AccountsUnlocked {
                accounts: accounts.into_iter().map(Into::into).collect(),
            },
            core::RuntimeResponse::BiometricAvailability {
                hardware,
                accounts,
                master_password_reentry_period_ms,
            } => Self::BiometricAvailability {
                hardware: hardware.into(),
                accounts: accounts.into_iter().map(Into::into).collect(),
                master_password_reentry_period_ms,
            },
            core::RuntimeResponse::BiometricEnabled {
                account_id,
                enabled,
            } => Self::BiometricEnabled {
                account_id: account_id.into(),
                enabled,
            },
            core::RuntimeResponse::BiometricUnlock { accounts } => Self::BiometricUnlock {
                accounts: accounts.into_iter().map(Into::into).collect(),
            },
            core::RuntimeResponse::MasterPasswordReentryPeriod { period_ms } => {
                Self::MasterPasswordReentryPeriod { period_ms }
            }
            core::RuntimeResponse::SignedIn {
                account_id,
                user_id,
            } => Self::SignedIn {
                account_id: account_id.into(),
                user_id,
            },
            core::RuntimeResponse::AccessChanged { account_id, access } => Self::AccessChanged {
                account_id: account_id.into(),
                access: access.into(),
            },
            core::RuntimeResponse::ServerAccountDeletion {
                account_id,
                request_id,
                outcome,
            } => Self::ServerAccountDeletion {
                account_id: account_id.into(),
                request_id,
                outcome: outcome.into(),
            },
            core::RuntimeResponse::Accepted {
                operation_id,
                item_id,
                replica_revision,
            } => Self::Accepted {
                operation_id,
                item_id,
                replica_revision,
            },
            core::RuntimeResponse::VaultUpdateAccepted {
                operation_id,
                vault_id,
                replica_revision,
            } => Self::VaultUpdateAccepted {
                operation_id,
                vault_id,
                replica_revision,
            },
            core::RuntimeResponse::VaultDeletionAccepted {
                operation_id,
                vault_id,
                replica_revision,
            } => Self::VaultDeletionAccepted {
                operation_id,
                vault_id,
                replica_revision,
            },
            core::RuntimeResponse::VaultCreationAccepted {
                operation_id,
                vault_id,
                replica_revision,
            } => Self::VaultCreationAccepted {
                operation_id,
                vault_id,
                replica_revision,
            },
            core::RuntimeResponse::ImportBatchAccepted {
                operation_id,
                vault_id,
                item_ids,
                replica_revision,
            } => Self::ImportBatchAccepted {
                operation_id,
                vault_id,
                item_ids,
                replica_revision,
            },
            core::RuntimeResponse::ShareResultAcknowledged {
                account_id,
                operation_id,
            } => Self::ShareResultAcknowledged {
                account_id: account_id.into(),
                operation_id,
            },
            core::RuntimeResponse::ItemShareLinks {
                account_id,
                item_id,
                links,
                base_share_url,
            } => Self::ItemShareLinks {
                account_id: account_id.as_str().to_owned(),
                item_id,
                links: links.into_iter().map(Into::into).collect(),
                base_share_url,
            },
            core::RuntimeResponse::ShareAccessLogs {
                account_id,
                link_id,
                logs,
            } => Self::ShareAccessLogs {
                account_id: account_id.as_str().to_owned(),
                link_id,
                logs: logs.into_iter().map(Into::into).collect(),
            },
            core::RuntimeResponse::ShareLinkRevoked {
                account_id,
                link_id,
            } => Self::ShareLinkRevoked {
                account_id: account_id.as_str().to_owned(),
                link_id,
            },
            core::RuntimeResponse::AttachmentRenamed {
                account_id,
                attachment_id,
            } => Self::AttachmentRenamed {
                account_id: account_id.into(),
                attachment_id,
            },
            core::RuntimeResponse::AttachmentDeleted {
                account_id,
                attachment_id,
            } => Self::AttachmentDeleted {
                account_id: account_id.into(),
                attachment_id,
            },
            core::RuntimeResponse::AttachmentDownloaded {
                account_id,
                attachment_id,
            } => Self::AttachmentDownloaded {
                account_id: account_id.into(),
                attachment_id,
            },
            core::RuntimeResponse::AttachmentUploaded {
                attachment_id,
                replica_revision,
            } => Self::AttachmentUploaded {
                attachment_id,
                replica_revision,
            },
            core::RuntimeResponse::Teardown {
                scope,
                status,
                failures,
            } => Self::Teardown {
                scope: scope.into(),
                status: status.into(),
                failures: failures.into_iter().map(Into::into).collect(),
            },
        }
    }
}

impl From<core::ServerAccountDeletionOutcome> for ServerAccountDeletionOutcome {
    fn from(value: core::ServerAccountDeletionOutcome) -> Self {
        match value {
            core::ServerAccountDeletionOutcome::Deleted => Self::Deleted,
            core::ServerAccountDeletionOutcome::ConfirmationEmailMismatch => {
                Self::ConfirmationEmailMismatch
            }
            core::ServerAccountDeletionOutcome::Blocked => Self::Blocked,
        }
    }
}

impl From<core::TeardownScope> for TeardownScope {
    fn from(value: core::TeardownScope) -> Self {
        match value {
            core::TeardownScope::Account { account_id } => Self::Account {
                account_id: account_id.into(),
            },
            core::TeardownScope::Device => Self::Device,
        }
    }
}

impl From<core::TeardownStatus> for TeardownStatus {
    fn from(value: core::TeardownStatus) -> Self {
        match value {
            core::TeardownStatus::Complete => Self::Complete,
            core::TeardownStatus::Incomplete => Self::Incomplete,
        }
    }
}

impl From<core::TeardownPhase> for TeardownPhase {
    fn from(value: core::TeardownPhase) -> Self {
        match value {
            core::TeardownPhase::AttachmentArtifacts => Self::AttachmentArtifacts,
            core::TeardownPhase::HostCleanup => Self::HostCleanup,
            core::TeardownPhase::PlatformStorage => Self::PlatformStorage,
            core::TeardownPhase::Replica => Self::Replica,
        }
    }
}

impl From<core::RuntimeProjection> for RuntimeProjection {
    fn from(value: core::RuntimeProjection) -> Self {
        match value {
            core::RuntimeProjection::TravelMode(value) => Self::TravelMode {
                value: value.into(),
            },
            core::RuntimeProjection::WritableVaultCatalog(value) => Self::WritableVaultCatalog {
                value: value.into(),
            },
            core::RuntimeProjection::Items(value) => Self::Items {
                value: value.into(),
            },
            core::RuntimeProjection::VaultExport(value) => Self::VaultExport {
                value: value.into(),
            },
            core::RuntimeProjection::Operations(value) => Self::Operations {
                value: value.into(),
            },
            core::RuntimeProjection::PendingShareResults(value) => Self::PendingShareResults {
                value: value.into(),
            },
            core::RuntimeProjection::RuntimeStatus(value) => Self::RuntimeStatus {
                value: value.into(),
            },
        }
    }
}

impl From<core::WritableVaultCatalogProjection> for WritableVaultCatalogProjection {
    fn from(value: core::WritableVaultCatalogProjection) -> Self {
        Self {
            revision: value.revision,
            vaults: value.vaults.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<core::WritableVaultProjection> for WritableVaultProjection {
    fn from(value: core::WritableVaultProjection) -> Self {
        Self {
            account_id: value.account_id.into(),
            vault_id: value.vault_id,
            name: value.name,
            vault_type: value.vault_type.into(),
            icon: value.icon,
            image_url: value.image_url,
            role: value.role.into(),
        }
    }
}

impl From<core::ItemsProjection> for ItemsProjection {
    fn from(value: core::ItemsProjection) -> Self {
        let core::ItemsProjection {
            account_id,
            replica_revision,
            items,
            vaults,
        } = value;
        Self {
            account_id: account_id.into(),
            replica_revision,
            items: items
                .into_iter()
                .map(|item| Arc::new(ItemProjection::from(item)))
                .collect(),
            vaults: vaults.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<core::VaultExportProjection> for VaultExportProjection {
    fn from(value: core::VaultExportProjection) -> Self {
        Self {
            account_id: value.account_id.into(),
            replica_revision: value.replica_revision,
            items: value.items.into_iter().map(Into::into).collect(),
            vaults: value.vaults.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<core::VaultExportItem> for VaultExportItem {
    fn from(value: core::VaultExportItem) -> Self {
        Self {
            account_id: value.account_id.into(),
            item_id: value.item_id,
            vault_id: value.vault_id,
            data: item_draft_from_core(value.data),
            favorite: value.favorite,
            deleted_at: value.deleted_at,
            attachments: value
                .attachments
                .into_iter()
                .map(|item| Arc::new(AttachmentProjection::from(item)))
                .collect(),
            created_at: value.created_at,
            updated_at: value.updated_at,
            status: value.status.into(),
        }
    }
}

impl From<core::PendingShareResultsProjection> for PendingShareResultsProjection {
    fn from(value: core::PendingShareResultsProjection) -> Self {
        Self {
            account_id: value.account_id.into(),
            replica_revision: value.replica_revision,
            results: value
                .results
                .into_iter()
                .map(|result| Arc::new(PendingShareResult::from(result)))
                .collect(),
        }
    }
}

impl From<core::PendingShareResult> for PendingShareResult {
    fn from(value: core::PendingShareResult) -> Self {
        Self {
            operation_id: value.operation_id.clone(),
            item_id: value.item_id.clone(),
            share_link_id: value.share_link_id.clone(),
            share_url: value.share_url.clone(),
            expires_at: value.expires_at.clone(),
        }
    }
}

impl From<core::ItemProjection> for ItemProjection {
    fn from(value: core::ItemProjection) -> Self {
        let core::ItemProjection {
            account_id,
            item_id,
            vault_id,
            data,
            favorite,
            deleted_at,
            attachments,
            created_at,
            updated_at,
            status,
            edit_guard,
            duplicate_source_guard,
        } = value;
        Self {
            account_id: account_id.into(),
            item_id,
            vault_id,
            data: public_item_draft_from_core(data),
            favorite,
            deleted_at,
            attachments: attachments
                .into_iter()
                .map(|attachment| Arc::new(AttachmentProjection::from(attachment)))
                .collect(),
            created_at,
            updated_at,
            status: status.into(),
            edit_guard: edit_guard.map(Into::into),
            duplicate_source_guard: duplicate_source_guard.map(Into::into),
        }
    }
}

impl From<core::ItemEditGuard> for ItemEditGuard {
    fn from(value: core::ItemEditGuard) -> Self {
        Self {
            account_id: value.account_id.into(),
            incarnation: value.incarnation.into(),
            lock_epoch: value.lock_epoch,
            item_id: value.item_id,
            vault_id: value.vault_id,
            item_version: value.item_version,
        }
    }
}

impl From<ItemEditGuard> for core::ItemEditGuard {
    fn from(value: ItemEditGuard) -> Self {
        Self {
            account_id: value.account_id.into(),
            incarnation: value.incarnation.into(),
            lock_epoch: value.lock_epoch,
            item_id: value.item_id,
            vault_id: value.vault_id,
            item_version: value.item_version,
        }
    }
}

impl From<core::ItemDuplicateGuard> for ItemDuplicateGuard {
    fn from(value: core::ItemDuplicateGuard) -> Self {
        Self {
            account_id: value.account_id.into(),
            incarnation_id: value.incarnation_id.into(),
            lock_epoch: value.lock_epoch,
            source_item_id: value.source_item_id,
            vault_id: value.vault_id,
            replica_revision: value.replica_revision,
            source: match value.source {
                core::DuplicateSourceGuard::Authoritative { item_version } => {
                    DuplicateSourceGuard::Authoritative { item_version }
                }
                core::DuplicateSourceGuard::AcceptedOverlay { operation_id } => {
                    DuplicateSourceGuard::AcceptedOverlay { operation_id }
                }
            },
        }
    }
}

impl From<ItemDuplicateGuard> for core::ItemDuplicateGuard {
    fn from(value: ItemDuplicateGuard) -> Self {
        Self {
            account_id: value.account_id.into(),
            incarnation_id: value.incarnation_id.into(),
            lock_epoch: value.lock_epoch,
            source_item_id: value.source_item_id,
            vault_id: value.vault_id,
            replica_revision: value.replica_revision,
            source: match value.source {
                DuplicateSourceGuard::Authoritative { item_version } => {
                    core::DuplicateSourceGuard::Authoritative { item_version }
                }
                DuplicateSourceGuard::AcceptedOverlay { operation_id } => {
                    core::DuplicateSourceGuard::AcceptedOverlay { operation_id }
                }
            },
        }
    }
}

fn editable_draft_to_core(value: EditableItemDraft) -> core::ItemDraft {
    let private_shape = match value {
        EditableItemDraft::Login { value } => {
            let value = Arc::unwrap_or_clone(value);
            ItemDraft::Login {
                value: Arc::new(LoginItemData {
                    title: value.title,
                    url: value.url,
                    urls: value.urls,
                    username: value.username,
                    password: value.password,
                    password_history: value.password_history,
                    passkeys: Vec::new(),
                    notes: value.notes,
                    note: value.note,
                    custom_fields: value.custom_fields,
                    tags: value.tags,
                    totp_secret: value.totp_secret,
                    totp_issuer: value.totp_issuer,
                    totp_account_name: value.totp_account_name,
                    totp_algorithm: value.totp_algorithm,
                    totp_digits: value.totp_digits,
                    totp_period: value.totp_period,
                }),
            }
        }
        EditableItemDraft::SecureNote { value } => ItemDraft::SecureNote { value },
        EditableItemDraft::CreditCard { value } => ItemDraft::CreditCard { value },
        EditableItemDraft::Identity { value } => ItemDraft::Identity { value },
        EditableItemDraft::Authenticator { value } => ItemDraft::Authenticator { value },
    };
    item_draft_to_core(&private_shape)
}

fn item_draft_to_core(value: &ItemDraft) -> core::ItemDraft {
    match value {
        ItemDraft::Login { value } => core::ItemDraft::Login(core::LoginItemData {
            title: value.title.clone(),
            url: value.url.clone(),
            urls: value.urls.clone(),
            username: value.username.clone(),
            password: value.password.clone(),
            password_history: value
                .password_history
                .iter()
                .map(|entry| core::PasswordHistoryEntry {
                    password: entry.password.clone(),
                    changed_at: entry.changed_at.clone(),
                })
                .collect(),
            passkeys: value
                .passkeys
                .iter()
                .map(|passkey| passkey_to_core(passkey))
                .collect(),
            notes: value.notes.clone(),
            note: value.note.clone(),
            custom_fields: value
                .custom_fields
                .iter()
                .map(|field| field.to_core())
                .collect(),
            tags: value.tags.clone(),
            totp_secret: value.totp_secret.clone(),
            totp_issuer: value.totp_issuer.clone(),
            totp_account_name: value.totp_account_name.clone(),
            totp_algorithm: value.totp_algorithm.map(totp_to_core),
            totp_digits: value.totp_digits.map(totp_digits_to_core),
            totp_period: value.totp_period,
        }),
        ItemDraft::SecureNote { value } => core::ItemDraft::SecureNote(core::SecureNoteItemData {
            title: value.title.clone(),
            note: value.note.clone(),
            notes: value.notes.clone(),
            custom_fields: value
                .custom_fields
                .iter()
                .map(|field| field.to_core())
                .collect(),
            tags: value.tags.clone(),
        }),
        ItemDraft::CreditCard { value } => core::ItemDraft::CreditCard(core::CreditCardItemData {
            title: value.title.clone(),
            cardholder_name: value.cardholder_name.clone(),
            card_number: value.card_number.clone(),
            cvv: value.cvv.clone(),
            expiry_date: value.expiry_date.clone(),
            billing_address: value.billing_address.clone(),
            notes: value.notes.clone(),
            custom_fields: value
                .custom_fields
                .iter()
                .map(|field| field.to_core())
                .collect(),
            totp_secret: value.totp_secret.clone(),
            totp_issuer: value.totp_issuer.clone(),
            totp_account_name: value.totp_account_name.clone(),
            totp_algorithm: value.totp_algorithm.map(totp_to_core),
            totp_digits: value.totp_digits.map(totp_digits_to_core),
            totp_period: value.totp_period,
            tags: value.tags.clone(),
        }),
        ItemDraft::Identity { value } => core::ItemDraft::Identity(core::IdentityItemData {
            title: value.title.clone(),
            first_name: value.first_name.clone(),
            middle_name: value.middle_name.clone(),
            last_name: value.last_name.clone(),
            email: value.email.clone(),
            addresses: value
                .addresses
                .iter()
                .map(|v| core::Address {
                    id: v.id.clone(),
                    street: v.street.clone(),
                    city: v.city.clone(),
                    state: v.state.clone(),
                    zip: v.zip.clone(),
                    country: v.country.clone(),
                })
                .collect(),
            phone_numbers: value
                .phone_numbers
                .iter()
                .map(|v| core::PhoneNumber {
                    id: v.id.clone(),
                    label: v.label.clone(),
                    number: v.number.clone(),
                })
                .collect(),
            ssn: value.ssn.clone(),
            passport_number: value.passport_number.clone(),
            drivers_license: value.drivers_license.clone(),
            date_of_birth: value.date_of_birth.clone(),
            notes: value.notes.clone(),
            custom_fields: value
                .custom_fields
                .iter()
                .map(|field| field.to_core())
                .collect(),
            totp_secret: value.totp_secret.clone(),
            totp_issuer: value.totp_issuer.clone(),
            totp_account_name: value.totp_account_name.clone(),
            totp_algorithm: value.totp_algorithm.map(totp_to_core),
            totp_digits: value.totp_digits.map(totp_digits_to_core),
            totp_period: value.totp_period,
            tags: value.tags.clone(),
        }),
        ItemDraft::Authenticator { value } => {
            core::ItemDraft::Authenticator(core::AuthenticatorItemData {
                title: value.title.clone(),
                totp_secret: value.totp_secret.clone(),
                totp_issuer: value.totp_issuer.clone(),
                totp_account_name: value.totp_account_name.clone(),
                totp_algorithm: value.totp_algorithm.map(totp_to_core),
                totp_digits: value.totp_digits.map(totp_digits_to_core),
                totp_period: value.totp_period,
                linked_item_id: value.linked_item_id.clone(),
                notes: value.notes.clone(),
                custom_fields: value
                    .custom_fields
                    .iter()
                    .map(|field| field.to_core())
                    .collect(),
                tags: value.tags.clone(),
            })
        }
    }
}

fn public_item_draft_from_core(value: core::PublicItemDraft) -> PublicItemDraft {
    match value {
        core::PublicItemDraft::Login(value) => PublicItemDraft::Login {
            value: Arc::new(PublicLoginItemData {
                editable: Arc::new(EditableLoginItemData {
                    title: value.editable.title,
                    url: value.editable.url,
                    urls: value.editable.urls,
                    username: value.editable.username,
                    password: value.editable.password,
                    password_history: value
                        .editable
                        .password_history
                        .into_iter()
                        .map(|v| {
                            Arc::new(PasswordHistoryEntry {
                                password: v.password,
                                changed_at: v.changed_at,
                            })
                        })
                        .collect(),
                    notes: value.editable.notes,
                    note: value.editable.note,
                    custom_fields: value
                        .editable
                        .custom_fields
                        .into_iter()
                        .map(|v| Arc::new(CustomField::from(v)))
                        .collect(),
                    tags: value.editable.tags,
                    totp_secret: value.editable.totp_secret,
                    totp_issuer: value.editable.totp_issuer,
                    totp_account_name: value.editable.totp_account_name,
                    totp_algorithm: value.editable.totp_algorithm.map(totp_from_core),
                    totp_digits: value.editable.totp_digits.map(totp_digits_from_core),
                    totp_period: value.editable.totp_period,
                }),
                passkeys: value
                    .passkeys
                    .into_iter()
                    .map(public_passkey_from_core)
                    .collect(),
            }),
        },
        core::PublicItemDraft::SecureNote(value) => {
            let ItemDraft::SecureNote { value } =
                item_draft_from_core(core::ItemDraft::SecureNote(value))
            else {
                unreachable!()
            };
            PublicItemDraft::SecureNote { value }
        }
        core::PublicItemDraft::CreditCard(value) => {
            let ItemDraft::CreditCard { value } =
                item_draft_from_core(core::ItemDraft::CreditCard(value))
            else {
                unreachable!()
            };
            PublicItemDraft::CreditCard { value }
        }
        core::PublicItemDraft::Identity(value) => {
            let ItemDraft::Identity { value } =
                item_draft_from_core(core::ItemDraft::Identity(value))
            else {
                unreachable!()
            };
            PublicItemDraft::Identity { value }
        }
        core::PublicItemDraft::Authenticator(value) => {
            let ItemDraft::Authenticator { value } =
                item_draft_from_core(core::ItemDraft::Authenticator(value))
            else {
                unreachable!()
            };
            PublicItemDraft::Authenticator { value }
        }
    }
}

fn public_passkey_from_core(value: core::PublicPasskey) -> PublicPasskey {
    PublicPasskey {
        credential_id: value.credential_id,
        rp_id: value.rp_id,
        rp_name: value.rp_name,
        user_handle: value.user_handle,
        user_name: value.user_name,
        user_display_name: value.user_display_name,
        public_key: value.public_key,
        public_key_fingerprint: value.public_key_fingerprint,
        algorithm: value.algorithm,
        sign_count: value.sign_count,
        transports: value.transports,
        created_at: value.created_at,
        last_used_at: value.last_used_at,
        status: value.status.map(passkey_status_from_core),
        status_reason: value.status_reason.map(passkey_status_reason_from_core),
        status_updated_at: value.status_updated_at,
    }
}

fn passkey_status_from_core(value: core::PasskeyStatus) -> PasskeyStatus {
    match value {
        core::PasskeyStatus::Active => PasskeyStatus::Active,
        core::PasskeyStatus::Suspect => PasskeyStatus::Suspect,
    }
}

fn passkey_status_reason_from_core(value: core::PasskeyStatusReason) -> PasskeyStatusReason {
    match value {
        core::PasskeyStatusReason::Manual => PasskeyStatusReason::Manual,
        core::PasskeyStatusReason::UnknownCredential => PasskeyStatusReason::UnknownCredential,
        core::PasskeyStatusReason::SigningError => PasskeyStatusReason::SigningError,
        core::PasskeyStatusReason::Other => PasskeyStatusReason::Other,
    }
}

fn item_draft_from_core(value: core::ItemDraft) -> ItemDraft {
    match value {
        core::ItemDraft::Login(value) => ItemDraft::Login {
            value: Arc::new(LoginItemData {
                title: value.title,
                url: value.url,
                urls: value.urls,
                username: value.username,
                password: value.password,
                password_history: value
                    .password_history
                    .into_iter()
                    .map(|v| {
                        Arc::new(PasswordHistoryEntry {
                            password: v.password,
                            changed_at: v.changed_at,
                        })
                    })
                    .collect(),
                passkeys: value
                    .passkeys
                    .into_iter()
                    .map(|v| Arc::new(passkey_from_core(v)))
                    .collect(),
                notes: value.notes,
                note: value.note,
                custom_fields: value
                    .custom_fields
                    .into_iter()
                    .map(|v| Arc::new(CustomField::from(v)))
                    .collect(),
                tags: value.tags,
                totp_secret: value.totp_secret,
                totp_issuer: value.totp_issuer,
                totp_account_name: value.totp_account_name,
                totp_algorithm: value.totp_algorithm.map(totp_from_core),
                totp_digits: value.totp_digits.map(totp_digits_from_core),
                totp_period: value.totp_period,
            }),
        },
        core::ItemDraft::SecureNote(value) => ItemDraft::SecureNote {
            value: Arc::new(SecureNoteItemData {
                title: value.title,
                note: value.note,
                notes: value.notes,
                custom_fields: value
                    .custom_fields
                    .into_iter()
                    .map(|v| Arc::new(CustomField::from(v)))
                    .collect(),
                tags: value.tags,
            }),
        },
        core::ItemDraft::CreditCard(value) => ItemDraft::CreditCard {
            value: Arc::new(CreditCardItemData {
                title: value.title,
                cardholder_name: value.cardholder_name,
                card_number: value.card_number,
                cvv: value.cvv,
                expiry_date: value.expiry_date,
                billing_address: value.billing_address,
                notes: value.notes,
                custom_fields: value
                    .custom_fields
                    .into_iter()
                    .map(|v| Arc::new(CustomField::from(v)))
                    .collect(),
                totp_secret: value.totp_secret,
                totp_issuer: value.totp_issuer,
                totp_account_name: value.totp_account_name,
                totp_algorithm: value.totp_algorithm.map(totp_from_core),
                totp_digits: value.totp_digits.map(totp_digits_from_core),
                totp_period: value.totp_period,
                tags: value.tags,
            }),
        },
        core::ItemDraft::Identity(value) => ItemDraft::Identity {
            value: Arc::new(IdentityItemData {
                title: value.title,
                first_name: value.first_name,
                middle_name: value.middle_name,
                last_name: value.last_name,
                email: value.email,
                addresses: value
                    .addresses
                    .into_iter()
                    .map(|v| {
                        Arc::new(Address {
                            id: v.id,
                            street: v.street,
                            city: v.city,
                            state: v.state,
                            zip: v.zip,
                            country: v.country,
                        })
                    })
                    .collect(),
                phone_numbers: value
                    .phone_numbers
                    .into_iter()
                    .map(|v| {
                        Arc::new(PhoneNumber {
                            id: v.id,
                            label: v.label,
                            number: v.number,
                        })
                    })
                    .collect(),
                ssn: value.ssn,
                passport_number: value.passport_number,
                drivers_license: value.drivers_license,
                date_of_birth: value.date_of_birth,
                notes: value.notes,
                custom_fields: value
                    .custom_fields
                    .into_iter()
                    .map(|v| Arc::new(CustomField::from(v)))
                    .collect(),
                totp_secret: value.totp_secret,
                totp_issuer: value.totp_issuer,
                totp_account_name: value.totp_account_name,
                totp_algorithm: value.totp_algorithm.map(totp_from_core),
                totp_digits: value.totp_digits.map(totp_digits_from_core),
                totp_period: value.totp_period,
                tags: value.tags,
            }),
        },
        core::ItemDraft::Authenticator(value) => ItemDraft::Authenticator {
            value: Arc::new(AuthenticatorItemData {
                title: value.title,
                totp_secret: value.totp_secret,
                totp_issuer: value.totp_issuer,
                totp_account_name: value.totp_account_name,
                totp_algorithm: value.totp_algorithm.map(totp_from_core),
                totp_digits: value.totp_digits.map(totp_digits_from_core),
                totp_period: value.totp_period,
                linked_item_id: value.linked_item_id,
                notes: value.notes,
                custom_fields: value
                    .custom_fields
                    .into_iter()
                    .map(|v| Arc::new(CustomField::from(v)))
                    .collect(),
                tags: value.tags,
            }),
        },
    }
}

fn totp_to_core(value: TotpAlgorithm) -> core::TotpAlgorithm {
    match value {
        TotpAlgorithm::Sha1 => core::TotpAlgorithm::Sha1,
        TotpAlgorithm::Sha256 => core::TotpAlgorithm::Sha256,
        TotpAlgorithm::Sha512 => core::TotpAlgorithm::Sha512,
    }
}
fn totp_from_core(value: core::TotpAlgorithm) -> TotpAlgorithm {
    match value {
        core::TotpAlgorithm::Sha1 => TotpAlgorithm::Sha1,
        core::TotpAlgorithm::Sha256 => TotpAlgorithm::Sha256,
        core::TotpAlgorithm::Sha512 => TotpAlgorithm::Sha512,
    }
}
fn totp_digits_to_core(value: TotpDigits) -> core::TotpDigits {
    match value {
        TotpDigits::Six => core::TotpDigits::Six,
        TotpDigits::Seven => core::TotpDigits::Seven,
        TotpDigits::Eight => core::TotpDigits::Eight,
    }
}
fn totp_digits_from_core(value: core::TotpDigits) -> TotpDigits {
    match value {
        core::TotpDigits::Six => TotpDigits::Six,
        core::TotpDigits::Seven => TotpDigits::Seven,
        core::TotpDigits::Eight => TotpDigits::Eight,
    }
}
fn passkey_to_core(value: &Passkey) -> core::Passkey {
    core::Passkey {
        credential_id: value.credential_id.clone(),
        rp_id: value.rp_id.clone(),
        rp_name: value.rp_name.clone(),
        user_handle: value.user_handle.clone(),
        user_name: value.user_name.clone(),
        user_display_name: value.user_display_name.clone(),
        private_key: value.private_key.clone(),
        public_key: value.public_key.clone(),
        algorithm: value.algorithm,
        sign_count: value.sign_count,
        transports: value.transports.clone(),
        created_at: value.created_at.clone(),
        last_used_at: value.last_used_at.clone(),
        status: value.status.map(|v| match v {
            PasskeyStatus::Active => core::PasskeyStatus::Active,
            PasskeyStatus::Suspect => core::PasskeyStatus::Suspect,
        }),
        status_reason: value.status_reason.map(|v| match v {
            PasskeyStatusReason::Manual => core::PasskeyStatusReason::Manual,
            PasskeyStatusReason::UnknownCredential => core::PasskeyStatusReason::UnknownCredential,
            PasskeyStatusReason::SigningError => core::PasskeyStatusReason::SigningError,
            PasskeyStatusReason::Other => core::PasskeyStatusReason::Other,
        }),
        status_updated_at: value.status_updated_at.clone(),
    }
}
fn passkey_from_core(value: core::Passkey) -> Passkey {
    Passkey {
        credential_id: value.credential_id,
        rp_id: value.rp_id,
        rp_name: value.rp_name,
        user_handle: value.user_handle,
        user_name: value.user_name,
        user_display_name: value.user_display_name,
        private_key: value.private_key,
        public_key: value.public_key,
        algorithm: value.algorithm,
        sign_count: value.sign_count,
        transports: value.transports,
        created_at: value.created_at,
        last_used_at: value.last_used_at,
        status: value.status.map(|v| match v {
            core::PasskeyStatus::Active => PasskeyStatus::Active,
            core::PasskeyStatus::Suspect => PasskeyStatus::Suspect,
        }),
        status_reason: value.status_reason.map(|v| match v {
            core::PasskeyStatusReason::Manual => PasskeyStatusReason::Manual,
            core::PasskeyStatusReason::UnknownCredential => PasskeyStatusReason::UnknownCredential,
            core::PasskeyStatusReason::SigningError => PasskeyStatusReason::SigningError,
            core::PasskeyStatusReason::Other => PasskeyStatusReason::Other,
        }),
        status_updated_at: value.status_updated_at,
    }
}

impl From<core::AttachmentProjection> for AttachmentProjection {
    fn from(value: core::AttachmentProjection) -> Self {
        let core::AttachmentProjection {
            account_id,
            attachment_id,
            item_id,
            vault_id,
            name,
            content_type,
            file_size,
            uploaded_by,
            created_at,
        } = value;
        Self {
            account_id: account_id.into(),
            attachment_id,
            item_id,
            vault_id,
            name,
            content_type,
            file_size,
            uploaded_by,
            created_at,
        }
    }
}

impl From<core::CustomField> for CustomField {
    fn from(value: core::CustomField) -> Self {
        let core::CustomField {
            id,
            label,
            value,
            field_type,
        } = value;
        Self {
            id,
            label,
            value,
            field_type: field_type.into(),
        }
    }
}

impl From<core::CustomFieldKind> for CustomFieldKind {
    fn from(value: core::CustomFieldKind) -> Self {
        match value {
            core::CustomFieldKind::Text => Self::Text,
            core::CustomFieldKind::Password => Self::Password,
            core::CustomFieldKind::Email => Self::Email,
            core::CustomFieldKind::Url => Self::Url,
        }
    }
}

impl From<core::VaultProjection> for VaultProjection {
    fn from(value: core::VaultProjection) -> Self {
        let core::VaultProjection {
            vault_id,
            name,
            vault_type,
            icon,
            image_url,
            role,
        } = value;
        Self {
            vault_id,
            name,
            vault_type: vault_type.into(),
            icon,
            image_url,
            role: role.into(),
        }
    }
}

impl From<core::VaultProjectionRole> for VaultProjectionRole {
    fn from(value: core::VaultProjectionRole) -> Self {
        match value {
            core::VaultProjectionRole::Owner => Self::Owner,
            core::VaultProjectionRole::Admin => Self::Admin,
            core::VaultProjectionRole::Member => Self::Member,
            core::VaultProjectionRole::ReadOnly => Self::ReadOnly,
        }
    }
}

impl From<core::VaultProjectionType> for VaultProjectionType {
    fn from(value: core::VaultProjectionType) -> Self {
        match value {
            core::VaultProjectionType::Personal => Self::Personal,
            core::VaultProjectionType::Team => Self::Team,
        }
    }
}

impl From<core::ItemProjectionStatus> for ItemProjectionStatus {
    fn from(value: core::ItemProjectionStatus) -> Self {
        match value {
            core::ItemProjectionStatus::Pending => Self::Pending,
            core::ItemProjectionStatus::Authoritative => Self::Authoritative,
            core::ItemProjectionStatus::Failed => Self::Failed,
        }
    }
}

impl From<core::RuntimeStatusProjection> for RuntimeStatusProjection {
    fn from(value: core::RuntimeStatusProjection) -> Self {
        let core::RuntimeStatusProjection {
            account_id,
            revision,
            accounts,
            closed,
            profile_admission_cleanup,
        } = value;
        Self {
            account_id: account_id.map(Into::into),
            revision,
            accounts: accounts.into_iter().map(Into::into).collect(),
            closed,
            profile_admission_cleanup: profile_admission_cleanup.map(Into::into),
        }
    }
}

impl From<core::AccountStatus> for AccountStatus {
    fn from(value: core::AccountStatus) -> Self {
        let core::AccountStatus {
            account_id,
            replica_revision,
            access,
            waiting_reason,
            failure,
            display_identity,
            unlock_capabilities,
        } = value;
        Self {
            account_id: account_id.into(),
            replica_revision,
            access: access.into(),
            waiting_reason: waiting_reason.map(Into::into),
            failure: failure.map(Into::into),
            display_identity: display_identity.map(Into::into),
            unlock_capabilities: AccountUnlockCapabilities {
                password: unlock_capabilities.password,
                desktop: unlock_capabilities.desktop,
                sign_in: unlock_capabilities.sign_in,
            },
        }
    }
}

impl From<core::AccountDisplayIdentity> for AccountDisplayIdentity {
    fn from(value: core::AccountDisplayIdentity) -> Self {
        Self {
            email: value.email,
            name: value.name,
            team_name: value.team_name,
            team_avatar_url: value.team_avatar_url,
            server_url: value.server_url,
            secret_key_hint: value.secret_key_hint,
        }
    }
}

impl From<core::AccountAccessState> for AccountAccessState {
    fn from(value: core::AccountAccessState) -> Self {
        match value {
            core::AccountAccessState::SignedOut => Self::SignedOut,
            core::AccountAccessState::Locked => Self::Locked,
            core::AccountAccessState::Unlocked => Self::Unlocked,
        }
    }
}

impl From<core::AccountWaitingReason> for AccountWaitingReason {
    fn from(value: core::AccountWaitingReason) -> Self {
        match value {
            core::AccountWaitingReason::ReauthenticationRequired => Self::ReauthenticationRequired,
        }
    }
}

impl From<core::RuntimeErrorCode> for RuntimeErrorCode {
    fn from(value: core::RuntimeErrorCode) -> Self {
        match value {
            core::RuntimeErrorCode::RecipientKeyUnverified => Self::RecipientKeyUnverified,
            core::RuntimeErrorCode::RecipientKeyChanged => Self::RecipientKeyChanged,
            core::RuntimeErrorCode::RecipientFingerprintMismatch => {
                Self::RecipientFingerprintMismatch
            }
            core::RuntimeErrorCode::RuntimeClosed => Self::RuntimeClosed,
            core::RuntimeErrorCode::Cancelled => Self::Cancelled,
            core::RuntimeErrorCode::AccountMissing => Self::AccountMissing,
            core::RuntimeErrorCode::AccountAlreadyInstalled => Self::AccountAlreadyInstalled,
            core::RuntimeErrorCode::AccountFailed => Self::AccountFailed,
            core::RuntimeErrorCode::AuthenticationRequired => Self::AuthenticationRequired,
            core::RuntimeErrorCode::AuthenticationUnavailable => Self::AuthenticationUnavailable,
            core::RuntimeErrorCode::CredentialUnavailable => Self::CredentialUnavailable,
            core::RuntimeErrorCode::StorageUnavailable => Self::StorageUnavailable,
            core::RuntimeErrorCode::RetryableTransport => Self::RetryableTransport,
            core::RuntimeErrorCode::VersionEvidenceUnavailable => Self::VersionEvidenceUnavailable,
            core::RuntimeErrorCode::AuthorityMissing => Self::AuthorityMissing,
            core::RuntimeErrorCode::AccessDenied => Self::AccessDenied,
            core::RuntimeErrorCode::ReadOnly => Self::ReadOnly,
            core::RuntimeErrorCode::QuotaExceeded => Self::QuotaExceeded,
            core::RuntimeErrorCode::SizeRejected => Self::SizeRejected,
            core::RuntimeErrorCode::SourceFailure => Self::SourceFailure,
            core::RuntimeErrorCode::SinkFailure => Self::SinkFailure,
            core::RuntimeErrorCode::InvariantViolation => Self::InvariantViolation,
        }
    }
}

impl From<core::RecoveryBound> for RecoveryBound {
    fn from(value: core::RecoveryBound) -> Self {
        match value {
            core::RecoveryBound::RecordBytes => Self::RecordBytes,
            core::RecoveryBound::ArchiveBytes => Self::ArchiveBytes,
            core::RecoveryBound::RecordCount => Self::RecordCount,
            core::RecoveryBound::ArtifactCount => Self::ArtifactCount,
            core::RecoveryBound::ReportBytes => Self::ReportBytes,
            core::RecoveryBound::SummaryBytes => Self::SummaryBytes,
            core::RecoveryBound::ControlBytes => Self::ControlBytes,
            core::RecoveryBound::CursorBytes => Self::CursorBytes,
            core::RecoveryBound::ChunkBytes => Self::ChunkBytes,
        }
    }
}

impl From<core::RuntimeError> for BindingError {
    fn from(value: core::RuntimeError) -> Self {
        Self::Runtime {
            code: value.code.into(),
            message: value.message,
            recovery_bound: value.recovery_bound.map(Into::into),
        }
    }
}

// Compiled on the host only for its own tests: the Web binding is the one caller, and
// `cargo test` on a native target is the only place this decision can be checked.
#[cfg(any(target_arch = "wasm32", test))]
mod account_retirement;
#[cfg(any(target_arch = "wasm32", test))]
mod observation_buffer;
#[cfg(any(target_arch = "wasm32", test))]
mod observation_slots;
#[cfg(target_arch = "wasm32")]
mod web;
#[cfg(target_arch = "wasm32")]
mod web_recovery_bridge;
#[cfg(target_arch = "wasm32")]
pub use web::WebClientRuntime;
#[allow(
    dead_code,
    reason = "generated Vault-image controls are consumed by shallow host adapters"
)]
mod vault_image_control;
#[cfg(any(target_arch = "wasm32", feature = "artifact-control-contract-schema"))]
mod web_attachment_artifact_control;
#[cfg(any(target_arch = "wasm32", test))]
mod web_attachment_artifact_policy;
#[cfg(target_arch = "wasm32")]
#[allow(
    dead_code,
    reason = "download handles retain explicit cancellation for the closed transfer contract; Runtime abandonment uses Drop"
)]
mod web_binary_transfer;
#[cfg(any(target_arch = "wasm32", test))]
mod web_binary_transfer_abandonment;
#[cfg(any(
    target_arch = "wasm32",
    feature = "transfer-control-contract-schema",
    test
))]
#[cfg_attr(test, allow(dead_code))]
mod web_binary_transfer_control;
#[cfg(any(target_arch = "wasm32", test))]
mod web_binary_transfer_policy;

#[cfg(feature = "vault-image-control-contract-schema")]
pub use vault_image_control::{
    vault_image_control_contract_fixture, vault_image_control_contract_schema,
};
#[cfg(feature = "artifact-control-contract-schema")]
#[doc(hidden)]
pub use web_attachment_artifact_control::{
    artifact_control_contract_fixture, artifact_control_contract_schema,
};
#[cfg(feature = "transfer-control-contract-schema")]
#[doc(hidden)]
pub use web_binary_transfer_control::{
    transfer_control_contract_fixture, transfer_control_contract_schema,
};
#[cfg(not(target_arch = "wasm32"))]
mod native_vault_image_bridge;
#[cfg(target_arch = "wasm32")]
mod web_attachment_artifact_store;
#[cfg(any(target_arch = "wasm32", test))]
mod web_attachment_move_bridge;
#[cfg(target_arch = "wasm32")]
mod web_vault_image_bridge;
#[cfg(all(target_arch = "wasm32", feature = "binding-test-harness"))]
pub use web_attachment_move_bridge::WebAttachmentMoveBridgeTestHarness;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_invitation_tokens_are_opaque_until_explicit_presentation() {
        let cases = [
            core::RuntimeResponse::TeamInvitationCreated {
                invitation_id: "created".into(),
                token: core::InvitationToken::from("UNIQUE_CREATED_TOKEN".to_owned()),
                candidate: None,
                continuation_id: None,
            },
            core::RuntimeResponse::TeamInvitationProvisioned {
                invitation_id: "provisioned".into(),
                token: core::InvitationToken::from("UNIQUE_PROVISIONED_TOKEN".to_owned()),
            },
            core::RuntimeResponse::TeamInvitationResent {
                invitation_id: "resent".into(),
                token: core::InvitationToken::from("UNIQUE_RESENT_TOKEN".to_owned()),
            },
        ];
        for (response, marker) in cases.into_iter().zip([
            "UNIQUE_CREATED_TOKEN",
            "UNIQUE_PROVISIONED_TOKEN",
            "UNIQUE_RESENT_TOKEN",
        ]) {
            let native = RuntimeResponse::from(response);
            assert!(!format!("{native:?}").contains(marker));
            let token = match native {
                RuntimeResponse::TeamInvitationCreated { token, .. }
                | RuntimeResponse::TeamInvitationProvisioned { token, .. }
                | RuntimeResponse::TeamInvitationResent { token, .. } => token,
                _ => unreachable!("only token-bearing results are in this test"),
            };
            assert_eq!(token.reveal(), marker);
        }
    }

    #[test]
    fn share_management_native_adapter_preserves_explicit_scopes_and_closed_results() {
        for request in [
            RuntimeRequest::ListItemShareLinks {
                account_id: "account-2".into(),
                item_id: "item-1".into(),
            },
            RuntimeRequest::ListShareAccessLogs {
                account_id: "account-2".into(),
                item_id: "item-1".into(),
                link_id: "link-1".into(),
            },
            RuntimeRequest::RevokeShareLink {
                account_id: "account-2".into(),
                item_id: "item-1".into(),
                link_id: "link-1".into(),
            },
        ] {
            let converted: core::RuntimeRequest = request.into();
            assert!(matches!(converted,
                core::RuntimeRequest::ListItemShareLinks {account_id, ..}
                | core::RuntimeRequest::ListShareAccessLogs {account_id, ..}
                | core::RuntimeRequest::RevokeShareLink {account_id, ..}
                if account_id.as_str() == "account-2"));
        }
        assert!(
            matches!(RuntimeResponse::from(core::RuntimeResponse::ShareLinkRevoked {
            account_id: core::AccountId::from("account-2"), link_id: "link-1".into(),
        }), RuntimeResponse::ShareLinkRevoked {account_id, link_id} if account_id == "account-2" && link_id == "link-1")
        );
        let log = ShareAccessLog::from(core::ShareAccessLog {
            id: "entry".into(),
            accessed_by_email: Some("reader@example.test".into()),
            ip_address: None,
            user_agent: None,
            success: false,
            failure_reason: Some("expired".into()),
            accessed_at: "2026-01-01".into(),
        });
        assert_eq!(
            log.accessed_by_email.as_deref(),
            Some("reader@example.test")
        );
        assert!(!log.success);
        assert_eq!(log.failure_reason.as_deref(), Some("expired"));
    }

    #[test]
    fn native_attachment_delete_keeps_the_closed_minimal_shape() {
        let core_request: core::RuntimeRequest = RuntimeRequest::DeleteAttachment {
            account_id: "account-1".into(),
            attachment_id: "attachment-1".into(),
        }
        .into();
        assert!(matches!(
            core_request,
            core::RuntimeRequest::DeleteAttachment {
                account_id,
                attachment_id,
            } if account_id.as_str() == "account-1" && attachment_id == "attachment-1"
        ));

        let response = RuntimeResponse::from(core::RuntimeResponse::AttachmentDeleted {
            account_id: core::AccountId::from("account-1"),
            attachment_id: "attachment-1".into(),
        });
        assert!(matches!(
            &response,
            RuntimeResponse::AttachmentDeleted {
                account_id,
                attachment_id,
            } if account_id == "account-1" && attachment_id == "attachment-1"
        ));
        let debug = format!("{response:?}");
        assert!(!debug.contains("storage"));
        assert!(!debug.contains("plaintext"));
    }

    #[test]
    fn native_attachment_download_keeps_the_closed_opaque_capability_shape() {
        for sink_capability_id in ["x".to_owned(), "x".repeat(128)] {
            let core_request: core::RuntimeRequest = RuntimeRequest::DownloadAttachment {
                account_id: "account-1".into(),
                attachment_id: "attachment-1".into(),
                sink_capability_id: sink_capability_id.clone(),
            }
            .into();
            assert!(
                matches!(core_request, core::RuntimeRequest::DownloadAttachment { sink_capability_id: actual, .. } if actual == sink_capability_id)
            );
        }
        let core_request: core::RuntimeRequest = RuntimeRequest::DownloadAttachment {
            account_id: "account-1".into(),
            attachment_id: "attachment-1".into(),
            sink_capability_id: "sink-opaque".into(),
        }
        .into();
        assert!(matches!(
            core_request,
            core::RuntimeRequest::DownloadAttachment {
                account_id,
                attachment_id,
                sink_capability_id,
            } if account_id.as_str() == "account-1"
                && attachment_id == "attachment-1"
                && sink_capability_id == "sink-opaque"
        ));
        let debug = format!(
            "{:?}",
            RuntimeRequest::DownloadAttachment {
                account_id: "account-1".into(),
                attachment_id: "attachment-1".into(),
                sink_capability_id: "sink-secret".into(),
            }
        );
        assert!(!debug.contains("sink-secret"));

        assert!(matches!(
            RuntimeResponse::from(core::RuntimeResponse::AttachmentDownloaded {
                account_id: core::AccountId::from("account-1"),
                attachment_id: "attachment-1".into(),
            }),
            RuntimeResponse::AttachmentDownloaded {
                account_id,
                attachment_id,
            } if account_id == "account-1" && attachment_id == "attachment-1"
        ));
    }

    #[test]
    fn native_account_email_helper_delegates_to_the_validated_core_contract() {
        assert_eq!(
            normalize_account_email("  ＭＵ̈ＬＬＥＲ＠ＥＸＡＭＰＬＥ．ＣＯＭ  ".into())
                .expect("valid email"),
            "müller@example.com"
        );
        assert!(normalize_account_email(format!("{}@example.com", "é".repeat(122))).is_err());
    }

    fn requires_zeroize_on_drop<T: zeroize::ZeroizeOnDrop>() {}

    #[test]
    fn native_pending_share_result_storage_zeroizes_when_its_handle_is_freed() {
        requires_zeroize_on_drop::<PendingShareResult>();
    }

    #[test]
    fn native_share_url_uniffi_lowering_is_wiped_before_its_rust_buffer_is_freed() {
        let pending = PendingShareResult {
            operation_id: "operation-1".into(),
            item_id: "item-1".into(),
            share_link_id: "share-link-1".into(),
            share_url: "UNIQUE_NATIVE_MARSHALLED_SHARE_URL".into(),
            expires_at: "2099-01-02T03:04:05Z".into(),
        };
        let buffer = <String as uniffi::Lower<UniFfiTag>>::lower(pending.share_url());
        let bytes = unsafe { std::slice::from_raw_parts(buffer.data_pointer(), buffer.len()) };
        assert_eq!(bytes, b"UNIQUE_NATIVE_MARSHALLED_SHARE_URL");
        let mut status = uniffi::RustCallStatus::default();

        unsafe {
            ffi_bittery_client_bindings_sensitive_rustbuffer_free(buffer, &mut status);
        }

        assert_eq!(take_sensitive_rust_buffer_free_observations(), 1);
    }

    #[test]
    fn native_vault_image_sensitive_chunk_lift_takes_the_exact_rust_buffer_allocation() {
        let buffer = <String as uniffi::Lower<UniFfiTag>>::lower("YWJj".into());
        let transferred = buffer.data_pointer();
        let chunk = <SensitiveVaultImageChunk as uniffi::Lift<UniFfiTag>>::try_lift(buffer)
            .expect("sensitive custom String lift");

        assert_eq!(chunk.0.as_ptr(), transferred);
        assert_eq!(chunk.0.as_str(), "YWJj");
    }

    #[test]
    fn binding_debug_output_redacts_every_plaintext_and_credential_field() {
        let attachment_name = AttachmentName::new("UNIQUE_OPAQUE_ATTACHMENT_NAME".into());
        let attachment_name_debug = format!("{:?}", attachment_name.as_ref());
        assert!(!attachment_name_debug.contains("UNIQUE_OPAQUE_ATTACHMENT_NAME"));

        let core_rename = core::RuntimeRequest::RenameAttachment {
            account_id: core::AccountId::from("account-1"),
            attachment_id: "attachment-1".into(),
            name: "UNIQUE_CORE_ATTACHMENT_NAME".into(),
        };
        let core_rename_debug = format!("{core_rename:?}");
        assert!(!core_rename_debug.contains("UNIQUE_CORE_ATTACHMENT_NAME"));

        let sign_in = RuntimeRequest::SignIn {
            server_url: "https://server.test".into(),
            email: "person@example.test".into(),
            master_password: SecretString::new("UNIQUE_MASTER_PASSWORD".into()),
            secret_key: SecretString::new("UNIQUE_SECRET_KEY".into()),
            insecure_transport_confirmed: false,
        };
        let quick_unlock = RuntimeRequest::QuickUnlock {
            account_id: "account-1".into(),
            master_password: SecretString::new("UNIQUE_QUICK_UNLOCK_PASSWORD".into()),
        };
        let create = RuntimeRequest::CreateItem {
            account_id: "account-1".into(),
            vault_id: "vault-1".into(),
            draft: EditableItemDraft::Login {
                value: Arc::new(EditableLoginItemData {
                    title: "UNIQUE_TITLE".into(),
                    url: Some("UNIQUE_URL".into()),
                    urls: vec!["UNIQUE_URLS".into()],
                    username: Some("UNIQUE_USERNAME".into()),
                    password: Some("UNIQUE_PASSWORD".into()),
                    password_history: vec![],
                    notes: Some("UNIQUE_NOTES".into()),
                    note: Some("UNIQUE_NOTE".into()),
                    custom_fields: vec![CustomField::new(
                        "UNIQUE_FIELD_ID".into(),
                        "UNIQUE_FIELD_LABEL".into(),
                        "UNIQUE_FIELD_VALUE".into(),
                        CustomFieldKind::Password,
                    )],
                    tags: vec!["UNIQUE_TAG".into()],
                    totp_secret: None,
                    totp_issuer: None,
                    totp_account_name: None,
                    totp_algorithm: None,
                    totp_digits: None,
                    totp_period: None,
                }),
            },
        };
        let rename = RuntimeRequest::RenameAttachment {
            account_id: "account-1".into(),
            attachment_id: "attachment-1".into(),
            name: AttachmentName::new("UNIQUE_ATTACHMENT_NAME".into()),
        };
        let projection = RuntimeProjection::Items {
            value: ItemsProjection {
                account_id: "account-1".into(),
                replica_revision: 1,
                items: vec![Arc::new(ItemProjection {
                    account_id: "account-1".into(),
                    item_id: "item-1".into(),
                    vault_id: "vault-1".into(),
                    data: PublicItemDraft::Login {
                        value: Arc::new(PublicLoginItemData {
                            editable: Arc::new(EditableLoginItemData {
                                title: "UNIQUE_PROJECTION_TITLE".into(),
                                url: Some("UNIQUE_PROJECTION_URL".into()),
                                urls: vec!["UNIQUE_PROJECTION_URLS".into()],
                                username: Some("UNIQUE_PROJECTION_USERNAME".into()),
                                password: Some("UNIQUE_PROJECTION_PASSWORD".into()),
                                password_history: vec![],
                                notes: Some("UNIQUE_PROJECTION_NOTES".into()),
                                note: Some("UNIQUE_PROJECTION_NOTE".into()),
                                custom_fields: vec![],
                                tags: vec![],
                                totp_secret: None,
                                totp_issuer: None,
                                totp_account_name: None,
                                totp_algorithm: None,
                                totp_digits: None,
                                totp_period: None,
                            }),
                            passkeys: vec![],
                        }),
                    },
                    favorite: true,
                    deleted_at: None,
                    attachments: vec![],
                    created_at: "2026-08-23T00:00:00Z".into(),
                    updated_at: "2026-08-23T00:00:00Z".into(),
                    status: ItemProjectionStatus::Pending,
                    edit_guard: None,
                    duplicate_source_guard: None,
                })],
                vaults: vec![VaultProjection {
                    vault_id: "vault-1".into(),
                    name: "Personal".into(),
                    vault_type: VaultProjectionType::Personal,
                    icon: None,
                    image_url: None,
                    role: VaultProjectionRole::Owner,
                }],
            },
        };
        let pending_share = RuntimeProjection::PendingShareResults {
            value: PendingShareResultsProjection {
                account_id: "account-1".into(),
                replica_revision: 2,
                results: vec![Arc::new(PendingShareResult {
                    operation_id: "operation-1".into(),
                    item_id: "item-1".into(),
                    share_link_id: "share-link-1".into(),
                    share_url: "UNIQUE_PENDING_SHARE_URL".into(),
                    expires_at: "2099-01-02T03:04:05Z".into(),
                })],
            },
        };

        let output = format!(
            "{sign_in:?} {quick_unlock:?} {create:?} {rename:?} {projection:?} {pending_share:?}"
        );
        for marker in [
            "UNIQUE_MASTER_PASSWORD",
            "UNIQUE_SECRET_KEY",
            "UNIQUE_QUICK_UNLOCK_PASSWORD",
            "UNIQUE_TITLE",
            "UNIQUE_URL",
            "UNIQUE_URLS",
            "UNIQUE_USERNAME",
            "UNIQUE_PASSWORD",
            "UNIQUE_NOTES",
            "UNIQUE_NOTE",
            "UNIQUE_FIELD_ID",
            "UNIQUE_FIELD_LABEL",
            "UNIQUE_FIELD_VALUE",
            "UNIQUE_TAG",
            "UNIQUE_ATTACHMENT_NAME",
            "UNIQUE_PROJECTION_TITLE",
            "UNIQUE_PROJECTION_URL",
            "UNIQUE_PROJECTION_URLS",
            "UNIQUE_PROJECTION_USERNAME",
            "UNIQUE_PROJECTION_PASSWORD",
            "UNIQUE_PROJECTION_NOTES",
            "UNIQUE_PROJECTION_NOTE",
            "UNIQUE_PENDING_SHARE_URL",
        ] {
            assert!(!output.contains(marker), "debug output leaked {marker}");
        }
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct OperationsProjection {
    pub account_id: String,
    pub replica_revision: u64,
    pub operations: Vec<OperationProjection>,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct OperationProjection {
    pub operation_id: String,
    pub kind: OperationProjectionKind,
    pub attempt_count: Option<String>,
    pub next_attempt_at_ms: Option<String>,
    pub resolution: OperationResolution,
    pub imported_count: Option<u16>,
    pub rejection_code: Option<String>,
    pub cross_account_move: Option<CrossAccountMoveProjection>,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct CrossAccountMoveProjection {
    pub phase: CrossAccountMovePhase,
    pub destination_server_url: String,
    pub destination_user_id: String,
    pub destination_vault_id: String,
    pub source_visible: bool,
    pub disposition: CrossAccountMoveDisposition,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct CrossAccountMoveResumeGuard {
    pub account_id: String,
    pub source_incarnation: String,
    pub source_lock_epoch: u64,
    pub target_account_id: String,
    pub target_incarnation: String,
    pub target_lock_epoch: u64,
    pub operation_id: String,
    pub binding_revision: u64,
    pub source_replica_revision: u64,
    pub owner_incarnation: String,
}

impl From<core::CrossAccountMoveResumeGuard> for CrossAccountMoveResumeGuard {
    fn from(value: core::CrossAccountMoveResumeGuard) -> Self {
        Self {
            account_id: value.account_id.into(),
            source_incarnation: value.source_incarnation.as_str().to_owned(),
            source_lock_epoch: value.source_lock_epoch,
            target_account_id: value.target_account_id.into(),
            target_incarnation: value.target_incarnation.as_str().to_owned(),
            target_lock_epoch: value.target_lock_epoch,
            operation_id: value.operation_id,
            binding_revision: value.binding_revision,
            source_replica_revision: value.source_replica_revision,
            owner_incarnation: value.owner_incarnation,
        }
    }
}

impl From<CrossAccountMoveResumeGuard> for core::CrossAccountMoveResumeGuard {
    fn from(value: CrossAccountMoveResumeGuard) -> Self {
        Self {
            account_id: value.account_id.into(),
            source_incarnation: value.source_incarnation.into(),
            source_lock_epoch: value.source_lock_epoch,
            target_account_id: value.target_account_id.into(),
            target_incarnation: value.target_incarnation.into(),
            target_lock_epoch: value.target_lock_epoch,
            operation_id: value.operation_id,
            binding_revision: value.binding_revision,
            source_replica_revision: value.source_replica_revision,
            owner_incarnation: value.owner_incarnation,
        }
    }
}
#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum CrossAccountMovePhase {
    TargetCreate,
    Attachments { next_index: u32 },
    SourceTrash,
    SourceDelete,
    Completed,
    Rejected,
}
#[derive(Clone, Debug, uniffi::Enum)]
pub enum CrossAccountMoveDisposition {
    Ready,
    LegacyHeld,
    Waiting {
        reason: CrossAccountMoveWaitingReason,
    },
    Blocked {
        reason: CrossAccountMoveBlockedReason,
    },
    Rejected {
        code: String,
    },
}
#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum CrossAccountMoveWaitingReason {
    AccountLocked,
    Offline,
    PolicyVerificationPending,
    AccessUnavailable,
    AttachmentAccessDenied,
    AttachmentQuotaExceeded,
    AttachmentSizeRejected,
}
#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum CrossAccountMoveBlockedReason {
    DestinationRetired,
    SourceChanged,
    TargetChanged,
    MissingProof,
    MissingArtifact,
    MissingSourceEvidence,
}
impl From<core::CrossAccountMoveProjection> for CrossAccountMoveProjection {
    fn from(value: core::CrossAccountMoveProjection) -> Self {
        Self {
            phase: value.phase.into(),
            destination_server_url: value.destination_server_url,
            destination_user_id: value.destination_user_id,
            destination_vault_id: value.destination_vault_id,
            source_visible: value.source_visible,
            disposition: value.disposition.into(),
        }
    }
}
impl From<core::CrossAccountMovePhase> for CrossAccountMovePhase {
    fn from(value: core::CrossAccountMovePhase) -> Self {
        match value {
            core::CrossAccountMovePhase::TargetCreate => Self::TargetCreate,
            core::CrossAccountMovePhase::Attachments { next_index } => {
                Self::Attachments { next_index }
            }
            core::CrossAccountMovePhase::SourceTrash => Self::SourceTrash,
            core::CrossAccountMovePhase::SourceDelete => Self::SourceDelete,
            core::CrossAccountMovePhase::Completed => Self::Completed,
            core::CrossAccountMovePhase::Rejected => Self::Rejected,
        }
    }
}
impl From<core::CrossAccountMoveDisposition> for CrossAccountMoveDisposition {
    fn from(value: core::CrossAccountMoveDisposition) -> Self {
        match value {
            core::CrossAccountMoveDisposition::Ready => Self::Ready,
            core::CrossAccountMoveDisposition::LegacyHeld => Self::LegacyHeld,
            core::CrossAccountMoveDisposition::Waiting { reason } => Self::Waiting {
                reason: reason.into(),
            },
            core::CrossAccountMoveDisposition::Blocked { reason } => Self::Blocked {
                reason: reason.into(),
            },
            core::CrossAccountMoveDisposition::Rejected { code } => Self::Rejected { code },
        }
    }
}
impl From<core::CrossAccountMoveWaitingReason> for CrossAccountMoveWaitingReason {
    fn from(value: core::CrossAccountMoveWaitingReason) -> Self {
        match value {
            core::CrossAccountMoveWaitingReason::AccountLocked => Self::AccountLocked,
            core::CrossAccountMoveWaitingReason::Offline => Self::Offline,
            core::CrossAccountMoveWaitingReason::PolicyVerificationPending => {
                Self::PolicyVerificationPending
            }
            core::CrossAccountMoveWaitingReason::AccessUnavailable => Self::AccessUnavailable,
            core::CrossAccountMoveWaitingReason::AttachmentAccessDenied => {
                Self::AttachmentAccessDenied
            }
            core::CrossAccountMoveWaitingReason::AttachmentQuotaExceeded => {
                Self::AttachmentQuotaExceeded
            }
            core::CrossAccountMoveWaitingReason::AttachmentSizeRejected => {
                Self::AttachmentSizeRejected
            }
        }
    }
}
impl From<core::CrossAccountMoveBlockedReason> for CrossAccountMoveBlockedReason {
    fn from(value: core::CrossAccountMoveBlockedReason) -> Self {
        match value {
            core::CrossAccountMoveBlockedReason::DestinationRetired => Self::DestinationRetired,
            core::CrossAccountMoveBlockedReason::SourceChanged => Self::SourceChanged,
            core::CrossAccountMoveBlockedReason::TargetChanged => Self::TargetChanged,
            core::CrossAccountMoveBlockedReason::MissingProof => Self::MissingProof,
            core::CrossAccountMoveBlockedReason::MissingArtifact => Self::MissingArtifact,
            core::CrossAccountMoveBlockedReason::MissingSourceEvidence => {
                Self::MissingSourceEvidence
            }
        }
    }
}
#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum OperationResolution {
    Pending,
    Applied,
    Rejected,
    LegacyFailed,
    LegacyConflicted,
}
#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum OperationProjectionKind {
    CreateVault,
    UpdateVault,
    DeleteVault,
    CreateItem,
    UpdateItem,
    SetItemFavorite,
    TrashItem,
    RestoreItem,
    MoveItem,
    PermanentlyDeleteItem,
    CreateShare,
    ImportItems,
    CreateVaultMemberRemovalRotationPlans,
    FinalizeVaultMemberRemovalRotationPlans,
    CreateTeamLeaveRotationPlans,
    FinalizeTeamLeaveRotationPlans,
    CreateTeamMemberRemovalRotationPlans,
    FinalizeTeamMemberRemovalRotationPlans,
}
impl From<core::OperationsProjection> for OperationsProjection {
    fn from(value: core::OperationsProjection) -> Self {
        Self {
            account_id: value.account_id.as_str().to_owned(),
            replica_revision: value.replica_revision,
            operations: value
                .operations
                .into_iter()
                .map(|op| OperationProjection {
                    operation_id: op.operation_id,
                    kind: op.kind.into(),
                    attempt_count: op.attempt_count,
                    next_attempt_at_ms: op.next_attempt_at_ms,
                    resolution: match op.resolution {
                        core::OperationResolution::Pending => OperationResolution::Pending,
                        core::OperationResolution::Applied => OperationResolution::Applied,
                        core::OperationResolution::Rejected => OperationResolution::Rejected,
                        core::OperationResolution::LegacyFailed => {
                            OperationResolution::LegacyFailed
                        }
                        core::OperationResolution::LegacyConflicted => {
                            OperationResolution::LegacyConflicted
                        }
                    },
                    imported_count: op.imported_count,
                    rejection_code: op.rejection_code,
                    cross_account_move: op.cross_account_move.map(Into::into),
                })
                .collect(),
        }
    }
}
impl From<core::OperationProjectionKind> for OperationProjectionKind {
    fn from(value: core::OperationProjectionKind) -> Self {
        match value {
            core::OperationProjectionKind::CreateVault => Self::CreateVault,
            core::OperationProjectionKind::UpdateVault => Self::UpdateVault,
            core::OperationProjectionKind::DeleteVault => Self::DeleteVault,
            core::OperationProjectionKind::CreateItem => Self::CreateItem,
            core::OperationProjectionKind::UpdateItem => Self::UpdateItem,
            core::OperationProjectionKind::SetItemFavorite => Self::SetItemFavorite,
            core::OperationProjectionKind::TrashItem => Self::TrashItem,
            core::OperationProjectionKind::RestoreItem => Self::RestoreItem,
            core::OperationProjectionKind::MoveItem => Self::MoveItem,
            core::OperationProjectionKind::PermanentlyDeleteItem => Self::PermanentlyDeleteItem,
            core::OperationProjectionKind::CreateShare => Self::CreateShare,
            core::OperationProjectionKind::ImportItems => Self::ImportItems,
            core::OperationProjectionKind::CreateVaultMemberRemovalRotationPlans => {
                Self::CreateVaultMemberRemovalRotationPlans
            }
            core::OperationProjectionKind::FinalizeVaultMemberRemovalRotationPlans => {
                Self::FinalizeVaultMemberRemovalRotationPlans
            }
            core::OperationProjectionKind::CreateTeamLeaveRotationPlans => {
                Self::CreateTeamLeaveRotationPlans
            }
            core::OperationProjectionKind::FinalizeTeamLeaveRotationPlans => {
                Self::FinalizeTeamLeaveRotationPlans
            }
            core::OperationProjectionKind::CreateTeamMemberRemovalRotationPlans => {
                Self::CreateTeamMemberRemovalRotationPlans
            }
            core::OperationProjectionKind::FinalizeTeamMemberRemovalRotationPlans => {
                Self::FinalizeTeamMemberRemovalRotationPlans
            }
        }
    }
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum RecoveryClassification {
    Complete,
    Partial,
}
impl From<core::RecoveryClassification> for RecoveryClassification {
    fn from(value: core::RecoveryClassification) -> Self {
        match value {
            core::RecoveryClassification::Complete => Self::Complete,
            core::RecoveryClassification::Partial => Self::Partial,
        }
    }
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum RecoveryMaintenanceStatus {
    Available,
    Unsupported,
    Busy,
    Unavailable,
}
#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum RecoverySchemaStatus {
    Supported,
    Unsupported,
    Unknown,
}
impl From<core::RecoverySchemaStatus> for RecoverySchemaStatus {
    fn from(value: core::RecoverySchemaStatus) -> Self {
        match value {
            core::RecoverySchemaStatus::Supported => Self::Supported,
            core::RecoverySchemaStatus::Unsupported => Self::Unsupported,
            core::RecoverySchemaStatus::Unknown => Self::Unknown,
        }
    }
}
impl From<core::RecoveryMaintenanceStatus> for RecoveryMaintenanceStatus {
    fn from(value: core::RecoveryMaintenanceStatus) -> Self {
        match value {
            core::RecoveryMaintenanceStatus::Available => Self::Available,
            core::RecoveryMaintenanceStatus::Unsupported => Self::Unsupported,
            core::RecoveryMaintenanceStatus::Busy => Self::Busy,
            core::RecoveryMaintenanceStatus::Unavailable => Self::Unavailable,
        }
    }
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum RecoveryDeviceStatus {
    FreshOrUnknown,
    KnownAccounts,
    StorageUnavailable,
}
impl From<core::RecoveryDeviceStatus> for RecoveryDeviceStatus {
    fn from(value: core::RecoveryDeviceStatus) -> Self {
        match value {
            core::RecoveryDeviceStatus::FreshOrUnknown => Self::FreshOrUnknown,
            core::RecoveryDeviceStatus::KnownAccounts => Self::KnownAccounts,
            core::RecoveryDeviceStatus::StorageUnavailable => Self::StorageUnavailable,
        }
    }
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum RecoveryStorageState {
    Ready,
    Corrupt,
    Missing,
    Unknown,
    Unreadable,
}
impl From<core::RecoveryStorageState> for RecoveryStorageState {
    fn from(value: core::RecoveryStorageState) -> Self {
        match value {
            core::RecoveryStorageState::Ready => Self::Ready,
            core::RecoveryStorageState::Corrupt => Self::Corrupt,
            core::RecoveryStorageState::Missing => Self::Missing,
            core::RecoveryStorageState::Unknown => Self::Unknown,
            core::RecoveryStorageState::Unreadable => Self::Unreadable,
        }
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct StorageRecoveryDiagnostics {
    pub failure: Option<RuntimeErrorCode>,
    pub maintenance: RecoveryMaintenanceStatus,
    pub schema: RecoverySchemaStatus,
    pub device: RecoveryDeviceStatus,
    pub accounts: Vec<StorageRecoveryAccount>,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct StorageRecoveryAccount {
    pub email: Option<String>,
    pub server_url: Option<String>,
    pub user_id: Option<String>,
    pub can_rebootstrap: bool,
    pub account_id: String,
    pub state: RecoveryStorageState,
    pub operation_count: Option<u32>,
    pub receipt_count: Option<u32>,
    pub missing_artifacts: Option<u32>,
    pub can_export: bool,
    pub can_repair: bool,
}
impl From<core::StorageRecoveryDiagnostics> for StorageRecoveryDiagnostics {
    fn from(value: core::StorageRecoveryDiagnostics) -> Self {
        Self {
            failure: value.failure.map(Into::into),
            maintenance: value.maintenance.into(),
            schema: value.schema.into(),
            device: value.device.into(),
            accounts: value.accounts.into_iter().map(Into::into).collect(),
        }
    }
}
impl From<core::StorageRecoveryAccount> for StorageRecoveryAccount {
    fn from(value: core::StorageRecoveryAccount) -> Self {
        Self {
            email: value.email,
            server_url: value.server_url,
            user_id: value.user_id,
            can_rebootstrap: value.can_rebootstrap,
            account_id: value.account_id.into(),
            state: value.state.into(),
            operation_count: value.operation_count,
            receipt_count: value.receipt_count,
            missing_artifacts: value.missing_artifacts,
            can_export: value.can_export,
            can_repair: value.can_repair,
        }
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct DeviceSetupDisclosure {
    pub account_id: String,
    pub incarnation: String,
    pub lock_epoch: u64,
    pub email: String,
    pub server_url: String,
    pub team_name: Option<String>,
    pub secret_key: Arc<SecretString>,
}
impl From<core::DeviceSetupDisclosure> for DeviceSetupDisclosure {
    fn from(value: core::DeviceSetupDisclosure) -> Self {
        Self {
            account_id: value.account_id.as_str().to_owned(),
            incarnation: value.incarnation.as_str().to_owned(),
            lock_epoch: value.lock_epoch,
            email: value.email.clone(),
            server_url: value.server_url.clone(),
            team_name: value.team_name.clone(),
            secret_key: SecretString::new(value.secret_key.to_string()),
        }
    }
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum ActivityKind {
    Interaction,
    Focus,
    Blur,
}

#[cfg(test)]
mod profile_admission_binding_tests {
    use super::*;

    #[test]
    fn inspection_and_abort_keep_the_exact_catalog_identity() {
        assert!(matches!(
            core::RuntimeRequest::from(RuntimeRequest::InspectProfileAdmission),
            core::RuntimeRequest::InspectProfileAdmission {}
        ));
        let request = RuntimeRequest::AbortProfileAdmission {
            admission_id: "admission-opaque".into(),
        };
        assert!(!format!("{request:?}").contains("admission-opaque"));
        assert!(
            matches!(core::RuntimeRequest::from(request), core::RuntimeRequest::AbortProfileAdmission { admission_id } if admission_id == "admission-opaque")
        );
        assert!(
            matches!(RuntimeResponse::from(core::RuntimeResponse::ProfileAdmissionAborted { admission_id: "admission-opaque".into() }), RuntimeResponse::ProfileAdmissionAborted { admission_id } if admission_id == "admission-opaque")
        );
        for phase in [
            core::ProfileAdmissionImportPhase::Preparing,
            core::ProfileAdmissionImportPhase::Aborting,
            core::ProfileAdmissionImportPhase::Aborted,
            core::ProfileAdmissionImportPhase::Committed,
            core::ProfileAdmissionImportPhase::Complete,
        ] {
            let response =
                RuntimeResponse::from(core::RuntimeResponse::ProfileAdmissionInspection {
                    state: core::ProfileAdmissionInspectionState::Import {
                        admission_id: "admission".into(),
                        phase,
                    },
                });
            assert!(
                matches!(response, RuntimeResponse::ProfileAdmissionInspection { state: ProfileAdmissionInspectionState::Import { admission_id, phase: actual } } if admission_id == "admission" && format!("{actual:?}") == format!("{phase:?}"))
            );
        }
        for phase in [
            core::ProfileAdmissionResetPhase::Wiping,
            core::ProfileAdmissionResetPhase::Wiped,
        ] {
            let response =
                RuntimeResponse::from(core::RuntimeResponse::ProfileAdmissionInspection {
                    state: core::ProfileAdmissionInspectionState::Reset {
                        wipe_id: "wipe".into(),
                        phase,
                    },
                });
            assert!(
                matches!(response, RuntimeResponse::ProfileAdmissionInspection { state: ProfileAdmissionInspectionState::Reset { wipe_id, phase: actual } } if wipe_id == "wipe" && format!("{actual:?}") == format!("{phase:?}"))
            );
        }
        assert!(matches!(
            RuntimeResponse::from(core::RuntimeResponse::ProfileAdmissionInspection {
                state: core::ProfileAdmissionInspectionState::NotStarted {}
            }),
            RuntimeResponse::ProfileAdmissionInspection {
                state: ProfileAdmissionInspectionState::NotStarted
            }
        ));
    }

    #[test]
    fn cleanup_projection_preserves_pending_even_with_zero_obligations() {
        for count in [0, u64::MAX] {
            let projection = RuntimeStatusProjection::from(core::RuntimeStatusProjection {
                account_id: None,
                revision: 7,
                accounts: Vec::new(),
                closed: false,
                profile_admission_cleanup: Some(core::ProfileAdmissionCleanupStatus::Pending {
                    pending_obligations: count,
                }),
            });
            assert!(
                matches!(projection.profile_admission_cleanup, Some(ProfileAdmissionCleanupStatus::Pending { pending_obligations }) if pending_obligations == count)
            );
        }
        let projection = RuntimeStatusProjection::from(core::RuntimeStatusProjection {
            account_id: None,
            revision: 8,
            accounts: Vec::new(),
            closed: true,
            profile_admission_cleanup: None,
        });
        assert!(projection.profile_admission_cleanup.is_none());
    }
}
impl From<ActivityKind> for core::ActivityKind {
    fn from(value: ActivityKind) -> Self {
        match value {
            ActivityKind::Interaction => Self::Interaction,
            ActivityKind::Focus => Self::Focus,
            ActivityKind::Blur => Self::Blur,
        }
    }
}
