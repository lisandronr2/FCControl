package com.solucionesmata.fccontrol.isapi

import java.security.MessageDigest
import kotlin.random.Random

/** Reto Digest (RFC 2617) parseado del header WWW-Authenticate que devuelve la ISAPI. */
data class DigestChallenge(
    val realm: String,
    val nonce: String,
    val qop: String?,
    val opaque: String?
)

object DigestAuth {

    fun parseChallenge(header: String): DigestChallenge? {
        if (!header.trim().startsWith("Digest", ignoreCase = true)) return null
        val params = Regex("""(\w+)="?([^",]+)"?""")
            .findAll(header)
            .associate { it.groupValues[1] to it.groupValues[2] }

        val realm = params["realm"] ?: return null
        val nonce = params["nonce"] ?: return null
        return DigestChallenge(realm, nonce, params["qop"], params["opaque"])
    }

    /** Construye el header Authorization para la siguiente petición con las credenciales dadas. */
    fun buildAuthorizationHeader(
        challenge: DigestChallenge,
        method: String,
        uri: String,
        username: String,
        password: String,
        nc: String = "00000001"
    ): String {
        val cnonce = randomHex(16)
        val ha1 = md5("$username:${challenge.realm}:$password")
        val ha2 = md5("$method:$uri")
        val qop = challenge.qop?.split(",")?.map { it.trim() }?.firstOrNull { it == "auth" }

        val response = if (qop != null) {
            md5("$ha1:${challenge.nonce}:$nc:$cnonce:$qop:$ha2")
        } else {
            md5("$ha1:${challenge.nonce}:$ha2")
        }

        val sb = StringBuilder()
        sb.append("Digest username=\"$username\", realm=\"${challenge.realm}\", ")
        sb.append("nonce=\"${challenge.nonce}\", uri=\"$uri\", response=\"$response\"")
        if (qop != null) sb.append(", qop=$qop, nc=$nc, cnonce=\"$cnonce\"")
        if (challenge.opaque != null) sb.append(", opaque=\"${challenge.opaque}\"")
        return sb.toString()
    }

    private fun md5(input: String): String {
        val digest = MessageDigest.getInstance("MD5").digest(input.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    private fun randomHex(bytes: Int): String {
        val arr = ByteArray(bytes)
        Random.Default.nextBytes(arr)
        return arr.joinToString("") { "%02x".format(it) }
    }
}
