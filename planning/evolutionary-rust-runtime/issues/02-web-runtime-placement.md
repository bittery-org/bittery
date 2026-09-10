# Web runtime placement

Type: grilling
Status: resolved
Blocked by: 01

## Question

Where should Web Runtime and crypto live so opaque key handles remain valid?

## Answer

Web crypto and the Rust `ClientRuntime` share one process-wide Worker instance. The existing
SRP implementation and the Runtime execute inside that same handle-owning instance. React and the
main thread submit credentials and receive only typed results, projections, status, and opaque
references; component lifecycle does not own the Worker, live keys, or durable work.
