const KOTLIN: &str = include_str!(
    "../../../generated/native/kotlin/uniffi/bittery_client_bindings/bittery_client_bindings.kt"
);
const SWIFT: &str = include_str!("../../../generated/native/swift/bittery_client_bindings.swift");
const KOTLIN_FACADE: &str = include_str!("../facades/kotlin/BitteryClientRuntime.kt");
const SWIFT_FACADE: &str = include_str!("../facades/swift/BitteryClientRuntime.swift");
const WEB_DECLARATIONS: &str =
    include_str!("../../../../crypto/wasm/generated/wasm-bindgen/index.d.ts");
const WEB_BINDING_SOURCE: &str = include_str!("../src/web.rs");

#[test]
fn native_generated_values_keep_plaintext_behind_opaque_objects() {
    for name in [
        "SecretString",
        "LoginCustomField",
        "LoginItemDraft",
        "LoginItemProjection",
    ] {
        assert!(KOTLIN.contains(&format!("open class {name}:")));
        assert!(!KOTLIN.contains(&format!("data class {name}")));
        assert!(SWIFT.contains(&format!("open class {name}:")));
        assert!(!SWIFT.contains(&format!("public struct {name}")));
    }
    assert!(KOTLIN.contains("val `masterPassword`: uniffi.bittery_client_bindings.SecretString"));
    assert!(KOTLIN.contains("val `draft`: uniffi.bittery_client_bindings.LoginItemDraft"));
    assert!(SWIFT.contains("masterPassword: SecretString, secretKey: SecretString"));
    assert!(SWIFT.contains("draft: LoginItemDraft"));
    assert!(!KOTLIN.contains("override fun toString"));
    assert!(!SWIFT.contains("CustomStringConvertible"));
}

#[test]
fn every_host_exposes_the_stable_async_close_facade() {
    assert!(KOTLIN_FACADE.contains("suspend fun close()"));
    assert!(KOTLIN_FACADE.contains("native.shutdown()"));
    assert!(SWIFT_FACADE.contains("public func close() async"));
    assert!(SWIFT_FACADE.contains("await native.shutdown()"));
    assert!(WEB_DECLARATIONS.contains("close(): Promise<void>"));
}

#[test]
fn web_exposes_one_flat_serialized_executor_factory_and_async_open() {
    assert!(WEB_DECLARATIONS.contains("static withExecutors("));
    assert!(WEB_DECLARATIONS.contains("replica_invoke: Function,"));
    assert!(WEB_DECLARATIONS.contains("platform_storage_invoke: Function,"));
    assert!(WEB_DECLARATIONS.contains("http_invoke: Function,"));
    assert!(WEB_DECLARATIONS.contains("http_cancel: Function,"));
    assert!(WEB_DECLARATIONS.contains("open(): Promise<void>;"));
}

#[test]
fn web_close_cancels_binding_requests_before_waiting_for_core_close() {
    let close = WEB_BINDING_SOURCE
        .find("pub async fn close(&self)")
        .expect("Web close method");
    let close_body = &WEB_BINDING_SOURCE[close..];
    let cancel = close_body
        .find("cancellation.cancel();")
        .expect("binding request cancellation");
    let core_close = close_body
        .find("self.inner.close().await;")
        .expect("Core close await");

    assert!(cancel < core_close);
}

/// Every Web Runtime drives the dispatch loop, whichever constructor built it.
///
/// The core loop is a plain future with no scheduler of its own, so an unspawned one means an
/// Operation accepted offline is durable and never sent. `from_inner` is the single place every
/// constructor funnels through, which is why the assertion is anchored there.
#[test]
fn web_constructors_drive_the_operation_dispatch_loop() {
    let from_inner = WEB_BINDING_SOURCE
        .find("fn from_inner(inner: Arc<core::Runtime>) -> Self {")
        .expect("Web from_inner constructor");
    let body = &WEB_BINDING_SOURCE[from_inner..];
    let end = body.find("\n    }\n").expect("from_inner body ends");
    let body = &body[..end];
    assert!(
        body.contains("spawn_local(Arc::clone(&inner).run_operation_dispatch());"),
        "from_inner must lend the Runtime the Worker's executor"
    );
    assert!(
        body.contains("drain_published_observations("),
        "and must still deliver published observations"
    );

    for constructor in [
        "pub fn new() -> Self {",
        "pub fn with_replica_executor(",
        "pub fn with_executors(",
        "pub fn with_configured_executors(",
    ] {
        let start = WEB_BINDING_SOURCE
            .find(constructor)
            .unwrap_or_else(|| panic!("constructor {constructor}"));
        let rest = &WEB_BINDING_SOURCE[start..];
        let end = rest.find("\n    }\n").expect("constructor body ends");
        assert!(
            rest[..end].contains("Self::from_inner("),
            "{constructor} must build through from_inner"
        );
    }
}
