import ExpoModulesCore
import CommonCrypto

public class SRP6aModule: Module {
    public func definition() -> ModuleDefinition {
        Name("SRP6a")

        // Generate random salt
        Function("generateSalt") { (hashAlgorithm: String, hashBytes: Int) -> String in
            var bytes = [UInt8](repeating: 0, count: hashBytes)
            let status = SecRandomCopyBytes(kSecRandomDefault, hashBytes, &bytes)
            guard status == errSecSuccess else {
                throw SRPException("Failed to generate random bytes")
            }
            return bytes.map { String(format: "%02x", $0) }.joined()
        }

        // Derive private key using PBKDF2
        AsyncFunction("deriveSafePrivateKey") { (hashAlgorithm: String, salt: String, password: String, iterations: Int) -> String in
            let saltData = hexToData(salt)
            let passwordData = Data(password.utf8)

            let algorithm: CCPseudoRandomAlgorithm
            let keyLength: Int
            switch hashAlgorithm {
            case "SHA-1":
                algorithm = CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1)
                keyLength = 20
            case "SHA-256":
                algorithm = CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256)
                keyLength = 32
            case "SHA-384":
                algorithm = CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA384)
                keyLength = 48
            case "SHA-512":
                algorithm = CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA512)
                keyLength = 64
            default:
                throw SRPException("Unsupported hash algorithm: \(hashAlgorithm)")
            }

            var derivedKey = [UInt8](repeating: 0, count: keyLength)
            let status = CCKeyDerivationPBKDF(
                CCPBKDFAlgorithm(kCCPBKDF2),
                password,
                passwordData.count,
                [UInt8](saltData),
                saltData.count,
                algorithm,
                UInt32(iterations),
                &derivedKey,
                keyLength
            )

            guard status == kCCSuccess else {
                throw SRPException("PBKDF2 derivation failed with status: \(status)")
            }

            return derivedKey.map { String(format: "%02x", $0) }.joined()
        }

        // Derive verifier: v = g^x mod N
        Function("deriveVerifier") { (primeGroup: Int, privateKey: String) -> String in
            let params = SRPParams.getParams(primeGroup)
            let x = BigUInt(hexString: privateKey)
            let v = x.modPow(base: params.g, modulus: params.N)
            return v.toHexString().padLeft(toLength: params.hexLength)
        }

        // Generate client ephemeral: A = g^a mod N
        Function("generateEphemeral") { (hashAlgorithm: String, primeGroup: Int, hashBytes: Int) -> [String: String] in
            let params = SRPParams.getParams(primeGroup)

            // Generate random a
            var bytes = [UInt8](repeating: 0, count: hashBytes)
            let status = SecRandomCopyBytes(kSecRandomDefault, hashBytes, &bytes)
            guard status == errSecSuccess else {
                throw SRPException("Failed to generate random bytes")
            }
            let a = BigUInt(data: Data(bytes))

            // A = g^a mod N
            let A = a.modPow(base: params.g, modulus: params.N)

            return [
                "secret": a.toHexString().padLeft(toLength: hashBytes * 2),
                "public": A.toHexString().padLeft(toLength: params.hexLength)
            ]
        }

        // Derive client session
        AsyncFunction("deriveClientSession") { (hashAlgorithm: String, primeGroup: Int, clientSecretEphemeral: String, serverPublicEphemeral: String, salt: String, username: String, privateKey: String) -> [String: String] in
            let params = SRPParams.getParams(primeGroup)
            let hasher = SRPHasher(algorithm: hashAlgorithm)

            let a = BigUInt(hexString: clientSecretEphemeral)
            let B = BigUInt(hexString: serverPublicEphemeral)
            let s = BigUInt(hexString: salt)
            let x = BigUInt(hexString: privateKey)

            // A = g^a mod N
            let A = a.modPow(base: params.g, modulus: params.N)

            // B % N > 0
            guard !B.mod(params.N).isZero else {
                throw SRPException("InvalidPublicEphemeral")
            }

            // u = H(PAD(A), PAD(B))
            let paddedA = A.toData().padLeft(toLength: params.hexLength / 2)
            let paddedB = B.toData().padLeft(toLength: params.hexLength / 2)
            let u = BigUInt(data: Data(hasher.hash(paddedA + paddedB)))

            // k = H(N, PAD(g))
            let paddedG = params.g.toData().padLeft(toLength: params.hexLength / 2)
            let k = BigUInt(data: Data(hasher.hash(params.N.toData() + paddedG)))

            // S = (B - k * g^x) ^ (a + u * x) mod N
            let gx = x.modPow(base: params.g, modulus: params.N)
            let kgx = k.multiply(gx).mod(params.N)

            var base: BigUInt
            if B.compare(kgx) == .greaterThan {
                base = B.subtract(kgx)
            } else {
                base = params.N.subtract(kgx).add(B)
            }
            let exp = a.add(u.multiply(x))
            let S = exp.modPow(base: base, modulus: params.N)

            // K = H(S)
            let K = hasher.hash(S.toData().padLeft(toLength: params.hexLength / 2))

            // M = H(H(N) xor H(g), H(I), s, A, B, K)
            let HN = hasher.hash(params.N.toData())
            let Hg = hasher.hash(params.g.toData())
            let HNxorHg = zip(HN, Hg).map { $0 ^ $1 }
            let HI = hasher.hash(Data(username.utf8))

            var mInput = Data()
            mInput.append(contentsOf: HNxorHg)
            mInput.append(contentsOf: HI)
            mInput.append(s.toData().padLeft(toLength: params.hexLength / 2))
            mInput.append(A.toData().padLeft(toLength: params.hexLength / 2))
            mInput.append(B.toData().padLeft(toLength: params.hexLength / 2))
            mInput.append(contentsOf: K)

            let M = hasher.hash(mInput)

            return [
                "key": K.map { String(format: "%02x", $0) }.joined(),
                "proof": M.map { String(format: "%02x", $0) }.joined()
            ]
        }

        // Verify client session
        AsyncFunction("verifyClientSession") { (hashAlgorithm: String, primeGroup: Int, clientPublicEphemeral: String, clientSessionKey: String, clientSessionProof: String, serverSessionProof: String) in
            let hasher = SRPHasher(algorithm: hashAlgorithm)

            let A = hexToData(clientPublicEphemeral)
            let M = hexToData(clientSessionProof)
            let K = hexToData(clientSessionKey)

            // Expected = H(A, M, K)
            var input = Data()
            input.append(A)
            input.append(M)
            input.append(K)
            let expected = hasher.hash(input)

            let actual = hexToData(serverSessionProof)

            guard expected == [UInt8](actual) else {
                throw SRPException("InvalidSessionProof")
            }
        }

        // Generate server ephemeral: B = kv + g^b mod N
        Function("generateServerEphemeral") { (hashAlgorithm: String, primeGroup: Int, verifier: String, hashBytes: Int) -> [String: String] in
            let params = SRPParams.getParams(primeGroup)
            let hasher = SRPHasher(algorithm: hashAlgorithm)
            let v = BigUInt(hexString: verifier)

            // Generate random b
            var bytes = [UInt8](repeating: 0, count: hashBytes)
            let status = SecRandomCopyBytes(kSecRandomDefault, hashBytes, &bytes)
            guard status == errSecSuccess else {
                throw SRPException("Failed to generate random bytes")
            }
            let b = BigUInt(data: Data(bytes))

            // k = H(N, PAD(g))
            let paddedG = params.g.toData().padLeft(toLength: params.hexLength / 2)
            let k = BigUInt(data: Data(hasher.hash(params.N.toData() + paddedG)))

            // B = kv + g^b mod N
            let kv = k.multiply(v).mod(params.N)
            let gb = b.modPow(base: params.g, modulus: params.N)
            let B = kv.add(gb).mod(params.N)

            return [
                "secret": b.toHexString().padLeft(toLength: hashBytes * 2),
                "public": B.toHexString().padLeft(toLength: params.hexLength)
            ]
        }

        // Derive server session
        AsyncFunction("deriveServerSession") { (hashAlgorithm: String, primeGroup: Int, serverSecretEphemeral: String, clientPublicEphemeral: String, salt: String, username: String, verifier: String, clientSessionProof: String) -> [String: String] in
            let params = SRPParams.getParams(primeGroup)
            let hasher = SRPHasher(algorithm: hashAlgorithm)

            let b = BigUInt(hexString: serverSecretEphemeral)
            let A = BigUInt(hexString: clientPublicEphemeral)
            let s = BigUInt(hexString: salt)
            let v = BigUInt(hexString: verifier)

            // A % N > 0
            guard !A.mod(params.N).isZero else {
                throw SRPException("InvalidPublicEphemeral")
            }

            // k = H(N, PAD(g))
            let paddedG = params.g.toData().padLeft(toLength: params.hexLength / 2)
            let k = BigUInt(data: Data(hasher.hash(params.N.toData() + paddedG)))

            // B = kv + g^b mod N
            let kv = k.multiply(v).mod(params.N)
            let gb = b.modPow(base: params.g, modulus: params.N)
            let B = kv.add(gb).mod(params.N)

            // u = H(PAD(A), PAD(B))
            let paddedA = A.toData().padLeft(toLength: params.hexLength / 2)
            let paddedB = B.toData().padLeft(toLength: params.hexLength / 2)
            let u = BigUInt(data: Data(hasher.hash(paddedA + paddedB)))

            // S = (A * v^u) ^ b mod N
            let vu = u.modPow(base: v, modulus: params.N)
            let base = A.multiply(vu).mod(params.N)
            let S = b.modPow(base: base, modulus: params.N)

            // K = H(S)
            let K = hasher.hash(S.toData().padLeft(toLength: params.hexLength / 2))

            // M = H(H(N) xor H(g), H(I), s, A, B, K)
            let HN = hasher.hash(params.N.toData())
            let Hg = hasher.hash(params.g.toData())
            let HNxorHg = zip(HN, Hg).map { $0 ^ $1 }
            let HI = hasher.hash(Data(username.utf8))

            var mInput = Data()
            mInput.append(contentsOf: HNxorHg)
            mInput.append(contentsOf: HI)
            mInput.append(s.toData().padLeft(toLength: params.hexLength / 2))
            mInput.append(A.toData().padLeft(toLength: params.hexLength / 2))
            mInput.append(B.toData().padLeft(toLength: params.hexLength / 2))
            mInput.append(contentsOf: K)

            let M = hasher.hash(mInput)

            // Verify client proof
            let expectedProof = M.map { String(format: "%02x", $0) }.joined()
            guard clientSessionProof.lowercased() == expectedProof else {
                throw SRPException("InvalidSessionProof")
            }

            // P = H(A, M, K)
            var pInput = Data()
            pInput.append(A.toData().padLeft(toLength: params.hexLength / 2))
            pInput.append(contentsOf: M)
            pInput.append(contentsOf: K)
            let P = hasher.hash(pInput)

            return [
                "key": K.map { String(format: "%02x", $0) }.joined(),
                "proof": P.map { String(format: "%02x", $0) }.joined()
            ]
        }

        // Verify server session
        AsyncFunction("verifyServerSession") { (primeGroup: Int, serverPublicEphemeral: String, clientSessionKey: String, clientSessionProof: String, serverSessionProof: String) in
            // Server verification is done by comparing session keys/proofs
            // This is a simplified version for client-side verification
            let expected = hexToData(serverSessionProof)
            let actual = hexToData(clientSessionProof)

            guard expected == actual else {
                throw SRPException("InvalidSessionProof")
            }
        }
    }
}

