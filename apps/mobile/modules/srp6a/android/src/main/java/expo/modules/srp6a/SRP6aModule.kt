package expo.modules.srp6a

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

class SRP6aModule : Module() {
    private val secureRandom = SecureRandom()

    override fun definition() = ModuleDefinition {
        Name("SRP6a")

        // Generate random salt
        Function("generateSalt") { hashAlgorithm: String, hashBytes: Int ->
            val bytes = ByteArray(hashBytes)
            secureRandom.nextBytes(bytes)
            bytes.toHexString()
        }

        // Derive private key using PBKDF2
        AsyncFunction("deriveSafePrivateKey") { hashAlgorithm: String, salt: String, password: String, iterations: Int, promise: Promise ->
            try {
                val saltBytes = salt.hexToByteArray()
                val algorithm = when (hashAlgorithm) {
                    "SHA-1" -> "PBKDF2WithHmacSHA1"
                    "SHA-256" -> "PBKDF2WithHmacSHA256"
                    "SHA-384" -> "PBKDF2WithHmacSHA384"
                    "SHA-512" -> "PBKDF2WithHmacSHA512"
                    else -> throw IllegalArgumentException("Unsupported hash algorithm: $hashAlgorithm")
                }
                val keyLength = when (hashAlgorithm) {
                    "SHA-1" -> 160
                    "SHA-256" -> 256
                    "SHA-384" -> 384
                    "SHA-512" -> 512
                    else -> 256
                }

                val spec = PBEKeySpec(password.toCharArray(), saltBytes, iterations, keyLength)
                val factory = SecretKeyFactory.getInstance(algorithm)
                val key = factory.generateSecret(spec).encoded
                promise.resolve(key.toHexString())
            } catch (e: Exception) {
                promise.reject("PBKDF2_ERROR", "PBKDF2 derivation failed: ${e.message}", e)
            }
        }

        // Derive verifier: v = g^x mod N
        Function("deriveVerifier") { primeGroup: Int, privateKey: String ->
            val params = SRPParams.getParams(primeGroup)
            val x = BigInteger(privateKey, 16)
            val v = params.g.modPow(x, params.N)
            v.toHexString(params.hexLength)
        }

        // Generate client ephemeral: A = g^a mod N
        Function("generateEphemeral") { hashAlgorithm: String, primeGroup: Int, hashBytes: Int ->
            val params = SRPParams.getParams(primeGroup)

            // Generate random a
            val aBytes = ByteArray(hashBytes)
            secureRandom.nextBytes(aBytes)
            val a = BigInteger(1, aBytes)

            // A = g^a mod N
            val A = params.g.modPow(a, params.N)

            mapOf(
                "secret" to a.toHexString(hashBytes * 2),
                "public" to A.toHexString(params.hexLength)
            )
        }

        // Derive client session
        AsyncFunction("deriveClientSession") { hashAlgorithm: String, primeGroup: Int, clientSecretEphemeral: String, serverPublicEphemeral: String, salt: String, username: String, privateKey: String, promise: Promise ->
            try {
                val params = SRPParams.getParams(primeGroup)
                val hasher = SRPHasher(hashAlgorithm)

                val a = BigInteger(clientSecretEphemeral, 16)
                val B = BigInteger(serverPublicEphemeral, 16)
                val s = BigInteger(salt, 16)
                val x = BigInteger(privateKey, 16)

                // A = g^a mod N
                val A = params.g.modPow(a, params.N)

                // B % N > 0
                if (B.mod(params.N) == BigInteger.ZERO) {
                    promise.reject("SRP_ERROR", "InvalidPublicEphemeral", null)
                    return@AsyncFunction
                }

                // u = H(PAD(A), PAD(B))
                val paddedA = A.toByteArrayPadded(params.hexLength / 2)
                val paddedB = B.toByteArrayPadded(params.hexLength / 2)
                val u = BigInteger(1, hasher.hash(paddedA + paddedB))

                // k = H(N, PAD(g))
                val paddedG = params.g.toByteArrayPadded(params.hexLength / 2)
                val k = BigInteger(1, hasher.hash(params.N.toByteArray() + paddedG))

                // S = (B - k * g^x) ^ (a + u * x) mod N
                val gx = params.g.modPow(x, params.N)
                val kgx = k.multiply(gx).mod(params.N)
                var base = B.subtract(kgx)
                if (base.signum() < 0) {
                    base = base.add(params.N)
                }
                val exp = a.add(u.multiply(x))
                val S = base.modPow(exp, params.N)

                // K = H(S)
                val K = hasher.hash(S.toByteArrayPadded(params.hexLength / 2))

                // M = H(H(N) xor H(g), H(I), s, A, B, K)
                val HN = hasher.hash(params.N.toByteArray())
                val Hg = hasher.hash(params.g.toByteArray())
                val HNxorHg = HN.zip(Hg).map { (a, b) -> (a.toInt() xor b.toInt()).toByte() }.toByteArray()
                val HI = hasher.hash(username.toByteArray(Charsets.UTF_8))

                val mInput = HNxorHg + HI +
                        s.toByteArrayPadded(params.hexLength / 2) +
                        A.toByteArrayPadded(params.hexLength / 2) +
                        B.toByteArrayPadded(params.hexLength / 2) +
                        K

                val M = hasher.hash(mInput)

                promise.resolve(
                    mapOf(
                        "key" to K.toHexString(),
                        "proof" to M.toHexString()
                    )
                )
            } catch (e: Exception) {
                promise.reject("SRP_ERROR", "Session derivation failed: ${e.message}", e)
            }
        }

        // Verify client session
        AsyncFunction("verifyClientSession") { hashAlgorithm: String, primeGroup: Int, clientPublicEphemeral: String, clientSessionKey: String, clientSessionProof: String, serverSessionProof: String, promise: Promise ->
            try {
                val hasher = SRPHasher(hashAlgorithm)

                val A = clientPublicEphemeral.hexToByteArray()
                val M = clientSessionProof.hexToByteArray()
                val K = clientSessionKey.hexToByteArray()

                // Expected = H(A, M, K)
                val expected = hasher.hash(A + M + K)
                val actual = serverSessionProof.hexToByteArray()

                if (!expected.contentEquals(actual)) {
                    promise.reject("SRP_ERROR", "InvalidSessionProof", null)
                    return@AsyncFunction
                }
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("SRP_ERROR", "Session verification failed: ${e.message}", e)
            }
        }

        // Generate server ephemeral: B = kv + g^b mod N
        Function("generateServerEphemeral") { hashAlgorithm: String, primeGroup: Int, verifier: String, hashBytes: Int ->
            val params = SRPParams.getParams(primeGroup)
            val hasher = SRPHasher(hashAlgorithm)
            val v = BigInteger(verifier, 16)

            // Generate random b
            val bBytes = ByteArray(hashBytes)
            secureRandom.nextBytes(bBytes)
            val b = BigInteger(1, bBytes)

            // k = H(N, PAD(g))
            val paddedG = params.g.toByteArrayPadded(params.hexLength / 2)
            val k = BigInteger(1, hasher.hash(params.N.toByteArray() + paddedG))

            // B = kv + g^b mod N
            val kv = k.multiply(v).mod(params.N)
            val gb = params.g.modPow(b, params.N)
            val B = kv.add(gb).mod(params.N)

            mapOf(
                "secret" to b.toHexString(hashBytes * 2),
                "public" to B.toHexString(params.hexLength)
            )
        }

        // Derive server session
        AsyncFunction("deriveServerSession") { hashAlgorithm: String, primeGroup: Int, serverSecretEphemeral: String, clientPublicEphemeral: String, salt: String, username: String, verifier: String, clientSessionProof: String, promise: Promise ->
            try {
                val params = SRPParams.getParams(primeGroup)
                val hasher = SRPHasher(hashAlgorithm)

                val b = BigInteger(serverSecretEphemeral, 16)
                val A = BigInteger(clientPublicEphemeral, 16)
                val s = BigInteger(salt, 16)
                val v = BigInteger(verifier, 16)

                // A % N > 0
                if (A.mod(params.N) == BigInteger.ZERO) {
                    promise.reject("SRP_ERROR", "InvalidPublicEphemeral", null)
                    return@AsyncFunction
                }

                // k = H(N, PAD(g))
                val paddedG = params.g.toByteArrayPadded(params.hexLength / 2)
                val k = BigInteger(1, hasher.hash(params.N.toByteArray() + paddedG))

                // B = kv + g^b mod N
                val kv = k.multiply(v).mod(params.N)
                val gb = params.g.modPow(b, params.N)
                val B = kv.add(gb).mod(params.N)

                // u = H(PAD(A), PAD(B))
                val paddedA = A.toByteArrayPadded(params.hexLength / 2)
                val paddedB = B.toByteArrayPadded(params.hexLength / 2)
                val u = BigInteger(1, hasher.hash(paddedA + paddedB))

                // S = (A * v^u) ^ b mod N
                val vu = v.modPow(u, params.N)
                val base = A.multiply(vu).mod(params.N)
                val S = base.modPow(b, params.N)

                // K = H(S)
                val K = hasher.hash(S.toByteArrayPadded(params.hexLength / 2))

                // M = H(H(N) xor H(g), H(I), s, A, B, K)
                val HN = hasher.hash(params.N.toByteArray())
                val Hg = hasher.hash(params.g.toByteArray())
                val HNxorHg = HN.zip(Hg).map { (a, b) -> (a.toInt() xor b.toInt()).toByte() }.toByteArray()
                val HI = hasher.hash(username.toByteArray(Charsets.UTF_8))

                val mInput = HNxorHg + HI +
                        s.toByteArrayPadded(params.hexLength / 2) +
                        A.toByteArrayPadded(params.hexLength / 2) +
                        B.toByteArrayPadded(params.hexLength / 2) +
                        K

                val M = hasher.hash(mInput)

                // Verify client proof
                val expectedProof = M.toHexString()
                if (clientSessionProof.lowercase() != expectedProof) {
                    promise.reject("SRP_ERROR", "InvalidSessionProof", null)
                    return@AsyncFunction
                }

                // P = H(A, M, K)
                val pInput = A.toByteArrayPadded(params.hexLength / 2) + M + K
                val P = hasher.hash(pInput)

                promise.resolve(
                    mapOf(
                        "key" to K.toHexString(),
                        "proof" to P.toHexString()
                    )
                )
            } catch (e: Exception) {
                promise.reject("SRP_ERROR", "Session derivation failed: ${e.message}", e)
            }
        }

        // Verify server session
        AsyncFunction("verifyServerSession") { primeGroup: Int, serverPublicEphemeral: String, clientSessionKey: String, clientSessionProof: String, serverSessionProof: String, promise: Promise ->
            try {
                // Server verification is done by comparing session proofs
                val expected = serverSessionProof.hexToByteArray()
                val actual = clientSessionProof.hexToByteArray()

                if (!expected.contentEquals(actual)) {
                    promise.reject("SRP_ERROR", "InvalidSessionProof", null)
                    return@AsyncFunction
                }
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("SRP_ERROR", "Session verification failed: ${e.message}", e)
            }
        }
    }
}

