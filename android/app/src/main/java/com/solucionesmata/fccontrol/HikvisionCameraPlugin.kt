package com.solucionesmata.fccontrol

import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Puente nativo entre FCControl (JS) y el panel web real de la cámara
 * Hikvision/HikMicro, conectada por WiFi o Ethernet a la tablet.
 *
 * Antes esto hablaba ISAPI/Digest directo (ver commits previos): funciona
 * en cámaras Hikvision clásicas, pero el modelo HikMicro en uso cifra la
 * contraseña de activación con un esquema propietario no documentado — la
 * cámara devuelve 403 porque nunca entiende la contraseña que le mandamos
 * en crudo. En vez de reversear ese cifrado, automatizamos el panel web
 * real (HikvisionPortalAutomation, un WebView oculto) exactamente como lo
 * haría un técnico — el cifrado lo sigue haciendo el JS original de la
 * cámara, que sabemos que funciona (confirmado contra hardware real desde
 * la versión de escritorio, que usa la misma estrategia).
 */
@CapacitorPlugin(name = "HikvisionCamera")
class HikvisionCameraPlugin : Plugin() {

    private val scope = CoroutineScope(Dispatchers.Main)
    private var automation: HikvisionPortalAutomation? = null
    private var boundNetwork: Network? = null

    // Las cámaras se configuran por red cableada (Ethernet vía adaptador
    // USB-C) o WiFi según el equipo — no asumimos una sola.
    private fun activeLocalNetwork(): Network? {
        val cm = context.getSystemService(android.content.Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        return cm.allNetworks.firstOrNull { net ->
            val caps = cm.getNetworkCapabilities(net)
            caps != null && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
        }
    }

    // La tablet puede tener datos móviles activos a la vez que la red local
    // de la cámara (que casi nunca tiene salida a internet) — sin atar el
    // proceso a la red correcta, Android puede enrutar el WebView por la
    // red equivocada y la cámara nunca responde.
    private fun bindToLocalNetwork(): Boolean {
        val cm = context.getSystemService(android.content.Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = activeLocalNetwork() ?: return false
        cm.bindProcessToNetwork(network)
        boundNetwork = network
        return true
    }

    private fun unbindNetwork() {
        if (boundNetwork != null) {
            val cm = context.getSystemService(android.content.Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            cm.bindProcessToNetwork(null)
            boundNetwork = null
        }
    }

    @PluginMethod
    fun readAndSecure(call: PluginCall) {
        val accessIp = call.getString("accessIp") ?: return call.reject("Falta accessIp")
        val currentUser = call.getString("currentUser") ?: "admin"
        val currentPass = call.getString("currentPass") ?: "12345"
        val newPass = call.getString("newPass") ?: return call.reject("Falta newPass")

        if (!bindToLocalNetwork()) {
            return call.reject("Sin conexión a la red de la cámara. Conectá el cable o el WiFi a la red donde está la cámara.")
        }

        scope.launch {
            try {
                val auto = HikvisionPortalAutomation(activity)
                automation = auto
                val secured = auto.readAndSecure(accessIp, currentUser, currentPass, newPass)

                val result = JSObject()
                result.put("ok", true)
                result.put("activated", secured.activated)
                result.put("mac", secured.mac)
                result.put("currentIp", secured.currentIp)
                result.put("currentMask", secured.currentMask)
                call.resolve(result)
            } catch (e: Exception) {
                unbindNetwork()
                call.reject(e.message ?: "Error al comunicarse con la cámara.")
            }
        }
    }

    @PluginMethod
    fun applyNetwork(call: PluginCall) {
        val accessIp = call.getString("accessIp") ?: return call.reject("Falta accessIp")
        val deviceName = call.getString("deviceName")
        val targetIp = call.getString("targetIp") ?: return call.reject("Falta targetIp")
        val targetMask = call.getString("targetMask") ?: return call.reject("Falta targetMask")
        val targetGateway = call.getString("targetGateway") ?: ""

        val auto = automation
            ?: return call.reject("Primero ejecutá el paso de credenciales (readAndSecure) para esta cámara.")

        scope.launch {
            val result = JSObject()
            try {
                auto.applyNetwork(accessIp, deviceName, targetIp, targetMask, targetGateway)
                result.put("ok", true)
                result.put("probablySucceeded", true)
                call.resolve(result)
            } catch (e: Exception) {
                result.put("ok", false)
                result.put("message", e.message ?: "No se pudo aplicar la configuración de red.")
                call.resolve(result)
            } finally {
                automation = null
                unbindNetwork()
            }
        }
    }
}
