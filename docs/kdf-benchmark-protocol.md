# 600k KDF benchmark protocol

Record extension and Android results separately. Do not substitute desktop Node
timings for either environment.

Use this fixed vector for every run:

- Password: `testPassword123!`
- Secret Key: `A3-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`
- Email: `test@example.com`
- Profile: schema 1, `pbkdf2-sha256`, 600,000 iterations

For each target, discard five warm-up runs, record 30 measured runs with a
monotonic clock around the complete `deriveKeys` call, and report both the
median and the maximum latency in milliseconds. Confirm the output against the
cross-platform vector before accepting timings:

- Auth key: `ZceGVJ8qMMsFI+KQQBwCkK36+s1tZcnalkgD5HX8JCk=`
- Master unlock key: `o3TQ32pQg8cRvihBOAZxiA+Hz+7+o4wqWSlt4s0McNo=`

## Extension service worker

Run the measurement inside the installed extension's service-worker context,
using the packaged WASM artifact and `performance.now()`. Keep DevTools open so
the worker is not suspended between samples. Record the browser version,
extension build revision, operating system, CPU, median, and maximum.

## Low-end Android

Run the same vector through the Expo/Kotlin/JNI path on a named low-end physical
device. Use `SystemClock.elapsedRealtimeNanos()` around the complete call and
keep the device unplugged from thermal throttling or record its thermal state.
Record device model, Android version, ABI, build revision, median, and maximum.

Extension packaging, native builds, and physical-device execution are manual
gates and must be explicitly authorized. Results belong below once those gates
are run; leaving them blank is preferable to recording desktop proxy evidence.

| Target | Environment | Median (ms) | Maximum (ms) |
| --- | --- | ---: | ---: |
| Extension service worker | Pending authorized packaged run | — | — |
| Low-end Android | Pending authorized physical-device run | — | — |
