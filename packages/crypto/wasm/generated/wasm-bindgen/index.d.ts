/* tslint:disable */
/* eslint-disable */

export class RustCallStatus {
  free(): void;
  [Symbol.dispose](): void;
  constructor();
  code: number;
  get errorBuf(): Uint8Array | undefined;
  set errorBuf(value: Uint8Array | null | undefined);
}

export class WebClientRuntime {
  free(): void;
  [Symbol.dispose](): void;
  cancel(request_id: string): void;
  close(): Promise<void>;
  constructor();
  static normalizeAccountEmail(input: string): string;
  observe_json(
    observation_id: string,
    request_json: string,
    callback: Function,
  ): void;
  open(): Promise<void>;
  request_json(request_id: string, request_json: string): Promise<string>;
  unobserve(observation_id: string): void;
  static withConfiguredAttachmentMovePreparation(
    replica_invoke: Function,
    platform_storage_invoke: Function,
    http_invoke: Function,
    http_cancel: Function,
    artifact_executor: any,
    binary_executor: any,
    lease_executor: any,
    client_id: string,
    platform: string,
    version: string,
    lifecycle_error: Function,
  ): WebClientRuntime;
  static withConfiguredExecutors(
    replica_invoke: Function,
    platform_storage_invoke: Function,
    http_invoke: Function,
    http_cancel: Function,
    client_id: string,
    platform: string,
    version: string,
  ): WebClientRuntime;
  static withExecutors(
    replica_invoke: Function,
    platform_storage_invoke: Function,
    http_invoke: Function,
    http_cancel: Function,
  ): WebClientRuntime;
  static withReplicaExecutor(invoke: Function): WebClientRuntime;
}

