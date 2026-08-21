# Vault key rotation is a forward atomic epoch cutover

Status: accepted

Bittery rotates a Vault key to protect newly accepted writes, not to pretend that keys or plaintext
already copied by a former member can be revoked. Existing Item and Attachment envelopes therefore
stay in their original epochs, while superseded offline writes from still-authorized Devices are
re-sealed under the current epoch before upload. Historical grants for currently authorized Accounts
remain while retained ciphertext references them.

Access loss and exhaustion of a fixed 2^24-envelope budget create a non-expiring, write-blocking
Rotation requirement. A client prepares one new key and a complete signed grant set, and the Server
installs the next consecutive epoch in one atomic command. The frozen product's resumable plan and
bulk re-encryption were rejected because they add manifests, staging, expiry, cleanup, and partial-
failure states without restoring secrecy for data a departed member could already hold. Automatic
rollback and operator override were rejected because either would reopen writes under the key that
the trigger retired.
