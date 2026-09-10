import Foundation

/// Stable Swift facade; the raw UniFFI `shutdown` name avoids Kotlin's `AutoCloseable.close` clash.
public final class BitteryClientRuntime: @unchecked Sendable {
    private let native: ClientRuntime
    private let closeLock = NSLock()
    private var closed = false

    public init(native: ClientRuntime = ClientRuntime()) {
        self.native = native
    }

    public func request(_ request: RuntimeRequest) async throws -> RuntimeResponse {
        try await native.request(request: request)
    }

    public func observe(
        _ request: ObservationRequest,
        sink: ObservationSink
    ) throws -> ObservationHandle {
        try native.observe(request: request, sink: sink)
    }

    public func close() async {
        if beginClose() {
            await native.shutdown()
        }
    }

    private func beginClose() -> Bool {
        closeLock.lock()
        let shouldClose = !closed
        closed = true
        closeLock.unlock()
        return shouldClose
    }
}