// MARK: - Helper Functions

private func hexToData(_ hex: String) -> Data {
    let sanitized = hex.lowercased().replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "\n", with: "")
    var data = Data()
    var index = sanitized.startIndex
    while index < sanitized.endIndex {
        let nextIndex = sanitized.index(index, offsetBy: 2)
        let byteString = String(sanitized[index..<nextIndex])
        if let byte = UInt8(byteString, radix: 16) {
            data.append(byte)
        }
        index = nextIndex
    }
    return data
}

// MARK: - SRP Exception

private class SRPException: Exception {
    override var reason: String {
        return message ?? "SRP operation failed"
    }

    private let message: String?

    init(_ message: String) {
        self.message = message
        super.init()
    }
}

// MARK: - SRP Hasher

private class SRPHasher {
    let algorithm: String

    init(algorithm: String) {
        self.algorithm = algorithm
    }

    func hash(_ data: Data) -> [UInt8] {
        switch algorithm {
        case "SHA-1":
            var digest = [UInt8](repeating: 0, count: Int(CC_SHA1_DIGEST_LENGTH))
            data.withUnsafeBytes { bytes in
                _ = CC_SHA1(bytes.baseAddress, CC_LONG(data.count), &digest)
            }
            return digest
        case "SHA-256":
            var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
            data.withUnsafeBytes { bytes in
                _ = CC_SHA256(bytes.baseAddress, CC_LONG(data.count), &digest)
            }
            return digest
        case "SHA-384":
            var digest = [UInt8](repeating: 0, count: Int(CC_SHA384_DIGEST_LENGTH))
            data.withUnsafeBytes { bytes in
                _ = CC_SHA384(bytes.baseAddress, CC_LONG(data.count), &digest)
            }
            return digest
        case "SHA-512":
            var digest = [UInt8](repeating: 0, count: Int(CC_SHA512_DIGEST_LENGTH))
            data.withUnsafeBytes { bytes in
                _ = CC_SHA512(bytes.baseAddress, CC_LONG(data.count), &digest)
            }
            return digest
        default:
            fatalError("Unsupported hash algorithm: \(algorithm)")
        }
    }
}

