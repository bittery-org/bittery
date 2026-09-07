# ClientRuntime interface shape

Type: grilling
Status: resolved
Blocked by: 02

## Question

Which external Runtime interface can serve Web and native hosts without exposing internal policy?

## Answer

The external Runtime seam is a closed typed protocol with `request`, `observe`, and `close`. The first
slice implements only the Sign-in, Login-Item creation, Items projection, and Runtime-status variants
it needs. Account scope is explicit wherever an Account already exists; Sign-in returns the new
Account identity. Host-specific TypeScript, Kotlin, and Swift adapters may expose convenient methods
but add no Domain, Replica, authentication, or Sync behavior. Cancellation stops waiting or
observation and never cancels an accepted durable Operation.
