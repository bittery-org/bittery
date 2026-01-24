import { NativeModule, requireNativeModule } from 'expo'
import type { Ephemeral, HashAlgorithm, PrimeGroup, Session } from './SRP6a.types'

interface SRP6aNativeModule extends NativeModule {
  generateSalt(hashAlgorithm: string, hashBytes: number): string

  deriveSafePrivateKey(
    hashAlgorithm: string,
    salt: string,
    password: string,
    iterations: number
  ): Promise<string>

  deriveVerifier(primeGroup: number, privateKey: string): string

  generateEphemeral(
    hashAlgorithm: string,
    primeGroup: number,
    hashBytes: number
  ): Ephemeral

  deriveClientSession(
    hashAlgorithm: string,
    primeGroup: number,
    clientSecretEphemeral: string,
    serverPublicEphemeral: string,
    salt: string,
    username: string,
    privateKey: string
  ): Promise<Session>

  verifyClientSession(
    hashAlgorithm: string,
    primeGroup: number,
    clientPublicEphemeral: string,
    clientSessionKey: string,
    clientSessionProof: string,
    serverSessionProof: string
  ): Promise<void>

  generateServerEphemeral(
    hashAlgorithm: string,
    primeGroup: number,
    verifier: string,
    hashBytes: number
  ): Ephemeral

  deriveServerSession(
    hashAlgorithm: string,
    primeGroup: number,
    serverSecretEphemeral: string,
    clientPublicEphemeral: string,
    salt: string,
    username: string,
    verifier: string,
    clientSessionProof: string
  ): Promise<Session>

  verifyServerSession(
    primeGroup: number,
    serverPublicEphemeral: string,
    clientSessionKey: string,
    clientSessionProof: string,
    serverSessionProof: string
  ): Promise<void>
}

const SRP6aNative = requireNativeModule<SRP6aNativeModule>('SRP6a')

// Hash algorithm byte sizes
const hashBytes: Record<HashAlgorithm, number> = {
  'SHA-1': 160 / 8,
  'SHA-256': 256 / 8,
  'SHA-384': 384 / 8,
  'SHA-512': 512 / 8,
}

// Default PBKDF2 iterations per OWASP recommendations
const pbkdf2Iterations: Record<HashAlgorithm, number> = {
  'SHA-1': 720000,
  'SHA-256': 310000,
  'SHA-384': 215000,
  'SHA-512': 120000,
}

export class SRPError extends Error {
  constructor(
    public readonly responsibleParty: 'client' | 'server',
    public readonly code: string
  ) {
    super(`${responsibleParty}: ${code}`)
    this.name = 'SRPError'
  }
}

/**
 * Creates an SRP client for authentication.
 * This is a drop-in replacement for @bittery/srp6a's createSRPClient.
 */
export function createSRPClient(
  hashAlgorithm: HashAlgorithm,
  primeGroup: PrimeGroup
) {
  const bytes = hashBytes[hashAlgorithm]
  const defaultIterations = pbkdf2Iterations[hashAlgorithm]

  return {
    generateSalt: (): string => {
      return SRP6aNative.generateSalt(hashAlgorithm, bytes)
    },

    deriveSafePrivateKey: async (
      salt: string,
      password: string,
      iterations?: number
    ): Promise<string> => {
      const normalizedPassword = password.normalize('NFKC')
      return SRP6aNative.deriveSafePrivateKey(
        hashAlgorithm,
        salt,
        normalizedPassword,
        iterations ?? defaultIterations
      )
    },

    deriveVerifier: (privateKey: string): string => {
      return SRP6aNative.deriveVerifier(primeGroup, privateKey)
    },

    generateEphemeral: (): Ephemeral => {
      return SRP6aNative.generateEphemeral(hashAlgorithm, primeGroup, bytes)
    },

    deriveSession: async (
      clientSecretEphemeral: string,
      serverPublicEphemeral: string,
      salt: string,
      username: string,
      privateKey: string
    ): Promise<Session> => {
      const normalizedUsername = username.normalize('NFKC')
      try {
        return await SRP6aNative.deriveClientSession(
          hashAlgorithm,
          primeGroup,
          clientSecretEphemeral,
          serverPublicEphemeral,
          salt,
          normalizedUsername,
          privateKey
        )
      } catch (error: unknown) {
        if (error instanceof Error && error.message.includes('InvalidPublicEphemeral')) {
          throw new SRPError('server', 'InvalidPublicEphemeral')
        }
        throw error
      }
    },

    verifySession: async (
      clientPublicEphemeral: string,
      clientSession: Session,
      serverSessionProof: string
    ): Promise<void> => {
      try {
        await SRP6aNative.verifyClientSession(
          hashAlgorithm,
          primeGroup,
          clientPublicEphemeral,
          clientSession.key,
          clientSession.proof,
          serverSessionProof
        )
      } catch (error: unknown) {
        if (error instanceof Error && error.message.includes('InvalidSessionProof')) {
          throw new SRPError('server', 'InvalidSessionProof')
        }
        throw error
      }
    },
  }
}

/**
 * Creates an SRP server for authentication verification.
 * This is a drop-in replacement for @bittery/srp6a's createSRPServer.
 */
export function createSRPServer(
  hashAlgorithm: HashAlgorithm,
  primeGroup: PrimeGroup
) {
  const bytes = hashBytes[hashAlgorithm]

  return {
    generateEphemeral: async (verifier: string): Promise<Ephemeral> => {
      return SRP6aNative.generateServerEphemeral(
        hashAlgorithm,
        primeGroup,
        verifier,
        bytes
      )
    },

    deriveSession: async (
      serverSecretEphemeral: string,
      clientPublicEphemeral: string,
      salt: string,
      username: string,
      verifier: string,
      clientSessionProof: string
    ): Promise<Session> => {
      const normalizedUsername = username.normalize('NFKC')
      try {
        return await SRP6aNative.deriveServerSession(
          hashAlgorithm,
          primeGroup,
          serverSecretEphemeral,
          clientPublicEphemeral,
          salt,
          normalizedUsername,
          verifier,
          clientSessionProof
        )
      } catch (error: unknown) {
        if (error instanceof Error && error.message.includes('InvalidPublicEphemeral')) {
          throw new SRPError('client', 'InvalidPublicEphemeral')
        }
        if (error instanceof Error && error.message.includes('InvalidSessionProof')) {
          throw new SRPError('client', 'InvalidSessionProof')
        }
        throw error
      }
    },

    verifySession: async (
      serverPublicEphemeral: string,
      clientSession: Session,
      serverSessionProof: string
    ): Promise<void> => {
      try {
        await SRP6aNative.verifyServerSession(
          primeGroup,
          serverPublicEphemeral,
          clientSession.key,
          clientSession.proof,
          serverSessionProof
        )
      } catch (error: unknown) {
        if (error instanceof Error && error.message.includes('InvalidSessionProof')) {
          throw new SRPError('client', 'InvalidSessionProof')
        }
        throw error
      }
    },
  }
}