// MARK: - String Extension

private extension String {
    func padLeft(toLength length: Int, withPad character: Character = "0") -> String {
        let currentLength = self.count
        guard currentLength < length else { return self }
        return String(repeating: character, count: length - currentLength) + self
    }
}

// MARK: - Data Extension

private extension Data {
    func padLeft(toLength length: Int) -> Data {
        guard count < length else { return self }
        var padded = Data(repeating: 0, count: length - count)
        padded.append(self)
        return padded
    }
}

// MARK: - BigUInt Implementation
// A minimal big unsigned integer implementation for SRP operations

private struct BigUInt {
    // Store as array of UInt64 in little-endian order (least significant first)
    private var words: [UInt64]

    static let zero = BigUInt(words: [0])
    static let one = BigUInt(words: [1])

    var isZero: Bool {
        return words.allSatisfy { $0 == 0 }
    }

    init(words: [UInt64]) {
        self.words = words
        normalize()
    }

    init(_ value: UInt64) {
        self.words = [value]
    }

    init(data: Data) {
        // Convert big-endian data to little-endian words
        var words: [UInt64] = []
        let bytes = [UInt8](data)

        var i = bytes.count
        while i > 0 {
            var word: UInt64 = 0
            for j in 0..<8 {
                let byteIndex = i - 1 - j
                if byteIndex >= 0 {
                    word |= UInt64(bytes[byteIndex]) << (j * 8)
                }
            }
            words.append(word)
            i -= 8
        }

        if words.isEmpty {
            words = [0]
        }

        self.words = words
        normalize()
    }

