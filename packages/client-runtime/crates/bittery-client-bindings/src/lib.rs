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

#[derive(uniffi::Object)]
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

#[derive(Clone, uniffi::Enum)]
pub enum RuntimeRequest {
    SignIn {
        server_url: String,
        email: String,
        master_password: Arc<SecretString>,
        secret_key: Arc<SecretString>,
        insecure_transport_confirmed: bool,
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
    CreateItem {
        account_id: String,
        vault_id: String,
        draft: ItemDraft,
    },
    UpdateItem {
        account_id: String,
        item_id: String,
        draft: ItemDraft,
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

impl fmt::Debug for RuntimeRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SignIn {
                server_url, email, ..
            } => formatter
                .debug_struct("SignIn")
                .field("server_url", server_url)
                .field("email", email)
                .field("credentials", &"[redacted]")
                .finish(),
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
            Self::UpdateItem {
                account_id,
                item_id,
                draft,
            } => formatter
                .debug_struct("UpdateItem")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("draft", draft)
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
            } => formatter
                .debug_struct("MoveItem")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("target_vault_id", target_vault_id)
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

#[derive(Clone, Debug, uniffi::Enum)]
pub enum RuntimeResponse {
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
    ShareResultAcknowledged {
        account_id: String,
        operation_id: String,
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
    Items { account_id: String },
    PendingShareResults { account_id: String },
    RuntimeStatus { account_id: Option<String> },
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
    data: ItemDraft,
    favorite: bool,
    deleted_at: Option<String>,
    attachments: Vec<Arc<AttachmentProjection>>,
    created_at: String,
    updated_at: String,
    status: ItemProjectionStatus,
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
    pub fn data(&self) -> ItemDraft {
        self.data.clone()
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
    RuntimeClosed,
    Cancelled,
    AccountMissing,
    AccountAlreadyInstalled,
    AccountFailed,
    AuthenticationRequired,
    AuthenticationUnavailable,
    RetryableTransport,
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
pub struct AccountDisplayIdentity {
    pub email: String,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct AccountStatus {
    pub account_id: String,
    pub replica_revision: u64,
    pub access: AccountAccessState,
    pub waiting_reason: Option<AccountWaitingReason>,
    pub failure: Option<RuntimeErrorCode>,
    pub display_identity: Option<AccountDisplayIdentity>,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct RuntimeStatusProjection {
    pub account_id: Option<String>,
    pub revision: u64,
    pub accounts: Vec<AccountStatus>,
    pub closed: bool,
}

#[derive(Clone, uniffi::Enum)]
pub enum RuntimeProjection {
    Items {
        value: ItemsProjection,
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
            Self::Items { value } => formatter.debug_tuple("Items").field(value).finish(),
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

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum BindingError {
    #[error("Runtime request failed: {message}")]
    Runtime {
        code: RuntimeErrorCode,
        message: String,
    },
}

#[cfg(not(target_arch = "wasm32"))]
#[uniffi::export(with_foreign)]
pub trait ObservationSink: Send + Sync {
    fn publish(&self, projection: RuntimeProjection);
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
        self.inner
            .request(request.into(), core::RequestCancellation::new())
            .await
            .map(Into::into)
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
    pub fn close(&self) {
        self.inner.close();
    }
}

impl From<RuntimeRequest> for core::RuntimeRequest {
    fn from(value: RuntimeRequest) -> Self {
        match value {
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
            RuntimeRequest::CreateItem {
                account_id,
                vault_id,
                draft,
            } => Self::CreateItem {
                account_id: account_id.into(),
                vault_id,
                draft: draft.to_core(),
            },
            RuntimeRequest::UpdateItem {
                account_id,
                item_id,
                draft,
            } => Self::UpdateItem {
                account_id: account_id.into(),
                item_id,
                draft: draft.to_core(),
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
            } => Self::MoveItem {
                account_id: account_id.into(),
                item_id,
                target_vault_id,
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
            ObservationRequest::Items { account_id } => Self::Items {
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

impl From<core::RuntimeResponse> for RuntimeResponse {
    fn from(value: core::RuntimeResponse) -> Self {
        match value {
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
            core::RuntimeResponse::ShareResultAcknowledged {
                account_id,
                operation_id,
            } => Self::ShareResultAcknowledged {
                account_id: account_id.into(),
                operation_id,
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
            core::RuntimeProjection::Items(value) => Self::Items {
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
        } = value;
        Self {
            account_id: account_id.into(),
            item_id,
            vault_id,
            data: item_draft_from_core(data),
            favorite,
            deleted_at,
            attachments: attachments
                .into_iter()
                .map(|attachment| Arc::new(AttachmentProjection::from(attachment)))
                .collect(),
            created_at,
            updated_at,
            status: status.into(),
        }
    }
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
        } = value;
        Self {
            account_id: account_id.map(Into::into),
            revision,
            accounts: accounts.into_iter().map(Into::into).collect(),
            closed,
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
        } = value;
        Self {
            account_id: account_id.into(),
            replica_revision,
            access: access.into(),
            waiting_reason: waiting_reason.map(Into::into),
            failure: failure.map(Into::into),
            display_identity: display_identity.map(Into::into),
        }
    }
}

impl From<core::AccountDisplayIdentity> for AccountDisplayIdentity {
    fn from(value: core::AccountDisplayIdentity) -> Self {
        Self { email: value.email }
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
            core::RuntimeErrorCode::RuntimeClosed => Self::RuntimeClosed,
            core::RuntimeErrorCode::Cancelled => Self::Cancelled,
            core::RuntimeErrorCode::AccountMissing => Self::AccountMissing,
            core::RuntimeErrorCode::AccountAlreadyInstalled => Self::AccountAlreadyInstalled,
            core::RuntimeErrorCode::AccountFailed => Self::AccountFailed,
            core::RuntimeErrorCode::AuthenticationRequired => Self::AuthenticationRequired,
            core::RuntimeErrorCode::AuthenticationUnavailable => Self::AuthenticationUnavailable,
            core::RuntimeErrorCode::RetryableTransport => Self::RetryableTransport,
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

impl From<core::RuntimeError> for BindingError {
    fn from(value: core::RuntimeError) -> Self {
        Self::Runtime {
            code: value.code.into(),
            message: value.message,
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
            draft: ItemDraft::Login {
                value: Arc::new(LoginItemData {
                    title: "UNIQUE_TITLE".into(),
                    url: Some("UNIQUE_URL".into()),
                    urls: vec!["UNIQUE_URLS".into()],
                    username: Some("UNIQUE_USERNAME".into()),
                    password: Some("UNIQUE_PASSWORD".into()),
                    password_history: vec![],
                    passkeys: vec![],
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
                    data: ItemDraft::Login {
                        value: Arc::new(LoginItemData {
                            title: "UNIQUE_PROJECTION_TITLE".into(),
                            url: Some("UNIQUE_PROJECTION_URL".into()),
                            urls: vec!["UNIQUE_PROJECTION_URLS".into()],
                            username: Some("UNIQUE_PROJECTION_USERNAME".into()),
                            password: Some("UNIQUE_PROJECTION_PASSWORD".into()),
                            password_history: vec![],
                            passkeys: vec![],
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
                    },
                    favorite: true,
                    deleted_at: None,
                    attachments: vec![],
                    created_at: "2026-08-23T00:00:00Z".into(),
                    updated_at: "2026-08-23T00:00:00Z".into(),
                    status: ItemProjectionStatus::Pending,
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
