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
export const uniffi_bittery_client_bindings_checksum_constructor_logincustomfield_new: () => number;
export const uniffi_bittery_client_bindings_checksum_constructor_loginitemdraft_new: () => number;
export const uniffi_bittery_client_bindings_checksum_constructor_secretstring_new: () => number;
export const uniffi_bittery_client_bindings_checksum_method_attachmentprojection_account_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_attachmentprojection_attachment_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_attachmentprojection_content_type: () => number;
export const uniffi_bittery_client_bindings_checksum_method_attachmentprojection_created_at: () => number;
export const uniffi_bittery_client_bindings_checksum_method_attachmentprojection_file_size: () => number;
export const uniffi_bittery_client_bindings_checksum_method_attachmentprojection_item_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_attachmentprojection_name: () => number;
export const uniffi_bittery_client_bindings_checksum_method_attachmentprojection_storage_key: () => number;
export const uniffi_bittery_client_bindings_checksum_method_attachmentprojection_uploaded_by: () => number;
export const uniffi_bittery_client_bindings_checksum_method_attachmentprojection_vault_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_logincustomfield_field_type: () => number;
export const uniffi_bittery_client_bindings_checksum_method_logincustomfield_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_logincustomfield_label: () => number;
export const uniffi_bittery_client_bindings_checksum_method_logincustomfield_value: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemprojection_account_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemprojection_attachments: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemprojection_created_at: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemprojection_custom_fields: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemprojection_deleted_at: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemprojection_favorite: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemprojection_item_id: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemprojection_note: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemprojection_notes: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemprojection_password: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemprojection_status: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemprojection_tags: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemprojection_title: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemprojection_updated_at: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemprojection_url: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemprojection_urls: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemprojection_username: () => number;
export const uniffi_bittery_client_bindings_checksum_method_loginitemprojection_vault_id: () => number;
export const uniffi_bittery_client_bindings_fn_clone_attachmentprojection: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_constructor_logincustomfield_new: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_constructor_loginitemdraft_new: (
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
) => bigint;
export const uniffi_bittery_client_bindings_fn_constructor_secretstring_new: (
  a: number,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_free_attachmentprojection: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_client_bindings_fn_free_logincustomfield: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_client_bindings_fn_free_loginitemdraft: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_client_bindings_fn_free_loginitemprojection: (
  a: bigint,
  b: number,
) => void;
export const uniffi_bittery_client_bindings_fn_free_secretstring: (
  a: bigint,
  b: number,
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
export const uniffi_bittery_client_bindings_fn_method_attachmentprojection_storage_key: (
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
export const uniffi_bittery_client_bindings_fn_method_logincustomfield_field_type: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_logincustomfield_id: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_logincustomfield_label: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_logincustomfield_value: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemprojection_account_id: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemprojection_attachments: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemprojection_created_at: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemprojection_custom_fields: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemprojection_deleted_at: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemprojection_favorite: (
  a: bigint,
  b: number,
) => number;
export const uniffi_bittery_client_bindings_fn_method_loginitemprojection_item_id: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemprojection_note: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemprojection_notes: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemprojection_password: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemprojection_status: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemprojection_tags: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemprojection_title: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemprojection_updated_at: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemprojection_url: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemprojection_urls: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemprojection_username: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const uniffi_bittery_client_bindings_fn_method_loginitemprojection_vault_id: (
  a: number,
  b: bigint,
  c: number,
) => void;
export const webclientruntime_cancel: (a: number, b: number, c: number) => void;
export const webclientruntime_close: (a: number) => any;
export const webclientruntime_new: () => number;
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
export const uniffi_bittery_client_bindings_fn_clone_logincustomfield: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_clone_loginitemdraft: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_clone_loginitemprojection: (
  a: bigint,
  b: number,
) => bigint;
export const uniffi_bittery_client_bindings_fn_clone_secretstring: (
  a: bigint,
  b: number,
) => bigint;
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