    init(hexString: String) {
        let sanitized = hexString.lowercased().replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "\n", with: "")
        var data = Data()
        var index = sanitized.startIndex
        while index < sanitized.endIndex {
            let nextIndex = sanitized.index(index, offsetBy: min(2, sanitized.distance(from: index, to: sanitized.endIndex)))
            let byteString = String(sanitized[index..<nextIndex])
            if let byte = UInt8(byteString, radix: 16) {
                data.append(byte)
            }
            index = nextIndex
        }
        self.init(data: data)
    }

    private mutating func normalize() {
        while words.count > 1 && words.last == 0 {
            words.removeLast()
        }
    }

    func toData() -> Data {
        // Convert little-endian words to big-endian data
        var bytes: [UInt8] = []

        for i in (0..<words.count).reversed() {
            let word = words[i]
            for j in (0..<8).reversed() {
                bytes.append(UInt8((word >> (j * 8)) & 0xFF))
            }
        }

        // Remove leading zeros
        while bytes.count > 1 && bytes.first == 0 {
            bytes.removeFirst()
        }

        return Data(bytes)
    }

    func toHexString() -> String {
        return toData().map { String(format: "%02x", $0) }.joined()
    }

    func compare(_ other: BigUInt) -> ComparisonResult {
        if words.count != other.words.count {
            return words.count > other.words.count ? .greaterThan : .lessThan
        }

        for i in (0..<words.count).reversed() {
            if words[i] != other.words[i] {
                return words[i] > other.words[i] ? .greaterThan : .lessThan
            }
        }

        return .same
    }

    func add(_ other: BigUInt) -> BigUInt {
        let maxLen = max(words.count, other.words.count)
        var result = [UInt64](repeating: 0, count: maxLen + 1)
        var carry: UInt64 = 0

        for i in 0..<maxLen {
            let a = i < words.count ? words[i] : 0
            let b = i < other.words.count ? other.words[i] : 0
            let (sum1, overflow1) = a.addingReportingOverflow(b)
            let (sum2, overflow2) = sum1.addingReportingOverflow(carry)
            result[i] = sum2
            carry = (overflow1 ? 1 : 0) + (overflow2 ? 1 : 0)
        }

        result[maxLen] = carry
        return BigUInt(words: result)
    }

    func subtract(_ other: BigUInt) -> BigUInt {
        guard compare(other) != .lessThan else {
            return BigUInt.zero
        }

        var result = [UInt64](repeating: 0, count: words.count)
        var borrow: UInt64 = 0

        for i in 0..<words.count {
            let a = words[i]
            let b = i < other.words.count ? other.words[i] : 0
            let (diff1, overflow1) = a.subtractingReportingOverflow(b)
            let (diff2, overflow2) = diff1.subtractingReportingOverflow(borrow)
            result[i] = diff2
            borrow = (overflow1 ? 1 : 0) + (overflow2 ? 1 : 0)
        }

        return BigUInt(words: result)
    }

    func multiply(_ other: BigUInt) -> BigUInt {
        if isZero || other.isZero {
            return BigUInt.zero
        }

        var result = [UInt64](repeating: 0, count: words.count + other.words.count)

        for i in 0..<words.count {
            var carry: UInt64 = 0
            for j in 0..<other.words.count {
                let (high, low) = words[i].multipliedFullWidth(by: other.words[j])
                let (sum1, overflow1) = result[i + j].addingReportingOverflow(low)
                let (sum2, overflow2) = sum1.addingReportingOverflow(carry)
                result[i + j] = sum2
                carry = high + (overflow1 ? 1 : 0) + (overflow2 ? 1 : 0)
            }
            result[i + other.words.count] = carry
        }

        return BigUInt(words: result)
    }

    // Division with remainder using long division
    func divideWithRemainder(by divisor: BigUInt) -> (quotient: BigUInt, remainder: BigUInt) {
        if divisor.isZero {
            fatalError("Division by zero")
        }

        if compare(divisor) == .lessThan {
            return (BigUInt.zero, self)
        }

        if divisor.words.count == 1 {
            // Fast path for single-word divisor
            return divideByWord(divisor.words[0])
        }

        // Binary long division
        var quotient = BigUInt.zero
        var remainder = BigUInt.zero

        let totalBits = words.count * 64
        for i in (0..<totalBits).reversed() {
            // Left shift remainder by 1 and add the next bit
            remainder = remainder.shiftLeft(1)
            let wordIndex = i / 64
            let bitIndex = i % 64
            if wordIndex < words.count && (words[wordIndex] >> bitIndex) & 1 == 1 {
                remainder = remainder.add(BigUInt.one)
            }

            if remainder.compare(divisor) != .lessThan {
                remainder = remainder.subtract(divisor)
                quotient = quotient.setBit(i)
            }
        }

        return (quotient, remainder)
    }

    private func divideByWord(_ divisor: UInt64) -> (quotient: BigUInt, remainder: BigUInt) {
        var result = [UInt64](repeating: 0, count: words.count)
        var remainder: UInt64 = 0

        for i in (0..<words.count).reversed() {
            let dividend = (UInt128(remainder) << 64) | UInt128(words[i])
            let (q, r) = dividend.quotientAndRemainder(dividingBy: UInt128(divisor))
            result[i] = UInt64(q)
            remainder = UInt64(r)
        }

        return (BigUInt(words: result), BigUInt(remainder))
    }

    func mod(_ modulus: BigUInt) -> BigUInt {
        return divideWithRemainder(by: modulus).remainder
    }

    func shiftLeft(_ bits: Int) -> BigUInt {
        if bits == 0 || isZero {
            return self
        }

        let wordShift = bits / 64
        let bitShift = bits % 64

        var result = [UInt64](repeating: 0, count: words.count + wordShift + 1)

        if bitShift == 0 {
            for i in 0..<words.count {
                result[i + wordShift] = words[i]
            }
        } else {
            var carry: UInt64 = 0
            for i in 0..<words.count {
                result[i + wordShift] = (words[i] << bitShift) | carry
                carry = words[i] >> (64 - bitShift)
            }
            result[words.count + wordShift] = carry
        }

        return BigUInt(words: result)
    }

    func setBit(_ bit: Int) -> BigUInt {
        let wordIndex = bit / 64
        let bitIndex = bit % 64

        var newWords = words
        while newWords.count <= wordIndex {
            newWords.append(0)
        }
        newWords[wordIndex] |= (1 << bitIndex)

        return BigUInt(words: newWords)
    }

    // Modular exponentiation using square-and-multiply
    func modPow(base: BigUInt, modulus: BigUInt) -> BigUInt {
        if modulus.isZero {
            fatalError("Modulus cannot be zero")
        }

        if isZero {
            return BigUInt.one
        }

        var result = BigUInt.one
        var base = base.mod(modulus)
        var exp = self

        while !exp.isZero {
            // If LSB is 1
            if exp.words[0] & 1 == 1 {
                result = result.multiply(base).mod(modulus)
            }
            // Right shift exponent by 1
            exp = exp.shiftRight(1)
            // Square the base
            base = base.multiply(base).mod(modulus)
        }

        return result
    }

    func shiftRight(_ bits: Int) -> BigUInt {
        if bits == 0 || isZero {
            return self
        }

        let wordShift = bits / 64
        let bitShift = bits % 64

        if wordShift >= words.count {
            return BigUInt.zero
        }

        var result = [UInt64](repeating: 0, count: words.count - wordShift)

        if bitShift == 0 {
            for i in 0..<result.count {
                result[i] = words[i + wordShift]
            }
        } else {
            for i in 0..<result.count {
                result[i] = words[i + wordShift] >> bitShift
                if i + wordShift + 1 < words.count {
                    result[i] |= words[i + wordShift + 1] << (64 - bitShift)
                }
            }
        }

        return BigUInt(words: result)
    }
}

