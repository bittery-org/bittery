/* @ts-self-types="./index.d.ts" */

export class RustCallStatus {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RustCallStatusFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rustcallstatus_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get code() {
        const ret = wasm.__wbg_get_rustcallstatus_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint8Array | undefined}
     */
    get errorBuf() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.rustcallstatus_error_buf(ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    constructor() {
        const ret = wasm.rustcallstatus_new();
        this.__wbg_ptr = ret;
        RustCallStatusFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Uint8Array | null} [bytes]
     */
    set errorBuf(bytes) {
        var ptr0 = isLikeNone(bytes) ? 0 : passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        var len0 = WASM_VECTOR_LEN;
        wasm.rustcallstatus_set_error_buf(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {number} arg0
     */
    set code(arg0) {
        wasm.__wbg_set_rustcallstatus_code(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) RustCallStatus.prototype[Symbol.dispose] = RustCallStatus.prototype.free;

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_f32(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_cancel_f32(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_f64(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_cancel_f64(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_i16(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_cancel_i16(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_i32(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_cancel_i32(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_i64(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_cancel_i64(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_i8(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_cancel_i8(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_rust_buffer(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_cancel_rust_buffer(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_u16(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_cancel_u16(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_u32(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_cancel_u32(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_u64(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_cancel_u64(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_u8(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_cancel_u8(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_void(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_cancel_void(handle);
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {number}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_f32(handle, f_status_) {
    _assertClass(f_status_, RustCallStatus);
    const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_f32(handle, f_status_.__wbg_ptr);
    return ret;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {number}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_f64(handle, f_status_) {
    _assertClass(f_status_, RustCallStatus);
    const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_f64(handle, f_status_.__wbg_ptr);
    return ret;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {number}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_i16(handle, f_status_) {
    _assertClass(f_status_, RustCallStatus);
    const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_i16(handle, f_status_.__wbg_ptr);
    return ret;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {number}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_i32(handle, f_status_) {
    _assertClass(f_status_, RustCallStatus);
    const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_i32(handle, f_status_.__wbg_ptr);
    return ret;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {bigint}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_i64(handle, f_status_) {
    _assertClass(f_status_, RustCallStatus);
    const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_i64(handle, f_status_.__wbg_ptr);
    return ret;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {number}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_i8(handle, f_status_) {
    _assertClass(f_status_, RustCallStatus);
    const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_i8(handle, f_status_.__wbg_ptr);
    return ret;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {Uint8Array}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_rust_buffer(handle, f_status_) {
    _assertClass(f_status_, RustCallStatus);
    const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_rust_buffer(handle, f_status_.__wbg_ptr);
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {number}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_u16(handle, f_status_) {
    _assertClass(f_status_, RustCallStatus);
    const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_u16(handle, f_status_.__wbg_ptr);
    return ret;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {number}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_u32(handle, f_status_) {
    _assertClass(f_status_, RustCallStatus);
    const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_u32(handle, f_status_.__wbg_ptr);
    return ret >>> 0;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {bigint}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_u64(handle, f_status_) {
    _assertClass(f_status_, RustCallStatus);
    const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_u64(handle, f_status_.__wbg_ptr);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {number}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_u8(handle, f_status_) {
    _assertClass(f_status_, RustCallStatus);
    const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_u8(handle, f_status_.__wbg_ptr);
    return ret;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_void(handle, f_status_) {
    _assertClass(f_status_, RustCallStatus);
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_void(handle, f_status_.__wbg_ptr);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_free_f32(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_free_f32(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_free_f64(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_free_f64(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_free_i16(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_free_i16(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_free_i32(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_free_i32(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_free_i64(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_free_i64(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_free_i8(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_free_i8(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_free_rust_buffer(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_free_rust_buffer(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_free_u16(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_free_u16(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_free_u32(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_free_u32(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_free_u64(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_free_u64(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_free_u8(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_free_u8(handle);
}

/**
 * @param {bigint} handle
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_free_void(handle) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_free_void(handle);
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_f32(handle, callback, callback_data) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_f32(handle, callback, callback_data);
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_f64(handle, callback, callback_data) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_f64(handle, callback, callback_data);
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_i16(handle, callback, callback_data) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_i16(handle, callback, callback_data);
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_i32(handle, callback, callback_data) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_i32(handle, callback, callback_data);
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_i64(handle, callback, callback_data) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_i64(handle, callback, callback_data);
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_i8(handle, callback, callback_data) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_i8(handle, callback, callback_data);
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_rust_buffer(handle, callback, callback_data) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_rust_buffer(handle, callback, callback_data);
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_u16(handle, callback, callback_data) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_u16(handle, callback, callback_data);
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_u32(handle, callback, callback_data) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_u32(handle, callback, callback_data);
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_u64(handle, callback, callback_data) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_u64(handle, callback, callback_data);
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_u8(handle, callback, callback_data) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_u8(handle, callback, callback_data);
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_void(handle, callback, callback_data) {
    wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_void(handle, callback, callback_data);
}

/**
 * @returns {number}
 */
export function ubrn_ffi_bittery_crypto_api_uniffi_contract_version() {
    const ret = wasm.ubrn_ffi_bittery_crypto_api_uniffi_contract_version();
    return ret >>> 0;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_constructor_srpclient_new() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_constructor_srpclient_new();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_constructor_srpserver_new() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_constructor_srpserver_new();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_build_passkey_attestation_object() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_build_passkey_attestation_object();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_clone_key() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_clone_key();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_many() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_many();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_master_key() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_master_key();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_rsa_wrapped_key() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_rsa_wrapped_key();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_derive_client_session() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_derive_client_session();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_derive_keys() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_derive_keys();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_derive_keys_from_master_key() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_derive_keys_from_master_key();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_derive_master_key() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_derive_master_key();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_derive_srp_password() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_derive_srp_password();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_destroy_key() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_destroy_key();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_master_key() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_master_key();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_for_member() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_for_member();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_with_muk() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_with_muk();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_export_key() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_export_key();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_client_ephemeral() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_client_ephemeral();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_encryption_key() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_encryption_key();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_passkey_credential_id() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_passkey_credential_id();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_passkey_keypair() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_passkey_keypair();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_recovery_key() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_recovery_key();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_rsa_key_pair() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_rsa_key_pair();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_secret_key() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_secret_key();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_srp_registration() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_srp_registration();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_totp() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_totp();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_totp_at() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_totp_at();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_uuid() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_uuid();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_import_key() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_import_key();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_initialize() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_initialize();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_perform_key_rotation() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_perform_key_rotation();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_re_encrypt_item() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_re_encrypt_item();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_rsa_decrypt() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_rsa_decrypt();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_rsa_encrypt() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_rsa_encrypt();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_sign_passkey_assertion() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_sign_passkey_assertion();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_unwrap_key() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_unwrap_key();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_validate_recovery_key() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_validate_recovery_key();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_validate_rotation_data() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_validate_rotation_data();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_validate_secret_key() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_validate_secret_key();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_verify_server_session() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_verify_server_session();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_wrap_key() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_wrap_key();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_method_keyhandle_destroy() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_method_keyhandle_destroy();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_derive_safe_private_key() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_derive_safe_private_key();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_derive_verifier() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_derive_verifier();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_generate_salt() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_generate_salt();
    return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_method_srpserver_generate_ephemeral() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_checksum_method_srpserver_generate_ephemeral();
    return ret;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_clone_keyhandle(handle, f_status_) {
    _assertClass(f_status_, RustCallStatus);
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_clone_keyhandle(handle, f_status_.__wbg_ptr);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_clone_srpclient(handle, f_status_) {
    _assertClass(f_status_, RustCallStatus);
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_clone_srpclient(handle, f_status_.__wbg_ptr);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_clone_srpserver(handle, f_status_) {
    _assertClass(f_status_, RustCallStatus);
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_clone_srpserver(handle, f_status_.__wbg_ptr);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {RustCallStatus} f_status_
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_constructor_srpclient_new(f_status_) {
    _assertClass(f_status_, RustCallStatus);
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_constructor_srpclient_new(f_status_.__wbg_ptr);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {RustCallStatus} f_status_
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_constructor_srpserver_new(f_status_) {
    _assertClass(f_status_, RustCallStatus);
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_constructor_srpserver_new(f_status_.__wbg_ptr);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 */
export function ubrn_uniffi_bittery_crypto_api_fn_free_keyhandle(handle, f_status_) {
    _assertClass(f_status_, RustCallStatus);
    wasm.ubrn_uniffi_bittery_crypto_api_fn_free_keyhandle(handle, f_status_.__wbg_ptr);
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 */
export function ubrn_uniffi_bittery_crypto_api_fn_free_srpclient(handle, f_status_) {
    _assertClass(f_status_, RustCallStatus);
    wasm.ubrn_uniffi_bittery_crypto_api_fn_free_srpclient(handle, f_status_.__wbg_ptr);
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 */
export function ubrn_uniffi_bittery_crypto_api_fn_free_srpserver(handle, f_status_) {
    _assertClass(f_status_, RustCallStatus);
    wasm.ubrn_uniffi_bittery_crypto_api_fn_free_srpserver(handle, f_status_.__wbg_ptr);
}

/**
 * @param {Uint8Array} rp_id
 * @param {Uint8Array} credential_id_base64
 * @param {Uint8Array} cose_public_key_base64
 * @param {number} sign_count
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_build_passkey_attestation_object(rp_id, credential_id_base64, cose_public_key_base64, sign_count) {
    const ptr0 = passArray8ToWasm0(rp_id, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(credential_id_base64, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(cose_public_key_base64, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_build_passkey_attestation_object(ptr0, len0, ptr1, len1, ptr2, len2, sign_count);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} key
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_clone_key(key) {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_clone_key(key);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} data
 * @param {bigint} key
 * @param {Uint8Array} context
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_decrypt(data, key, context) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(context, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_decrypt(ptr0, len0, key, ptr1, len1);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} requests
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_many(requests) {
    const ptr0 = passArray8ToWasm0(requests, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_many(ptr0, len0);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} data
 * @param {Uint8Array} recovery_key
 * @param {Uint8Array} email
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_master_key(data, recovery_key, email) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(recovery_key, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(email, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_master_key(ptr0, len0, ptr1, len1, ptr2, len2);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} ciphertext
 * @param {Uint8Array} encrypted_private_key
 * @param {bigint} private_key_wrapping_key
 * @param {Uint8Array} private_key_context
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_rsa_wrapped_key(ciphertext, encrypted_private_key, private_key_wrapping_key, private_key_context) {
    const ptr0 = passArray8ToWasm0(ciphertext, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(encrypted_private_key, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(private_key_context, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_rsa_wrapped_key(ptr0, len0, ptr1, len1, private_key_wrapping_key, ptr2, len2);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} client_ephemeral_secret
 * @param {Uint8Array} challenge
 * @param {Uint8Array} password
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_derive_client_session(client_ephemeral_secret, challenge, password) {
    const ptr0 = passArray8ToWasm0(client_ephemeral_secret, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(challenge, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(password, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_derive_client_session(ptr0, len0, ptr1, len1, ptr2, len2);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} account_password
 * @param {Uint8Array} secret_key
 * @param {Uint8Array} email
 * @param {Uint8Array} profile
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_derive_keys(account_password, secret_key, email, profile) {
    const ptr0 = passArray8ToWasm0(account_password, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(secret_key, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(email, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(profile, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_derive_keys(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} master_key
 * @param {Uint8Array} email
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_derive_keys_from_master_key(master_key, email) {
    const ptr0 = passArray8ToWasm0(email, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_derive_keys_from_master_key(master_key, ptr0, len0);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} account_password
 * @param {Uint8Array} secret_key
 * @param {Uint8Array} email
 * @param {Uint8Array} profile
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_derive_master_key(account_password, secret_key, email, profile) {
    const ptr0 = passArray8ToWasm0(account_password, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(secret_key, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(email, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(profile, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_derive_master_key(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} auth_key
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_derive_srp_password(auth_key) {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_derive_srp_password(auth_key);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} key
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_destroy_key(key) {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_destroy_key(key);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} plaintext
 * @param {bigint} key
 * @param {Uint8Array} context
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_encrypt(plaintext, key, context) {
    const ptr0 = passArray8ToWasm0(plaintext, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(context, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_encrypt(ptr0, len0, key, ptr1, len1);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} master_key
 * @param {Uint8Array} recovery_key
 * @param {Uint8Array} email
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_master_key(master_key, recovery_key, email) {
    const ptr0 = passArray8ToWasm0(recovery_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(email, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_master_key(master_key, ptr0, len0, ptr1, len1);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} vault_key
 * @param {Uint8Array} member_public_key_pem
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_for_member(vault_key, member_public_key_pem) {
    const ptr0 = passArray8ToWasm0(member_public_key_pem, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_for_member(vault_key, ptr0, len0);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} vault_key
 * @param {bigint} master_unlock_key
 * @param {Uint8Array} vault_id
 * @param {Uint8Array} user_id
 * @param {bigint} key_version
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_with_muk(vault_key, master_unlock_key, vault_id, user_id, key_version) {
    const ptr0 = passArray8ToWasm0(vault_id, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(user_id, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_with_muk(vault_key, master_unlock_key, ptr0, len0, ptr1, len1, key_version);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} key
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_export_key(key) {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_export_key(key);
    return BigInt.asUintN(64, ret);
}

/**
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_client_ephemeral() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_generate_client_ephemeral();
    return BigInt.asUintN(64, ret);
}

/**
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_encryption_key() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_generate_encryption_key();
    return BigInt.asUintN(64, ret);
}

/**
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_passkey_credential_id() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_generate_passkey_credential_id();
    return BigInt.asUintN(64, ret);
}

/**
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_passkey_keypair() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_generate_passkey_keypair();
    return BigInt.asUintN(64, ret);
}

/**
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_recovery_key() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_generate_recovery_key();
    return BigInt.asUintN(64, ret);
}

/**
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_rsa_key_pair() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_generate_rsa_key_pair();
    return BigInt.asUintN(64, ret);
}

/**
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_secret_key() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_generate_secret_key();
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} password
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_srp_registration(password) {
    const ptr0 = passArray8ToWasm0(password, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_generate_srp_registration(ptr0, len0);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} secret
 * @param {Uint8Array} algorithm
 * @param {number} digits
 * @param {bigint} period
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_totp(secret, algorithm, digits, period) {
    const ptr0 = passArray8ToWasm0(secret, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(algorithm, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_generate_totp(ptr0, len0, ptr1, len1, digits, period);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} secret
 * @param {Uint8Array} algorithm
 * @param {number} digits
 * @param {bigint} period
 * @param {bigint} timestamp
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_totp_at(secret, algorithm, digits, period, timestamp) {
    const ptr0 = passArray8ToWasm0(secret, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(algorithm, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_generate_totp_at(ptr0, len0, ptr1, len1, digits, period, timestamp);
    return BigInt.asUintN(64, ret);
}

/**
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_uuid() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_generate_uuid();
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} key
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_import_key(key) {
    const ptr0 = passArray8ToWasm0(key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_import_key(ptr0, len0);
    return BigInt.asUintN(64, ret);
}

/**
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_initialize() {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_initialize();
    return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} old_vault_key
 * @param {Uint8Array} members
 * @param {Uint8Array} items
 * @param {Uint8Array} vault_id
 * @param {bigint} key_version
 * @param {Uint8Array} current_user_id
 * @param {bigint} master_unlock_key
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_perform_key_rotation(old_vault_key, members, items, vault_id, key_version, current_user_id, master_unlock_key) {
    const ptr0 = passArray8ToWasm0(members, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(items, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(vault_id, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(current_user_id, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_perform_key_rotation(old_vault_key, ptr0, len0, ptr1, len1, ptr2, len2, key_version, ptr3, len3, master_unlock_key);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} item
 * @param {bigint} old_vault_key
 * @param {bigint} new_vault_key
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_re_encrypt_item(item, old_vault_key, new_vault_key) {
    const ptr0 = passArray8ToWasm0(item, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_re_encrypt_item(ptr0, len0, old_vault_key, new_vault_key);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} ciphertext
 * @param {Uint8Array} private_key_pem
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_rsa_decrypt(ciphertext, private_key_pem) {
    const ptr0 = passArray8ToWasm0(ciphertext, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(private_key_pem, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_rsa_decrypt(ptr0, len0, ptr1, len1);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} plaintext
 * @param {Uint8Array} public_key_pem
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_rsa_encrypt(plaintext, public_key_pem) {
    const ptr0 = passArray8ToWasm0(plaintext, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(public_key_pem, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_rsa_encrypt(ptr0, len0, ptr1, len1);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} private_key_base64
 * @param {Uint8Array} rp_id
 * @param {Uint8Array} client_data_hash_base64
 * @param {number} sign_count
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_sign_passkey_assertion(private_key_base64, rp_id, client_data_hash_base64, sign_count) {
    const ptr0 = passArray8ToWasm0(private_key_base64, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(rp_id, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(client_data_hash_base64, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_sign_passkey_assertion(ptr0, len0, ptr1, len1, ptr2, len2, sign_count);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} data
 * @param {bigint} wrapping_key
 * @param {Uint8Array} context
 * @param {Uint8Array} legacy_marker
 * @param {Uint8Array} legacy_context
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_unwrap_key(data, wrapping_key, context, legacy_marker, legacy_context) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(context, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(legacy_marker, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(legacy_context, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_unwrap_key(ptr0, len0, wrapping_key, ptr1, len1, ptr2, len2, ptr3, len3);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} recovery_key
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_validate_recovery_key(recovery_key) {
    const ptr0 = passArray8ToWasm0(recovery_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_validate_recovery_key(ptr0, len0);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} members
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_validate_rotation_data(members) {
    const ptr0 = passArray8ToWasm0(members, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_validate_rotation_data(ptr0, len0);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} secret_key
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_validate_secret_key(secret_key) {
    const ptr0 = passArray8ToWasm0(secret_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_validate_secret_key(ptr0, len0);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} client_public_ephemeral
 * @param {Uint8Array} session
 * @param {Uint8Array} server_session_proof
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_verify_server_session(client_public_ephemeral, session, server_session_proof) {
    const ptr0 = passArray8ToWasm0(client_public_ephemeral, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(session, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(server_session_proof, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_verify_server_session(ptr0, len0, ptr1, len1, ptr2, len2);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} key
 * @param {bigint} wrapping_key
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_wrap_key(key, wrapping_key) {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_wrap_key(key, wrapping_key);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} ptr
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_method_keyhandle_destroy(ptr) {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_method_keyhandle_destroy(ptr);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} ptr
 * @param {Uint8Array} salt
 * @param {Uint8Array} password
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_derive_safe_private_key(ptr, salt, password) {
    const ptr0 = passArray8ToWasm0(salt, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(password, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_derive_safe_private_key(ptr, ptr0, len0, ptr1, len1);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} ptr
 * @param {Uint8Array} private_key
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_derive_verifier(ptr, private_key) {
    const ptr0 = passArray8ToWasm0(private_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_derive_verifier(ptr, ptr0, len0);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} ptr
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_generate_salt(ptr) {
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_generate_salt(ptr);
    return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} ptr
 * @param {Uint8Array} verifier
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_method_srpserver_generate_ephemeral(ptr, verifier) {
    const ptr0 = passArray8ToWasm0(verifier, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_method_srpserver_generate_ephemeral(ptr, ptr0, len0);
    return BigInt.asUintN(64, ret);
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_is_function_1ff95bcc5517c252: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_a27215656b807791: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_ea5e6cc2e4141dfe: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_c05833b95a3cf397: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_4a841e042b37beb3: function(arg0, arg1, arg2, arg3) {
            arg0.call(arg1, BigInt.asUintN(64, arg2), arg3);
        },
        __wbg_call_a6e5c5dce5018821: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_crypto_38df2bab126b63dc: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_getRandomValues_cc7f052a444bb2ce: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbg_length_1f0964f4a5e2c6d8: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_with_length_e6785c33c8e4cce8: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_node_84ea875411254db1: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_process_44c7a14e11e9f69e: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_4770620bbe4688a0: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_static_accessor_GLOBAL_4ef717fb391d88b7: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_8d1badc68b5a74f4: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_146583524fe1469b: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_f2829a2234d7819e: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_subarray_3ed232c8a6baee09: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_versions_276b2795b1c6a219: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./index_bg.js": import0,
    };
}

const RustCallStatusFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rustcallstatus_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }


    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
