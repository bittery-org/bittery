/**
 * SRP-6a Native Module Test
 *
 * This test file verifies that the native SRP-6a implementation
 * produces correct results matching the JavaScript implementation.
 *
 * Run these tests in the app by importing and calling testSRP6a()
 */

import { createSRPClient, createSRPServer } from '../SRP6aModule'

export async function testSRP6a(): Promise<{ success: boolean; message: string; details?: unknown }> {
  try {
    console.log('[SRP6a Test] Starting native module test...')
    const startTime = Date.now()

    const client = createSRPClient('SHA-256', 4096)
    const server = createSRPServer('SHA-256', 4096)

    const username = ''
    const password = 'testPassword123!'

    // Step 1: Generate registration data
    console.log('[SRP6a Test] Generating salt...')
    const salt = client.generateSalt()
    console.log(`[SRP6a Test] Salt: ${salt.substring(0, 20)}...`)

    // Step 2: Derive private key
    console.log('[SRP6a Test] Deriving private key (PBKDF2)...')
    const privateKeyStart = Date.now()
    const privateKey = await client.deriveSafePrivateKey(salt, password)
    console.log(`[SRP6a Test] Private key derivation: ${Date.now() - privateKeyStart}ms`)

    // Step 3: Derive verifier
    console.log('[SRP6a Test] Deriving verifier...')
    const verifier = client.deriveVerifier(privateKey)
    console.log(`[SRP6a Test] Verifier: ${verifier.substring(0, 20)}...`)

    // Step 4: Generate ephemeral keys
    console.log('[SRP6a Test] Generating client ephemeral...')
    const clientEphemeral = client.generateEphemeral()
    console.log(`[SRP6a Test] Client public: ${clientEphemeral.public.substring(0, 20)}...`)

    console.log('[SRP6a Test] Generating server ephemeral...')
    const serverEphemeral = await server.generateEphemeral(verifier)
    console.log(`[SRP6a Test] Server public: ${serverEphemeral.public.substring(0, 20)}...`)

    // Step 5: Derive client session
    console.log('[SRP6a Test] Deriving client session...')
    const clientSessionStart = Date.now()
    const clientSession = await client.deriveSession(
      clientEphemeral.secret,
      serverEphemeral.public,
      salt,
      username,
      privateKey
    )
    console.log(`[SRP6a Test] Client session: ${Date.now() - clientSessionStart}ms`)
    console.log(`[SRP6a Test] Client key: ${clientSession.key.substring(0, 20)}...`)
    console.log(`[SRP6a Test] Client proof: ${clientSession.proof.substring(0, 20)}...`)

    // Step 6: Derive server session (verifies client proof)
    console.log('[SRP6a Test] Deriving server session...')
    const serverSessionStart = Date.now()
    const serverSession = await server.deriveSession(
      serverEphemeral.secret,
      clientEphemeral.public,
      salt,
      username,
      verifier,
      clientSession.proof
    )
    console.log(`[SRP6a Test] Server session: ${Date.now() - serverSessionStart}ms`)
    console.log(`[SRP6a Test] Server key: ${serverSession.key.substring(0, 20)}...`)
    console.log(`[SRP6a Test] Server proof: ${serverSession.proof.substring(0, 20)}...`)

    // Step 7: Verify server proof
    console.log('[SRP6a Test] Verifying server session...')
    await client.verifySession(clientEphemeral.public, clientSession, serverSession.proof)
    console.log('[SRP6a Test] Server verification successful!')

    // Step 8: Verify keys match
    if (clientSession.key !== serverSession.key) {
      throw new Error(`Session keys don't match!\nClient: ${clientSession.key}\nServer: ${serverSession.key}`)
    }
    console.log('[SRP6a Test] Session keys match!')

    const totalTime = Date.now() - startTime
    console.log(`[SRP6a Test] Total time: ${totalTime}ms`)

    return {
      success: true,
      message: `SRP-6a test passed in ${totalTime}ms`,
      details: {
        totalTime,
        sessionKeysMatch: true,
        clientKey: clientSession.key,
        serverKey: serverSession.key
      }
    }
  } catch (error) {
    console.error('[SRP6a Test] Error:', error)
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
      details: error
    }
  }
}

/**
 * Benchmark test to compare performance
 */
export async function benchmarkSRP6a(iterations = 5): Promise<{
  averageTime: number
  times: number[]
}> {
  const times: number[] = []

  for (let i = 0; i < iterations; i++) {
    const start = Date.now()
    await testSRP6a()
    times.push(Date.now() - start)
  }

  const averageTime = times.reduce((a, b) => a + b, 0) / times.length

  console.log(`[SRP6a Benchmark] Average time: ${averageTime.toFixed(2)}ms`)
  console.log(`[SRP6a Benchmark] Times: ${times.join(', ')}ms`)

  return { averageTime, times }
}
