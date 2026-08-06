#[allow(unused_imports)]
use uniffi_runtime_javascript::{self as js, uniffi as u, IntoJs, IntoRust};
use wasm_bindgen::prelude::wasm_bindgen;
extern "C" {
    fn uniffi_bittery_crypto_api_fn_clone_keyhandle(
        handle: u64,
        status_: &mut u::RustCallStatus,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_free_keyhandle(
        handle: u64,
        status_: &mut u::RustCallStatus,
    );
    fn uniffi_bittery_crypto_api_fn_method_keyhandle_destroy(ptr: u64) -> u64;
    fn uniffi_bittery_crypto_api_fn_clone_srpclient(
        handle: u64,
        status_: &mut u::RustCallStatus,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_free_srpclient(
        handle: u64,
        status_: &mut u::RustCallStatus,
    );
    fn uniffi_bittery_crypto_api_fn_constructor_srpclient_new(
        status_: &mut u::RustCallStatus,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_method_srpclient_derive_safe_private_key(
        ptr: u64,
        salt: u::RustBuffer,
        password: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_method_srpclient_derive_verifier(
        ptr: u64,
        private_key: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_method_srpclient_generate_salt(ptr: u64) -> u64;
    fn uniffi_bittery_crypto_api_fn_clone_srpserver(
        handle: u64,
        status_: &mut u::RustCallStatus,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_free_srpserver(
        handle: u64,
        status_: &mut u::RustCallStatus,
    );
    fn uniffi_bittery_crypto_api_fn_constructor_srpserver_new(
        status_: &mut u::RustCallStatus,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_method_srpserver_generate_ephemeral(
        ptr: u64,
        verifier: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_build_passkey_attestation_object(
        rp_id: u::RustBuffer,
        credential_id_base64: u::RustBuffer,
        cose_public_key_base64: u::RustBuffer,
        sign_count: u32,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_clone_key(key: u64) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_decrypt(
        data: u::RustBuffer,
        key: u64,
        context: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_decrypt_many(requests: u::RustBuffer) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_decrypt_master_key(
        data: u::RustBuffer,
        recovery_key: u::RustBuffer,
        email: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_decrypt_rsa_wrapped_key(
        ciphertext: u::RustBuffer,
        encrypted_private_key: u::RustBuffer,
        private_key_wrapping_key: u64,
        private_key_context: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_derive_client_session(
        client_ephemeral_secret: u::RustBuffer,
        challenge: u::RustBuffer,
        password: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_derive_keys(
        account_password: u::RustBuffer,
        secret_key: u::RustBuffer,
        email: u::RustBuffer,
        profile: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_derive_keys_from_master_key(
        master_key: u64,
        email: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_derive_master_key(
        account_password: u::RustBuffer,
        secret_key: u::RustBuffer,
        email: u::RustBuffer,
        profile: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_derive_srp_password(auth_key: u64) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_destroy_key(key: u64) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_encrypt(
        plaintext: u::RustBuffer,
        key: u64,
        context: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_encrypt_master_key(
        master_key: u64,
        recovery_key: u::RustBuffer,
        email: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_for_member(
        vault_key: u64,
        member_public_key_pem: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_with_muk(
        vault_key: u64,
        master_unlock_key: u64,
        vault_id: u::RustBuffer,
        user_id: u::RustBuffer,
        key_version: u64,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_export_key(key: u64) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_generate_client_ephemeral() -> u64;
    fn uniffi_bittery_crypto_api_fn_func_generate_encryption_key() -> u64;
    fn uniffi_bittery_crypto_api_fn_func_generate_passkey_credential_id() -> u64;
    fn uniffi_bittery_crypto_api_fn_func_generate_passkey_keypair() -> u64;
    fn uniffi_bittery_crypto_api_fn_func_generate_recovery_key() -> u64;
    fn uniffi_bittery_crypto_api_fn_func_generate_rsa_key_pair() -> u64;
    fn uniffi_bittery_crypto_api_fn_func_generate_secret_key() -> u64;
    fn uniffi_bittery_crypto_api_fn_func_generate_srp_registration(
        password: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_generate_totp(
        secret: u::RustBuffer,
        algorithm: u::RustBuffer,
        digits: u32,
        period: u64,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_generate_totp_at(
        secret: u::RustBuffer,
        algorithm: u::RustBuffer,
        digits: u32,
        period: u64,
        timestamp: u64,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_generate_uuid() -> u64;
    fn uniffi_bittery_crypto_api_fn_func_import_key(key: u::RustBuffer) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_initialize() -> u64;
    fn uniffi_bittery_crypto_api_fn_func_perform_key_rotation(
        old_vault_key: u64,
        members: u::RustBuffer,
        items: u::RustBuffer,
        vault_id: u::RustBuffer,
        key_version: u64,
        current_user_id: u::RustBuffer,
        master_unlock_key: u64,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_re_encrypt_item(
        item: u::RustBuffer,
        old_vault_key: u64,
        new_vault_key: u64,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_rsa_decrypt(
        ciphertext: u::RustBuffer,
        private_key_pem: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_rsa_encrypt(
        plaintext: u::RustBuffer,
        public_key_pem: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_sign_passkey_assertion(
        private_key_base64: u::RustBuffer,
        rp_id: u::RustBuffer,
        client_data_hash_base64: u::RustBuffer,
        sign_count: u32,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_unwrap_key(
        data: u::RustBuffer,
        wrapping_key: u64,
        context: u::RustBuffer,
        legacy_marker: u::RustBuffer,
        legacy_context: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_validate_recovery_key(
        recovery_key: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_validate_rotation_data(
        members: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_validate_secret_key(
        secret_key: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_verify_server_session(
        client_public_ephemeral: u::RustBuffer,
        session: u::RustBuffer,
        server_session_proof: u::RustBuffer,
    ) -> u64;
    fn uniffi_bittery_crypto_api_fn_func_wrap_key(key: u64, wrapping_key: u64) -> u64;
    fn ffi_bittery_crypto_api_rust_future_poll_u8(
        handle: u64,
        callback: rust_future_continuation_callback::FnSig,
        callback_data: u64,
    );
    fn ffi_bittery_crypto_api_rust_future_cancel_u8(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_free_u8(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_complete_u8(
        handle: u64,
        status_: &mut u::RustCallStatus,
    ) -> u8;
    fn ffi_bittery_crypto_api_rust_future_poll_i8(
        handle: u64,
        callback: rust_future_continuation_callback::FnSig,
        callback_data: u64,
    );
    fn ffi_bittery_crypto_api_rust_future_cancel_i8(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_free_i8(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_complete_i8(
        handle: u64,
        status_: &mut u::RustCallStatus,
    ) -> i8;
    fn ffi_bittery_crypto_api_rust_future_poll_u16(
        handle: u64,
        callback: rust_future_continuation_callback::FnSig,
        callback_data: u64,
    );
    fn ffi_bittery_crypto_api_rust_future_cancel_u16(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_free_u16(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_complete_u16(
        handle: u64,
        status_: &mut u::RustCallStatus,
    ) -> u16;
    fn ffi_bittery_crypto_api_rust_future_poll_i16(
        handle: u64,
        callback: rust_future_continuation_callback::FnSig,
        callback_data: u64,
    );
    fn ffi_bittery_crypto_api_rust_future_cancel_i16(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_free_i16(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_complete_i16(
        handle: u64,
        status_: &mut u::RustCallStatus,
    ) -> i16;
    fn ffi_bittery_crypto_api_rust_future_poll_u32(
        handle: u64,
        callback: rust_future_continuation_callback::FnSig,
        callback_data: u64,
    );
    fn ffi_bittery_crypto_api_rust_future_cancel_u32(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_free_u32(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_complete_u32(
        handle: u64,
        status_: &mut u::RustCallStatus,
    ) -> u32;
    fn ffi_bittery_crypto_api_rust_future_poll_i32(
        handle: u64,
        callback: rust_future_continuation_callback::FnSig,
        callback_data: u64,
    );
    fn ffi_bittery_crypto_api_rust_future_cancel_i32(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_free_i32(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_complete_i32(
        handle: u64,
        status_: &mut u::RustCallStatus,
    ) -> i32;
    fn ffi_bittery_crypto_api_rust_future_poll_u64(
        handle: u64,
        callback: rust_future_continuation_callback::FnSig,
        callback_data: u64,
    );
    fn ffi_bittery_crypto_api_rust_future_cancel_u64(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_free_u64(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_complete_u64(
        handle: u64,
        status_: &mut u::RustCallStatus,
    ) -> u64;
    fn ffi_bittery_crypto_api_rust_future_poll_i64(
        handle: u64,
        callback: rust_future_continuation_callback::FnSig,
        callback_data: u64,
    );
    fn ffi_bittery_crypto_api_rust_future_cancel_i64(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_free_i64(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_complete_i64(
        handle: u64,
        status_: &mut u::RustCallStatus,
    ) -> i64;
    fn ffi_bittery_crypto_api_rust_future_poll_f32(
        handle: u64,
        callback: rust_future_continuation_callback::FnSig,
        callback_data: u64,
    );
    fn ffi_bittery_crypto_api_rust_future_cancel_f32(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_free_f32(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_complete_f32(
        handle: u64,
        status_: &mut u::RustCallStatus,
    ) -> f32;
    fn ffi_bittery_crypto_api_rust_future_poll_f64(
        handle: u64,
        callback: rust_future_continuation_callback::FnSig,
        callback_data: u64,
    );
    fn ffi_bittery_crypto_api_rust_future_cancel_f64(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_free_f64(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_complete_f64(
        handle: u64,
        status_: &mut u::RustCallStatus,
    ) -> f64;
    fn ffi_bittery_crypto_api_rust_future_poll_rust_buffer(
        handle: u64,
        callback: rust_future_continuation_callback::FnSig,
        callback_data: u64,
    );
    fn ffi_bittery_crypto_api_rust_future_cancel_rust_buffer(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_free_rust_buffer(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_complete_rust_buffer(
        handle: u64,
        status_: &mut u::RustCallStatus,
    ) -> u::RustBuffer;
    fn ffi_bittery_crypto_api_rust_future_poll_void(
        handle: u64,
        callback: rust_future_continuation_callback::FnSig,
        callback_data: u64,
    );
    fn ffi_bittery_crypto_api_rust_future_cancel_void(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_free_void(handle: u64);
    fn ffi_bittery_crypto_api_rust_future_complete_void(
        handle: u64,
        status_: &mut u::RustCallStatus,
    );
    fn uniffi_bittery_crypto_api_checksum_func_build_passkey_attestation_object() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_clone_key() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_decrypt() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_decrypt_many() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_decrypt_master_key() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_decrypt_rsa_wrapped_key() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_derive_client_session() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_derive_keys() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_derive_keys_from_master_key() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_derive_master_key() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_derive_srp_password() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_destroy_key() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_encrypt() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_encrypt_master_key() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_for_member() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_with_muk() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_export_key() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_generate_client_ephemeral() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_generate_encryption_key() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_generate_passkey_credential_id() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_generate_passkey_keypair() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_generate_recovery_key() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_generate_rsa_key_pair() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_generate_secret_key() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_generate_srp_registration() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_generate_totp() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_generate_totp_at() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_generate_uuid() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_import_key() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_initialize() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_perform_key_rotation() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_re_encrypt_item() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_rsa_decrypt() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_rsa_encrypt() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_sign_passkey_assertion() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_unwrap_key() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_validate_recovery_key() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_validate_rotation_data() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_validate_secret_key() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_verify_server_session() -> u16;
    fn uniffi_bittery_crypto_api_checksum_func_wrap_key() -> u16;
    fn uniffi_bittery_crypto_api_checksum_method_keyhandle_destroy() -> u16;
    fn uniffi_bittery_crypto_api_checksum_method_srpclient_derive_safe_private_key() -> u16;
    fn uniffi_bittery_crypto_api_checksum_method_srpclient_derive_verifier() -> u16;
    fn uniffi_bittery_crypto_api_checksum_method_srpclient_generate_salt() -> u16;
    fn uniffi_bittery_crypto_api_checksum_method_srpserver_generate_ephemeral() -> u16;
    fn uniffi_bittery_crypto_api_checksum_constructor_srpclient_new() -> u16;
    fn uniffi_bittery_crypto_api_checksum_constructor_srpserver_new() -> u16;
    fn ffi_bittery_crypto_api_uniffi_contract_version() -> u32;
}
#[wasm_bindgen]
pub fn ubrn_uniffi_bittery_crypto_api_fn_clone_keyhandle(
    handle: js::Handle,
    f_status_: &mut js::RustCallStatus,
) -> js::Handle {
    let mut u_status_ = u::RustCallStatus::default();
    let value_ = unsafe {
        uniffi_bittery_crypto_api_fn_clone_keyhandle(
            u64::into_rust(handle),
            &mut u_status_,
        )
    };
    f_status_.copy_from(u_status_);
    value_.into_js()
}
#[wasm_bindgen]
pub fn ubrn_uniffi_bittery_crypto_api_fn_free_keyhandle(
    handle: js::Handle,
    f_status_: &mut js::RustCallStatus,
) {
    let mut u_status_ = u::RustCallStatus::default();
    unsafe {
        uniffi_bittery_crypto_api_fn_free_keyhandle(
            u64::into_rust(handle),
            &mut u_status_,
        )
    };
    f_status_.copy_from(u_status_);
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_method_keyhandle_destroy(
    ptr: js::Handle,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_method_keyhandle_destroy(u64::into_rust(ptr)).into_js()
}
#[wasm_bindgen]
pub fn ubrn_uniffi_bittery_crypto_api_fn_clone_srpclient(
    handle: js::Handle,
    f_status_: &mut js::RustCallStatus,
) -> js::Handle {
    let mut u_status_ = u::RustCallStatus::default();
    let value_ = unsafe {
        uniffi_bittery_crypto_api_fn_clone_srpclient(
            u64::into_rust(handle),
            &mut u_status_,
        )
    };
    f_status_.copy_from(u_status_);
    value_.into_js()
}
#[wasm_bindgen]
pub fn ubrn_uniffi_bittery_crypto_api_fn_free_srpclient(
    handle: js::Handle,
    f_status_: &mut js::RustCallStatus,
) {
    let mut u_status_ = u::RustCallStatus::default();
    unsafe {
        uniffi_bittery_crypto_api_fn_free_srpclient(
            u64::into_rust(handle),
            &mut u_status_,
        )
    };
    f_status_.copy_from(u_status_);
}
#[wasm_bindgen]
pub fn ubrn_uniffi_bittery_crypto_api_fn_constructor_srpclient_new(
    f_status_: &mut js::RustCallStatus,
) -> js::Handle {
    let mut u_status_ = u::RustCallStatus::default();
    let value_ = unsafe {
        uniffi_bittery_crypto_api_fn_constructor_srpclient_new(&mut u_status_)
    };
    f_status_.copy_from(u_status_);
    value_.into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_derive_safe_private_key(
    ptr: js::Handle,
    salt: js::ForeignBytes,
    password: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_method_srpclient_derive_safe_private_key(
            u64::into_rust(ptr),
            u::RustBuffer::into_rust(salt),
            u::RustBuffer::into_rust(password),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_derive_verifier(
    ptr: js::Handle,
    private_key: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_method_srpclient_derive_verifier(
            u64::into_rust(ptr),
            u::RustBuffer::into_rust(private_key),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_generate_salt(
    ptr: js::Handle,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_method_srpclient_generate_salt(u64::into_rust(ptr))
        .into_js()
}
#[wasm_bindgen]
pub fn ubrn_uniffi_bittery_crypto_api_fn_clone_srpserver(
    handle: js::Handle,
    f_status_: &mut js::RustCallStatus,
) -> js::Handle {
    let mut u_status_ = u::RustCallStatus::default();
    let value_ = unsafe {
        uniffi_bittery_crypto_api_fn_clone_srpserver(
            u64::into_rust(handle),
            &mut u_status_,
        )
    };
    f_status_.copy_from(u_status_);
    value_.into_js()
}
#[wasm_bindgen]
pub fn ubrn_uniffi_bittery_crypto_api_fn_free_srpserver(
    handle: js::Handle,
    f_status_: &mut js::RustCallStatus,
) {
    let mut u_status_ = u::RustCallStatus::default();
    unsafe {
        uniffi_bittery_crypto_api_fn_free_srpserver(
            u64::into_rust(handle),
            &mut u_status_,
        )
    };
    f_status_.copy_from(u_status_);
}
#[wasm_bindgen]
pub fn ubrn_uniffi_bittery_crypto_api_fn_constructor_srpserver_new(
    f_status_: &mut js::RustCallStatus,
) -> js::Handle {
    let mut u_status_ = u::RustCallStatus::default();
    let value_ = unsafe {
        uniffi_bittery_crypto_api_fn_constructor_srpserver_new(&mut u_status_)
    };
    f_status_.copy_from(u_status_);
    value_.into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_method_srpserver_generate_ephemeral(
    ptr: js::Handle,
    verifier: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_method_srpserver_generate_ephemeral(
            u64::into_rust(ptr),
            u::RustBuffer::into_rust(verifier),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_build_passkey_attestation_object(
    rp_id: js::ForeignBytes,
    credential_id_base64: js::ForeignBytes,
    cose_public_key_base64: js::ForeignBytes,
    sign_count: js::UInt32,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_build_passkey_attestation_object(
            u::RustBuffer::into_rust(rp_id),
            u::RustBuffer::into_rust(credential_id_base64),
            u::RustBuffer::into_rust(cose_public_key_base64),
            u32::into_rust(sign_count),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_clone_key(
    key: js::Handle,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_clone_key(u64::into_rust(key)).into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_decrypt(
    data: js::ForeignBytes,
    key: js::Handle,
    context: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_decrypt(
            u::RustBuffer::into_rust(data),
            u64::into_rust(key),
            u::RustBuffer::into_rust(context),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_many(
    requests: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_decrypt_many(u::RustBuffer::into_rust(requests))
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_master_key(
    data: js::ForeignBytes,
    recovery_key: js::ForeignBytes,
    email: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_decrypt_master_key(
            u::RustBuffer::into_rust(data),
            u::RustBuffer::into_rust(recovery_key),
            u::RustBuffer::into_rust(email),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_rsa_wrapped_key(
    ciphertext: js::ForeignBytes,
    encrypted_private_key: js::ForeignBytes,
    private_key_wrapping_key: js::Handle,
    private_key_context: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_decrypt_rsa_wrapped_key(
            u::RustBuffer::into_rust(ciphertext),
            u::RustBuffer::into_rust(encrypted_private_key),
            u64::into_rust(private_key_wrapping_key),
            u::RustBuffer::into_rust(private_key_context),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_derive_client_session(
    client_ephemeral_secret: js::ForeignBytes,
    challenge: js::ForeignBytes,
    password: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_derive_client_session(
            u::RustBuffer::into_rust(client_ephemeral_secret),
            u::RustBuffer::into_rust(challenge),
            u::RustBuffer::into_rust(password),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_derive_keys(
    account_password: js::ForeignBytes,
    secret_key: js::ForeignBytes,
    email: js::ForeignBytes,
    profile: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_derive_keys(
            u::RustBuffer::into_rust(account_password),
            u::RustBuffer::into_rust(secret_key),
            u::RustBuffer::into_rust(email),
            u::RustBuffer::into_rust(profile),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_derive_keys_from_master_key(
    master_key: js::Handle,
    email: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_derive_keys_from_master_key(
            u64::into_rust(master_key),
            u::RustBuffer::into_rust(email),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_derive_master_key(
    account_password: js::ForeignBytes,
    secret_key: js::ForeignBytes,
    email: js::ForeignBytes,
    profile: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_derive_master_key(
            u::RustBuffer::into_rust(account_password),
            u::RustBuffer::into_rust(secret_key),
            u::RustBuffer::into_rust(email),
            u::RustBuffer::into_rust(profile),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_derive_srp_password(
    auth_key: js::Handle,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_derive_srp_password(u64::into_rust(auth_key))
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_destroy_key(
    key: js::Handle,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_destroy_key(u64::into_rust(key)).into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_encrypt(
    plaintext: js::ForeignBytes,
    key: js::Handle,
    context: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_encrypt(
            u::RustBuffer::into_rust(plaintext),
            u64::into_rust(key),
            u::RustBuffer::into_rust(context),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_master_key(
    master_key: js::Handle,
    recovery_key: js::ForeignBytes,
    email: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_encrypt_master_key(
            u64::into_rust(master_key),
            u::RustBuffer::into_rust(recovery_key),
            u::RustBuffer::into_rust(email),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_for_member(
    vault_key: js::Handle,
    member_public_key_pem: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_for_member(
            u64::into_rust(vault_key),
            u::RustBuffer::into_rust(member_public_key_pem),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_with_muk(
    vault_key: js::Handle,
    master_unlock_key: js::Handle,
    vault_id: js::ForeignBytes,
    user_id: js::ForeignBytes,
    key_version: js::UInt64,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_with_muk(
            u64::into_rust(vault_key),
            u64::into_rust(master_unlock_key),
            u::RustBuffer::into_rust(vault_id),
            u::RustBuffer::into_rust(user_id),
            u64::into_rust(key_version),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_export_key(
    key: js::Handle,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_export_key(u64::into_rust(key)).into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_generate_client_ephemeral() -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_generate_client_ephemeral().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_generate_encryption_key() -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_generate_encryption_key().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_generate_passkey_credential_id() -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_generate_passkey_credential_id().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_generate_passkey_keypair() -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_generate_passkey_keypair().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_generate_recovery_key() -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_generate_recovery_key().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_generate_rsa_key_pair() -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_generate_rsa_key_pair().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_generate_secret_key() -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_generate_secret_key().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_generate_srp_registration(
    password: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_generate_srp_registration(
            u::RustBuffer::into_rust(password),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_generate_totp(
    secret: js::ForeignBytes,
    algorithm: js::ForeignBytes,
    digits: js::UInt32,
    period: js::UInt64,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_generate_totp(
            u::RustBuffer::into_rust(secret),
            u::RustBuffer::into_rust(algorithm),
            u32::into_rust(digits),
            u64::into_rust(period),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_generate_totp_at(
    secret: js::ForeignBytes,
    algorithm: js::ForeignBytes,
    digits: js::UInt32,
    period: js::UInt64,
    timestamp: js::UInt64,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_generate_totp_at(
            u::RustBuffer::into_rust(secret),
            u::RustBuffer::into_rust(algorithm),
            u32::into_rust(digits),
            u64::into_rust(period),
            u64::into_rust(timestamp),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_generate_uuid() -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_generate_uuid().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_import_key(
    key: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_import_key(u::RustBuffer::into_rust(key)).into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_initialize() -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_initialize().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_perform_key_rotation(
    old_vault_key: js::Handle,
    members: js::ForeignBytes,
    items: js::ForeignBytes,
    vault_id: js::ForeignBytes,
    key_version: js::UInt64,
    current_user_id: js::ForeignBytes,
    master_unlock_key: js::Handle,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_perform_key_rotation(
            u64::into_rust(old_vault_key),
            u::RustBuffer::into_rust(members),
            u::RustBuffer::into_rust(items),
            u::RustBuffer::into_rust(vault_id),
            u64::into_rust(key_version),
            u::RustBuffer::into_rust(current_user_id),
            u64::into_rust(master_unlock_key),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_re_encrypt_item(
    item: js::ForeignBytes,
    old_vault_key: js::Handle,
    new_vault_key: js::Handle,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_re_encrypt_item(
            u::RustBuffer::into_rust(item),
            u64::into_rust(old_vault_key),
            u64::into_rust(new_vault_key),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_rsa_decrypt(
    ciphertext: js::ForeignBytes,
    private_key_pem: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_rsa_decrypt(
            u::RustBuffer::into_rust(ciphertext),
            u::RustBuffer::into_rust(private_key_pem),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_rsa_encrypt(
    plaintext: js::ForeignBytes,
    public_key_pem: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_rsa_encrypt(
            u::RustBuffer::into_rust(plaintext),
            u::RustBuffer::into_rust(public_key_pem),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_sign_passkey_assertion(
    private_key_base64: js::ForeignBytes,
    rp_id: js::ForeignBytes,
    client_data_hash_base64: js::ForeignBytes,
    sign_count: js::UInt32,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_sign_passkey_assertion(
            u::RustBuffer::into_rust(private_key_base64),
            u::RustBuffer::into_rust(rp_id),
            u::RustBuffer::into_rust(client_data_hash_base64),
            u32::into_rust(sign_count),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_unwrap_key(
    data: js::ForeignBytes,
    wrapping_key: js::Handle,
    context: js::ForeignBytes,
    legacy_marker: js::ForeignBytes,
    legacy_context: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_unwrap_key(
            u::RustBuffer::into_rust(data),
            u64::into_rust(wrapping_key),
            u::RustBuffer::into_rust(context),
            u::RustBuffer::into_rust(legacy_marker),
            u::RustBuffer::into_rust(legacy_context),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_validate_recovery_key(
    recovery_key: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_validate_recovery_key(
            u::RustBuffer::into_rust(recovery_key),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_validate_rotation_data(
    members: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_validate_rotation_data(
            u::RustBuffer::into_rust(members),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_validate_secret_key(
    secret_key: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_validate_secret_key(
            u::RustBuffer::into_rust(secret_key),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_verify_server_session(
    client_public_ephemeral: js::ForeignBytes,
    session: js::ForeignBytes,
    server_session_proof: js::ForeignBytes,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_verify_server_session(
            u::RustBuffer::into_rust(client_public_ephemeral),
            u::RustBuffer::into_rust(session),
            u::RustBuffer::into_rust(server_session_proof),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_fn_func_wrap_key(
    key: js::Handle,
    wrapping_key: js::Handle,
) -> js::Handle {
    uniffi_bittery_crypto_api_fn_func_wrap_key(
            u64::into_rust(key),
            u64::into_rust(wrapping_key),
        )
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_poll_u8(
    handle: js::Handle,
    callback: rust_future_continuation_callback::JsCallbackFnRustFutureContinuationCallback,
    callback_data: js::Handle,
) {
    ffi_bittery_crypto_api_rust_future_poll_u8(
        u64::into_rust(handle),
        rust_future_continuation_callback::FnSig::into_rust(callback),
        u64::into_rust(callback_data),
    );
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_cancel_u8(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_cancel_u8(u64::into_rust(handle));
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_free_u8(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_free_u8(u64::into_rust(handle));
}
#[wasm_bindgen]
pub fn ubrn_ffi_bittery_crypto_api_rust_future_complete_u8(
    handle: js::Handle,
    f_status_: &mut js::RustCallStatus,
) -> js::UInt8 {
    let mut u_status_ = u::RustCallStatus::default();
    let value_ = unsafe {
        ffi_bittery_crypto_api_rust_future_complete_u8(
            u64::into_rust(handle),
            &mut u_status_,
        )
    };
    f_status_.copy_from(u_status_);
    value_.into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_poll_i8(
    handle: js::Handle,
    callback: rust_future_continuation_callback::JsCallbackFnRustFutureContinuationCallback,
    callback_data: js::Handle,
) {
    ffi_bittery_crypto_api_rust_future_poll_i8(
        u64::into_rust(handle),
        rust_future_continuation_callback::FnSig::into_rust(callback),
        u64::into_rust(callback_data),
    );
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_cancel_i8(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_cancel_i8(u64::into_rust(handle));
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_free_i8(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_free_i8(u64::into_rust(handle));
}
#[wasm_bindgen]
pub fn ubrn_ffi_bittery_crypto_api_rust_future_complete_i8(
    handle: js::Handle,
    f_status_: &mut js::RustCallStatus,
) -> js::Int8 {
    let mut u_status_ = u::RustCallStatus::default();
    let value_ = unsafe {
        ffi_bittery_crypto_api_rust_future_complete_i8(
            u64::into_rust(handle),
            &mut u_status_,
        )
    };
    f_status_.copy_from(u_status_);
    value_.into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_poll_u16(
    handle: js::Handle,
    callback: rust_future_continuation_callback::JsCallbackFnRustFutureContinuationCallback,
    callback_data: js::Handle,
) {
    ffi_bittery_crypto_api_rust_future_poll_u16(
        u64::into_rust(handle),
        rust_future_continuation_callback::FnSig::into_rust(callback),
        u64::into_rust(callback_data),
    );
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_cancel_u16(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_cancel_u16(u64::into_rust(handle));
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_free_u16(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_free_u16(u64::into_rust(handle));
}
#[wasm_bindgen]
pub fn ubrn_ffi_bittery_crypto_api_rust_future_complete_u16(
    handle: js::Handle,
    f_status_: &mut js::RustCallStatus,
) -> js::UInt16 {
    let mut u_status_ = u::RustCallStatus::default();
    let value_ = unsafe {
        ffi_bittery_crypto_api_rust_future_complete_u16(
            u64::into_rust(handle),
            &mut u_status_,
        )
    };
    f_status_.copy_from(u_status_);
    value_.into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_poll_i16(
    handle: js::Handle,
    callback: rust_future_continuation_callback::JsCallbackFnRustFutureContinuationCallback,
    callback_data: js::Handle,
) {
    ffi_bittery_crypto_api_rust_future_poll_i16(
        u64::into_rust(handle),
        rust_future_continuation_callback::FnSig::into_rust(callback),
        u64::into_rust(callback_data),
    );
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_cancel_i16(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_cancel_i16(u64::into_rust(handle));
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_free_i16(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_free_i16(u64::into_rust(handle));
}
#[wasm_bindgen]
pub fn ubrn_ffi_bittery_crypto_api_rust_future_complete_i16(
    handle: js::Handle,
    f_status_: &mut js::RustCallStatus,
) -> js::Int16 {
    let mut u_status_ = u::RustCallStatus::default();
    let value_ = unsafe {
        ffi_bittery_crypto_api_rust_future_complete_i16(
            u64::into_rust(handle),
            &mut u_status_,
        )
    };
    f_status_.copy_from(u_status_);
    value_.into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_poll_u32(
    handle: js::Handle,
    callback: rust_future_continuation_callback::JsCallbackFnRustFutureContinuationCallback,
    callback_data: js::Handle,
) {
    ffi_bittery_crypto_api_rust_future_poll_u32(
        u64::into_rust(handle),
        rust_future_continuation_callback::FnSig::into_rust(callback),
        u64::into_rust(callback_data),
    );
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_cancel_u32(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_cancel_u32(u64::into_rust(handle));
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_free_u32(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_free_u32(u64::into_rust(handle));
}
#[wasm_bindgen]
pub fn ubrn_ffi_bittery_crypto_api_rust_future_complete_u32(
    handle: js::Handle,
    f_status_: &mut js::RustCallStatus,
) -> js::UInt32 {
    let mut u_status_ = u::RustCallStatus::default();
    let value_ = unsafe {
        ffi_bittery_crypto_api_rust_future_complete_u32(
            u64::into_rust(handle),
            &mut u_status_,
        )
    };
    f_status_.copy_from(u_status_);
    value_.into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_poll_i32(
    handle: js::Handle,
    callback: rust_future_continuation_callback::JsCallbackFnRustFutureContinuationCallback,
    callback_data: js::Handle,
) {
    ffi_bittery_crypto_api_rust_future_poll_i32(
        u64::into_rust(handle),
        rust_future_continuation_callback::FnSig::into_rust(callback),
        u64::into_rust(callback_data),
    );
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_cancel_i32(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_cancel_i32(u64::into_rust(handle));
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_free_i32(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_free_i32(u64::into_rust(handle));
}
#[wasm_bindgen]
pub fn ubrn_ffi_bittery_crypto_api_rust_future_complete_i32(
    handle: js::Handle,
    f_status_: &mut js::RustCallStatus,
) -> js::Int32 {
    let mut u_status_ = u::RustCallStatus::default();
    let value_ = unsafe {
        ffi_bittery_crypto_api_rust_future_complete_i32(
            u64::into_rust(handle),
            &mut u_status_,
        )
    };
    f_status_.copy_from(u_status_);
    value_.into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_poll_u64(
    handle: js::Handle,
    callback: rust_future_continuation_callback::JsCallbackFnRustFutureContinuationCallback,
    callback_data: js::Handle,
) {
    ffi_bittery_crypto_api_rust_future_poll_u64(
        u64::into_rust(handle),
        rust_future_continuation_callback::FnSig::into_rust(callback),
        u64::into_rust(callback_data),
    );
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_cancel_u64(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_cancel_u64(u64::into_rust(handle));
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_free_u64(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_free_u64(u64::into_rust(handle));
}
#[wasm_bindgen]
pub fn ubrn_ffi_bittery_crypto_api_rust_future_complete_u64(
    handle: js::Handle,
    f_status_: &mut js::RustCallStatus,
) -> js::UInt64 {
    let mut u_status_ = u::RustCallStatus::default();
    let value_ = unsafe {
        ffi_bittery_crypto_api_rust_future_complete_u64(
            u64::into_rust(handle),
            &mut u_status_,
        )
    };
    f_status_.copy_from(u_status_);
    value_.into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_poll_i64(
    handle: js::Handle,
    callback: rust_future_continuation_callback::JsCallbackFnRustFutureContinuationCallback,
    callback_data: js::Handle,
) {
    ffi_bittery_crypto_api_rust_future_poll_i64(
        u64::into_rust(handle),
        rust_future_continuation_callback::FnSig::into_rust(callback),
        u64::into_rust(callback_data),
    );
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_cancel_i64(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_cancel_i64(u64::into_rust(handle));
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_free_i64(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_free_i64(u64::into_rust(handle));
}
#[wasm_bindgen]
pub fn ubrn_ffi_bittery_crypto_api_rust_future_complete_i64(
    handle: js::Handle,
    f_status_: &mut js::RustCallStatus,
) -> js::Int64 {
    let mut u_status_ = u::RustCallStatus::default();
    let value_ = unsafe {
        ffi_bittery_crypto_api_rust_future_complete_i64(
            u64::into_rust(handle),
            &mut u_status_,
        )
    };
    f_status_.copy_from(u_status_);
    value_.into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_poll_f32(
    handle: js::Handle,
    callback: rust_future_continuation_callback::JsCallbackFnRustFutureContinuationCallback,
    callback_data: js::Handle,
) {
    ffi_bittery_crypto_api_rust_future_poll_f32(
        u64::into_rust(handle),
        rust_future_continuation_callback::FnSig::into_rust(callback),
        u64::into_rust(callback_data),
    );
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_cancel_f32(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_cancel_f32(u64::into_rust(handle));
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_free_f32(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_free_f32(u64::into_rust(handle));
}
#[wasm_bindgen]
pub fn ubrn_ffi_bittery_crypto_api_rust_future_complete_f32(
    handle: js::Handle,
    f_status_: &mut js::RustCallStatus,
) -> js::Float32 {
    let mut u_status_ = u::RustCallStatus::default();
    let value_ = unsafe {
        ffi_bittery_crypto_api_rust_future_complete_f32(
            u64::into_rust(handle),
            &mut u_status_,
        )
    };
    f_status_.copy_from(u_status_);
    value_.into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_poll_f64(
    handle: js::Handle,
    callback: rust_future_continuation_callback::JsCallbackFnRustFutureContinuationCallback,
    callback_data: js::Handle,
) {
    ffi_bittery_crypto_api_rust_future_poll_f64(
        u64::into_rust(handle),
        rust_future_continuation_callback::FnSig::into_rust(callback),
        u64::into_rust(callback_data),
    );
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_cancel_f64(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_cancel_f64(u64::into_rust(handle));
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_free_f64(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_free_f64(u64::into_rust(handle));
}
#[wasm_bindgen]
pub fn ubrn_ffi_bittery_crypto_api_rust_future_complete_f64(
    handle: js::Handle,
    f_status_: &mut js::RustCallStatus,
) -> js::Float64 {
    let mut u_status_ = u::RustCallStatus::default();
    let value_ = unsafe {
        ffi_bittery_crypto_api_rust_future_complete_f64(
            u64::into_rust(handle),
            &mut u_status_,
        )
    };
    f_status_.copy_from(u_status_);
    value_.into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_poll_rust_buffer(
    handle: js::Handle,
    callback: rust_future_continuation_callback::JsCallbackFnRustFutureContinuationCallback,
    callback_data: js::Handle,
) {
    ffi_bittery_crypto_api_rust_future_poll_rust_buffer(
        u64::into_rust(handle),
        rust_future_continuation_callback::FnSig::into_rust(callback),
        u64::into_rust(callback_data),
    );
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_cancel_rust_buffer(
    handle: js::Handle,
) {
    ffi_bittery_crypto_api_rust_future_cancel_rust_buffer(u64::into_rust(handle));
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_free_rust_buffer(
    handle: js::Handle,
) {
    ffi_bittery_crypto_api_rust_future_free_rust_buffer(u64::into_rust(handle));
}
#[wasm_bindgen]
pub fn ubrn_ffi_bittery_crypto_api_rust_future_complete_rust_buffer(
    handle: js::Handle,
    f_status_: &mut js::RustCallStatus,
) -> js::ForeignBytes {
    let mut u_status_ = u::RustCallStatus::default();
    let value_ = unsafe {
        ffi_bittery_crypto_api_rust_future_complete_rust_buffer(
            u64::into_rust(handle),
            &mut u_status_,
        )
    };
    f_status_.copy_from(u_status_);
    value_.into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_poll_void(
    handle: js::Handle,
    callback: rust_future_continuation_callback::JsCallbackFnRustFutureContinuationCallback,
    callback_data: js::Handle,
) {
    ffi_bittery_crypto_api_rust_future_poll_void(
        u64::into_rust(handle),
        rust_future_continuation_callback::FnSig::into_rust(callback),
        u64::into_rust(callback_data),
    );
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_cancel_void(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_cancel_void(u64::into_rust(handle));
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_rust_future_free_void(handle: js::Handle) {
    ffi_bittery_crypto_api_rust_future_free_void(u64::into_rust(handle));
}
#[wasm_bindgen]
pub fn ubrn_ffi_bittery_crypto_api_rust_future_complete_void(
    handle: js::Handle,
    f_status_: &mut js::RustCallStatus,
) {
    let mut u_status_ = u::RustCallStatus::default();
    unsafe {
        ffi_bittery_crypto_api_rust_future_complete_void(
            u64::into_rust(handle),
            &mut u_status_,
        )
    };
    f_status_.copy_from(u_status_);
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_build_passkey_attestation_object() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_build_passkey_attestation_object().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_clone_key() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_clone_key().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_decrypt().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_many() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_decrypt_many().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_master_key() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_decrypt_master_key().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_rsa_wrapped_key() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_decrypt_rsa_wrapped_key().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_derive_client_session() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_derive_client_session().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_derive_keys() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_derive_keys().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_derive_keys_from_master_key() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_derive_keys_from_master_key().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_derive_master_key() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_derive_master_key().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_derive_srp_password() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_derive_srp_password().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_destroy_key() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_destroy_key().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_encrypt().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_master_key() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_encrypt_master_key().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_for_member() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_for_member().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_with_muk() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_with_muk().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_export_key() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_export_key().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_generate_client_ephemeral() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_generate_client_ephemeral().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_generate_encryption_key() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_generate_encryption_key().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_generate_passkey_credential_id() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_generate_passkey_credential_id().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_generate_passkey_keypair() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_generate_passkey_keypair().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_generate_recovery_key() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_generate_recovery_key().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_generate_rsa_key_pair() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_generate_rsa_key_pair().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_generate_secret_key() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_generate_secret_key().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_generate_srp_registration() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_generate_srp_registration().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_generate_totp() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_generate_totp().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_generate_totp_at() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_generate_totp_at().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_generate_uuid() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_generate_uuid().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_import_key() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_import_key().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_initialize() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_initialize().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_perform_key_rotation() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_perform_key_rotation().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_re_encrypt_item() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_re_encrypt_item().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_rsa_decrypt() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_rsa_decrypt().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_rsa_encrypt() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_rsa_encrypt().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_sign_passkey_assertion() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_sign_passkey_assertion().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_unwrap_key() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_unwrap_key().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_validate_recovery_key() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_validate_recovery_key().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_validate_rotation_data() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_validate_rotation_data().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_validate_secret_key() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_validate_secret_key().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_verify_server_session() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_verify_server_session().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_func_wrap_key() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_func_wrap_key().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_method_keyhandle_destroy() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_method_keyhandle_destroy().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_derive_safe_private_key() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_method_srpclient_derive_safe_private_key()
        .into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_derive_verifier() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_method_srpclient_derive_verifier().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_generate_salt() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_method_srpclient_generate_salt().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_method_srpserver_generate_ephemeral() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_method_srpserver_generate_ephemeral().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_constructor_srpclient_new() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_constructor_srpclient_new().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_uniffi_bittery_crypto_api_checksum_constructor_srpserver_new() -> js::UInt16 {
    uniffi_bittery_crypto_api_checksum_constructor_srpserver_new().into_js()
}
#[wasm_bindgen]
pub unsafe fn ubrn_ffi_bittery_crypto_api_uniffi_contract_version() -> js::UInt32 {
    ffi_bittery_crypto_api_uniffi_contract_version().into_js()
}
mod rust_future_continuation_callback {
    use super::*;
    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen]
        pub type JsCallbackFnRustFutureContinuationCallback;
        #[wasm_bindgen(method)]
        pub fn call(
            this_: &JsCallbackFnRustFutureContinuationCallback,
            ctx_: &JsCallbackFnRustFutureContinuationCallback,
            data: js::UInt64,
            poll_result: js::Int8,
        );
    }
    thread_local! {
        static CALLBACK : js::ForeignCell < JsCallbackFnRustFutureContinuationCallback >
        = js::ForeignCell::new();
    }
    impl IntoRust<JsCallbackFnRustFutureContinuationCallback> for FnSig {
        fn into_rust(callback: JsCallbackFnRustFutureContinuationCallback) -> Self {
            CALLBACK.with(|cell| cell.set(callback));
            implementation
        }
    }
    pub(super) type FnSig = extern "C" fn(data: u64, poll_result: i8);
    extern "C" fn implementation(data: u64, poll_result: i8) {
        CALLBACK
            .with(|cell_| {
                cell_
                    .with_value(|callback_| {
                        callback_.call(callback_, data.into_js(), poll_result.into_js())
                    })
            });
    }
}
