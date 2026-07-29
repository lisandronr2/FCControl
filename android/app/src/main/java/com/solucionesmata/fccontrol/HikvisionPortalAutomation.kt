package com.solucionesmata.fccontrol

import android.annotation.SuppressLint
import android.app.Activity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject
import kotlin.coroutines.resume

// Config de cámaras Hikvision/HikMicro desde Android.
//
// La primera versión de esto hablaba ISAPI/Digest directo (ver
// HikvisionCameraPlugin.kt original). En la práctica, el modelo probado
// (HikMicro, firmware con portal Vue/Element UI) cifra la contraseña de
// activación con un esquema propietario no documentado antes de mandarla a
// /ISAPI/System/activate — eso da el "error 403" que se ve en la app: la
// cámara rechaza la activación/login porque nunca le llega la contraseña
// que espera.
//
// La solución (idéntica en espíritu a la de Electron, que sí funciona
// contra hardware real) es dejar de hablar ISAPI a ciegas y en cambio
// automatizar el panel web real de la cámara dentro de un WebView oculto:
// cargamos la página, completamos los campos de login/activación/red como
// lo haría un técnico, y dejamos que el cifrado lo haga el JS original de
// la cámara, que sabemos que funciona.
class HikvisionPortalAutomation(private val activity: Activity) {

    class PortalAutomationException(message: String) : Exception(message)

    data class SecureResult(
        val activated: Boolean,
        val mac: String,
        val currentIp: String,
        val currentMask: String
    )

    private var webView: WebView? = null
    private var lastLoadError: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    private suspend fun ensureWebView(): WebView = withContext(Dispatchers.Main) {
        webView?.let { return@withContext it }

        val wv = WebView(activity)
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        wv.settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        wv.webViewClient = object : WebViewClient() {
            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                if (request == null || request.isForMainFrame) {
                    lastLoadError = error?.description?.toString() ?: "Error de red desconocido"
                }
            }
        }

        // 1x1 e invisible, pero colgado del árbol de vistas de la Activity:
        // un WebView nunca adjuntado (o con la Activity en background) puede
        // dejar de ejecutar JS o de cargar recursos — no alcanza con crearlo
        // suelto en memoria.
        val decor = activity.window.decorView as ViewGroup
        val lp = ViewGroup.LayoutParams(1, 1)
        wv.visibility = View.INVISIBLE
        decor.addView(wv, lp)

