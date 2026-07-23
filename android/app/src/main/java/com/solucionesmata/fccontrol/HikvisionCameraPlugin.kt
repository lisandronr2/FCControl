package com.solucionesmata.fccontrol

import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.solucionesmata.fccontrol.isapi.HikvisionIsapiClient
import java.io.IOException
import java.net.SocketTimeoutException

/**
 * Puente nativo entre FCControl (JS/WebView) y la ISAPI de una cámara
 * Hikvision conectada a la misma WiFi local del teléfono.
 *
 * La WebView de la app sigue restringida a HTTPS (allowMixedContent=false);
 * estas llamadas van por un cliente HTTP nativo aparte, atado explícitamente
 * a la red WiFi activa, y nunca pasan por el motor de la WebView.
 */
@CapacitorPlugin(name = "HikvisionCamera")
class HikvisionCameraPlugin : Plugin() {

    private data class Session(val client: HikvisionIsapiClient, val user: String, val pass: String, val interfaceId: String)
    private val sessions = mutableMapOf<String, Session>()

    private fun activeWifiNetwork(): Network? {
        val cm = context.getSystemService(android.content.Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        return cm.allNetworks.firstOrNull { net ->
            val caps = cm.getNetworkCapabilities(net)
            caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
        }
    }

    @PluginMethod
    fun readAndSecure(call: PluginCall) {
        val accessIp = call.getString("accessIp") ?: return call.reject("Falta accessIp")
        val currentUser = call.getString("currentUser") ?: "admin"
        val currentPass = call.getString("currentPass") ?: "12345"
        val newPass = call.getString("newPass") ?: return call.reject("Falta newPass")

        val network = activeWifiNetwork()
            ?: return call.reject("No hay WiFi conectada. Conectá el teléfono a la red de la cámara.")

        Thread {
            try {
                val client = HikvisionIsapiClient(network, "http://$accessIp")

                // 1) Intentar activación (cámara de fábrica, nunca configurada)
                val activateBody = """<?xml version="1.0" encoding="UTF-8"?>
                    |<ActivationInfo xmlns="http://www.hikvision.com/ver20/XMLSchema">
                    |<Password>${escapeXml(newPass)}</Password>
                    |</ActivationInfo>""".trimMargin()
                val activateResp = client.requestNoAuth("POST", "/ISAPI/Security/activate", activateBody)

                var effectiveUser = "admin"
                var effectivePass: String
                var activated: Boolean

                if (activateResp.code in 200..299) {
                    activated = true
                    effectivePass = newPass
                } else {
                    // Ya estaba activa: login con credenciales actuales y cambio de contraseña
                    activated = false
                    val userBody = """<?xml version="1.0" encoding="UTF-8"?>
                        |<User xmlns="http://www.hikvision.com/ver20/XMLSchema">
                        |<id>1</id>
                        |<userName>$currentUser</userName>
                        |<password>${escapeXml(newPass)}</password>
                        |</User>""".trimMargin()
                    val pwResp = client.requestAuth("PUT", "/ISAPI/Security/users/1", currentUser, currentPass, userBody)
                    if (pwResp.code !in 200..299) {
                        val msg = HikvisionIsapiClient.xmlTagValue(pwResp.body, "statusString")
                            ?: "La cámara rechazó las credenciales actuales (código ${pwResp.code})."
                        return@Thread postError(call, msg)
                    }
                    effectivePass = newPass
                }

                // 2) Leer red actual (IP, máscara, gateway) + MAC real desde la cámara
                val netResp = client.requestAuth("GET", "/ISAPI/System/Network/interfaces", effectiveUser, effectivePass)
                if (netResp.code !in 200..299) {
                    return@Thread postError(call, "No se pudo leer la configuración de red (código ${netResp.code}).")
                }

                val mac = HikvisionIsapiClient.xmlTagValue(netResp.body, "MACAddress") ?: ""
                val curIp = HikvisionIsapiClient.xmlTagValue(netResp.body, "ipAddress") ?: ""
                val curMask = HikvisionIsapiClient.xmlTagValue(netResp.body, "subnetMask") ?: ""
                val interfaceId = HikvisionIsapiClient.xmlTagValue(netResp.body, "id") ?: "1"

                sessions[accessIp] = Session(client, effectiveUser, effectivePass, interfaceId)

                val result = JSObject()
                result.put("ok", true)
                result.put("activated", activated)
                result.put("mac", mac)
                result.put("currentIp", curIp)
                result.put("currentMask", curMask)
                result.put("interfaceId", interfaceId)
                activity.runOnUiThread { call.resolve(result) }

            } catch (e: SocketTimeoutException) {
                postError(call, "La cámara no respondió a tiempo. Verificá que el teléfono esté conectado a su red.")
            } catch (e: IOException) {
                postError(call, "No se pudo conectar con la cámara en $accessIp: ${e.message}")
            } catch (e: Exception) {
                postError(call, "Error inesperado: ${e.message}")
            }
        }.start()
    }

    @PluginMethod
    fun applyNetwork(call: PluginCall) {
        val accessIp = call.getString("accessIp") ?: return call.reject("Falta accessIp")
        val targetIp = call.getString("targetIp") ?: return call.reject("Falta targetIp")
        val targetMask = call.getString("targetMask") ?: return call.reject("Falta targetMask")
        val targetGateway = call.getString("targetGateway") ?: ""

        val session = sessions[accessIp]
            ?: return call.reject("Primero ejecutá el paso de credenciales (readAndSecure) para esta cámara.")

        Thread {
            try {
                val gwXml = if (targetGateway.isNotBlank())
                    "<DefaultGateway><ipAddress>${escapeXml(targetGateway)}</ipAddress></DefaultGateway>" else ""

                val body = """<?xml version="1.0" encoding="UTF-8"?>
                    |<NetworkInterface xmlns="http://www.hikvision.com/ver20/XMLSchema">
                    |<id>${session.interfaceId}</id>
                    |<IPAddress>
                    |<ipVersion>v4</ipVersion>
                    |<addressingType>static</addressingType>
                    |<ipAddress>${escapeXml(targetIp)}</ipAddress>
                    |<subnetMask>${escapeXml(targetMask)}</subnetMask>
                    |$gwXml
                    |</IPAddress>
                    |</NetworkInterface>""".trimMargin()

                val resp = session.client.requestAuth(
                    "PUT", "/ISAPI/System/Network/interfaces/${session.interfaceId}",
                    session.user, session.pass, body
                )

                sessions.remove(accessIp) // la IP cambió: la sesión ya no es válida a esta dirección

                val result = JSObject()
                if (resp.code in 200..299) {
                    result.put("ok", true)
                    result.put("probablySucceeded", false)
                } else {
                    result.put("ok", false)
                    result.put("message", HikvisionIsapiClient.xmlTagValue(resp.body, "statusString")
                        ?: "La cámara devolvió un error (código ${resp.code}).")
                }
                activity.runOnUiThread { call.resolve(result) }

            } catch (e: SocketTimeoutException) {
                // Esperado: la cámara cambia de IP a mitad de la respuesta y corta la conexión.
                sessions.remove(accessIp)
                val result = JSObject()
                result.put("ok", true)
                result.put("probablySucceeded", true)
                activity.runOnUiThread { call.resolve(result) }
            } catch (e: Exception) {
                postError(call, "Error al aplicar la red: ${e.message}")
            }
        }.start()
    }

    private fun postError(call: PluginCall, message: String) {
        activity.runOnUiThread { call.reject(message) }
    }

    private fun escapeXml(s: String): String =
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace("\"", "&quot;").replace("'", "&apos;")
}
