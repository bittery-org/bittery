package com.bittery.mobile.credentialprovider.domain

import java.net.IDN

/**
 * The one answer to "may this saved credential be offered on this site?" for
 * Android.
 *
 * Before this object the module carried six independent host-extraction
 * implementations that disagreed with each other and with the browser
 * extension: some stripped `www.`, some lowercased, some stripped a port, and
 * parent-domain widening took one label off, so `x.co.uk` widened to `co.uk` and
 * every UK site looked related. The same saved credential could match in the
 * extension and miss on Android.
 *
 * The behaviour here mirrors `apps/extension/src/lib/hostname.ts` and is pinned
 * to it by `apps/extension/src/lib/domain-matching.vectors.json`, which
 * `DomainMatchVectorsTest` asserts against. There is no generator between the
 * two languages, so that fixture is the seam — change it first, then both sides.
 *
 * Note what this is *not* for: a WebAuthn `rpId` is a protocol value whose hash
 * is signed, so it is stored and signed exactly as [normalizeHost] returns it -
 * [normalizeHost] never strips `www.`, because changing an rpId would invalidate
 * the signature. Passkey identity is [sameRelyingParty], which is narrower than
 * [matches] and is the one rule here the extension does not share: the extension
 * compares rpIds for exact equality where Android also folds `www.`. That
 * difference predates this file and is left alone; widening or narrowing it is a
 * WebAuthn decision, not a deduplication.
 */
object DomainMatch {

    /**
     * Multi-label public suffixes. The full Public Suffix List is ~10,000
     * entries and needs periodic updates; this is the high-traffic subset, kept
     * small enough to restate in TypeScript by hand. An unlisted suffix degrades
     * to last-two-labels rather than failing, so adding one is always safe.
     *
     * Must stay identical to MULTI_LABEL_PUBLIC_SUFFIXES in hostname.ts.
     */
    private val MULTI_LABEL_PUBLIC_SUFFIXES = setOf(
        // United Kingdom
        "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk",
        "ac.uk", "gov.uk", "nhs.uk",
        // Australia / New Zealand
        "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
        "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
        // Japan / Korea / Taiwan / China / Hong Kong / Singapore
        "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
        "co.kr", "or.kr", "com.tw",
        "com.cn", "net.cn", "org.cn", "gov.cn", "com.hk", "com.sg",
        // South / Southeast Asia
        "co.in", "net.in", "org.in", "gov.in", "ac.in",
        "com.my", "com.ph", "com.pk", "co.th", "co.id", "com.vn", "com.bd",
        // Americas
        "com.br", "net.br", "org.br", "gov.br",
        "com.mx", "com.ar", "com.co", "com.pe", "com.uy", "com.ve", "com.ec",
        "com.bo", "com.py", "com.do", "com.gt", "com.pa", "co.cr",
        // Europe, Middle East, Africa, Turkey, Russia
        "co.za", "org.za", "net.za", "gov.za",
        "com.ng", "com.eg", "com.gh", "co.ke", "co.il",
        "com.tr", "gov.tr", "edu.tr", "com.sa", "com.ua", "com.ru",
        "com.pl", "com.gr", "com.es", "com.pt", "com.cy", "com.hr", "co.rs",
    )

    private val SCHEME = Regex("^[a-z][a-z0-9+.\\-]*://")
    private val IPV4 = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$")

    /**
     * Reduce any of a URL, an origin, an rpId or a bare host to a comparable
     * host: lowercased, with scheme, userinfo, port, path/query/fragment and
     * boundary dots removed. Non-hosts (an Android package name, say) pass
     * through unchanged so callers can still compare them for equality.
     */
    fun normalizeHost(value: String?): String {
        if (value.isNullOrBlank()) return ""

        var host = SCHEME.replace(value.trim().lowercase(), "")

        val boundary = host.indexOfFirst { it == '/' || it == '?' || it == '#' }
        if (boundary >= 0) host = host.substring(0, boundary)

        val userinfo = host.lastIndexOf('@')
        if (userinfo >= 0) host = host.substring(userinfo + 1)

        if (host.startsWith("[")) {
            // IPv6 literal: everything after the closing bracket is the port.
            val close = host.indexOf(']')
            if (close >= 0) host = host.substring(0, close + 1)
        } else {
            val colon = host.lastIndexOf(':')
            if (colon >= 0 && colon + 1 < host.length &&
                host.substring(colon + 1).all { it.isDigit() }
            ) {
                host = host.substring(0, colon)
            }
        }

        host = host.trim('.')

        // Punycode, so a Unicode host compares equal to the ASCII form Android
        // and the extension both supply. Mirrors `new URL(...).hostname` on the
        // TypeScript side; IDN.toASCII throws on a malformed label, and a value
        // that is not a host at all (an Android package name) is left alone.
        return try {
            IDN.toASCII(host, IDN.ALLOW_UNASSIGNED)
        } catch (_: IllegalArgumentException) {
            host
        }
    }

