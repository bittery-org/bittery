/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const uniffi_bittery_crypto_api_fn_clone_keyhandle: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_derive_srp_password: (
  a: bigint,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_destroy_key: (
  a: bigint,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_encrypt: (
  a: number,
  b: bigint,
  c: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_generate_rsa_key_pair: () => bigint;
export const uniffi_bittery_crypto_api_fn_func_generate_secret_key: () => bigint;
export const uniffi_bittery_crypto_api_fn_func_generate_srp_registration: (
  a: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_generate_totp: (
  a: number,
  b: number,
  c: number,
  d: bigint,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_generate_totp_at: (
  a: number,
  b: number,
  c: number,
  d: bigint,
  e: bigint,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_generate_uuid: () => bigint;
export const uniffi_bittery_crypto_api_fn_func_import_key: (
  a: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_initialize: () => bigint;
export const uniffi_bittery_crypto_api_fn_free_keyhandle: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_crypto_api_fn_func_encrypt_master_key: (
  a: bigint,
  b: number,
  c: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_for_member: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_with_muk: (
  a: bigint,
  b: bigint,
  c: number,
  d: number,
  e: bigint,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_export_key: (
  a: bigint,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_generate_client_ephemeral: () => bigint;
export const uniffi_bittery_crypto_api_fn_func_generate_encryption_key: () => bigint;
export const uniffi_bittery_crypto_api_fn_func_generate_passkey_credential_id: () => bigint;
export const uniffi_bittery_crypto_api_fn_func_generate_passkey_keypair: () => bigint;
export const uniffi_bittery_crypto_api_fn_func_generate_recovery_key: () => bigint;
export const uniffi_bittery_crypto_api_fn_func_re_encrypt_item: (
  a: number,
  b: bigint,
  c: bigint,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_rewrap_attachment_key: (
  a: number,
  b: bigint,
  c: bigint,
  d: number,
  e: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_rsa_decrypt: (
  a: number,
  b: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_rsa_encrypt: (
  a: number,
  b: number,
) => bigint;
export const ffi_bittery_crypto_api_rust_future_free_u8: (a: bigint) => void;
export const ffi_bittery_crypto_api_rust_future_complete_u8: (
  a: bigint,
  b: number,
) => number;
export const ffi_bittery_crypto_api_rust_future_poll_i8: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_crypto_api_rust_future_cancel_i8: (a: bigint) => void;
export const ffi_bittery_crypto_api_rust_future_free_i8: (a: bigint) => void;
export const ffi_bittery_crypto_api_rust_future_complete_i8: (
  a: bigint,
  b: number,
) => number;
export const ffi_bittery_crypto_api_rust_future_poll_u16: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_crypto_api_rust_future_cancel_u16: (a: bigint) => void;
export const ffi_bittery_crypto_api_rust_future_free_u16: (a: bigint) => void;
export const uniffi_bittery_crypto_api_fn_func_sign_passkey_assertion: (
  a: number,
  b: number,
  c: number,
  d: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_unwrap_key: (
  a: number,
  b: bigint,
  c: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_validate_recovery_key: (
  a: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_validate_secret_key: (
  a: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_verify_server_session: (
  a: number,
  b: number,
  c: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_wrap_key: (
  a: bigint,
  b: bigint,
  c: number,
) => bigint;
export const ffi_bittery_crypto_api_rust_future_poll_u8: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_crypto_api_rust_future_cancel_u8: (a: bigint) => void;
export const ffi_bittery_crypto_api_rust_future_complete_u16: (
  a: bigint,
  b: number,
) => number;
export const ffi_bittery_crypto_api_rust_future_poll_i16: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_crypto_api_rust_future_cancel_i16: (a: bigint) => void;
export const ffi_bittery_crypto_api_rust_future_complete_i32: (
  a: bigint,
  b: number,
) => number;
export const ffi_bittery_crypto_api_rust_future_poll_u64: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_crypto_api_rust_future_cancel_u64: (a: bigint) => void;
export const ffi_bittery_crypto_api_rust_future_free_u64: (a: bigint) => void;
export const ffi_bittery_crypto_api_rust_future_complete_u64: (
  a: bigint,
  b: number,
) => bigint;
export const ffi_bittery_crypto_api_rust_future_poll_i64: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_crypto_api_rust_future_cancel_i64: (a: bigint) => void;
export const ffi_bittery_crypto_api_rust_future_free_i64: (a: bigint) => void;
export const ffi_bittery_crypto_api_rust_future_complete_i64: (
  a: bigint,
  b: number,
) => bigint;
export const ffi_bittery_crypto_api_rust_future_free_i16: (a: bigint) => void;
export const ffi_bittery_crypto_api_rust_future_complete_i16: (
  a: bigint,
  b: number,
) => number;
export const ffi_bittery_crypto_api_rust_future_poll_u32: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_crypto_api_rust_future_cancel_u32: (a: bigint) => void;
export const ffi_bittery_crypto_api_rust_future_free_u32: (a: bigint) => void;
export const ffi_bittery_crypto_api_rust_future_complete_u32: (
  a: bigint,
  b: number,
) => number;
export const ffi_bittery_crypto_api_rust_future_poll_i32: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_crypto_api_rust_future_cancel_i32: (a: bigint) => void;
export const ffi_bittery_crypto_api_rust_future_free_i32: (a: bigint) => void;
export const ffi_bittery_crypto_api_rust_future_poll_f32: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_crypto_api_rust_future_cancel_f32: (a: bigint) => void;
export const ffi_bittery_crypto_api_rust_future_free_f32: (a: bigint) => void;
export const ffi_bittery_crypto_api_rust_future_poll_void: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_crypto_api_rust_future_cancel_void: (
  a: bigint,
) => void;
export const ffi_bittery_crypto_api_rust_future_free_void: (a: bigint) => void;
export const ffi_bittery_crypto_api_rust_future_complete_void: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_crypto_api_checksum_func_build_passkey_attestation_object: () => number;
export const uniffi_bittery_crypto_api_checksum_func_clone_key: () => number;
export const uniffi_bittery_crypto_api_checksum_func_decrypt: () => number;
export const uniffi_bittery_crypto_api_checksum_func_decrypt_many: () => number;
export const uniffi_bittery_crypto_api_fn_clone_srpclient: (
  a: bigint,
  b: number,
) => bigint;
export const ffi_bittery_crypto_api_rust_future_complete_f32: (
  a: bigint,
  b: number,
) => number;
export const ffi_bittery_crypto_api_rust_future_poll_f64: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_crypto_api_rust_future_cancel_f64: (a: bigint) => void;
export const ffi_bittery_crypto_api_rust_future_free_f64: (a: bigint) => void;
export const ffi_bittery_crypto_api_rust_future_complete_f64: (
  a: bigint,
  b: number,
) => number;
export const ffi_bittery_crypto_api_rust_future_poll_rust_buffer: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_crypto_api_rust_future_cancel_rust_buffer: (
  a: bigint,
) => void;
export const ffi_bittery_crypto_api_rust_future_free_rust_buffer: (
  a: bigint,
) => void;
export const ffi_bittery_crypto_api_rust_future_complete_rust_buffer: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_crypto_api_checksum_func_decrypt_master_key: () => number;
export const uniffi_bittery_crypto_api_checksum_func_decrypt_rsa_wrapped_key: () => number;
export const uniffi_bittery_crypto_api_checksum_func_derive_client_session: () => number;
export const uniffi_bittery_crypto_api_checksum_func_derive_keys: () => number;
export const uniffi_bittery_crypto_api_checksum_func_export_key: () => number;
export const uniffi_bittery_crypto_api_checksum_func_generate_client_ephemeral: () => number;
export const uniffi_bittery_crypto_api_checksum_func_generate_encryption_key: () => number;
export const uniffi_bittery_crypto_api_checksum_func_generate_passkey_credential_id: () => number;
export const uniffi_bittery_crypto_api_checksum_func_generate_passkey_keypair: () => number;
export const uniffi_bittery_crypto_api_checksum_func_generate_recovery_key: () => number;
export const uniffi_bittery_crypto_api_checksum_func_generate_rsa_key_pair: () => number;
export const uniffi_bittery_crypto_api_checksum_func_generate_secret_key: () => number;
export const uniffi_bittery_crypto_api_checksum_func_generate_srp_registration: () => number;
export const uniffi_bittery_crypto_api_checksum_func_derive_keys_from_master_key: () => number;
export const uniffi_bittery_crypto_api_checksum_func_derive_master_key: () => number;
export const uniffi_bittery_crypto_api_checksum_func_derive_srp_password: () => number;
export const uniffi_bittery_crypto_api_checksum_func_destroy_key: () => number;
export const uniffi_bittery_crypto_api_checksum_func_encrypt: () => number;
export const uniffi_bittery_crypto_api_checksum_func_encrypt_master_key: () => number;
export const uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_for_member: () => number;
export const uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_with_muk: () => number;
export const uniffi_bittery_crypto_api_checksum_func_generate_totp: () => number;
export const uniffi_bittery_crypto_api_checksum_func_generate_totp_at: () => number;
export const uniffi_bittery_crypto_api_checksum_func_generate_uuid: () => number;
export const uniffi_bittery_crypto_api_checksum_func_validate_secret_key: () => number;
export const uniffi_bittery_crypto_api_checksum_func_verify_server_session: () => number;
export const uniffi_bittery_crypto_api_checksum_func_wrap_key: () => number;
export const uniffi_bittery_crypto_api_checksum_method_srpclient_derive_safe_private_key: () => number;
export const uniffi_bittery_crypto_api_checksum_method_srpclient_derive_verifier: () => number;
export const uniffi_bittery_crypto_api_checksum_method_srpclient_generate_salt: () => number;
export const uniffi_bittery_crypto_api_checksum_method_srpserver_generate_ephemeral: () => number;
export const uniffi_bittery_crypto_api_checksum_constructor_srpclient_new: () => number;
export const uniffi_bittery_crypto_api_checksum_constructor_srpserver_new: () => number;
export const uniffi_bittery_crypto_api_checksum_func_import_key: () => number;
export const uniffi_bittery_crypto_api_checksum_func_initialize: () => number;
export const uniffi_bittery_crypto_api_checksum_func_re_encrypt_item: () => number;
export const uniffi_bittery_crypto_api_checksum_func_rewrap_attachment_key: () => number;
export const uniffi_bittery_crypto_api_checksum_func_rsa_decrypt: () => number;
export const uniffi_bittery_crypto_api_checksum_func_rsa_encrypt: () => number;
export const uniffi_bittery_crypto_api_checksum_func_sign_passkey_assertion: () => number;
export const uniffi_bittery_crypto_api_checksum_func_unwrap_key: () => number;
export const uniffi_bittery_crypto_api_checksum_func_validate_recovery_key: () => number;
export const ffi_bittery_crypto_api_uniffi_contract_version: () => number;
export const uniffi_bittery_crypto_api_fn_free_srpclient: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_crypto_api_fn_func_clone_key: (a: bigint) => bigint;
export const uniffi_bittery_crypto_api_fn_func_decrypt: (
  a: number,
  b: bigint,
  c: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_decrypt_many: (
  a: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_decrypt_master_key: (
  a: number,
  b: number,
  c: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_decrypt_rsa_wrapped_key: (
  a: number,
  b: number,
  c: bigint,
  d: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_derive_client_session: (
  a: number,
  b: number,
  c: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_derive_keys: (
  a: number,
  b: number,
  c: number,
  d: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_derive_keys_from_master_key: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_derive_master_key: (
  a: number,
  b: number,
  c: number,
  d: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_constructor_srpclient_new: (
  a: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_method_srpclient_derive_safe_private_key: (
  a: bigint,
  b: number,
  c: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_method_srpclient_derive_verifier: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_method_srpclient_generate_salt: (
  a: bigint,
) => bigint;
export const uniffi_bittery_crypto_api_fn_clone_srpserver: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_free_srpserver: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_crypto_api_fn_constructor_srpserver_new: (
  a: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_method_srpserver_generate_ephemeral: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_crypto_api_fn_func_build_passkey_attestation_object: (
  a: number,
  b: number,
  c: number,
  d: number,
) => bigint;
export const ubrn_ffi_bittery_crypto_api_rust_future_cancel_f32: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_cancel_f64: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_cancel_i16: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_cancel_i32: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_cancel_i64: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_cancel_i8: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_cancel_rust_buffer: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_cancel_u16: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_cancel_u32: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_cancel_u64: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_cancel_u8: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_cancel_void: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_complete_f32: (
  a: bigint,
  b: number,
) => number;
export const ubrn_ffi_bittery_crypto_api_rust_future_complete_f64: (
  a: bigint,
  b: number,
) => number;
export const ubrn_ffi_bittery_crypto_api_rust_future_complete_i16: (
  a: bigint,
  b: number,
) => number;
export const ubrn_ffi_bittery_crypto_api_rust_future_complete_i32: (
  a: bigint,
  b: number,
) => number;
export const ubrn_ffi_bittery_crypto_api_rust_future_complete_i64: (
  a: bigint,
  b: number,
) => bigint;
export const ubrn_ffi_bittery_crypto_api_rust_future_complete_i8: (
  a: bigint,
  b: number,
) => number;
export const ubrn_ffi_bittery_crypto_api_rust_future_complete_rust_buffer: (
  a: bigint,
  b: number,
) => [number, number];
export const ubrn_ffi_bittery_crypto_api_rust_future_complete_u16: (
  a: bigint,
  b: number,
) => number;
export const ubrn_ffi_bittery_crypto_api_rust_future_complete_u32: (
  a: bigint,
  b: number,
) => number;
export const ubrn_ffi_bittery_crypto_api_rust_future_complete_u64: (
  a: bigint,
  b: number,
) => bigint;
export const ubrn_ffi_bittery_crypto_api_rust_future_complete_u8: (
  a: bigint,
  b: number,
) => number;
export const ubrn_ffi_bittery_crypto_api_rust_future_complete_void: (
  a: bigint,
  b: number,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_free_f32: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_free_f64: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_free_i16: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_free_i32: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_free_i64: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_free_i8: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_free_rust_buffer: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_free_u16: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_free_u32: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_free_u64: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_free_u8: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_free_void: (
  a: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_poll_f32: (
  a: bigint,
  b: any,
  c: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_poll_f64: (
  a: bigint,
  b: any,
  c: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_poll_i16: (
  a: bigint,
  b: any,
  c: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_poll_i32: (
  a: bigint,
  b: any,
  c: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_poll_i64: (
  a: bigint,
  b: any,
  c: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_poll_i8: (
  a: bigint,
  b: any,
  c: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_poll_rust_buffer: (
  a: bigint,
  b: any,
  c: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_poll_u16: (
  a: bigint,
  b: any,
  c: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_poll_u32: (
  a: bigint,
  b: any,
  c: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_poll_u64: (
  a: bigint,
  b: any,
  c: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_poll_u8: (
  a: bigint,
  b: any,
  c: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_rust_future_poll_void: (
  a: bigint,
  b: any,
  c: bigint,
) => void;
export const ubrn_ffi_bittery_crypto_api_uniffi_contract_version: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_constructor_srpclient_new: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_constructor_srpserver_new: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_build_passkey_attestation_object: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_clone_key: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_many: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_master_key: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_rsa_wrapped_key: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_derive_client_session: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_derive_keys: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_derive_keys_from_master_key: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_derive_master_key: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_derive_srp_password: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_destroy_key: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_master_key: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_for_member: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_with_muk: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_export_key: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_generate_client_ephemeral: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_generate_encryption_key: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_generate_passkey_credential_id: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_generate_passkey_keypair: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_generate_recovery_key: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_generate_rsa_key_pair: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_generate_secret_key: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_generate_srp_registration: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_generate_totp: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_generate_totp_at: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_generate_uuid: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_import_key: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_initialize: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_re_encrypt_item: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_rewrap_attachment_key: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_rsa_decrypt: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_rsa_encrypt: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_sign_passkey_assertion: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_unwrap_key: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_validate_recovery_key: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_validate_secret_key: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_verify_server_session: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_func_wrap_key: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_derive_safe_private_key: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_derive_verifier: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_generate_salt: () => number;
export const ubrn_uniffi_bittery_crypto_api_checksum_method_srpserver_generate_ephemeral: () => number;
export const ubrn_uniffi_bittery_crypto_api_fn_clone_keyhandle: (
  a: bigint,
  b: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_clone_srpclient: (
  a: bigint,
  b: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_clone_srpserver: (
  a: bigint,
  b: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_constructor_srpclient_new: (
  a: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_constructor_srpserver_new: (
  a: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_free_keyhandle: (
  a: bigint,
  b: number,
) => void;
export const ubrn_uniffi_bittery_crypto_api_fn_free_srpclient: (
  a: bigint,
  b: number,
) => void;
export const ubrn_uniffi_bittery_crypto_api_fn_free_srpserver: (
  a: bigint,
  b: number,
) => void;
export const ubrn_uniffi_bittery_crypto_api_fn_func_build_passkey_attestation_object: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_clone_key: (
  a: bigint,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_decrypt: (
  a: number,
  b: number,
  c: bigint,
  d: number,
  e: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_many: (
  a: number,
  b: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_master_key: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_rsa_wrapped_key: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: bigint,
  f: number,
  g: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_derive_client_session: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_derive_keys: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_derive_keys_from_master_key: (
  a: bigint,
  b: number,
  c: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_derive_master_key: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_derive_srp_password: (
  a: bigint,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_destroy_key: (
  a: bigint,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_encrypt: (
  a: number,
  b: number,
  c: bigint,
  d: number,
  e: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_master_key: (
  a: bigint,
  b: number,
  c: number,
  d: number,
  e: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_for_member: (
  a: bigint,
  b: number,
  c: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_with_muk: (
  a: bigint,
  b: bigint,
  c: number,
  d: number,
  e: number,
  f: number,
  g: bigint,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_export_key: (
  a: bigint,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_generate_srp_registration: (
  a: number,
  b: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_generate_totp: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: bigint,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_generate_totp_at: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: bigint,
  g: bigint,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_import_key: (
  a: number,
  b: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_re_encrypt_item: (
  a: number,
  b: number,
  c: bigint,
  d: bigint,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_rewrap_attachment_key: (
  a: number,
  b: number,
  c: bigint,
  d: bigint,
  e: number,
  f: number,
  g: number,
  h: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_rsa_decrypt: (
  a: number,
  b: number,
  c: number,
  d: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_rsa_encrypt: (
  a: number,
  b: number,
  c: number,
  d: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_sign_passkey_assertion: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_unwrap_key: (
  a: number,
  b: number,
  c: bigint,
  d: number,
  e: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_validate_recovery_key: (
  a: number,
  b: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_validate_secret_key: (
  a: number,
  b: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_verify_server_session: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_wrap_key: (
  a: bigint,
  b: bigint,
  c: number,
  d: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_derive_safe_private_key: (
  a: bigint,
  b: number,
  c: number,
  d: number,
  e: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_derive_verifier: (
  a: bigint,
  b: number,
  c: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_generate_salt: (
  a: bigint,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_method_srpserver_generate_ephemeral: (
  a: bigint,
  b: number,
  c: number,
) => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_generate_client_ephemeral: () => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_generate_encryption_key: () => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_generate_passkey_credential_id: () => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_generate_passkey_keypair: () => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_generate_recovery_key: () => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_generate_rsa_key_pair: () => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_generate_secret_key: () => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_generate_uuid: () => bigint;
export const ubrn_uniffi_bittery_crypto_api_fn_func_initialize: () => bigint;
export const __wbg_get_rustcallstatus_code: (a: number) => number;
export const __wbg_rustcallstatus_free: (a: number, b: number) => void;
export const __wbg_set_rustcallstatus_code: (a: number, b: number) => void;
export const rustcallstatus_error_buf: (a: number) => [number, number];
export const rustcallstatus_new: () => number;
export const rustcallstatus_set_error_buf: (
  a: number,
  b: number,
  c: number,
) => void;
export const __wbg_webclientruntime_free: (a: number, b: number) => void;
export const ffi_bittery_client_bindings_rust_future_cancel_f32: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_complete_f32: (
  a: bigint,
  b: number,
) => number;
export const ffi_bittery_client_bindings_rust_future_complete_f64: (
  a: bigint,
  b: number,
) => number;
export const ffi_bittery_client_bindings_rust_future_complete_i16: (
  a: bigint,
  b: number,
) => number;
export const ffi_bittery_client_bindings_rust_future_complete_i32: (
  a: bigint,
  b: number,
) => number;
export const ffi_bittery_client_bindings_rust_future_complete_i64: (
  a: bigint,
  b: number,
) => bigint;
export const ffi_bittery_client_bindings_rust_future_complete_i8: (
  a: bigint,
  b: number,
) => number;
export const ffi_bittery_client_bindings_rust_future_complete_rust_buffer: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const ffi_bittery_client_bindings_rust_future_complete_u16: (
  a: bigint,
  b: number,
) => number;
export const ffi_bittery_client_bindings_rust_future_complete_u32: (
  a: bigint,
  b: number,
) => number;
export const ffi_bittery_client_bindings_rust_future_complete_u64: (
  a: bigint,
  b: number,
) => bigint;
export const ffi_bittery_client_bindings_rust_future_complete_u8: (
  a: bigint,
  b: number,
) => number;
export const ffi_bittery_client_bindings_rust_future_complete_void: (
  a: bigint,
  b: number,
) => void;
export const ffi_bittery_client_bindings_rust_future_poll_f32: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_poll_f64: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_poll_i16: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_poll_i32: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_poll_i64: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_poll_i8: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_poll_rust_buffer: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_poll_u16: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_poll_u32: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_poll_u64: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_poll_u8: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_poll_void: (
  a: bigint,
  b: number,
  c: bigint,
) => void;
export const ffi_bittery_client_bindings_rustbuffer_alloc: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const ffi_bittery_client_bindings_rustbuffer_free: (
  a: number,
  b: number,
) => void;
export const ffi_bittery_client_bindings_rustbuffer_from_bytes: (
  a: number,
  b: number,
  c: number,
) => void;
export const ffi_bittery_client_bindings_rustbuffer_reserve: (
  a: number,
  b: number,
  c: bigint,
  d: number,
) => void;
export const ffi_bittery_client_bindings_uniffi_contract_version: () => number;
export const uniffi_bittery_client_bindings_checksum_constructor_address_new: () => number;
export const uniffi_bittery_client_bindings_checksum_constructor_attachmentname_new: () => number;
export const uniffi_bittery_client_bindings_checksum_constructor_attachmentuploadmetadata_new: () => number;
export const uniffi_bittery_client_bindings_checksum_constructor_authenticatoritemdata_new: () => number;
export const uniffi_bittery_client_bindings_checksum_constructor_creditcarditemdata_new: () => number;
export const uniffi_bittery_client_bindings_checksum_constructor_customfield_new: () => number;
export const uniffi_bittery_client_bindings_checksum_constructor_identityitemdata_new: () => number;
export const uniffi_bittery_client_bindings_checksum_constructor_loginitemdata_new: () => number;
export const uniffi_bittery_client_bindings_checksum_constructor_passkey_new: () => number;
export const uniffi_bittery_client_bindings_checksum_constructor_passwordhistoryentry_new: () => number;
export const uniffi_bittery_client_bindings_checksum_constructor_phonenumber_new: () => number;
export const uniffi_bittery_client_bindings_checksum_constructor_secretstring_new: () => number;
export const uniffi_bittery_client_bindings_checksum_constructor_securenoteitemdata_new: () => number;
export const uniffi_bittery_client_bindings_checksum_func_normalize_account_email: () => number;
export const uniffi_bittery_client_bindings_checksum_method_address_city: () => number;
export const uniffi_bittery_client_bindings_checksum_method_address_country: () => number;
export const uniffi_bittery_client_bindings_checksum_method_address_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_address_state: () => number;
export const uniffi_bittery_client_bindings_checksum_method_address_street: () => number;
export const uniffi_bittery_client_bindings_checksum_method_address_zip: () => number;
export const uniffi_bittery_client_bindings_checksum_method_attachmentprojection_account_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_attachmentprojection_attachment_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_attachmentprojection_content_type: () => number;
export const uniffi_bittery_client_bindings_checksum_method_attachmentprojection_created_at: () => number;
export const uniffi_bittery_client_bindings_checksum_method_attachmentprojection_file_size: () => number;
export const uniffi_bittery_client_bindings_checksum_method_attachmentprojection_item_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_attachmentprojection_name: () => number;
export const uniffi_bittery_client_bindings_checksum_method_attachmentprojection_uploaded_by: () => number;
export const uniffi_bittery_client_bindings_checksum_method_attachmentprojection_vault_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_authenticatoritemdata_custom_fields: () => number;
export const uniffi_bittery_client_bindings_checksum_method_authenticatoritemdata_linked_item_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_authenticatoritemdata_notes: () => number;
export const uniffi_bittery_client_bindings_checksum_method_authenticatoritemdata_tags: () => number;
export const uniffi_bittery_client_bindings_checksum_method_authenticatoritemdata_title: () => number;
export const uniffi_bittery_client_bindings_checksum_method_authenticatoritemdata_totp_account_name: () => number;
export const uniffi_bittery_client_bindings_checksum_method_authenticatoritemdata_totp_algorithm: () => number;
export const uniffi_bittery_client_bindings_checksum_method_authenticatoritemdata_totp_digits: () => number;
export const uniffi_bittery_client_bindings_checksum_method_authenticatoritemdata_totp_issuer: () => number;
export const uniffi_bittery_client_bindings_checksum_method_authenticatoritemdata_totp_period: () => number;
export const uniffi_bittery_client_bindings_checksum_method_authenticatoritemdata_totp_secret: () => number;
export const uniffi_bittery_client_bindings_checksum_method_creditcarditemdata_billing_address: () => number;
export const uniffi_bittery_client_bindings_checksum_method_creditcarditemdata_card_number: () => number;
export const uniffi_bittery_client_bindings_checksum_method_creditcarditemdata_cardholder_name: () => number;
export const uniffi_bittery_client_bindings_checksum_method_creditcarditemdata_custom_fields: () => number;
export const uniffi_bittery_client_bindings_checksum_method_creditcarditemdata_cvv: () => number;
export const uniffi_bittery_client_bindings_checksum_method_creditcarditemdata_expiry_date: () => number;
export const uniffi_bittery_client_bindings_checksum_method_creditcarditemdata_notes: () => number;
export const uniffi_bittery_client_bindings_checksum_method_creditcarditemdata_tags: () => number;
export const uniffi_bittery_client_bindings_checksum_method_creditcarditemdata_title: () => number;
export const uniffi_bittery_client_bindings_checksum_method_creditcarditemdata_totp_account_name: () => number;
export const uniffi_bittery_client_bindings_checksum_method_creditcarditemdata_totp_algorithm: () => number;
export const uniffi_bittery_client_bindings_checksum_method_creditcarditemdata_totp_digits: () => number;
export const uniffi_bittery_client_bindings_checksum_method_creditcarditemdata_totp_issuer: () => number;
export const uniffi_bittery_client_bindings_checksum_method_creditcarditemdata_totp_period: () => number;
export const uniffi_bittery_client_bindings_checksum_method_creditcarditemdata_totp_secret: () => number;
export const uniffi_bittery_client_bindings_checksum_method_customfield_field_type: () => number;
export const uniffi_bittery_client_bindings_checksum_method_customfield_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_customfield_label: () => number;
export const uniffi_bittery_client_bindings_checksum_method_customfield_value: () => number;
export const uniffi_bittery_client_bindings_checksum_method_identityitemdata_addresses: () => number;
export const uniffi_bittery_client_bindings_checksum_method_identityitemdata_custom_fields: () => number;
export const uniffi_bittery_client_bindings_checksum_method_identityitemdata_date_of_birth: () => number;
export const uniffi_bittery_client_bindings_checksum_method_identityitemdata_drivers_license: () => number;
export const uniffi_bittery_client_bindings_checksum_method_identityitemdata_email: () => number;
export const uniffi_bittery_client_bindings_checksum_method_identityitemdata_first_name: () => number;
export const uniffi_bittery_client_bindings_checksum_method_identityitemdata_last_name: () => number;
export const uniffi_bittery_client_bindings_checksum_method_identityitemdata_middle_name: () => number;
export const uniffi_bittery_client_bindings_checksum_method_identityitemdata_notes: () => number;
export const uniffi_bittery_client_bindings_checksum_method_identityitemdata_passport_number: () => number;
export const uniffi_bittery_client_bindings_checksum_method_identityitemdata_phone_numbers: () => number;
export const uniffi_bittery_client_bindings_checksum_method_identityitemdata_ssn: () => number;
export const uniffi_bittery_client_bindings_checksum_method_identityitemdata_tags: () => number;
export const uniffi_bittery_client_bindings_checksum_method_identityitemdata_title: () => number;
export const uniffi_bittery_client_bindings_checksum_method_identityitemdata_totp_account_name: () => number;
export const uniffi_bittery_client_bindings_checksum_method_identityitemdata_totp_algorithm: () => number;
export const uniffi_bittery_client_bindings_checksum_method_identityitemdata_totp_digits: () => number;
export const uniffi_bittery_client_bindings_checksum_method_identityitemdata_totp_issuer: () => number;
export const uniffi_bittery_client_bindings_checksum_method_identityitemdata_totp_period: () => number;
export const uniffi_bittery_client_bindings_checksum_method_identityitemdata_totp_secret: () => number;
export const uniffi_bittery_client_bindings_checksum_method_itemprojection_account_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_itemprojection_attachments: () => number;
export const uniffi_bittery_client_bindings_checksum_method_itemprojection_created_at: () => number;
export const uniffi_bittery_client_bindings_checksum_method_itemprojection_data: () => number;
export const uniffi_bittery_client_bindings_checksum_method_itemprojection_deleted_at: () => number;
export const uniffi_bittery_client_bindings_checksum_method_itemprojection_favorite: () => number;
export const uniffi_bittery_client_bindings_checksum_method_itemprojection_item_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_itemprojection_status: () => number;
export const uniffi_bittery_client_bindings_checksum_method_itemprojection_updated_at: () => number;
export const uniffi_bittery_client_bindings_checksum_method_itemprojection_vault_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemdata_custom_fields: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemdata_note: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemdata_notes: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemdata_passkeys: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemdata_password: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemdata_password_history: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemdata_tags: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemdata_title: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemdata_totp_account_name: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemdata_totp_algorithm: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemdata_totp_digits: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemdata_totp_issuer: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemdata_totp_period: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemdata_totp_secret: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemdata_url: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemdata_urls: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemdata_username: () => number;
export const uniffi_bittery_client_bindings_checksum_method_passkey_algorithm: () => number;
export const uniffi_bittery_client_bindings_checksum_method_passkey_created_at: () => number;
export const uniffi_bittery_client_bindings_checksum_method_passkey_credential_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_passkey_last_used_at: () => number;
export const uniffi_bittery_client_bindings_checksum_method_passkey_private_key: () => number;
export const uniffi_bittery_client_bindings_checksum_method_passkey_public_key: () => number;
export const uniffi_bittery_client_bindings_checksum_method_passkey_rp_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_passkey_rp_name: () => number;
export const uniffi_bittery_client_bindings_checksum_method_passkey_sign_count: () => number;
export const uniffi_bittery_client_bindings_checksum_method_passkey_status: () => number;
export const uniffi_bittery_client_bindings_checksum_method_passkey_status_updated_at: () => number;
export const uniffi_bittery_client_bindings_checksum_method_passkey_transports: () => number;
export const uniffi_bittery_client_bindings_checksum_method_passkey_user_display_name: () => number;
export const uniffi_bittery_client_bindings_checksum_method_passkey_user_handle: () => number;
export const uniffi_bittery_client_bindings_checksum_method_passkey_user_name: () => number;
export const uniffi_bittery_client_bindings_checksum_method_passwordhistoryentry_changed_at: () => number;
export const uniffi_bittery_client_bindings_checksum_method_passwordhistoryentry_password: () => number;
export const uniffi_bittery_client_bindings_checksum_method_pendingshareresult_expires_at: () => number;
export const uniffi_bittery_client_bindings_checksum_method_pendingshareresult_item_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_pendingshareresult_operation_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_pendingshareresult_share_link_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_pendingshareresult_share_url: () => number;
export const uniffi_bittery_client_bindings_checksum_method_phonenumber_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_phonenumber_label: () => number;
export const uniffi_bittery_client_bindings_checksum_method_phonenumber_number: () => number;
export const uniffi_bittery_client_bindings_checksum_method_securenoteitemdata_custom_fields: () => number;
export const uniffi_bittery_client_bindings_checksum_method_securenoteitemdata_note: () => number;
export const uniffi_bittery_client_bindings_checksum_method_securenoteitemdata_notes: () => number;
export const uniffi_bittery_client_bindings_checksum_method_securenoteitemdata_tags: () => number;
export const uniffi_bittery_client_bindings_fn_clone_address: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_constructor_address_new: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_constructor_attachmentname_new: (
  a: number,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_constructor_attachmentuploadmetadata_new: (
  a: number,
  b: number,
  c: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_constructor_authenticatoritemdata_new: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number,
  j: number,
  k: number,
  l: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_constructor_creditcarditemdata_new: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number,
  j: number,
  k: number,
  l: number,
  m: number,
  n: number,
  o: number,
  p: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_constructor_customfield_new: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_constructor_identityitemdata_new: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number,
  j: number,
  k: number,
  l: number,
  m: number,
  n: number,
  o: number,
  p: number,
  q: number,
  r: number,
  s: number,
  t: number,
  u: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_constructor_loginitemdata_new: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number,
  j: number,
  k: number,
  l: number,
  m: number,
  n: number,
  o: number,
  p: number,
  q: number,
  r: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_constructor_passkey_new: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number,
  j: number,
  k: number,
  l: number,
  m: number,
  n: number,
  o: number,
  p: number,
  q: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_constructor_passwordhistoryentry_new: (
  a: number,
  b: number,
  c: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_constructor_phonenumber_new: (
  a: number,
  b: number,
  c: number,
  d: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_constructor_securenoteitemdata_new: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_free_address: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_client_bindings_fn_free_attachmentname: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_client_bindings_fn_free_attachmentprojection: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_client_bindings_fn_free_attachmentuploadmetadata: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_client_bindings_fn_free_authenticatoritemdata: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_client_bindings_fn_free_creditcarditemdata: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_client_bindings_fn_free_customfield: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_client_bindings_fn_free_identityitemdata: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_client_bindings_fn_free_itemprojection: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_client_bindings_fn_free_loginitemdata: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_client_bindings_fn_free_passkey: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_client_bindings_fn_free_pendingshareresult: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_client_bindings_fn_free_phonenumber: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_client_bindings_fn_free_securenoteitemdata: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_client_bindings_fn_func_normalize_account_email: (
  a: number,
  b: number,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_address_city: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_address_country: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_address_id: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_address_state: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_address_street: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_address_zip: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_attachmentprojection_account_id: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_attachmentprojection_attachment_id: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_attachmentprojection_content_type: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_attachmentprojection_created_at: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_attachmentprojection_file_size: (
  a: bigint,
  b: number,
) => number;
export const uniffi_bittery_client_bindings_fn_method_attachmentprojection_item_id: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_attachmentprojection_name: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_attachmentprojection_uploaded_by: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_attachmentprojection_vault_id: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_authenticatoritemdata_custom_fields: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_authenticatoritemdata_linked_item_id: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_authenticatoritemdata_notes: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_authenticatoritemdata_tags: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_authenticatoritemdata_title: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_authenticatoritemdata_totp_account_name: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_authenticatoritemdata_totp_algorithm: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_authenticatoritemdata_totp_digits: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_authenticatoritemdata_totp_issuer: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_authenticatoritemdata_totp_period: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_authenticatoritemdata_totp_secret: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_creditcarditemdata_billing_address: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_creditcarditemdata_card_number: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_creditcarditemdata_cardholder_name: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_creditcarditemdata_custom_fields: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_creditcarditemdata_cvv: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_creditcarditemdata_expiry_date: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_creditcarditemdata_notes: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_creditcarditemdata_tags: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_creditcarditemdata_title: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_creditcarditemdata_totp_account_name: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_creditcarditemdata_totp_algorithm: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_creditcarditemdata_totp_digits: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_creditcarditemdata_totp_issuer: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_creditcarditemdata_totp_period: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_creditcarditemdata_totp_secret: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_customfield_field_type: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_customfield_id: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_customfield_label: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_customfield_value: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_identityitemdata_addresses: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_identityitemdata_custom_fields: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_identityitemdata_date_of_birth: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_identityitemdata_drivers_license: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_identityitemdata_email: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_identityitemdata_first_name: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_identityitemdata_last_name: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_identityitemdata_middle_name: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_identityitemdata_notes: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_identityitemdata_passport_number: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_identityitemdata_phone_numbers: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_identityitemdata_ssn: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_identityitemdata_tags: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_identityitemdata_title: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_identityitemdata_totp_account_name: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_identityitemdata_totp_algorithm: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_identityitemdata_totp_digits: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_identityitemdata_totp_issuer: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_identityitemdata_totp_period: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_identityitemdata_totp_secret: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_itemprojection_account_id: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_itemprojection_attachments: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_itemprojection_created_at: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_itemprojection_data: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_itemprojection_deleted_at: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_itemprojection_favorite: (
  a: bigint,
  b: number,
) => number;
export const uniffi_bittery_client_bindings_fn_method_itemprojection_item_id: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_itemprojection_status: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_itemprojection_updated_at: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_itemprojection_vault_id: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemdata_custom_fields: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemdata_note: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemdata_notes: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemdata_passkeys: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemdata_password: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemdata_password_history: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemdata_tags: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemdata_title: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemdata_totp_account_name: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemdata_totp_algorithm: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemdata_totp_digits: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemdata_totp_issuer: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemdata_totp_period: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemdata_totp_secret: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemdata_url: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemdata_urls: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemdata_username: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_passkey_algorithm: (
  a: bigint,
  b: number,
) => number;
export const uniffi_bittery_client_bindings_fn_method_passkey_created_at: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_passkey_credential_id: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_passkey_last_used_at: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_passkey_private_key: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_passkey_public_key: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_passkey_rp_id: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_passkey_rp_name: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_passkey_sign_count: (
  a: bigint,
  b: number,
) => number;
export const uniffi_bittery_client_bindings_fn_method_passkey_status: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_passkey_status_reason: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_passkey_status_updated_at: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_passkey_transports: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_passkey_user_display_name: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_passkey_user_handle: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_passkey_user_name: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_passwordhistoryentry_changed_at: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_passwordhistoryentry_password: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_pendingshareresult_expires_at: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_pendingshareresult_item_id: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_pendingshareresult_operation_id: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_pendingshareresult_share_link_id: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_pendingshareresult_share_url: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_phonenumber_id: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_phonenumber_label: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_phonenumber_number: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_securenoteitemdata_custom_fields: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_securenoteitemdata_note: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_securenoteitemdata_notes: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_securenoteitemdata_tags: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_securenoteitemdata_title: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const webclientruntime_cancel: (a: number, b: number, c: number) => void;
export const webclientruntime_close: (a: number) => any;
export const webclientruntime_new: () => number;
export const webclientruntime_normalizeAccountEmail: (
  a: number,
  b: number,
) => [number, number, number, number];
export const webclientruntime_observe_json: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: any,
) => [number, number];
export const webclientruntime_open: (a: number) => any;
export const webclientruntime_request_json: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
) => any;
export const webclientruntime_unobserve: (
  a: number,
  b: number,
  c: number,
) => void;
export const webclientruntime_withConfiguredAttachmentMovePreparation: (
  a: any,
  b: any,
  c: any,
  d: any,
  e: any,
  f: any,
  g: any,
  h: number,
  i: number,
  j: number,
  k: number,
  l: number,
  m: number,
  n: any,
  o: any,
  p: any,
  q: any,
) => [number, number, number];
export const webclientruntime_withConfiguredExecutors: (
  a: any,
  b: any,
  c: any,
  d: any,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number,
  j: number,
) => [number, number, number];
export const webclientruntime_withExecutors: (
  a: any,
  b: any,
  c: any,
  d: any,
) => number;
export const webclientruntime_withReplicaExecutor: (a: any) => number;
export const uniffi_bittery_client_bindings_fn_clone_attachmentname: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_clone_attachmentprojection: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_clone_attachmentuploadmetadata: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_clone_authenticatoritemdata: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_clone_creditcarditemdata: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_clone_customfield: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_clone_identityitemdata: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_clone_itemprojection: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_clone_loginitemdata: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_clone_passkey: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_clone_passwordhistoryentry: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_clone_pendingshareresult: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_clone_phonenumber: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_clone_secretstring: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_clone_securenoteitemdata: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_checksum_method_passkey_status_reason: () => number;
export const uniffi_bittery_client_bindings_checksum_method_securenoteitemdata_title: () => number;
export const ffi_bittery_client_bindings_rust_future_free_f32: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_free_f64: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_free_i16: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_free_i32: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_free_i64: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_free_i8: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_free_rust_buffer: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_free_u16: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_free_u32: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_free_u64: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_free_u8: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_free_void: (
  a: bigint,
) => void;
export const uniffi_bittery_client_bindings_fn_constructor_secretstring_new: (
  a: number,
  b: number,
) => bigint;
export const ffi_bittery_client_bindings_rust_future_cancel_rust_buffer: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_cancel_i8: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_cancel_f64: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_cancel_u8: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_cancel_i32: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_cancel_u32: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_cancel_i16: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_cancel_u16: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_cancel_void: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_cancel_i64: (
  a: bigint,
) => void;
export const ffi_bittery_client_bindings_rust_future_cancel_u64: (
  a: bigint,
) => void;
export const uniffi_bittery_client_bindings_fn_free_secretstring: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_client_bindings_fn_free_passwordhistoryentry: (
  a: bigint,
  b: number,
) => void;
export const ffi_bittery_crypto_api_rustbuffer_alloc: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const ffi_bittery_crypto_api_rustbuffer_free: (
  a: number,
  b: number,
) => void;
export const ffi_bittery_crypto_api_rustbuffer_from_bytes: (
  a: number,
  b: number,
  c: number,
) => void;
export const ffi_bittery_crypto_api_rustbuffer_reserve: (
  a: number,
  b: number,
  c: bigint,
  d: number,
) => void;
export const wasm_bindgen_68d88193d3b0622c___convert__closures_____invoke___wasm_bindgen_68d88193d3b0622c___JsValue__core_9b3796e30d99ddb7___result__Result_____wasm_bindgen_68d88193d3b0622c___JsError___true_: (
  a: number,
  b: number,
  c: any,
) => [number, number];
export const wasm_bindgen_68d88193d3b0622c___convert__closures_____invoke___js_sys_111dd60f12cd5482___Function_fn_wasm_bindgen_68d88193d3b0622c___JsValue_____wasm_bindgen_68d88193d3b0622c___sys__Undefined___js_sys_111dd60f12cd5482___Function_fn_wasm_bindgen_68d88193d3b0622c___JsValue_____wasm_bindgen_68d88193d3b0622c___sys__Undefined_______true_: (
  a: number,
  b: number,
  c: any,
  d: any,
) => void;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (
  a: number,
  b: number,
  c: number,
  d: number,
) => number;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __wbindgen_destroy_closure: (a: number, b: number) => void;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_start: () => void;
