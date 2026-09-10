# Keep biometric unlock local

Biometric unlock remains available as the one local exception to password Quick Unlock's fresh
online SRP ceremony. The operating-system prompt may release the existing Device-bound wrapped
master unlock key, but it does not create or refresh a Server Session; Server work without a usable
Session requires password Quick Unlock or Full Sign-in. Bittery will not persist a new Auth key or
SRP-password equivalent for biometric login because the Auth key and master unlock key are separate,
the former cannot be reconstructed from the latter, and adding a durable login secret would change
the crypto and storage specification this evolutionary pivot keeps fixed.