    /**
     * The registrable domain: the public suffix plus one label — `bbc.co.uk` for
     * `news.bbc.co.uk`, `example.com` for `a.b.example.com`. This is the unit two
     * sibling subdomains have to share before their credentials are interchangeable.
     */
    fun registrableDomain(host: String?): String {
        val normalized = normalizeHost(host)
        if (normalized.isEmpty() || IPV4.matches(normalized) || normalized.startsWith("[")) {
            return normalized
        }

        val labels = normalized.split(".")
        var suffixLabels = 1
        for (index in 1 until labels.size) {
            val candidate = labels.subList(index, labels.size).joinToString(".")
            if (MULTI_LABEL_PUBLIC_SUFFIXES.contains(candidate)) {
                suffixLabels = maxOf(suffixLabels, labels.size - index)
            }
        }

        if (labels.size <= suffixLabels) return normalized
        return labels.subList(labels.size - suffixLabels - 1, labels.size).joinToString(".")
    }

    /**
     * A host nobody can own: a bare TLD, or a listed multi-label suffix.
     *
     * Without this, the superdomain rule in [matches] treats `co.uk` as the
     * parent site of every UK domain. A single label counts because there is no
     * way to tell `com` from `localhost` without the full Public Suffix List,
     * and the safe direction is to offer a credential too rarely.
     */
    private fun isPublicSuffix(host: String): Boolean =
        !host.contains(".") || MULTI_LABEL_PUBLIC_SUFFIXES.contains(host)

    /**
     * The domain keys a host is indexed and queried under in `item_domains`.
     *
     * Sync writes these rows for an item's URLs; a lookup queries these keys for
     * the requesting origin. Matching is then a key intersection, which is
     * exactly [matches] expressed in SQL — asserted over a full corpus cross
     * product, not just the vectors, in `DomainMatchVectorsTest`.
     *
     * This is a deliberate widening of Android's old behaviour, which indexed
     * one `www.`-stripped host per URL and could only widen the *query* by one
     * label. A credential saved at `login.example.com` is now offered on
     * `shop.example.com`, because that is what the extension has always done and
     * the point of this class is that the two agree. Existing installs keep
     * their old single-key rows until each item next syncs; there is no
     * backfill, because sync replaces an item's rows wholesale.
     */
    fun lookupKeys(host: String?): List<String> {
        val normalized = normalizeHost(host)
        if (normalized.isEmpty()) return emptyList()
        val registrable = registrableDomain(normalized)
        return if (registrable == normalized) listOf(normalized) else listOf(normalized, registrable)
    }

    /**
     * Whether two WebAuthn `rpId`s identify the same relying party.
     *
     * Deliberately narrower than [matches]. A passkey is scoped to its `rpId`,
     * and WebAuthn never lets a sibling subdomain assert it — `a.example.com`
     * and `b.example.com` are the same *site* for password autofill and two
     * different relying parties for passkeys. Only `www.` is folded, because a
     * site that registers at `www.example.com` and asserts at `example.com` is
     * one party in practice; that is what this replaced.
     */
    fun sameRelyingParty(left: String?, right: String?): Boolean {
        val a = normalizeHost(left).removePrefix("www.")
        val b = normalizeHost(right).removePrefix("www.")
        return a.isNotEmpty() && a == b
    }

    /**
     * The `item_domains` keys to query when looking for the item a passkey
     * belongs to.
     *
     * Narrower than [lookupKeys] for the same reason [sameRelyingParty] is
     * narrower than [matches]: a create flow that widened to the registrable
     * domain would offer `shop.example.com`'s item as the home for a passkey
     * being registered at `login.example.com`, and the create path auto-selects
     * when exactly one candidate comes back.
     */
    fun relyingPartyLookupKeys(rpId: String?): List<String> {
        val normalized = normalizeHost(rpId)
        if (normalized.isEmpty()) return emptyList()
        val bare = normalized.removePrefix("www.")
        return linkedSetOf(normalized, bare, "www.$bare").toList()
    }

    /**
     * True when the two hosts are the same site: identical, one a subdomain of
     * the other, or siblings under one registrable domain. Symmetric.
     *
     * This is the *password* matching rule. Passkeys use [sameRelyingParty].
     */
    fun matches(left: String?, right: String?): Boolean {
        val a = normalizeHost(left)
        val b = normalizeHost(right)
        if (a.isEmpty() || b.isEmpty()) return false

        if (a == b) return true
        if (a.endsWith(".$b") && !isPublicSuffix(b)) return true
        if (b.endsWith(".$a") && !isPublicSuffix(a)) return true

        if (isPublicSuffix(a) || isPublicSuffix(b)) return false
        return registrableDomain(a) == registrableDomain(b)
    }
}
