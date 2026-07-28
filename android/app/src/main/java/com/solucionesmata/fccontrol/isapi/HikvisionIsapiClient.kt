package com.solucionesmata.fccontrol.isapi

import android.net.Network
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Document

/** Resultado crudo de una petición ISAPI. */
data class IsapiResponse(val code: Int, val body: String)

/**
 * Cliente mínimo para hablar la ISAPI de una cámara Hikvision/HikMicro en
 * la red local, con soporte de Digest Auth (RFC 2617) y HTTPS con
 * certificado autofirmado (varios firmwares recientes exigen HTTPS
 * específicamente para /ISAPI/Security/activate y rechazan la llamada por
 * HTTP con un error genérico).
 *
 * Cada petición se abre explícitamente sobre la [Network] indicada
 * (via Network.openConnection), no sobre la ruta por defecto del teléfono —
 * así el resto de la app sigue usando datos móviles / la red que tenga sin
 * que esta cámara (que normalmente no da salida a internet) le pise el tráfico.
 */
class HikvisionIsapiClient(private val network: Network, private val baseUrl: String) {

    private val timeoutMs = 8000

    /** Petición sin autenticar (solo usada para /ISAPI/Security/activate). */
    fun requestNoAuth(method: String, path: String, body: String? = null): IsapiResponse {
        return rawRequest(method, path, null, body)
    }

    /** Petición con Digest Auth: primero dispara el 401 para obtener el reto, reintenta con Authorization. */
    fun requestAuth(method: String, path: String, user: String, pass: String, body: String? = null): IsapiResponse {
        val probe = rawRequest(method, path, null, body)
        if (probe.code != 401) return probe

        val wwwAuth = lastWwwAuthenticate ?: return probe
        val challenge = DigestAuth.parseChallenge(wwwAuth) ?: return probe
        val authHeader = DigestAuth.buildAuthorizationHeader(challenge, method, path, user, pass)
        return rawRequest(method, path, authHeader, body)
    }

    private var lastWwwAuthenticate: String? = null

    private fun rawRequest(method: String, path: String, authHeader: String?, body: String?): IsapiResponse {
        val url = URL(baseUrl + path)
        val conn = network.openConnection(url) as HttpURLConnection
        if (conn is HttpsURLConnection) {
            conn.sslSocketFactory = trustAllSslContext.socketFactory
            conn.hostnameVerifier = trustAllHostnameVerifier
        }
        try {
            conn.requestMethod = method
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.setRequestProperty("Accept", "application/xml")
            if (authHeader != null) conn.setRequestProperty("Authorization", authHeader)
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/xml")
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }

            val code = conn.responseCode
            lastWwwAuthenticate = conn.getHeaderField("WWW-Authenticate")

            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.let { readAll(it) } ?: ""
            return IsapiResponse(code, text)
        } finally {
            conn.disconnect()
        }
    }

    private fun readAll(input: java.io.InputStream): String {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(4096)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toString("UTF-8")
    }

    companion object {
        // La cámara usa un certificado autofirmado propio (no una CA pública) —
        // aceptamos cualquier certificado para esta conexión administrativa
        // directa por IP en la red local, igual que hace el cliente de Electron
        // con rejectUnauthorized:false.
        private val trustAllHostnameVerifier = HostnameVerifier { _, _ -> true }
        private val trustAllSslContext: SSLContext by lazy {
            val trustAll = arrayOf<TrustManager>(object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
            })
            SSLContext.getInstance("TLS").apply { init(null, trustAll, SecureRandom()) }
        }

        /** Sondeo liviano de HTTPS (443, certificado autofirmado) vs HTTP (80) para una IP dada. */
        fun detectProtocol(network: Network, accessIp: String): String {
            return try {
                val client = HikvisionIsapiClient(network, "https://$accessIp")
                client.requestNoAuth("GET", "/ISAPI/System/deviceInfo")
                "https://$accessIp"
            } catch (e: Exception) {
                "http://$accessIp"
            }
        }

        /** Extrae un valor de texto por nombre de tag (ignorando namespace/prefijo), o null si no existe. */
        fun xmlTagValue(xml: String, tag: String): String? {
            return try {
                val doc: Document = DocumentBuilderFactory.newInstance().newDocumentBuilder()
                    .parse(xml.byteInputStream(Charsets.UTF_8))
                val nodes = doc.getElementsByTagName(tag)
                if (nodes.length == 0) null else nodes.item(0).textContent?.trim()
            } catch (e: Exception) {
                null
            }
        }

        /**
         * Arma un detalle legible de un error ISAPI: la cámara casi siempre
         * devuelve algo como "Invalid Operation" sin más contexto, así que
         * acá sumamos el código HTTP y el subStatusCode (mucho más
         * específico) si la respuesta lo trae.
         */
        fun describeIsapiError(resp: IsapiResponse): String {
            val statusString = xmlTagValue(resp.body, "statusString")
            val subStatusCode = xmlTagValue(resp.body, "subStatusCode")
            val parts = mutableListOf(statusString ?: "HTTP ${resp.code}")
            if (subStatusCode != null) parts.add("detalle: $subStatusCode")
            parts.add("http=${resp.code}")
            return parts.joinToString(" · ")
        }
    }
}