export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_f32(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_f64(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_i16(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_i32(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_i64(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_i8(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_rust_buffer(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_u16(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_u32(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_u64(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_u8(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_void(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_complete_f32(
  handle: bigint,
  f_status_: RustCallStatus,
): number;

export function ubrn_ffi_bittery_crypto_api_rust_future_complete_f64(
  handle: bigint,
  f_status_: RustCallStatus,
): number;

export function ubrn_ffi_bittery_crypto_api_rust_future_complete_i16(
  handle: bigint,
  f_status_: RustCallStatus,
): number;

export function ubrn_ffi_bittery_crypto_api_rust_future_complete_i32(
  handle: bigint,
  f_status_: RustCallStatus,
): number;

export function ubrn_ffi_bittery_crypto_api_rust_future_complete_i64(
  handle: bigint,
  f_status_: RustCallStatus,
): bigint;

export function ubrn_ffi_bittery_crypto_api_rust_future_complete_i8(
  handle: bigint,
  f_status_: RustCallStatus,
): number;

export function ubrn_ffi_bittery_crypto_api_rust_future_complete_rust_buffer(
  handle: bigint,
  f_status_: RustCallStatus,
): Uint8Array;

export function ubrn_ffi_bittery_crypto_api_rust_future_complete_u16(
  handle: bigint,
  f_status_: RustCallStatus,
): number;

export function ubrn_ffi_bittery_crypto_api_rust_future_complete_u32(
  handle: bigint,
  f_status_: RustCallStatus,
): number;

export function ubrn_ffi_bittery_crypto_api_rust_future_complete_u64(
  handle: bigint,
  f_status_: RustCallStatus,
): bigint;

export function ubrn_ffi_bittery_crypto_api_rust_future_complete_u8(
  handle: bigint,
  f_status_: RustCallStatus,
): number;

export function ubrn_ffi_bittery_crypto_api_rust_future_complete_void(
  handle: bigint,
  f_status_: RustCallStatus,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_free_f32(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_free_f64(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_free_i16(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_free_i32(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_free_i64(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_free_i8(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_free_rust_buffer(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_free_u16(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_free_u32(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_free_u64(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_free_u8(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_free_void(
  handle: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_poll_f32(
  handle: bigint,
  callback: any,
  callback_data: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_poll_f64(
  handle: bigint,
  callback: any,
  callback_data: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_poll_i16(
  handle: bigint,
  callback: any,
  callback_data: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_poll_i32(
  handle: bigint,
  callback: any,
  callback_data: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_poll_i64(
  handle: bigint,
  callback: any,
  callback_data: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_poll_i8(
  handle: bigint,
  callback: any,
  callback_data: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_poll_rust_buffer(
  handle: bigint,
  callback: any,
  callback_data: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_poll_u16(
  handle: bigint,
  callback: any,
  callback_data: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_poll_u32(
  handle: bigint,
  callback: any,
  callback_data: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_poll_u64(
  handle: bigint,
  callback: any,
  callback_data: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_poll_u8(
  handle: bigint,
  callback: any,
  callback_data: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_rust_future_poll_void(
  handle: bigint,
  callback: any,
  callback_data: bigint,
): void;

export function ubrn_ffi_bittery_crypto_api_uniffi_contract_version(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_constructor_srpclient_new(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_constructor_srpserver_new(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_build_passkey_attestation_object(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_clone_key(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_many(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_master_key(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_rsa_wrapped_key(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_derive_client_session(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_derive_keys(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_derive_keys_from_master_key(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_derive_master_key(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_derive_srp_password(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_destroy_key(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_master_key(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_for_member(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_with_muk(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_export_key(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_client_ephemeral(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_encryption_key(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_passkey_credential_id(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_passkey_keypair(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_recovery_key(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_rsa_key_pair(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_secret_key(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_srp_registration(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_totp(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_totp_at(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_uuid(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_import_key(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_initialize(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_re_encrypt_item(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_rewrap_attachment_key(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_rsa_decrypt(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_rsa_encrypt(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_sign_passkey_assertion(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_unwrap_key(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_validate_recovery_key(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_validate_secret_key(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_verify_server_session(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_func_wrap_key(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_derive_safe_private_key(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_derive_verifier(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_generate_salt(): number;

export function ubrn_uniffi_bittery_crypto_api_checksum_method_srpserver_generate_ephemeral(): number;

export function ubrn_uniffi_bittery_crypto_api_fn_clone_keyhandle(
  handle: bigint,
  f_status_: RustCallStatus,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_clone_srpclient(
  handle: bigint,
  f_status_: RustCallStatus,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_clone_srpserver(
  handle: bigint,
  f_status_: RustCallStatus,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_constructor_srpclient_new(
  f_status_: RustCallStatus,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_constructor_srpserver_new(
  f_status_: RustCallStatus,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_free_keyhandle(
  handle: bigint,
  f_status_: RustCallStatus,
): void;

export function ubrn_uniffi_bittery_crypto_api_fn_free_srpclient(
  handle: bigint,
  f_status_: RustCallStatus,
): void;

export function ubrn_uniffi_bittery_crypto_api_fn_free_srpserver(
  handle: bigint,
  f_status_: RustCallStatus,
): void;

export function ubrn_uniffi_bittery_crypto_api_fn_func_build_passkey_attestation_object(
  rp_id: Uint8Array,
  credential_id_base64: Uint8Array,
  cose_public_key_base64: Uint8Array,
  sign_count: number,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_clone_key(
  key: bigint,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_decrypt(
  data: Uint8Array,
  key: bigint,
  context: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_many(
  requests: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_master_key(
  data: Uint8Array,
  recovery_key: Uint8Array,
  email: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_rsa_wrapped_key(
  ciphertext: Uint8Array,
  encrypted_private_key: Uint8Array,
  private_key_wrapping_key: bigint,
  private_key_context: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_derive_client_session(
  client_ephemeral_secret: Uint8Array,
  challenge: Uint8Array,
  password: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_derive_keys(
  account_password: Uint8Array,
  secret_key: Uint8Array,
  email: Uint8Array,
  profile: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_derive_keys_from_master_key(
  master_key: bigint,
  email: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_derive_master_key(
  account_password: Uint8Array,
  secret_key: Uint8Array,
  email: Uint8Array,
  profile: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_derive_srp_password(
  auth_key: bigint,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_destroy_key(
  key: bigint,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_encrypt(
  plaintext: Uint8Array,
  key: bigint,
  context: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_master_key(
  master_key: bigint,
  recovery_key: Uint8Array,
  email: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_for_member(
  vault_key: bigint,
  member_public_key_pem: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_with_muk(
  vault_key: bigint,
  master_unlock_key: bigint,
  vault_id: Uint8Array,
  user_id: Uint8Array,
  key_version: bigint,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_export_key(
  key: bigint,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_client_ephemeral(): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_encryption_key(): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_passkey_credential_id(): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_passkey_keypair(): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_recovery_key(): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_rsa_key_pair(): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_secret_key(): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_srp_registration(
  password: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_totp(
  secret: Uint8Array,
  algorithm: Uint8Array,
  digits: number,
  period: bigint,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_totp_at(
  secret: Uint8Array,
  algorithm: Uint8Array,
  digits: number,
  period: bigint,
  timestamp: bigint,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_uuid(): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_import_key(
  key: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_initialize(): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_re_encrypt_item(
  item: Uint8Array,
  old_vault_key: bigint,
  new_vault_key: bigint,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_rewrap_attachment_key(
  encrypted_attachment_key: Uint8Array,
  old_vault_key: bigint,
  new_vault_key: bigint,
  old_context: Uint8Array,
  new_context: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_rsa_decrypt(
  ciphertext: Uint8Array,
  private_key_pem: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_rsa_encrypt(
  plaintext: Uint8Array,
  public_key_pem: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_sign_passkey_assertion(
  private_key_base64: Uint8Array,
  rp_id: Uint8Array,
  client_data_hash_base64: Uint8Array,
  sign_count: number,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_unwrap_key(
  data: Uint8Array,
  wrapping_key: bigint,
  context: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_validate_recovery_key(
  recovery_key: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_validate_secret_key(
  secret_key: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_verify_server_session(
  client_public_ephemeral: Uint8Array,
  session: Uint8Array,
  server_session_proof: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_func_wrap_key(
  key: bigint,
  wrapping_key: bigint,
  context: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_derive_safe_private_key(
  ptr: bigint,
  salt: Uint8Array,
  password: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_derive_verifier(
  ptr: bigint,
  private_key: Uint8Array,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_generate_salt(
  ptr: bigint,
): bigint;

export function ubrn_uniffi_bittery_crypto_api_fn_method_srpserver_generate_ephemeral(
  ptr: bigint,
  verifier: Uint8Array,
): bigint;

export type InitInput =
  RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly uniffi_bittery_crypto_api_fn_clone_keyhandle: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_derive_srp_password: (
    a: bigint,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_destroy_key: (a: bigint) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_encrypt: (
    a: number,
    b: bigint,
    c: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_generate_rsa_key_pair: () => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_generate_secret_key: () => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_generate_srp_registration: (
    a: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_generate_totp: (
    a: number,
    b: number,
    c: number,
    d: bigint,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_generate_totp_at: (
    a: number,
    b: number,
    c: number,
    d: bigint,
    e: bigint,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_generate_uuid: () => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_import_key: (a: number) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_initialize: () => bigint;
  readonly uniffi_bittery_crypto_api_fn_free_keyhandle: (
    a: bigint,
    b: number,
  ) => void;
  readonly uniffi_bittery_crypto_api_fn_func_encrypt_master_key: (
    a: bigint,
    b: number,
    c: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_for_member: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_with_muk: (
    a: bigint,
    b: bigint,
    c: number,
    d: number,
    e: bigint,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_export_key: (a: bigint) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_generate_client_ephemeral: () => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_generate_encryption_key: () => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_generate_passkey_credential_id: () => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_generate_passkey_keypair: () => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_generate_recovery_key: () => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_re_encrypt_item: (
    a: number,
    b: bigint,
    c: bigint,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_rewrap_attachment_key: (
    a: number,
    b: bigint,
    c: bigint,
    d: number,
    e: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_rsa_decrypt: (
    a: number,
    b: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_rsa_encrypt: (
    a: number,
    b: number,
  ) => bigint;
  readonly ffi_bittery_crypto_api_rust_future_free_u8: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_complete_u8: (
    a: bigint,
    b: number,
  ) => number;
  readonly ffi_bittery_crypto_api_rust_future_poll_i8: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_crypto_api_rust_future_cancel_i8: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_free_i8: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_complete_i8: (
    a: bigint,
    b: number,
  ) => number;
  readonly ffi_bittery_crypto_api_rust_future_poll_u16: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_crypto_api_rust_future_cancel_u16: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_free_u16: (a: bigint) => void;
  readonly uniffi_bittery_crypto_api_fn_func_sign_passkey_assertion: (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_unwrap_key: (
    a: number,
    b: bigint,
    c: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_validate_recovery_key: (
    a: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_validate_secret_key: (
    a: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_verify_server_session: (
    a: number,
    b: number,
    c: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_wrap_key: (
    a: bigint,
    b: bigint,
    c: number,
  ) => bigint;
  readonly ffi_bittery_crypto_api_rust_future_poll_u8: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_crypto_api_rust_future_cancel_u8: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_complete_u16: (
    a: bigint,
    b: number,
  ) => number;
  readonly ffi_bittery_crypto_api_rust_future_poll_i16: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_crypto_api_rust_future_cancel_i16: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_complete_i32: (
    a: bigint,
    b: number,
  ) => number;
  readonly ffi_bittery_crypto_api_rust_future_poll_u64: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_crypto_api_rust_future_cancel_u64: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_free_u64: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_complete_u64: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly ffi_bittery_crypto_api_rust_future_poll_i64: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_crypto_api_rust_future_cancel_i64: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_free_i64: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_complete_i64: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly ffi_bittery_crypto_api_rust_future_free_i16: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_complete_i16: (
    a: bigint,
    b: number,
  ) => number;
  readonly ffi_bittery_crypto_api_rust_future_poll_u32: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_crypto_api_rust_future_cancel_u32: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_free_u32: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_complete_u32: (
    a: bigint,
    b: number,
  ) => number;
  readonly ffi_bittery_crypto_api_rust_future_poll_i32: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_crypto_api_rust_future_cancel_i32: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_free_i32: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_poll_f32: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_crypto_api_rust_future_cancel_f32: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_free_f32: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_poll_void: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_crypto_api_rust_future_cancel_void: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_free_void: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_complete_void: (
    a: bigint,
    b: number,
  ) => void;
  readonly uniffi_bittery_crypto_api_checksum_func_build_passkey_attestation_object: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_clone_key: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_decrypt: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_decrypt_many: () => number;
  readonly uniffi_bittery_crypto_api_fn_clone_srpclient: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly ffi_bittery_crypto_api_rust_future_complete_f32: (
    a: bigint,
    b: number,
  ) => number;
  readonly ffi_bittery_crypto_api_rust_future_poll_f64: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_crypto_api_rust_future_cancel_f64: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_free_f64: (a: bigint) => void;
  readonly ffi_bittery_crypto_api_rust_future_complete_f64: (
    a: bigint,
    b: number,
  ) => number;
  readonly ffi_bittery_crypto_api_rust_future_poll_rust_buffer: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_crypto_api_rust_future_cancel_rust_buffer: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_crypto_api_rust_future_free_rust_buffer: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_crypto_api_rust_future_complete_rust_buffer: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_crypto_api_checksum_func_decrypt_master_key: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_decrypt_rsa_wrapped_key: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_derive_client_session: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_derive_keys: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_export_key: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_generate_client_ephemeral: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_generate_encryption_key: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_generate_passkey_credential_id: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_generate_passkey_keypair: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_generate_recovery_key: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_generate_rsa_key_pair: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_generate_secret_key: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_generate_srp_registration: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_derive_keys_from_master_key: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_derive_master_key: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_derive_srp_password: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_destroy_key: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_encrypt: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_encrypt_master_key: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_for_member: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_with_muk: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_generate_totp: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_generate_totp_at: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_generate_uuid: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_validate_secret_key: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_verify_server_session: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_wrap_key: () => number;
  readonly uniffi_bittery_crypto_api_checksum_method_srpclient_derive_safe_private_key: () => number;
  readonly uniffi_bittery_crypto_api_checksum_method_srpclient_derive_verifier: () => number;
  readonly uniffi_bittery_crypto_api_checksum_method_srpclient_generate_salt: () => number;
  readonly uniffi_bittery_crypto_api_checksum_method_srpserver_generate_ephemeral: () => number;
  readonly uniffi_bittery_crypto_api_checksum_constructor_srpclient_new: () => number;
  readonly uniffi_bittery_crypto_api_checksum_constructor_srpserver_new: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_import_key: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_initialize: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_re_encrypt_item: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_rewrap_attachment_key: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_rsa_decrypt: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_rsa_encrypt: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_sign_passkey_assertion: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_unwrap_key: () => number;
  readonly uniffi_bittery_crypto_api_checksum_func_validate_recovery_key: () => number;
  readonly ffi_bittery_crypto_api_uniffi_contract_version: () => number;
  readonly uniffi_bittery_crypto_api_fn_free_srpclient: (
    a: bigint,
    b: number,
  ) => void;
  readonly uniffi_bittery_crypto_api_fn_func_clone_key: (a: bigint) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_decrypt: (
    a: number,
    b: bigint,
    c: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_decrypt_many: (
    a: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_decrypt_master_key: (
    a: number,
    b: number,
    c: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_decrypt_rsa_wrapped_key: (
    a: number,
    b: number,
    c: bigint,
    d: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_derive_client_session: (
    a: number,
    b: number,
    c: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_derive_keys: (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_derive_keys_from_master_key: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_derive_master_key: (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_constructor_srpclient_new: (
    a: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_method_srpclient_derive_safe_private_key: (
    a: bigint,
    b: number,
    c: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_method_srpclient_derive_verifier: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_method_srpclient_generate_salt: (
    a: bigint,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_clone_srpserver: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_free_srpserver: (
    a: bigint,
    b: number,
  ) => void;
  readonly uniffi_bittery_crypto_api_fn_constructor_srpserver_new: (
    a: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_method_srpserver_generate_ephemeral: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly uniffi_bittery_crypto_api_fn_func_build_passkey_attestation_object: (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => bigint;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_cancel_f32: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_cancel_f64: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_cancel_i16: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_cancel_i32: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_cancel_i64: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_cancel_i8: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_cancel_rust_buffer: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_cancel_u16: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_cancel_u32: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_cancel_u64: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_cancel_u8: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_cancel_void: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_complete_f32: (
    a: bigint,
    b: number,
  ) => number;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_complete_f64: (
    a: bigint,
    b: number,
  ) => number;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_complete_i16: (
    a: bigint,
    b: number,
  ) => number;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_complete_i32: (
    a: bigint,
    b: number,
  ) => number;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_complete_i64: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_complete_i8: (
    a: bigint,
    b: number,
  ) => number;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_complete_rust_buffer: (
    a: bigint,
    b: number,
  ) => [number, number];
  readonly ubrn_ffi_bittery_crypto_api_rust_future_complete_u16: (
    a: bigint,
    b: number,
  ) => number;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_complete_u32: (
    a: bigint,
    b: number,
  ) => number;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_complete_u64: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_complete_u8: (
    a: bigint,
    b: number,
  ) => number;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_complete_void: (
    a: bigint,
    b: number,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_free_f32: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_free_f64: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_free_i16: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_free_i32: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_free_i64: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_free_i8: (a: bigint) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_free_rust_buffer: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_free_u16: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_free_u32: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_free_u64: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_free_u8: (a: bigint) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_free_void: (
    a: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_poll_f32: (
    a: bigint,
    b: any,
    c: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_poll_f64: (
    a: bigint,
    b: any,
    c: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_poll_i16: (
    a: bigint,
    b: any,
    c: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_poll_i32: (
    a: bigint,
    b: any,
    c: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_poll_i64: (
    a: bigint,
    b: any,
    c: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_poll_i8: (
    a: bigint,
    b: any,
    c: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_poll_rust_buffer: (
    a: bigint,
    b: any,
    c: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_poll_u16: (
    a: bigint,
    b: any,
    c: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_poll_u32: (
    a: bigint,
    b: any,
    c: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_poll_u64: (
    a: bigint,
    b: any,
    c: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_poll_u8: (
    a: bigint,
    b: any,
    c: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_rust_future_poll_void: (
    a: bigint,
    b: any,
    c: bigint,
  ) => void;
  readonly ubrn_ffi_bittery_crypto_api_uniffi_contract_version: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_constructor_srpclient_new: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_constructor_srpserver_new: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_build_passkey_attestation_object: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_clone_key: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_many: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_master_key: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_rsa_wrapped_key: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_derive_client_session: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_derive_keys: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_derive_keys_from_master_key: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_derive_master_key: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_derive_srp_password: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_destroy_key: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_master_key: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_for_member: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_with_muk: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_export_key: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_generate_client_ephemeral: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_generate_encryption_key: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_generate_passkey_credential_id: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_generate_passkey_keypair: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_generate_recovery_key: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_generate_rsa_key_pair: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_generate_secret_key: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_generate_srp_registration: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_generate_totp: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_generate_totp_at: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_generate_uuid: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_import_key: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_initialize: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_re_encrypt_item: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_rewrap_attachment_key: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_rsa_decrypt: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_rsa_encrypt: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_sign_passkey_assertion: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_unwrap_key: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_validate_recovery_key: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_validate_secret_key: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_verify_server_session: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_func_wrap_key: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_derive_safe_private_key: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_derive_verifier: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_generate_salt: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_checksum_method_srpserver_generate_ephemeral: () => number;
  readonly ubrn_uniffi_bittery_crypto_api_fn_clone_keyhandle: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_clone_srpclient: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_clone_srpserver: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_constructor_srpclient_new: (
    a: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_constructor_srpserver_new: (
    a: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_free_keyhandle: (
    a: bigint,
    b: number,
  ) => void;
  readonly ubrn_uniffi_bittery_crypto_api_fn_free_srpclient: (
    a: bigint,
    b: number,
  ) => void;
  readonly ubrn_uniffi_bittery_crypto_api_fn_free_srpserver: (
    a: bigint,
    b: number,
  ) => void;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_build_passkey_attestation_object: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_clone_key: (
    a: bigint,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_decrypt: (
    a: number,
    b: number,
    c: bigint,
    d: number,
    e: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_many: (
    a: number,
    b: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_master_key: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_rsa_wrapped_key: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: bigint,
    f: number,
    g: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_derive_client_session: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_derive_keys: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_derive_keys_from_master_key: (
    a: bigint,
    b: number,
    c: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_derive_master_key: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_derive_srp_password: (
    a: bigint,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_destroy_key: (
    a: bigint,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_encrypt: (
    a: number,
    b: number,
    c: bigint,
    d: number,
    e: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_master_key: (
    a: bigint,
    b: number,
    c: number,
    d: number,
    e: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_for_member: (
    a: bigint,
    b: number,
    c: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_with_muk: (
    a: bigint,
    b: bigint,
    c: number,
    d: number,
    e: number,
    f: number,
    g: bigint,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_export_key: (
    a: bigint,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_generate_srp_registration: (
    a: number,
    b: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_generate_totp: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: bigint,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_generate_totp_at: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: bigint,
    g: bigint,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_import_key: (
    a: number,
    b: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_re_encrypt_item: (
    a: number,
    b: number,
    c: bigint,
    d: bigint,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_rewrap_attachment_key: (
    a: number,
    b: number,
    c: bigint,
    d: bigint,
    e: number,
    f: number,
    g: number,
    h: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_rsa_decrypt: (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_rsa_encrypt: (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_sign_passkey_assertion: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_unwrap_key: (
    a: number,
    b: number,
    c: bigint,
    d: number,
    e: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_validate_recovery_key: (
    a: number,
    b: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_validate_secret_key: (
    a: number,
    b: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_verify_server_session: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_wrap_key: (
    a: bigint,
    b: bigint,
    c: number,
    d: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_derive_safe_private_key: (
    a: bigint,
    b: number,
    c: number,
    d: number,
    e: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_derive_verifier: (
    a: bigint,
    b: number,
    c: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_generate_salt: (
    a: bigint,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_method_srpserver_generate_ephemeral: (
    a: bigint,
    b: number,
    c: number,
  ) => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_generate_client_ephemeral: () => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_generate_encryption_key: () => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_generate_passkey_credential_id: () => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_generate_passkey_keypair: () => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_generate_recovery_key: () => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_generate_rsa_key_pair: () => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_generate_secret_key: () => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_generate_uuid: () => bigint;
  readonly ubrn_uniffi_bittery_crypto_api_fn_func_initialize: () => bigint;
  readonly __wbg_get_rustcallstatus_code: (a: number) => number;
  readonly __wbg_rustcallstatus_free: (a: number, b: number) => void;
  readonly __wbg_set_rustcallstatus_code: (a: number, b: number) => void;
  readonly rustcallstatus_error_buf: (a: number) => [number, number];
  readonly rustcallstatus_new: () => number;
  readonly rustcallstatus_set_error_buf: (
    a: number,
    b: number,
    c: number,
  ) => void;
  readonly __wbg_webclientruntime_free: (a: number, b: number) => void;
  readonly ffi_bittery_client_bindings_rust_future_cancel_f32: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_complete_f32: (
    a: bigint,
    b: number,
  ) => number;
  readonly ffi_bittery_client_bindings_rust_future_complete_f64: (
    a: bigint,
    b: number,
  ) => number;
  readonly ffi_bittery_client_bindings_rust_future_complete_i16: (
    a: bigint,
    b: number,
  ) => number;
  readonly ffi_bittery_client_bindings_rust_future_complete_i32: (
    a: bigint,
    b: number,
  ) => number;
  readonly ffi_bittery_client_bindings_rust_future_complete_i64: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly ffi_bittery_client_bindings_rust_future_complete_i8: (
    a: bigint,
    b: number,
  ) => number;
  readonly ffi_bittery_client_bindings_rust_future_complete_rust_buffer: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_complete_u16: (
    a: bigint,
    b: number,
  ) => number;
  readonly ffi_bittery_client_bindings_rust_future_complete_u32: (
    a: bigint,
    b: number,
  ) => number;
  readonly ffi_bittery_client_bindings_rust_future_complete_u64: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly ffi_bittery_client_bindings_rust_future_complete_u8: (
    a: bigint,
    b: number,
  ) => number;
  readonly ffi_bittery_client_bindings_rust_future_complete_void: (
    a: bigint,
    b: number,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_poll_f32: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_poll_f64: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_poll_i16: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_poll_i32: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_poll_i64: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_poll_i8: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_poll_rust_buffer: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_poll_u16: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_poll_u32: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_poll_u64: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_poll_u8: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_poll_void: (
    a: bigint,
    b: number,
    c: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rustbuffer_alloc: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly ffi_bittery_client_bindings_rustbuffer_free: (
    a: number,
    b: number,
  ) => void;
  readonly ffi_bittery_client_bindings_rustbuffer_from_bytes: (
    a: number,
    b: number,
    c: number,
  ) => void;
  readonly ffi_bittery_client_bindings_rustbuffer_reserve: (
    a: number,
    b: number,
    c: bigint,
    d: number,
  ) => void;
  readonly ffi_bittery_client_bindings_uniffi_contract_version: () => number;
  readonly uniffi_bittery_client_bindings_checksum_constructor_attachmentname_new: () => number;
  readonly uniffi_bittery_client_bindings_checksum_constructor_logincustomfield_new: () => number;
  readonly uniffi_bittery_client_bindings_checksum_constructor_loginitemdraft_new: () => number;
  readonly uniffi_bittery_client_bindings_checksum_constructor_secretstring_new: () => number;
  readonly uniffi_bittery_client_bindings_checksum_func_normalize_account_email: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_attachmentprojection_account_id: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_attachmentprojection_attachment_id: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_attachmentprojection_content_type: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_attachmentprojection_created_at: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_attachmentprojection_file_size: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_attachmentprojection_item_id: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_attachmentprojection_name: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_attachmentprojection_uploaded_by: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_attachmentprojection_vault_id: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_logincustomfield_field_type: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_logincustomfield_id: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_logincustomfield_label: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_logincustomfield_value: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_loginitemprojection_account_id: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_loginitemprojection_attachments: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_loginitemprojection_created_at: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_loginitemprojection_custom_fields: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_loginitemprojection_deleted_at: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_loginitemprojection_favorite: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_loginitemprojection_item_id: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_loginitemprojection_note: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_loginitemprojection_notes: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_loginitemprojection_password: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_loginitemprojection_status: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_loginitemprojection_tags: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_loginitemprojection_title: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_loginitemprojection_updated_at: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_loginitemprojection_url: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_loginitemprojection_urls: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_loginitemprojection_username: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_loginitemprojection_vault_id: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_pendingshareresult_expires_at: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_pendingshareresult_item_id: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_pendingshareresult_operation_id: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_pendingshareresult_share_link_id: () => number;
  readonly uniffi_bittery_client_bindings_checksum_method_pendingshareresult_share_url: () => number;
  readonly uniffi_bittery_client_bindings_fn_clone_attachmentname: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly uniffi_bittery_client_bindings_fn_constructor_attachmentname_new: (
    a: number,
    b: number,
  ) => bigint;
  readonly uniffi_bittery_client_bindings_fn_constructor_logincustomfield_new: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
  ) => bigint;
  readonly uniffi_bittery_client_bindings_fn_constructor_loginitemdraft_new: (
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
  readonly uniffi_bittery_client_bindings_fn_free_attachmentname: (
    a: bigint,
    b: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_free_attachmentprojection: (
    a: bigint,
    b: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_free_logincustomfield: (
    a: bigint,
    b: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_free_loginitemdraft: (
    a: bigint,
    b: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_free_loginitemprojection: (
    a: bigint,
    b: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_free_pendingshareresult: (
    a: bigint,
    b: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_func_normalize_account_email: (
    a: number,
    b: number,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_attachmentprojection_account_id: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_attachmentprojection_attachment_id: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_attachmentprojection_content_type: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_attachmentprojection_created_at: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_attachmentprojection_file_size: (
    a: bigint,
    b: number,
  ) => number;
  readonly uniffi_bittery_client_bindings_fn_method_attachmentprojection_item_id: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_attachmentprojection_name: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_attachmentprojection_uploaded_by: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_attachmentprojection_vault_id: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_logincustomfield_field_type: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_logincustomfield_id: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_logincustomfield_label: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_logincustomfield_value: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_loginitemprojection_account_id: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_loginitemprojection_attachments: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_loginitemprojection_created_at: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_loginitemprojection_custom_fields: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_loginitemprojection_deleted_at: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_loginitemprojection_favorite: (
    a: bigint,
    b: number,
  ) => number;
  readonly uniffi_bittery_client_bindings_fn_method_loginitemprojection_item_id: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_loginitemprojection_note: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_loginitemprojection_notes: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_loginitemprojection_password: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_loginitemprojection_status: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_loginitemprojection_tags: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_loginitemprojection_title: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_loginitemprojection_updated_at: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_loginitemprojection_url: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_loginitemprojection_urls: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_loginitemprojection_username: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_loginitemprojection_vault_id: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_pendingshareresult_expires_at: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_pendingshareresult_item_id: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_pendingshareresult_operation_id: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_pendingshareresult_share_link_id: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_method_pendingshareresult_share_url: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly webclientruntime_cancel: (a: number, b: number, c: number) => void;
  readonly webclientruntime_close: (a: number) => any;
  readonly webclientruntime_new: () => number;
  readonly webclientruntime_normalizeAccountEmail: (
    a: number,
    b: number,
  ) => [number, number, number, number];
  readonly webclientruntime_observe_json: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: any,
  ) => [number, number];
  readonly webclientruntime_open: (a: number) => any;
  readonly webclientruntime_request_json: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
  ) => any;
  readonly webclientruntime_unobserve: (
    a: number,
    b: number,
    c: number,
  ) => void;
  readonly webclientruntime_withConfiguredAttachmentMovePreparation: (
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
  readonly webclientruntime_withConfiguredExecutors: (
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
  readonly webclientruntime_withExecutors: (
    a: any,
    b: any,
    c: any,
    d: any,
  ) => number;
  readonly webclientruntime_withReplicaExecutor: (a: any) => number;
  readonly uniffi_bittery_client_bindings_fn_clone_attachmentprojection: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly uniffi_bittery_client_bindings_fn_clone_logincustomfield: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly uniffi_bittery_client_bindings_fn_clone_loginitemdraft: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly uniffi_bittery_client_bindings_fn_clone_loginitemprojection: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly uniffi_bittery_client_bindings_fn_clone_pendingshareresult: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly uniffi_bittery_client_bindings_fn_clone_secretstring: (
    a: bigint,
    b: number,
  ) => bigint;
  readonly ffi_bittery_client_bindings_rust_future_free_f32: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_free_f64: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_free_i16: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_free_i32: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_free_i64: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_free_i8: (a: bigint) => void;
  readonly ffi_bittery_client_bindings_rust_future_free_rust_buffer: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_free_u16: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_free_u32: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_free_u64: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_free_u8: (a: bigint) => void;
  readonly ffi_bittery_client_bindings_rust_future_free_void: (
    a: bigint,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_constructor_secretstring_new: (
    a: number,
    b: number,
  ) => bigint;
  readonly ffi_bittery_client_bindings_rust_future_cancel_rust_buffer: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_cancel_i8: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_cancel_f64: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_cancel_u8: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_cancel_i32: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_cancel_u32: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_cancel_i16: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_cancel_u16: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_cancel_void: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_cancel_i64: (
    a: bigint,
  ) => void;
  readonly ffi_bittery_client_bindings_rust_future_cancel_u64: (
    a: bigint,
  ) => void;
  readonly uniffi_bittery_client_bindings_fn_free_secretstring: (
    a: bigint,
    b: number,
  ) => void;
  readonly ffi_bittery_crypto_api_rustbuffer_alloc: (
    a: number,
    b: bigint,
    c: number,
  ) => void;
  readonly ffi_bittery_crypto_api_rustbuffer_free: (
    a: number,
    b: number,
  ) => void;
  readonly ffi_bittery_crypto_api_rustbuffer_from_bytes: (
    a: number,
    b: number,
    c: number,
  ) => void;
  readonly ffi_bittery_crypto_api_rustbuffer_reserve: (
    a: number,
    b: number,
    c: bigint,
    d: number,
  ) => void;
  readonly wasm_bindgen_68d88193d3b0622c___convert__closures_____invoke___wasm_bindgen_68d88193d3b0622c___JsValue__core_9b3796e30d99ddb7___result__Result_____wasm_bindgen_68d88193d3b0622c___JsError___true_: (
    a: number,
    b: number,
    c: any,
  ) => [number, number];
  readonly wasm_bindgen_68d88193d3b0622c___convert__closures_____invoke___js_sys_111dd60f12cd5482___Function_fn_wasm_bindgen_68d88193d3b0622c___JsValue_____wasm_bindgen_68d88193d3b0622c___sys__Undefined___js_sys_111dd60f12cd5482___Function_fn_wasm_bindgen_68d88193d3b0622c___JsValue_____wasm_bindgen_68d88193d3b0622c___sys__Undefined_______true_: (
    a: number,
    b: number,
    c: any,
    d: any,
  ) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(
  module: { module: SyncInitInput } | SyncInitInput,
): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init(
  module_or_path:
    | { module_or_path: InitInput | Promise<InitInput> }
    | InitInput
    | Promise<InitInput>,
): Promise<InitOutput>;