// Extension functions
private fun ByteArray.toHexString(): String = joinToString("") { "%02x".format(it) }

private fun String.hexToByteArray(): ByteArray {
    val sanitized = this.lowercase().replace(" ", "").replace("\n", "")
    return ByteArray(sanitized.length / 2) { i ->
        sanitized.substring(i * 2, i * 2 + 2).toInt(16).toByte()
    }
}

private fun BigInteger.toHexString(minLength: Int): String {
    val hex = this.toString(16)
    return if (hex.length < minLength) {
        "0".repeat(minLength - hex.length) + hex
    } else {
        hex
    }
}

private fun BigInteger.toByteArrayPadded(length: Int): ByteArray {
    val bytes = this.toByteArray()
    return when {
        bytes.size == length -> bytes
        bytes.size > length -> {
            // Remove leading zeros if present
            if (bytes[0] == 0.toByte() && bytes.size == length + 1) {
                bytes.copyOfRange(1, bytes.size)
            } else {
                bytes.copyOfRange(bytes.size - length, bytes.size)
            }
        }
        else -> {
            // Pad with zeros
            val padded = ByteArray(length)
            System.arraycopy(bytes, 0, padded, length - bytes.size, bytes.size)
            padded
        }
    }
}

// SRP Hasher class
private class SRPHasher(private val algorithm: String) {
    private val digestAlgorithm = when (algorithm) {
        "SHA-1" -> "SHA-1"
        "SHA-256" -> "SHA-256"
        "SHA-384" -> "SHA-384"
        "SHA-512" -> "SHA-512"
        else -> throw IllegalArgumentException("Unsupported hash algorithm: $algorithm")
    }