        webView = wv
        wv
    }

    private fun destroyWebView() {
        val wv = webView ?: return
        webView = null
        activity.runOnUiThread {
            (wv.parent as? ViewGroup)?.removeView(wv)
            wv.destroy()
        }
    }

    private fun jsStr(s: String): String = JSONObject.quote(s)

    private suspend fun exec(js: String): String = withContext(Dispatchers.Main) {
        val wv = webView ?: throw PortalAutomationException("Sesión con la cámara no inicializada.")
        suspendCancellableCoroutine { cont ->
            wv.evaluateJavascript(js) { raw ->
                if (cont.isActive) cont.resume(raw ?: "null")
            }
        }
    }

    // El resultado de evaluateJavascript viene codificado como JSON (una
    // cadena JS "algo" llega como el texto `"algo"`, con comillas y escapes)
    private fun unquoteJsResult(raw: String): String {
        if (raw == "null" || raw.isEmpty()) return ""
        return try {
            JSONObject.wrap(JSONObject("{\"v\":$raw}").opt("v"))?.toString() ?: ""
        } catch (e: Exception) {
            raw.trim('"')
        }
    }

    private suspend fun waitFor(conditionJs: String, timeoutMs: Long = 10000, intervalMs: Long = 300): Boolean {
        val start = System.currentTimeMillis()
        while (System.currentTimeMillis() - start < timeoutMs) {
            if (exec(conditionJs) == "true") return true
            delay(intervalMs)
        }
        return false
    }

    private fun findInputByPlaceholderJs(sub: String) =
        "Array.from(document.querySelectorAll('input')).find(function(i){ return i.placeholder && i.placeholder.includes(${jsStr(sub)}); })"

    private fun findInputByTypeJs(type: String) =
        "Array.from(document.querySelectorAll('input')).find(function(i){ return i.type === ${jsStr(type)}; })"

    private fun findButtonByTextJs(text: String) =
        "Array.from(document.querySelectorAll('button')).find(function(b){ return b.textContent.trim().includes(${jsStr(text)}); })"

    private val setValFn = """
        function setVal(el, val) {
          if (!el) return false;
          var proto = Object.getPrototypeOf(el);
          var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
    """.trimIndent()

    private suspend fun login(user: String, pass: String): Boolean {
        val filledJs = """
            (function(){
              $setValFn
              var userEl = ${findInputByPlaceholderJs("usuario")};
              var passEl = ${findInputByTypeJs("password")};
              if (!userEl || !passEl) return false;
              setVal(userEl, ${jsStr(user)});
              setVal(passEl, ${jsStr(pass)});
              return true;
            })()
        """.trimIndent()
        if (exec(filledJs) != "true") return false

        delay(300)
        exec("""(function(){ var btn = ${findButtonByTextJs("Iniciar sesión")}; if (btn) btn.click(); })()""")

        waitFor("!location.hash.includes('/login')", 8000)
        delay(800)
        val stillOnLogin = exec("location.hash.includes('/login')") == "true"
        return !stillOnLogin
    }

    private suspend fun activate(newPass: String): Boolean {
        val filledJs = """
            (function(){
              $setValFn
              var passInputs = Array.from(document.querySelectorAll('input[type=password]'));
              if (passInputs.length < 2) return false;
              setVal(passInputs[0], ${jsStr(newPass)});
              setVal(passInputs[1], ${jsStr(newPass)});
              return true;
            })()
        """.trimIndent()
        if (exec(filledJs) != "true") return false

        delay(300)
        exec("""(function(){ var btn = ${findButtonByTextJs("Activación")}; if (btn) btn.click(); })()""")

        waitFor("!document.querySelector('input[type=password]')", 8000)
        delay(1000)
        return true
    }

    private suspend fun navigateAndWaitForPortal(accessIp: String, path: String) {
        val wv = ensureWebView()
        lastLoadError = null
        withContext(Dispatchers.Main) { wv.loadUrl("http://$accessIp$path") }

        val loaded = waitFor("document.querySelectorAll('input').length > 0", 8000, 400)
        if (!loaded) {
            lastLoadError?.let {
                throw PortalAutomationException("No se pudo conectar con la cámara en $accessIp ($it). Verificá la IP y que la tablet esté en la misma red.")
            }
            val diag = try {
                exec("JSON.stringify({url: location.href, title: document.title, bodyLen: document.body ? document.body.innerHTML.length : 0})")
            } catch (e: Exception) { "{}" }
            throw PortalAutomationException("La cámara respondió en $accessIp pero el panel no terminó de cargar ($diag). Probá de nuevo o revisá la IP de acceso.")
        }
    }

    private suspend fun clickNext() {
        exec("""(function(){ var btn = ${findButtonByTextJs("Siguiente")}; if (btn) btn.click(); })()""")
        delay(1200)
    }

    // Pone el nombre OSD (superpuesto en la imagen) de la cámara para que
    // coincida con el nombre del dispositivo en FCControl, ANTES de tocar la
    // red (orden pedido explícitamente), recorriendo el asistente desde el
    // paso 1 sin modificar nada hasta llegar al paso de OSD.
    private suspend fun setOsdName(accessIp: String, deviceName: String) {
        navigateAndWaitForPortal(accessIp, "/doc/index.html#/wizard")
        if (!waitFor("document.querySelector('.el-form-item') != null", 6000)) {
            throw PortalAutomationException("No se pudo llegar al asistente para configurar el nombre OSD.")
        }

        clickNext() // paso 1 (red) sin tocar
        clickNext() // paso 2 (hora) sin tocar

        val onOsdStep = waitFor(
            """
            document.body.textContent.toUpperCase().includes('OSD') ||
            document.body.textContent.toUpperCase().includes('SUPERPOSICI')
            """.trimIndent(),
            5000
        )
        if (!onOsdStep) {
            val diag = try {
                exec("JSON.stringify({url: location.href, bodySnippet: document.body.textContent.slice(0,300)})")
            } catch (e: Exception) { "{}" }
            throw PortalAutomationException("No se llegó a la pantalla de Ajustes OSD del asistente ($diag).")
        }

        // ¿Cámara de dos canales? Buscamos pestañas/selectores "1"/"2" o
        // "Canal 1"/"Canal 2"/"CH1"/"CH2".
        val channelTabsInfo = exec(
            """
            (function(){
              var tabs = Array.from(document.querySelectorAll('.el-tabs__item, .el-radio, [role=tab]'));
              var chTabs = tabs.filter(function(t){ return /^(canal\s*)?[12]${'$'}|^ch\s*[12]${'$'}/i.test(t.textContent.trim()); });
              return chTabs.length;
            })()
            """.trimIndent()
        ).toIntOrNull() ?: 0

        suspend fun setNameOnCurrentPanel(name: String): Boolean {
            val js = """
                (function(){
                  $setValFn
                  var items = Array.from(document.querySelectorAll('.el-form-item'));
                  var item = items.find(function(it){
                    var lbl = it.querySelector('label');
                    if (!lbl) return false;
                    var t = lbl.textContent.toUpperCase();
                    return t.includes('NOMBRE') || t.includes('OSD') || t.includes('CANAL');
                  });
                  var input = item ? item.querySelector('input[type=text]') : null;
                  return setVal(input, ${jsStr(name)});
                })()
            """.trimIndent()
            return exec(js) == "true"
        }

        if (channelTabsInfo >= 2) {
            for (ch in 1..2) {
                val clickJs = """
                    (function(){
                      var tabs = Array.from(document.querySelectorAll('.el-tabs__item, .el-radio, [role=tab]'));
                      var re = new RegExp('^(canal\\s*)?$ch${'$'}|^ch\\s*$ch${'$'}', 'i');
                      var tab = tabs.find(function(t){ return re.test(t.textContent.trim()); });
                      if (tab) { tab.click(); return true; }
                      return false;
                    })()
                """.trimIndent()
                if (exec(clickJs) != "true") {
                    throw PortalAutomationException("No se encontró la pestaña del canal $ch en Ajustes OSD.")
                }
                delay(500)
                if (!setNameOnCurrentPanel("$deviceName 0$ch")) {
                    throw PortalAutomationException("No se encontró el campo de nombre OSD para el canal $ch.")
                }
            }
        } else {
            if (!setNameOnCurrentPanel(deviceName)) {
                val diag = try {
                    exec("JSON.stringify(Array.from(document.querySelectorAll('.el-form-item label')).map(function(l){return l.textContent.trim();}))")
                } catch (e: Exception) { "[]" }
                throw PortalAutomationException("No se encontró el campo de nombre OSD. Etiquetas visibles en esta pantalla: $diag")
            }
        }

        delay(300)
        clickNext()
    }

    suspend fun readAndSecure(accessIp: String, currentUser: String, currentPass: String, newPass: String): SecureResult {
        destroyWebView() // sesión limpia por cámara
        navigateAndWaitForPortal(accessIp, "/doc/index.html#/portal/login")

        val isActivationScreen = exec("document.querySelectorAll('input[type=password]').length >= 2") == "true"

        var activated = false
        if (isActivationScreen) {
            if (!activate(newPass)) throw PortalAutomationException("No se pudo completar la pantalla de activación de fábrica.")
            activated = true
            val stillNeedsLogin = exec("location.hash.includes('/login') || document.querySelectorAll('input[type=password]').length >= 2") == "true"
            if (stillNeedsLogin) {
                navigateAndWaitForPortal(accessIp, "/doc/index.html#/portal/login")
                if (!login("admin", newPass)) {
                    throw PortalAutomationException("La cámara se activó pero no se pudo iniciar sesión después con la contraseña nueva.")
                }
            }
        } else {
            var ok = login(currentUser, currentPass)
            if (!ok) {
                navigateAndWaitForPortal(accessIp, "/doc/index.html#/portal/login")
                ok = login(currentUser, newPass)
            }
            if (!ok) {
                throw PortalAutomationException(
                    "No se pudo iniciar sesión en $accessIp ni con la contraseña actual ('$currentPass') ni con la nueva ('$newPass'). Verificá que sea la IP correcta de esta cámara."
                )
            }
        }

        // Con sesión iniciada, la cookie ya autentica llamadas de solo lectura
        // directas a la ISAPI (confirmado contra hardware real vía Electron).
        val netXmlRaw = exec("fetch('/ISAPI/System/Network/interfaces', { credentials: 'same-origin' }).then(function(r){ return r.text(); }).catch(function(){ return ''; })")
        val netXml = unquoteJsResult(netXmlRaw)
        val mac = Regex("<MACAddress>([^<]*)</MACAddress>").find(netXml)?.groupValues?.get(1) ?: ""
        val currentIpVal = Regex("<ipAddress>([^<]*)</ipAddress>").find(netXml)?.groupValues?.get(1) ?: ""
        val currentMaskVal = Regex("<subnetMask>([^<]*)</subnetMask>").find(netXml)?.groupValues?.get(1) ?: ""

        return SecureResult(activated, mac, currentIpVal, currentMaskVal)
    }

    suspend fun applyNetwork(accessIp: String, deviceName: String?, targetIp: String, targetMask: String, targetGateway: String): Boolean {
        if (webView == null) throw PortalAutomationException("Primero ejecutá el paso de credenciales (readAndSecure) para esta cámara.")

        try {
            if (!deviceName.isNullOrBlank()) {
                setOsdName(accessIp, deviceName)
            }

            navigateAndWaitForPortal(accessIp, "/doc/index.html#/wizard")
            if (!waitFor("document.querySelector('.el-form-item') != null", 6000)) {
                throw PortalAutomationException("No se pudo llegar a la pantalla de ajustes de red del asistente.")
            }

            // Apagar DHCP si está prendido — reintenta y verifica, porque el
            // click sobre el <input type=checkbox> nativo (suele estar
            // oculto) es ignorado por Element UI.
            var dhcpOff = false
            for (attempt in 0 until 4) {
                val state = exec(
                    """
                    (function(){
                      var dhcp = Array.from(document.querySelectorAll('input[type=checkbox]'))
                        .find(function(i){ return i.closest('.el-form-item') && i.closest('.el-form-item').textContent.toUpperCase().includes('DHCP'); });
                      if (!dhcp) return 'NOT_FOUND';
                      if (!dhcp.checked) return 'OFF';
                      var clickable = dhcp.closest('.el-switch') || dhcp.closest('.el-checkbox') || dhcp.closest('label') || dhcp;
                      clickable.click();
                      return 'CLICKED';
                    })()
                    """.trimIndent()
                )
                val stateVal = unquoteJsResult(state)
                if (stateVal == "OFF") { dhcpOff = true; break }
                if (stateVal == "NOT_FOUND") { dhcpOff = false; break }
                delay(500)
            }
            if (!dhcpOff) {
                val recheck = exec(
                    """
                    (function(){
                      var dhcp = Array.from(document.querySelectorAll('input[type=checkbox]'))
                        .find(function(i){ return i.closest('.el-form-item') && i.closest('.el-form-item').textContent.toUpperCase().includes('DHCP'); });
                      return dhcp ? !dhcp.checked : false;
                    })()
                    """.trimIndent()
                )
                dhcpOff = recheck == "true"
            }
            if (!dhcpOff) throw PortalAutomationException("No se pudo desactivar el DHCP para poder fijar la IP estática.")
            delay(500)

            val hasGateway = targetGateway.isNotBlank()
            val ok = exec(
                """
                (function(){
                  $setValFn
                  function byLabel(sub) {
                    var items = Array.from(document.querySelectorAll('.el-form-item'));
                    var item = items.find(function(it){
                      var lbl = it.querySelector('label');
                      return lbl && lbl.textContent.includes(sub);
                    });
                    return item ? item.querySelector('input[type=text]') : null;
                  }
                  var ipEl = byLabel('Dirección IPv4 del dispositivo');
                  var maskEl = byLabel('Máscara de subred IPv4');
                  var gwEl = byLabel('Pasarela predeterminada IPv4');
                  var allOk = setVal(ipEl, ${jsStr(targetIp)}) && setVal(maskEl, ${jsStr(targetMask)});
                  if (gwEl && $hasGateway) setVal(gwEl, ${jsStr(targetGateway)});
                  return allOk;
                })()
                """.trimIndent()
            ) == "true"
            if (!ok) throw PortalAutomationException("No se encontraron los campos de IP/máscara en el asistente.")

            delay(500)
            exec("""(function(){ var btn = ${findButtonByTextJs("Siguiente")}; if (btn) btn.click(); })()""")
            delay(2500)

            destroyWebView()
            return true
        } catch (e: Exception) {
            destroyWebView()
            throw e
        }
    }
}
