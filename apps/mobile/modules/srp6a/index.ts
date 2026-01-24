export { createSRPClient, createSRPServer, SRPError } from './src/SRP6aModule'
export type { HashAlgorithm, PrimeGroup, Ephemeral, Session, ErrorCode } from './src/SRP6a.types'
export { testSRP6a, benchmarkSRP6a } from './src/__tests__/SRP6a.test'
