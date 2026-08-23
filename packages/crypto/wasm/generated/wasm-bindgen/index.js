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
    var ptr0 = isLikeNone(bytes)
      ? 0
      : passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
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
if (Symbol.dispose)
  RustCallStatus.prototype[Symbol.dispose] = RustCallStatus.prototype.free;

export class WebClientRuntime {
  static __wrap(ptr) {
    const obj = Object.create(WebClientRuntime.prototype);
    obj.__wbg_ptr = ptr;
    WebClientRuntimeFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    WebClientRuntimeFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_webclientruntime_free(ptr, 0);
  }
  /**
   * @param {string} request_id
   */
  cancel(request_id) {
    const ptr0 = passStringToWasm0(
      request_id,
      wasm.__wbindgen_malloc,
      wasm.__wbindgen_realloc,
    );
    const len0 = WASM_VECTOR_LEN;
    wasm.webclientruntime_cancel(this.__wbg_ptr, ptr0, len0);
  }
  /**
   * @returns {Promise<void>}
   */
  close() {
    const ret = wasm.webclientruntime_close(this.__wbg_ptr);
    return ret;
  }
  constructor() {
    const ret = wasm.webclientruntime_new();
    this.__wbg_ptr = ret;
    WebClientRuntimeFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
  /**
   * @param {string} observation_id
   * @param {string} request_json
   * @param {Function} callback
   */
  observe_json(observation_id, request_json, callback) {
    const ptr0 = passStringToWasm0(
      observation_id,
      wasm.__wbindgen_malloc,
      wasm.__wbindgen_realloc,
    );
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(
      request_json,
      wasm.__wbindgen_malloc,
      wasm.__wbindgen_realloc,
    );
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.webclientruntime_observe_json(
      this.__wbg_ptr,
      ptr0,
      len0,
      ptr1,
      len1,
      callback,
    );
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @returns {Promise<void>}
   */
  open() {
    const ret = wasm.webclientruntime_open(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {string} request_id
   * @param {string} request_json
   * @returns {Promise<string>}
   */
  request_json(request_id, request_json) {
    const ptr0 = passStringToWasm0(
      request_id,
      wasm.__wbindgen_malloc,
      wasm.__wbindgen_realloc,
    );
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(
      request_json,
      wasm.__wbindgen_malloc,
      wasm.__wbindgen_realloc,
    );
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.webclientruntime_request_json(
      this.__wbg_ptr,
      ptr0,
      len0,
      ptr1,
      len1,
    );
    return ret;
  }
  /**
   * @param {string} observation_id
   */
  unobserve(observation_id) {
    const ptr0 = passStringToWasm0(
      observation_id,
      wasm.__wbindgen_malloc,
      wasm.__wbindgen_realloc,
    );
    const len0 = WASM_VECTOR_LEN;
    wasm.webclientruntime_unobserve(this.__wbg_ptr, ptr0, len0);
  }
  /**
   * @param {Function} replica_invoke
   * @param {Function} platform_storage_invoke
   * @param {Function} http_invoke
   * @param {Function} http_cancel
   * @returns {WebClientRuntime}
   */
  static withExecutors(
    replica_invoke,
    platform_storage_invoke,
    http_invoke,
    http_cancel,
  ) {
    const ret = wasm.webclientruntime_withExecutors(
      replica_invoke,
      platform_storage_invoke,
      http_invoke,
      http_cancel,
    );
    return WebClientRuntime.__wrap(ret);
  }
  /**
   * @param {Function} invoke
   * @returns {WebClientRuntime}
   */
  static withReplicaExecutor(invoke) {
    const ret = wasm.webclientruntime_withReplicaExecutor(invoke);
    return WebClientRuntime.__wrap(ret);
  }
}
if (Symbol.dispose)
  WebClientRuntime.prototype[Symbol.dispose] = WebClientRuntime.prototype.free;

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
export function ubrn_ffi_bittery_crypto_api_rust_future_cancel_rust_buffer(
  handle,
) {
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
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_f32(
  handle,
  f_status_,
) {
  _assertClass(f_status_, RustCallStatus);
  const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_f32(
    handle,
    f_status_.__wbg_ptr,
  );
  return ret;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {number}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_f64(
  handle,
  f_status_,
) {
  _assertClass(f_status_, RustCallStatus);
  const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_f64(
    handle,
    f_status_.__wbg_ptr,
  );
  return ret;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {number}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_i16(
  handle,
  f_status_,
) {
  _assertClass(f_status_, RustCallStatus);
  const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_i16(
    handle,
    f_status_.__wbg_ptr,
  );
  return ret;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {number}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_i32(
  handle,
  f_status_,
) {
  _assertClass(f_status_, RustCallStatus);
  const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_i32(
    handle,
    f_status_.__wbg_ptr,
  );
  return ret;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {bigint}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_i64(
  handle,
  f_status_,
) {
  _assertClass(f_status_, RustCallStatus);
  const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_i64(
    handle,
    f_status_.__wbg_ptr,
  );
  return ret;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {number}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_i8(
  handle,
  f_status_,
) {
  _assertClass(f_status_, RustCallStatus);
  const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_i8(
    handle,
    f_status_.__wbg_ptr,
  );
  return ret;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {Uint8Array}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_rust_buffer(
  handle,
  f_status_,
) {
  _assertClass(f_status_, RustCallStatus);
  const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_rust_buffer(
    handle,
    f_status_.__wbg_ptr,
  );
  var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
  wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
  return v1;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {number}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_u16(
  handle,
  f_status_,
) {
  _assertClass(f_status_, RustCallStatus);
  const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_u16(
    handle,
    f_status_.__wbg_ptr,
  );
  return ret;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {number}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_u32(
  handle,
  f_status_,
) {
  _assertClass(f_status_, RustCallStatus);
  const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_u32(
    handle,
    f_status_.__wbg_ptr,
  );
  return ret >>> 0;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {bigint}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_u64(
  handle,
  f_status_,
) {
  _assertClass(f_status_, RustCallStatus);
  const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_u64(
    handle,
    f_status_.__wbg_ptr,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {number}
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_u8(
  handle,
  f_status_,
) {
  _assertClass(f_status_, RustCallStatus);
  const ret = wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_u8(
    handle,
    f_status_.__wbg_ptr,
  );
  return ret;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_complete_void(
  handle,
  f_status_,
) {
  _assertClass(f_status_, RustCallStatus);
  wasm.ubrn_ffi_bittery_crypto_api_rust_future_complete_void(
    handle,
    f_status_.__wbg_ptr,
  );
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
export function ubrn_ffi_bittery_crypto_api_rust_future_free_rust_buffer(
  handle,
) {
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
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_f32(
  handle,
  callback,
  callback_data,
) {
  wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_f32(
    handle,
    callback,
    callback_data,
  );
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_f64(
  handle,
  callback,
  callback_data,
) {
  wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_f64(
    handle,
    callback,
    callback_data,
  );
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_i16(
  handle,
  callback,
  callback_data,
) {
  wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_i16(
    handle,
    callback,
    callback_data,
  );
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_i32(
  handle,
  callback,
  callback_data,
) {
  wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_i32(
    handle,
    callback,
    callback_data,
  );
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_i64(
  handle,
  callback,
  callback_data,
) {
  wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_i64(
    handle,
    callback,
    callback_data,
  );
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_i8(
  handle,
  callback,
  callback_data,
) {
  wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_i8(
    handle,
    callback,
    callback_data,
  );
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_rust_buffer(
  handle,
  callback,
  callback_data,
) {
  wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_rust_buffer(
    handle,
    callback,
    callback_data,
  );
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_u16(
  handle,
  callback,
  callback_data,
) {
  wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_u16(
    handle,
    callback,
    callback_data,
  );
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_u32(
  handle,
  callback,
  callback_data,
) {
  wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_u32(
    handle,
    callback,
    callback_data,
  );
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_u64(
  handle,
  callback,
  callback_data,
) {
  wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_u64(
    handle,
    callback,
    callback_data,
  );
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_u8(
  handle,
  callback,
  callback_data,
) {
  wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_u8(
    handle,
    callback,
    callback_data,
  );
}

/**
 * @param {bigint} handle
 * @param {any} callback
 * @param {bigint} callback_data
 */
export function ubrn_ffi_bittery_crypto_api_rust_future_poll_void(
  handle,
  callback,
  callback_data,
) {
  wasm.ubrn_ffi_bittery_crypto_api_rust_future_poll_void(
    handle,
    callback,
    callback_data,
  );
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
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_constructor_srpclient_new();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_constructor_srpserver_new() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_constructor_srpserver_new();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_build_passkey_attestation_object() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_build_passkey_attestation_object();
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
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_master_key();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_rsa_wrapped_key() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_decrypt_rsa_wrapped_key();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_derive_client_session() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_derive_client_session();
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
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_derive_keys_from_master_key();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_derive_master_key() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_derive_master_key();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_derive_srp_password() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_derive_srp_password();
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
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_master_key();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_for_member() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_for_member();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_with_muk() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_encrypt_vault_key_with_muk();
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
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_client_ephemeral();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_encryption_key() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_encryption_key();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_passkey_credential_id() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_passkey_credential_id();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_passkey_keypair() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_passkey_keypair();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_recovery_key() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_recovery_key();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_rsa_key_pair() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_rsa_key_pair();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_secret_key() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_secret_key();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_generate_srp_registration() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_srp_registration();
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
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_totp_at();
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
export function ubrn_uniffi_bittery_crypto_api_checksum_func_re_encrypt_item() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_re_encrypt_item();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_rewrap_attachment_key() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_rewrap_attachment_key();
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
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_sign_passkey_assertion();
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
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_validate_recovery_key();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_validate_secret_key() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_validate_secret_key();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_func_verify_server_session() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_func_verify_server_session();
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
export function ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_derive_safe_private_key() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_derive_safe_private_key();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_derive_verifier() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_derive_verifier();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_generate_salt() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_method_srpclient_generate_salt();
  return ret;
}

/**
 * @returns {number}
 */
export function ubrn_uniffi_bittery_crypto_api_checksum_method_srpserver_generate_ephemeral() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_checksum_method_srpserver_generate_ephemeral();
  return ret;
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_clone_keyhandle(
  handle,
  f_status_,
) {
  _assertClass(f_status_, RustCallStatus);
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_clone_keyhandle(
    handle,
    f_status_.__wbg_ptr,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_clone_srpclient(
  handle,
  f_status_,
) {
  _assertClass(f_status_, RustCallStatus);
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_clone_srpclient(
    handle,
    f_status_.__wbg_ptr,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_clone_srpserver(
  handle,
  f_status_,
) {
  _assertClass(f_status_, RustCallStatus);
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_clone_srpserver(
    handle,
    f_status_.__wbg_ptr,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {RustCallStatus} f_status_
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_constructor_srpclient_new(
  f_status_,
) {
  _assertClass(f_status_, RustCallStatus);
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_constructor_srpclient_new(
    f_status_.__wbg_ptr,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {RustCallStatus} f_status_
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_constructor_srpserver_new(
  f_status_,
) {
  _assertClass(f_status_, RustCallStatus);
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_constructor_srpserver_new(
    f_status_.__wbg_ptr,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 */
export function ubrn_uniffi_bittery_crypto_api_fn_free_keyhandle(
  handle,
  f_status_,
) {
  _assertClass(f_status_, RustCallStatus);
  wasm.ubrn_uniffi_bittery_crypto_api_fn_free_keyhandle(
    handle,
    f_status_.__wbg_ptr,
  );
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 */
export function ubrn_uniffi_bittery_crypto_api_fn_free_srpclient(
  handle,
  f_status_,
) {
  _assertClass(f_status_, RustCallStatus);
  wasm.ubrn_uniffi_bittery_crypto_api_fn_free_srpclient(
    handle,
    f_status_.__wbg_ptr,
  );
}

/**
 * @param {bigint} handle
 * @param {RustCallStatus} f_status_
 */
export function ubrn_uniffi_bittery_crypto_api_fn_free_srpserver(
  handle,
  f_status_,
) {
  _assertClass(f_status_, RustCallStatus);
  wasm.ubrn_uniffi_bittery_crypto_api_fn_free_srpserver(
    handle,
    f_status_.__wbg_ptr,
  );
}

/**
 * @param {Uint8Array} rp_id
 * @param {Uint8Array} credential_id_base64
 * @param {Uint8Array} cose_public_key_base64
 * @param {number} sign_count
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_build_passkey_attestation_object(
  rp_id,
  credential_id_base64,
  cose_public_key_base64,
  sign_count,
) {
  const ptr0 = passArray8ToWasm0(rp_id, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(credential_id_base64, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ptr2 = passArray8ToWasm0(
    cose_public_key_base64,
    wasm.__wbindgen_malloc,
  );
  const len2 = WASM_VECTOR_LEN;
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_fn_func_build_passkey_attestation_object(
      ptr0,
      len0,
      ptr1,
      len1,
      ptr2,
      len2,
      sign_count,
    );
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
export function ubrn_uniffi_bittery_crypto_api_fn_func_decrypt(
  data,
  key,
  context,
) {
  const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(context, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_decrypt(
    ptr0,
    len0,
    key,
    ptr1,
    len1,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} requests
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_many(requests) {
  const ptr0 = passArray8ToWasm0(requests, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_many(
    ptr0,
    len0,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} data
 * @param {Uint8Array} recovery_key
 * @param {Uint8Array} email
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_master_key(
  data,
  recovery_key,
  email,
) {
  const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(recovery_key, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ptr2 = passArray8ToWasm0(email, wasm.__wbindgen_malloc);
  const len2 = WASM_VECTOR_LEN;
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_master_key(
    ptr0,
    len0,
    ptr1,
    len1,
    ptr2,
    len2,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} ciphertext
 * @param {Uint8Array} encrypted_private_key
 * @param {bigint} private_key_wrapping_key
 * @param {Uint8Array} private_key_context
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_rsa_wrapped_key(
  ciphertext,
  encrypted_private_key,
  private_key_wrapping_key,
  private_key_context,
) {
  const ptr0 = passArray8ToWasm0(ciphertext, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(encrypted_private_key, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ptr2 = passArray8ToWasm0(private_key_context, wasm.__wbindgen_malloc);
  const len2 = WASM_VECTOR_LEN;
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_fn_func_decrypt_rsa_wrapped_key(
      ptr0,
      len0,
      ptr1,
      len1,
      private_key_wrapping_key,
      ptr2,
      len2,
    );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} client_ephemeral_secret
 * @param {Uint8Array} challenge
 * @param {Uint8Array} password
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_derive_client_session(
  client_ephemeral_secret,
  challenge,
  password,
) {
  const ptr0 = passArray8ToWasm0(
    client_ephemeral_secret,
    wasm.__wbindgen_malloc,
  );
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(challenge, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ptr2 = passArray8ToWasm0(password, wasm.__wbindgen_malloc);
  const len2 = WASM_VECTOR_LEN;
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_derive_client_session(
    ptr0,
    len0,
    ptr1,
    len1,
    ptr2,
    len2,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} account_password
 * @param {Uint8Array} secret_key
 * @param {Uint8Array} email
 * @param {Uint8Array} profile
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_derive_keys(
  account_password,
  secret_key,
  email,
  profile,
) {
  const ptr0 = passArray8ToWasm0(account_password, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(secret_key, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ptr2 = passArray8ToWasm0(email, wasm.__wbindgen_malloc);
  const len2 = WASM_VECTOR_LEN;
  const ptr3 = passArray8ToWasm0(profile, wasm.__wbindgen_malloc);
  const len3 = WASM_VECTOR_LEN;
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_derive_keys(
    ptr0,
    len0,
    ptr1,
    len1,
    ptr2,
    len2,
    ptr3,
    len3,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} master_key
 * @param {Uint8Array} email
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_derive_keys_from_master_key(
  master_key,
  email,
) {
  const ptr0 = passArray8ToWasm0(email, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_fn_func_derive_keys_from_master_key(
      master_key,
      ptr0,
      len0,
    );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} account_password
 * @param {Uint8Array} secret_key
 * @param {Uint8Array} email
 * @param {Uint8Array} profile
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_derive_master_key(
  account_password,
  secret_key,
  email,
  profile,
) {
  const ptr0 = passArray8ToWasm0(account_password, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(secret_key, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ptr2 = passArray8ToWasm0(email, wasm.__wbindgen_malloc);
  const len2 = WASM_VECTOR_LEN;
  const ptr3 = passArray8ToWasm0(profile, wasm.__wbindgen_malloc);
  const len3 = WASM_VECTOR_LEN;
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_derive_master_key(
    ptr0,
    len0,
    ptr1,
    len1,
    ptr2,
    len2,
    ptr3,
    len3,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} auth_key
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_derive_srp_password(
  auth_key,
) {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_fn_func_derive_srp_password(auth_key);
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
export function ubrn_uniffi_bittery_crypto_api_fn_func_encrypt(
  plaintext,
  key,
  context,
) {
  const ptr0 = passArray8ToWasm0(plaintext, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(context, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_encrypt(
    ptr0,
    len0,
    key,
    ptr1,
    len1,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} master_key
 * @param {Uint8Array} recovery_key
 * @param {Uint8Array} email
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_master_key(
  master_key,
  recovery_key,
  email,
) {
  const ptr0 = passArray8ToWasm0(recovery_key, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(email, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_master_key(
    master_key,
    ptr0,
    len0,
    ptr1,
    len1,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} vault_key
 * @param {Uint8Array} member_public_key_pem
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_for_member(
  vault_key,
  member_public_key_pem,
) {
  const ptr0 = passArray8ToWasm0(member_public_key_pem, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_for_member(
      vault_key,
      ptr0,
      len0,
    );
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
export function ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_with_muk(
  vault_key,
  master_unlock_key,
  vault_id,
  user_id,
  key_version,
) {
  const ptr0 = passArray8ToWasm0(vault_id, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(user_id, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_fn_func_encrypt_vault_key_with_muk(
      vault_key,
      master_unlock_key,
      ptr0,
      len0,
      ptr1,
      len1,
      key_version,
    );
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
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_fn_func_generate_client_ephemeral();
  return BigInt.asUintN(64, ret);
}

/**
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_encryption_key() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_fn_func_generate_encryption_key();
  return BigInt.asUintN(64, ret);
}

/**
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_passkey_credential_id() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_fn_func_generate_passkey_credential_id();
  return BigInt.asUintN(64, ret);
}

/**
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_passkey_keypair() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_fn_func_generate_passkey_keypair();
  return BigInt.asUintN(64, ret);
}

/**
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_recovery_key() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_fn_func_generate_recovery_key();
  return BigInt.asUintN(64, ret);
}

/**
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_rsa_key_pair() {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_fn_func_generate_rsa_key_pair();
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
export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_srp_registration(
  password,
) {
  const ptr0 = passArray8ToWasm0(password, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_fn_func_generate_srp_registration(
      ptr0,
      len0,
    );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} secret
 * @param {Uint8Array} algorithm
 * @param {number} digits
 * @param {bigint} period
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_totp(
  secret,
  algorithm,
  digits,
  period,
) {
  const ptr0 = passArray8ToWasm0(secret, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(algorithm, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_generate_totp(
    ptr0,
    len0,
    ptr1,
    len1,
    digits,
    period,
  );
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
export function ubrn_uniffi_bittery_crypto_api_fn_func_generate_totp_at(
  secret,
  algorithm,
  digits,
  period,
  timestamp,
) {
  const ptr0 = passArray8ToWasm0(secret, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(algorithm, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_generate_totp_at(
    ptr0,
    len0,
    ptr1,
    len1,
    digits,
    period,
    timestamp,
  );
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
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_import_key(
    ptr0,
    len0,
  );
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
 * @param {Uint8Array} item
 * @param {bigint} old_vault_key
 * @param {bigint} new_vault_key
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_re_encrypt_item(
  item,
  old_vault_key,
  new_vault_key,
) {
  const ptr0 = passArray8ToWasm0(item, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_re_encrypt_item(
    ptr0,
    len0,
    old_vault_key,
    new_vault_key,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} encrypted_attachment_key
 * @param {bigint} old_vault_key
 * @param {bigint} new_vault_key
 * @param {Uint8Array} old_context
 * @param {Uint8Array} new_context
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_rewrap_attachment_key(
  encrypted_attachment_key,
  old_vault_key,
  new_vault_key,
  old_context,
  new_context,
) {
  const ptr0 = passArray8ToWasm0(
    encrypted_attachment_key,
    wasm.__wbindgen_malloc,
  );
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(old_context, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ptr2 = passArray8ToWasm0(new_context, wasm.__wbindgen_malloc);
  const len2 = WASM_VECTOR_LEN;
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_rewrap_attachment_key(
    ptr0,
    len0,
    old_vault_key,
    new_vault_key,
    ptr1,
    len1,
    ptr2,
    len2,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} ciphertext
 * @param {Uint8Array} private_key_pem
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_rsa_decrypt(
  ciphertext,
  private_key_pem,
) {
  const ptr0 = passArray8ToWasm0(ciphertext, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(private_key_pem, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_rsa_decrypt(
    ptr0,
    len0,
    ptr1,
    len1,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} plaintext
 * @param {Uint8Array} public_key_pem
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_rsa_encrypt(
  plaintext,
  public_key_pem,
) {
  const ptr0 = passArray8ToWasm0(plaintext, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(public_key_pem, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_rsa_encrypt(
    ptr0,
    len0,
    ptr1,
    len1,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} private_key_base64
 * @param {Uint8Array} rp_id
 * @param {Uint8Array} client_data_hash_base64
 * @param {number} sign_count
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_sign_passkey_assertion(
  private_key_base64,
  rp_id,
  client_data_hash_base64,
  sign_count,
) {
  const ptr0 = passArray8ToWasm0(private_key_base64, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(rp_id, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ptr2 = passArray8ToWasm0(
    client_data_hash_base64,
    wasm.__wbindgen_malloc,
  );
  const len2 = WASM_VECTOR_LEN;
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_fn_func_sign_passkey_assertion(
      ptr0,
      len0,
      ptr1,
      len1,
      ptr2,
      len2,
      sign_count,
    );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} data
 * @param {bigint} wrapping_key
 * @param {Uint8Array} context
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_unwrap_key(
  data,
  wrapping_key,
  context,
) {
  const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(context, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_unwrap_key(
    ptr0,
    len0,
    wrapping_key,
    ptr1,
    len1,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} recovery_key
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_validate_recovery_key(
  recovery_key,
) {
  const ptr0 = passArray8ToWasm0(recovery_key, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_validate_recovery_key(
    ptr0,
    len0,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} secret_key
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_validate_secret_key(
  secret_key,
) {
  const ptr0 = passArray8ToWasm0(secret_key, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_validate_secret_key(
    ptr0,
    len0,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {Uint8Array} client_public_ephemeral
 * @param {Uint8Array} session
 * @param {Uint8Array} server_session_proof
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_verify_server_session(
  client_public_ephemeral,
  session,
  server_session_proof,
) {
  const ptr0 = passArray8ToWasm0(
    client_public_ephemeral,
    wasm.__wbindgen_malloc,
  );
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(session, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ptr2 = passArray8ToWasm0(server_session_proof, wasm.__wbindgen_malloc);
  const len2 = WASM_VECTOR_LEN;
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_verify_server_session(
    ptr0,
    len0,
    ptr1,
    len1,
    ptr2,
    len2,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} key
 * @param {bigint} wrapping_key
 * @param {Uint8Array} context
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_func_wrap_key(
  key,
  wrapping_key,
  context,
) {
  const ptr0 = passArray8ToWasm0(context, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ret = wasm.ubrn_uniffi_bittery_crypto_api_fn_func_wrap_key(
    key,
    wrapping_key,
    ptr0,
    len0,
  );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} ptr
 * @param {Uint8Array} salt
 * @param {Uint8Array} password
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_derive_safe_private_key(
  ptr,
  salt,
  password,
) {
  const ptr0 = passArray8ToWasm0(salt, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(password, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_derive_safe_private_key(
      ptr,
      ptr0,
      len0,
      ptr1,
      len1,
    );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} ptr
 * @param {Uint8Array} private_key
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_derive_verifier(
  ptr,
  private_key,
) {
  const ptr0 = passArray8ToWasm0(private_key, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_derive_verifier(
      ptr,
      ptr0,
      len0,
    );
  return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} ptr
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_generate_salt(
  ptr,
) {
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_fn_method_srpclient_generate_salt(ptr);
  return BigInt.asUintN(64, ret);
}

/**
 * @param {bigint} ptr
 * @param {Uint8Array} verifier
 * @returns {bigint}
 */
export function ubrn_uniffi_bittery_crypto_api_fn_method_srpserver_generate_ephemeral(
  ptr,
  verifier,
) {
  const ptr0 = passArray8ToWasm0(verifier, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ret =
    wasm.ubrn_uniffi_bittery_crypto_api_fn_method_srpserver_generate_ephemeral(
      ptr,
      ptr0,
      len0,
    );
  return BigInt.asUintN(64, ret);
}
function __wbg_get_imports() {
  const import0 = {
    __proto__: null,
    __wbg___wbindgen_is_function_1ff95bcc5517c252: function (arg0) {
      const ret = typeof arg0 === "function";
      return ret;
    },
    __wbg___wbindgen_is_object_a27215656b807791: function (arg0) {
      const val = arg0;
      const ret = typeof val === "object" && val !== null;
      return ret;
    },
    __wbg___wbindgen_is_string_ea5e6cc2e4141dfe: function (arg0) {
      const ret = typeof arg0 === "string";
      return ret;
    },
    __wbg___wbindgen_is_undefined_c05833b95a3cf397: function (arg0) {
      const ret = arg0 === undefined;
      return ret;
    },
    __wbg___wbindgen_string_get_b0ca35b86a603356: function (arg0, arg1) {
      const obj = arg1;
      const ret = typeof obj === "string" ? obj : undefined;
      var ptr1 = isLikeNone(ret)
        ? 0
        : passStringToWasm0(
            ret,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc,
          );
      var len1 = WASM_VECTOR_LEN;
      getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
      getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    },
    __wbg___wbindgen_throw_344f42d3211c4765: function (arg0, arg1) {
      throw new Error(getStringFromWasm0(arg0, arg1));
    },
    __wbg__wbg_cb_unref_fffb441def202758: function (arg0) {
      arg0._wbg_cb_unref();
    },
    __wbg_call_4a841e042b37beb3: function (arg0, arg1, arg2, arg3) {
      arg0.call(arg1, BigInt.asUintN(64, arg2), arg3);
    },
    __wbg_call_a6e5c5dce5018821: function () {
      return handleError(function (arg0, arg1, arg2) {
        const ret = arg0.call(arg1, arg2);
        return ret;
      }, arguments);
    },
    __wbg_crypto_48300657fced39f9: function (arg0) {
      const ret = arg0.crypto;
      return ret;
    },
    __wbg_getRandomValues_263d0aa5464054ee: function () {
      return handleError(function (arg0, arg1) {
        arg0.getRandomValues(arg1);
      }, arguments);
    },
    __wbg_getRandomValues_76dfc69825c9c552: function () {
      return handleError(function (arg0, arg1) {
        globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
      }, arguments);
    },
    __wbg_instanceof_Promise_4cb210c0b8f8c959: function (arg0) {
      let result;
      try {
        result = arg0 instanceof Promise;
      } catch (_) {
        result = false;
      }
      const ret = result;
      return ret;
    },
    __wbg_length_1f0964f4a5e2c6d8: function (arg0) {
      const ret = arg0.length;
      return ret;
    },
    __wbg_msCrypto_8c6d45a75ef1d3da: function (arg0) {
      const ret = arg0.msCrypto;
      return ret;
    },
    __wbg_new_typed_1824d93f294193e5: function (arg0, arg1) {
      try {
        var state0 = { a: arg0, b: arg1 };
        var cb0 = (arg0, arg1) => {
          const a = state0.a;
          state0.a = 0;
          try {
            return wasm_bindgen_68d88193d3b0622c___convert__closures_____invoke___js_sys_111dd60f12cd5482___Function_fn_wasm_bindgen_68d88193d3b0622c___JsValue_____wasm_bindgen_68d88193d3b0622c___sys__Undefined___js_sys_111dd60f12cd5482___Function_fn_wasm_bindgen_68d88193d3b0622c___JsValue_____wasm_bindgen_68d88193d3b0622c___sys__Undefined_______true_(
              a,
              state0.b,
              arg0,
              arg1,
            );
          } finally {
            state0.a = a;
          }
        };
        const ret = new Promise(cb0);
        return ret;
      } finally {
        state0.a = 0;
      }
    },
    __wbg_new_with_length_e6785c33c8e4cce8: function (arg0) {
      const ret = new Uint8Array(arg0 >>> 0);
      return ret;
    },
    __wbg_node_95beb7570492fd97: function (arg0) {
      const ret = arg0.node;
      return ret;
    },
    __wbg_now_86c0d4ba3fa605b8: function () {
      const ret = Date.now();
      return ret;
    },
    __wbg_process_b2fea42461d03994: function (arg0) {
      const ret = arg0.process;
      return ret;
    },
    __wbg_prototypesetcall_4770620bbe4688a0: function (arg0, arg1, arg2) {
      Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
    },
    __wbg_queueMicrotask_0ab5b2d2393e99b9: function (arg0) {
      const ret = arg0.queueMicrotask;
      return ret;
    },
    __wbg_queueMicrotask_6a09b7bc46549209: function (arg0) {
      queueMicrotask(arg0);
    },
    __wbg_randomFillSync_ca9f178fb14c88cb: function () {
      return handleError(function (arg0, arg1) {
        arg0.randomFillSync(arg1);
      }, arguments);
    },
    __wbg_require_7a9419e39d796c95: function () {
      return handleError(function () {
        const ret = module.require;
        return ret;
      }, arguments);
    },
    __wbg_resolve_2191a4dfe481c25b: function (arg0) {
      const ret = Promise.resolve(arg0);
      return ret;
    },
    __wbg_static_accessor_GLOBAL_4ef717fb391d88b7: function () {
      const ret = typeof global === "undefined" ? null : global;
      return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    },
    __wbg_static_accessor_GLOBAL_THIS_8d1badc68b5a74f4: function () {
      const ret = typeof globalThis === "undefined" ? null : globalThis;
      return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    },
    __wbg_static_accessor_SELF_146583524fe1469b: function () {
      const ret = typeof self === "undefined" ? null : self;
      return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    },
    __wbg_static_accessor_WINDOW_f2829a2234d7819e: function () {
      const ret = typeof window === "undefined" ? null : window;
      return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    },
    __wbg_subarray_3ed232c8a6baee09: function (arg0, arg1, arg2) {
      const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
      return ret;
    },
    __wbg_then_16d107c451e9905d: function (arg0, arg1, arg2) {
      const ret = arg0.then(arg1, arg2);
      return ret;
    },
    __wbg_then_6ec10ae38b3e92f7: function (arg0, arg1) {
      const ret = arg0.then(arg1);
      return ret;
    },
    __wbg_versions_215a3ab1c9d5745a: function (arg0) {
      const ret = arg0.versions;
      return ret;
    },
    __wbindgen_cast_0000000000000001: function (arg0, arg1) {
      // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 319, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
      const ret = makeMutClosure(
        arg0,
        arg1,
        wasm_bindgen_68d88193d3b0622c___convert__closures_____invoke___wasm_bindgen_68d88193d3b0622c___JsValue__core_9b3796e30d99ddb7___result__Result_____wasm_bindgen_68d88193d3b0622c___JsError___true_,
      );
      return ret;
    },
    __wbindgen_cast_0000000000000002: function (arg0, arg1) {
      // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
      const ret = getArrayU8FromWasm0(arg0, arg1);
      return ret;
    },
    __wbindgen_cast_0000000000000003: function (arg0, arg1) {
      // Cast intrinsic for `Ref(String) -> Externref`.
      const ret = getStringFromWasm0(arg0, arg1);
      return ret;
    },
    __wbindgen_init_externref_table: function () {
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

function wasm_bindgen_68d88193d3b0622c___convert__closures_____invoke___wasm_bindgen_68d88193d3b0622c___JsValue__core_9b3796e30d99ddb7___result__Result_____wasm_bindgen_68d88193d3b0622c___JsError___true_(
  arg0,
  arg1,
  arg2,
) {
  const ret =
    wasm.wasm_bindgen_68d88193d3b0622c___convert__closures_____invoke___wasm_bindgen_68d88193d3b0622c___JsValue__core_9b3796e30d99ddb7___result__Result_____wasm_bindgen_68d88193d3b0622c___JsError___true_(
      arg0,
      arg1,
      arg2,
    );
  if (ret[1]) {
    throw takeFromExternrefTable0(ret[0]);
  }
}

function wasm_bindgen_68d88193d3b0622c___convert__closures_____invoke___js_sys_111dd60f12cd5482___Function_fn_wasm_bindgen_68d88193d3b0622c___JsValue_____wasm_bindgen_68d88193d3b0622c___sys__Undefined___js_sys_111dd60f12cd5482___Function_fn_wasm_bindgen_68d88193d3b0622c___JsValue_____wasm_bindgen_68d88193d3b0622c___sys__Undefined_______true_(
  arg0,
  arg1,
  arg2,
  arg3,
) {
  wasm.wasm_bindgen_68d88193d3b0622c___convert__closures_____invoke___js_sys_111dd60f12cd5482___Function_fn_wasm_bindgen_68d88193d3b0622c___JsValue_____wasm_bindgen_68d88193d3b0622c___sys__Undefined___js_sys_111dd60f12cd5482___Function_fn_wasm_bindgen_68d88193d3b0622c___JsValue_____wasm_bindgen_68d88193d3b0622c___sys__Undefined_______true_(
    arg0,
    arg1,
    arg2,
    arg3,
  );
}

const RustCallStatusFinalization =
  typeof FinalizationRegistry === "undefined"
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry((ptr) => wasm.__wbg_rustcallstatus_free(ptr, 1));
const WebClientRuntimeFinalization =
  typeof FinalizationRegistry === "undefined"
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry((ptr) =>
        wasm.__wbg_webclientruntime_free(ptr, 1),
      );

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

const CLOSURE_DTORS =
  typeof FinalizationRegistry === "undefined"
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry((state) =>
        wasm.__wbindgen_destroy_closure(state.a, state.b),
      );

function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
  if (
    cachedDataViewMemory0 === null ||
    cachedDataViewMemory0.buffer.detached === true ||
    (cachedDataViewMemory0.buffer.detached === undefined &&
      cachedDataViewMemory0.buffer !== wasm.memory.buffer)
  ) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
  }
  return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
  return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
  if (
    cachedUint8ArrayMemory0 === null ||
    cachedUint8ArrayMemory0.byteLength === 0
  ) {
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

function makeMutClosure(arg0, arg1, f) {
  const state = { a: arg0, b: arg1, cnt: 1 };
  const real = (...args) => {
    // First up with a closure we increment the internal reference
    // count. This ensures that the Rust closure environment won't
    // be deallocated while we're invoking it.
    state.cnt++;
    const a = state.a;
    state.a = 0;
    try {
      return f(a, state.b, ...args);
    } finally {
      state.a = a;
      real._wbg_cb_unref();
    }
  };
  real._wbg_cb_unref = () => {
    if (--state.cnt === 0) {
      wasm.__wbindgen_destroy_closure(state.a, state.b);
      state.a = 0;
      CLOSURE_DTORS.unregister(state);
    }
  };
  CLOSURE_DTORS.register(real, state, state);
  return real;
}

function passArray8ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 1, 1) >>> 0;
  getUint8ArrayMemory0().set(arg, ptr / 1);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === undefined) {
    const buf = cachedTextEncoder.encode(arg);
    const ptr = malloc(buf.length, 1) >>> 0;
    getUint8ArrayMemory0()
      .subarray(ptr, ptr + buf.length)
      .set(buf);
    WASM_VECTOR_LEN = buf.length;
    return ptr;
  }

  let len = arg.length;
  let ptr = malloc(len, 1) >>> 0;

  const mem = getUint8ArrayMemory0();

  let offset = 0;

  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 0x7f) break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset);
    }
    ptr = realloc(ptr, len, (len = offset + arg.length * 3), 1) >>> 0;
    const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
    const ret = cachedTextEncoder.encodeInto(arg, view);

    offset += ret.written;
    ptr = realloc(ptr, len, offset, 1) >>> 0;
  }

  WASM_VECTOR_LEN = offset;
  return ptr;
}

function takeFromExternrefTable0(idx) {
  const value = wasm.__wbindgen_externrefs.get(idx);
  wasm.__externref_table_dealloc(idx);
  return value;
}

let cachedTextDecoder = new TextDecoder("utf-8", {
  ignoreBOM: true,
  fatal: true,
});
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
  numBytesDecoded += len;
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder("utf-8", {
      ignoreBOM: true,
      fatal: true,
    });
    cachedTextDecoder.decode();
    numBytesDecoded = len;
  }
  return cachedTextDecoder.decode(
    getUint8ArrayMemory0().subarray(ptr, ptr + len),
  );
}

const cachedTextEncoder = new TextEncoder();

if (!("encodeInto" in cachedTextEncoder)) {
  cachedTextEncoder.encodeInto = function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
      read: arg.length,
      written: buf.length,
    };
  };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
  wasmInstance = instance;
  wasm = instance.exports;
  wasmModule = module;
  cachedDataViewMemory0 = null;
  cachedUint8ArrayMemory0 = null;
  wasm.__wbindgen_start();
  return wasm;
}

async function __wbg_load(module, imports) {
  if (typeof Response === "function" && module instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module, imports);
      } catch (e) {
        const validResponse = module.ok && expectedResponseType(module.type);

        if (
          validResponse &&
          module.headers.get("Content-Type") !== "application/wasm"
        ) {
          console.warn(
            "`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n",
            e,
          );
        } else {
          throw e;
        }
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
      case "basic":
      case "cors":
      case "default":
        return true;
    }
    return false;
  }
}

function initSync(module) {
  if (wasm !== undefined) return wasm;

  if (module !== undefined) {
    if (Object.getPrototypeOf(module) === Object.prototype) {
      ({ module } = module);
    } else {
      console.warn(
        "using deprecated parameters for `initSync()`; pass a single object instead",
      );
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
      ({ module_or_path } = module_or_path);
    } else {
      console.warn(
        "using deprecated parameters for the initialization function; pass a single object instead",
      );
    }
  }

  const imports = __wbg_get_imports();

  if (
    typeof module_or_path === "string" ||
    (typeof Request === "function" && module_or_path instanceof Request) ||
    (typeof URL === "function" && module_or_path instanceof URL)
  ) {
    module_or_path = fetch(module_or_path);
  }

  const { instance, module } = await __wbg_load(await module_or_path, imports);

  return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