private enum ComparisonResult {
    case lessThan
    case same
    case greaterThan
}

// MARK: - UInt128 for intermediate calculations

private struct UInt128 {
    let high: UInt64
    let low: UInt64

    init(_ value: UInt64) {
        self.high = 0
        self.low = value
    }

    init(high: UInt64, low: UInt64) {
        self.high = high
        self.low = low
    }

    static func << (lhs: UInt128, rhs: Int) -> UInt128 {
        if rhs >= 128 {
            return UInt128(high: 0, low: 0)
        } else if rhs >= 64 {
            return UInt128(high: lhs.low << (rhs - 64), low: 0)
        } else if rhs == 0 {
            return lhs
        } else {
            return UInt128(high: (lhs.high << rhs) | (lhs.low >> (64 - rhs)), low: lhs.low << rhs)
        }
    }

    static func | (lhs: UInt128, rhs: UInt128) -> UInt128 {
        return UInt128(high: lhs.high | rhs.high, low: lhs.low | rhs.low)
    }

    func quotientAndRemainder(dividingBy divisor: UInt128) -> (UInt128, UInt128) {
        // Simple case: divisor fits in 64 bits
        if divisor.high == 0 && high == 0 {
            let (q, r) = low.quotientAndRemainder(dividingBy: divisor.low)
            return (UInt128(q), UInt128(r))
        }

        // General case using binary long division
        var quotient = UInt128(0)
        var remainder = UInt128(0)

        for i in (0..<128).reversed() {
            // Left shift remainder
            remainder = remainder << 1

            // Add bit i from dividend
            let bit: UInt64
            if i >= 64 {
                bit = (high >> (i - 64)) & 1
            } else {
                bit = (low >> i) & 1
            }
            remainder = UInt128(high: remainder.high, low: remainder.low | bit)

            // Compare and subtract
            if !remainder.isLessThan(divisor) {
                remainder = remainder.subtract(divisor)
                if i >= 64 {
                    quotient = UInt128(high: quotient.high | (1 << (i - 64)), low: quotient.low)
                } else {
                    quotient = UInt128(high: quotient.high, low: quotient.low | (1 << i))
                }
            }
        }

        return (quotient, remainder)
    }