    fun hash(data: ByteArray): ByteArray {
        val digest = MessageDigest.getInstance(digestAlgorithm)
        return digest.digest(data)
    }
}

// SRP Parameters
private data class SRPParams(
    val N: BigInteger,
    val g: BigInteger,
    val hexLength: Int
) {
    companion object {
        fun getParams(primeGroup: Int): SRPParams = when (primeGroup) {
            1024 -> SRPParams(
                N = BigInteger("EEAF0AB9ADB38DD69C33F80AFA8FC5E86072618775FF3C0B9EA2314C9C256576D674DF7496EA81D3383B4813D692C6E0E0D5D8E250B98BE48E495C1D6089DAD15DC7D7B46154D6B6CE8EF4AD69B15D4982559B297BCF1885C529F566660E57EC68EDBC3C05726CC02FD4CBF4976EAA9AFD5138FE8376435B9FC61D2FC0EB06E3", 16),
                g = BigInteger.valueOf(2),
                hexLength = 256
            )
            1536 -> SRPParams(
                N = BigInteger("9DEF3CAFB939277AB1F12A8617A47BBBDBA51DF499AC4C80BEEEA9614B19CC4D5F4F5F556E27CBDE51C6A94BE4607A291558903BA0D0F84380B655BB9A22E8DCDF028A7CEC67F0D08134B1C8B97989149B609E0BE3BAB63D47548381DBC5B1FC764E3F4B53DD9DA1158BFD3E2B9C8CF56EDF019539349627DB2FD53D24B7C48665772E437D6C7F8CE442734AF7CCB7AE837C264AE3A9BEB87F8A2FE9B8B5292E5A021FFF5E91479E8CE7A28C2442C6F315180F93499A234DCF76E3FED135F9BB", 16),
                g = BigInteger.valueOf(2),
                hexLength = 384
            )
            2048 -> SRPParams(
                N = BigInteger("AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB694B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73", 16),
                g = BigInteger.valueOf(2),
                hexLength = 512
            )
            3072 -> SRPParams(
                N = BigInteger("FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF", 16),
                g = BigInteger.valueOf(5),
                hexLength = 768
            )
            4096 -> SRPParams(
                N = BigInteger("FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A92108011A723C12A787E6D788719A10BDBA5B2699C327186AF4E23C1A946834B6150BDA2583E9CA2AD44CE8DBBBC2DB04DE8EF92E8EFC141FBECAA6287C59474E6BC05D99B2964FA090C3A2233BA186515BE7ED1F612970CEE2D7AFB81BDD762170481CD0069127D5B05AA993B4EA988D8FDDC186FFB7DC90A6C08F4DF435C934063199FFFFFFFFFFFFFFFF", 16),
                g = BigInteger.valueOf(5),
                hexLength = 1024
            )
            6144 -> SRPParams(
                N = BigInteger("FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A92108011A723C12A787E6D788719A10BDBA5B2699C327186AF4E23C1A946834B6150BDA2583E9CA2AD44CE8DBBBC2DB04DE8EF92E8EFC141FBECAA6287C59474E6BC05D99B2964FA090C3A2233BA186515BE7ED1F612970CEE2D7AFB81BDD762170481CD0069127D5B05AA993B4EA988D8FDDC186FFB7DC90A6C08F4DF435C93402849236C3FAB4D27C7026C1D4DCB2602646DEC9751E763DBA37BDF8FF9406AD9E530EE5DB382F413001AEB06A53ED9027D831179727B0865A8918DA3EDBEBCF9B14ED44CE6CBACED4BB1BDB7F1447E6CC254B332051512BD7AF426FB8F401378CD2BF5983CA01C64B92ECF032EA15D1721D03F482D7CE6E74FEF6D55E702F46980C82B5A84031900B1C9E59E7C97FBEC7E8F323A97A7E36CC88BE0F1D45B7FF585AC54BD407B22B4154AACC8F6D7EBF48E1D814CC5ED20F8037E0A79715EEF29BE32806A1D58BB7C5DA76F550AA3D8A1FBFF0EB19CCB1A313D55CDA56C9EC2EF29632387FE8D76E3C0468043E8F663F4860EE12BF2D5B0B7474D6E694F91E6DCC4024FFFFFFFFFFFFFFFF", 16),
                g = BigInteger.valueOf(5),
                hexLength = 1536
            )
            8192 -> SRPParams(
                N = BigInteger("FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A92108011A723C12A787E6D788719A10BDBA5B2699C327186AF4E23C1A946834B6150BDA2583E9CA2AD44CE8DBBBC2DB04DE8EF92E8EFC141FBECAA6287C59474E6BC05D99B2964FA090C3A2233BA186515BE7ED1F612970CEE2D7AFB81BDD762170481CD0069127D5B05AA993B4EA988D8FDDC186FFB7DC90A6C08F4DF435C93402849236C3FAB4D27C7026C1D4DCB2602646DEC9751E763DBA37BDF8FF9406AD9E530EE5DB382F413001AEB06A53ED9027D831179727B0865A8918DA3EDBEBCF9B14ED44CE6CBACED4BB1BDB7F1447E6CC254B332051512BD7AF426FB8F401378CD2BF5983CA01C64B92ECF032EA15D1721D03F482D7CE6E74FEF6D55E702F46980C82B5A84031900B1C9E59E7C97FBEC7E8F323A97A7E36CC88BE0F1D45B7FF585AC54BD407B22B4154AACC8F6D7EBF48E1D814CC5ED20F8037E0A79715EEF29BE32806A1D58BB7C5DA76F550AA3D8A1FBFF0EB19CCB1A313D55CDA56C9EC2EF29632387FE8D76E3C0468043E8F663F4860EE12BF2D5B0B7474D6E694F91E6DBE115974A3926F12FEE5E438777CB6A932DF8CD8BEC4D073B931BA3BC832B68D9DD300741FA7BF8AFC47ED2576F6936BA424663AAB639C5AE4F5683423B4742BF1C978238F16CBE39D652DE3FDB8BEFC848AD922222E04A4037C0713EB57A81A23F0C73473FC646CEA306B4BCBC8862F8385DDFA9D4B7FA2C087E879683303ED5BDD3A062B3CF5B3A278A66D2A13F83F44F82DDF310EE074AB6A364597E899A0255DC164F31CC50846851DF9AB48195DED7EA1B1D510BD7EE74D73FAF36BC31ECFA268359046F4EB879F924009438B481C6CD7889A002ED5EE382BC9190DA6FC026E479558E4475677E9AA9E3050E2765694DFC81F56E880B96E7160C980DD98EDD3DFFFFFFFFFFFFFFFFF", 16),
                g = BigInteger.valueOf(19),
                hexLength = 2048
            )
            else -> throw IllegalArgumentException("Unsupported prime group: $primeGroup")
        }
    }
}
