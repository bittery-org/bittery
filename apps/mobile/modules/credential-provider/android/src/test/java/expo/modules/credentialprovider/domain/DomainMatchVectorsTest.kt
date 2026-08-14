package expo.modules.credentialprovider.domain

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Drives [DomainMatch] against the same fixture the browser extension asserts,
 * `apps/extension/src/lib/domain-matching.vectors.json`.
 *
 * There is no generator between Kotlin and TypeScript for credential domain
 * matching, so this fixture is the seam. If the two implementations drift, the
 * same saved credential matches in the extension and misses on Android — which
 * is the user-visible bug this suite exists to catch.
 *
 * The extension side is `apps/extension/tests/lib/hostname.test.ts`.
 */
class DomainMatchVectorsTest {

    private val vectors: JSONObject by lazy {
        JSONObject(vectorsFile().readText())
    }

    /**
     * Walks up from the working directory to the repository root rather than
     * hardcoding a depth, so the test does not depend on whether Gradle runs it
     * from the module directory or somewhere else.
     */
    private fun vectorsFile(): File {
        var directory: File? = File(".").absoluteFile
        while (directory != null) {
            if (File(directory, "pnpm-workspace.yaml").isFile) {
                val vectors = File(directory, "apps/extension/src/lib/domain-matching.vectors.json")
                check(vectors.isFile) { "Vectors fixture missing at ${vectors.path}" }
                return vectors
            }
            directory = directory.parentFile
        }
        throw IllegalStateException("Could not locate the repository root from ${File(".").absolutePath}")
    }

    private fun cases(name: String): List<JSONObject> {
        val array: JSONArray = vectors.getJSONArray(name)
        return (0 until array.length()).map { array.getJSONObject(it) }
    }

    @Test
    fun `normalizeHost matches the shared vectors`() {
        val cases = cases("normalizeHost")
        assertTrue("fixture should not be empty", cases.isNotEmpty())
        for (case in cases) {
            val input = case.getString("input")
            assertEquals(
                "normalizeHost(${quote(input)})",
                case.getString("expected"),
                DomainMatch.normalizeHost(input),
            )
        }
    }

    @Test
    fun `registrableDomain matches the shared vectors`() {
        for (case in cases("registrableDomain")) {
            val input = case.getString("input")
            assertEquals(
                "registrableDomain(${quote(input)})",
                case.getString("expected"),
                DomainMatch.registrableDomain(input),
            )
        }
    }

    @Test
    fun `matches is symmetric and follows the shared vectors`() {
        for (case in cases("matches")) {
            val left = case.getString("left")
            val right = case.getString("right")
            val expected = case.getBoolean("expected")
            assertEquals(
                "matches(${quote(left)}, ${quote(right)})",
                expected,
                DomainMatch.matches(left, right),
            )
            assertEquals(
                "matches(${quote(right)}, ${quote(left)}) - matching must be symmetric",
                expected,
                DomainMatch.matches(right, left),
            )
        }
    }

    @Test
    fun `lookupKeys matches the shared vectors`() {
        for (case in cases("lookupKeys")) {
            val input = case.getString("input")
            val expected = case.getJSONArray("expected").let { array ->
                (0 until array.length()).map { array.getString(it) }
            }
            assertEquals("lookupKeys(${quote(input)})", expected, DomainMatch.lookupKeys(input))
        }
    }

    /**
     * The Room queries match by intersecting an item's indexed domain keys with
     * the requesting origin's queried keys. That is only equivalent to
     * [DomainMatch.matches] if every matching pair shares a key.
     */
    @Test
    fun `lookupKeys intersection agrees with matches`() {
        for (case in cases("matches")) {
            val left = case.getString("left")
            val right = case.getString("right")
            val indexed = DomainMatch.lookupKeys(left).toSet()
            val queried = DomainMatch.lookupKeys(right)
            assertEquals(
                "SQL-shaped lookup for ${quote(left)} / ${quote(right)}",
                case.getBoolean("expected"),
                queried.any { indexed.contains(it) },
            )
        }
    }

    private fun quote(value: String) = "\"$value\""
}