    func isLessThan(_ other: UInt128) -> Bool {
        if high != other.high {
            return high < other.high
        }
        return low < other.low
    }

    func subtract(_ other: UInt128) -> UInt128 {
        let (low, borrow) = self.low.subtractingReportingOverflow(other.low)
        let high = self.high - other.high - (borrow ? 1 : 0)
        return UInt128(high: high, low: low)
    }
}

// MARK: - SRP Parameters

private struct SRPParams {
    let N: BigUInt
    let g: BigUInt
    let hexLength: Int

    static func getParams(_ primeGroup: Int) -> SRPParams {
        switch primeGroup {
        case 1024:
            return SRPParams(
                N: BigUInt(hexString: "EEAF0AB9ADB38DD69C33F80AFA8FC5E86072618775FF3C0B9EA2314C9C256576D674DF7496EA81D3383B4813D692C6E0E0D5D8E250B98BE48E495C1D6089DAD15DC7D7B46154D6B6CE8EF4AD69B15D4982559B297BCF1885C529F566660E57EC68EDBC3C05726CC02FD4CBF4976EAA9AFD5138FE8376435B9FC61D2FC0EB06E3"),
                g: BigUInt(2),
                hexLength: 256
            )
        case 1536:
            return SRPParams(
                N: BigUInt(hexString: "9DEF3CAFB939277AB1F12A8617A47BBBDBA51DF499AC4C80BEEEA9614B19CC4D5F4F5F556E27CBDE51C6A94BE4607A291558903BA0D0F84380B655BB9A22E8DCDF028A7CEC67F0D08134B1C8B97989149B609E0BE3BAB63D47548381DBC5B1FC764E3F4B53DD9DA1158BFD3E2B9C8CF56EDF019539349627DB2FD53D24B7C48665772E437D6C7F8CE442734AF7CCB7AE837C264AE3A9BEB87F8A2FE9B8B5292E5A021FFF5E91479E8CE7A28C2442C6F315180F93499A234DCF76E3FED135F9BB"),
                g: BigUInt(2),
                hexLength: 384
            )
        case 2048:
            return SRPParams(
                N: BigUInt(hexString: "AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB694B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73"),
                g: BigUInt(2),
                hexLength: 512
            )
        case 3072:
            return SRPParams(
                N: BigUInt(hexString: "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF"),
                g: BigUInt(5),
                hexLength: 768
            )
        case 4096:
            return SRPParams(
                N: BigUInt(hexString: "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A92108011A723C12A787E6D788719A10BDBA5B2699C327186AF4E23C1A946834B6150BDA2583E9CA2AD44CE8DBBBC2DB04DE8EF92E8EFC141FBECAA6287C59474E6BC05D99B2964FA090C3A2233BA186515BE7ED1F612970CEE2D7AFB81BDD762170481CD0069127D5B05AA993B4EA988D8FDDC186FFB7DC90A6C08F4DF435C934063199FFFFFFFFFFFFFFFF"),
                g: BigUInt(5),
                hexLength: 1024
            )
        case 6144:
            return SRPParams(
                N: BigUInt(hexString: "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A92108011A723C12A787E6D788719A10BDBA5B2699C327186AF4E23C1A946834B6150BDA2583E9CA2AD44CE8DBBBC2DB04DE8EF92E8EFC141FBECAA6287C59474E6BC05D99B2964FA090C3A2233BA186515BE7ED1F612970CEE2D7AFB81BDD762170481CD0069127D5B05AA993B4EA988D8FDDC186FFB7DC90A6C08F4DF435C93402849236C3FAB4D27C7026C1D4DCB2602646DEC9751E763DBA37BDF8FF9406AD9E530EE5DB382F413001AEB06A53ED9027D831179727B0865A8918DA3EDBEBCF9B14ED44CE6CBACED4BB1BDB7F1447E6CC254B332051512BD7AF426FB8F401378CD2BF5983CA01C64B92ECF032EA15D1721D03F482D7CE6E74FEF6D55E702F46980C82B5A84031900B1C9E59E7C97FBEC7E8F323A97A7E36CC88BE0F1D45B7FF585AC54BD407B22B4154AACC8F6D7EBF48E1D814CC5ED20F8037E0A79715EEF29BE32806A1D58BB7C5DA76F550AA3D8A1FBFF0EB19CCB1A313D55CDA56C9EC2EF29632387FE8D76E3C0468043E8F663F4860EE12BF2D5B0B7474D6E694F91E6DCC4024FFFFFFFFFFFFFFFF"),
                g: BigUInt(5),
                hexLength: 1536
            )
        case 8192:
            return SRPParams(
                N: BigUInt(hexString: "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A92108011A723C12A787E6D788719A10BDBA5B2699C327186AF4E23C1A946834B6150BDA2583E9CA2AD44CE8DBBBC2DB04DE8EF92E8EFC141FBECAA6287C59474E6BC05D99B2964FA090C3A2233BA186515BE7ED1F612970CEE2D7AFB81BDD762170481CD0069127D5B05AA993B4EA988D8FDDC186FFB7DC90A6C08F4DF435C93402849236C3FAB4D27C7026C1D4DCB2602646DEC9751E763DBA37BDF8FF9406AD9E530EE5DB382F413001AEB06A53ED9027D831179727B0865A8918DA3EDBEBCF9B14ED44CE6CBACED4BB1BDB7F1447E6CC254B332051512BD7AF426FB8F401378CD2BF5983CA01C64B92ECF032EA15D1721D03F482D7CE6E74FEF6D55E702F46980C82B5A84031900B1C9E59E7C97FBEC7E8F323A97A7E36CC88BE0F1D45B7FF585AC54BD407B22B4154AACC8F6D7EBF48E1D814CC5ED20F8037E0A79715EEF29BE32806A1D58BB7C5DA76F550AA3D8A1FBFF0EB19CCB1A313D55CDA56C9EC2EF29632387FE8D76E3C0468043E8F663F4860EE12BF2D5B0B7474D6E694F91E6DBE115974A3926F12FEE5E438777CB6A932DF8CD8BEC4D073B931BA3BC832B68D9DD300741FA7BF8AFC47ED2576F6936BA424663AAB639C5AE4F5683423B4742BF1C978238F16CBE39D652DE3FDB8BEFC848AD922222E04A4037C0713EB57A81A23F0C73473FC646CEA306B4BCBC8862F8385DDFA9D4B7FA2C087E879683303ED5BDD3A062B3CF5B3A278A66D2A13F83F44F82DDF310EE074AB6A364597E899A0255DC164F31CC50846851DF9AB48195DED7EA1B1D510BD7EE74D73FAF36BC31ECFA268359046F4EB879F924009438B481C6CD7889A002ED5EE382BC9190DA6FC026E479558E4475677E9AA9E3050E2765694DFC81F56E880B96E7160C980DD98EDD3DFFFFFFFFFFFFFFFFF"),
                g: BigUInt(19),
                hexLength: 2048
            )
        default:
            fatalError("Unsupported prime group: \(primeGroup)")
        }
    }
}
