package com.bittery.runtime

import java.util.concurrent.atomic.AtomicBoolean
import uniffi.bittery_client_bindings.ClientRuntime as NativeClientRuntime
import uniffi.bittery_client_bindings.ObservationHandle
import uniffi.bittery_client_bindings.ObservationRequest
import uniffi.bittery_client_bindings.ObservationSink
import uniffi.bittery_client_bindings.RuntimeRequest
import uniffi.bittery_client_bindings.RuntimeResponse

/** Stable Kotlin facade; the raw UniFFI `shutdown` name avoids its `AutoCloseable.close` collision. */
class BitteryClientRuntime(
    private val native: NativeClientRuntime = NativeClientRuntime(),
) {
    private val closed = AtomicBoolean(false)

    suspend fun request(request: RuntimeRequest): RuntimeResponse = native.request(request)

    fun observe(request: ObservationRequest, sink: ObservationSink): ObservationHandle =
        native.observe(request, sink)

    suspend fun close() {
        if (closed.compareAndSet(false, true)) {
            native.shutdown()
        }
    }
}
