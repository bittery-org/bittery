// Types
export type {
  DerivedKeys,
  EncryptedData,
  RsaKeyPair,
  Ephemeral,
  Session,
  HashAlgorithm,
  PrimeGroup,
} from "./BitteryCrypto.types";

export { ErrorCode, CryptoError } from "./BitteryCrypto.types";

// Module functions
export {
  // Key Derivation
  deriveKeys,
  // AES-256-GCM
  encrypt,
  decrypt,
  generateEncryptionKey,
  // RSA-4096
  generateRsaKeyPair,
  rsaEncrypt,
  rsaDecrypt,
  // Secret Key
  generateSecretKey,
  validateSecretKey,
  getSecretKeyHint,
  // SRP-6a
  createSRPClient,
  createSRPServer,
} from "./BitteryCryptoModule";
