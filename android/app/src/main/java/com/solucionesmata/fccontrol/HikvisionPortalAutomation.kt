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

        // Invisible pero con tamaño real, colgado del árbol de vistas de la
        // Activity: un WebView nunca adjuntado (o con la Activity en
        // background) puede dejar de ejecutar JS — pero un WebView de 1x1
        // píxel TAMBIÉN puede quedar sin renderizar ni ejecutar JS en
        // muchas versiones de Android (vistas de tamaño casi cero se tratan
        // como "no visibles, no hace falta dibujarlas" y el motor de layout
        // interno del WebView nunca corre) — confirmado en la práctica: el
        // panel de la cámara nunca terminaba de montar sus <input> en la
        // tablet, aunque en escritorio (una ventana real, no una View)
        // nunca dio problema. Se le da un tamaño real (el panel completo
        // del asistente ronda 900x700 en escritorio) mientras se mantiene
        // INVISIBLE para que no se vea en pantalla.
        val decor = activity.window.decorView as ViewGroup
        val lp = ViewGroup.LayoutParams(900, 700)
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

        val loaded = waitFor("document.querySelectorAll('input').length > 0", 12000, 400)
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

    // Matchea por texto de forma tolerante (sin acentos/mayúsculas, exacto
    // primero y por "contiene" como respaldo) porque las etiquetas reales
    // del panel varían levemente entre lo que el técnico recuerda y lo que
    // realmente dice la UI (p. ej. "Ajuste OSD" vs "Ajustes OSD").
    private suspend fun clickMenuText(text: String): Boolean {
        val js = """
            (function(){
              function norm(s){ return (s||'').trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
              // Los íconos del riel lateral (Configuración, etc.) no siempre
              // tienen texto visible — la etiqueta suele estar en
              // title/aria-label del propio elemento o de un ancestro cercano.
              function labelOf(el){
                var s = el.textContent || '';
                var node = el;
                for (var i = 0; i < 3 && node; i++){
                  s += ' ' + (node.getAttribute && (node.getAttribute('title') || node.getAttribute('aria-label') || '') || '');
                  node = node.parentElement;
                }
                return s;
              }
              var target = norm(${jsStr(text)});
              var all = Array.from(document.querySelectorAll('li, div, span, a, button, i, svg, .el-menu-item, .el-tabs__item, [role=tab], [title], [aria-label], [class]'));
              var candidates = all.filter(function(el){ return norm(el.textContent) === target; });
              if (!candidates.length) candidates = all.filter(function(el){ return norm(el.textContent).includes(target); });
              if (!candidates.length) candidates = all.filter(function(el){ return norm(labelOf(el)).includes(target); });
              if (!candidates.length) {
                // Último recurso: íconos sin texto ni title/aria-label
                // (típico de fuentes de íconos tipo Element UI, ej. clase
                // "el-icon-setting") solo se ubican por palabras clave en
                // su clase CSS — suele estar en inglés aunque la UI no lo esté.
                var keywordsByTarget = { 'CONFIGURACION': ['setting', 'config', 'gear', 'cog'] };
                var keywords = keywordsByTarget[target] || [];
                if (keywords.length) {
                  candidates = all.filter(function(el){
                    var cls = ((el.getAttribute && el.getAttribute('class')) || '').toLowerCase();
                    return keywords.some(function(k){ return cls.includes(k); });
                  });
                }
              }
              candidates.sort(function(a, b){ return a.innerHTML.length - b.innerHTML.length; });
              var el = candidates[0];
              if (el) {
                // Algunos menús laterales despliegan el submenú al pasar el
                // mouse (hover), no al hacer click — confirmado que la
                // segunda vez que se navega a "Configuración" en la misma
                // sesión, un .click() solo no alcanza.
                el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                el.click();
                return true;
              }
              return false;
            })()
        """.trimIndent()
        return exec(js) == "true"
    }

    // Clickea el primer botón de "confirmar cambios" que encuentre en la
    // pantalla actual — las distintas pantallas usan Guardar/Aceptar/
    // Aplicar/Confirmar según cuál sea.
    private suspend fun clickSaveButton(): Boolean {
        for (word in listOf("Guardar", "Aceptar", "Aplicar", "Confirmar")) {
            val clicked = exec("""(function(){ var btn = ${findButtonByTextJs(word)}; if (btn) { btn.click(); return true; } return false; })()""") == "true"
            if (clicked) return true
        }
        return false
    }

    // Pone el nombre del dispositivo en Configuración → Sistema →
    // Configuración del Sistema → Información Básica. Es una pantalla de
    // configuración normal con su propio botón de guardar que aplica el
    // cambio de inmediato (mismo mecanismo que la contraseña, que sabemos
    // que funciona) — no hace falta ningún asistente de varios pasos.
    private suspend fun setDeviceNameInSystemInfo(deviceName: String) {
        for (step in listOf("Configuración", "Sistema", "Configuración del Sistema")) {
            if (!clickMenuText(step)) {
                throw PortalAutomationException("No se encontró \"$step\" en el panel de la cámara.")
            }
            delay(800)
        }
        clickMenuText("Información Básica") // por si no quedó seleccionada por defecto
        delay(500)

        if (!waitFor("document.body.textContent.includes('Nombre de dispositivo')", 5000)) {
            val diag = try {
                exec("JSON.stringify({url: location.href, bodySnippet: document.body.textContent.slice(0,300)})")
            } catch (e: Exception) { "{}" }
            throw PortalAutomationException("No se llegó a la pantalla de Información Básica ($diag).")
        }

        val set = exec(
            """
            (function(){
              $setValFn
              var items = Array.from(document.querySelectorAll('.el-form-item'));
              var item = items.find(function(it){
                var lbl = it.querySelector('label');
                return lbl && lbl.textContent.includes('Nombre de dispositivo');
              });
              var input = item ? item.querySelector('input[type=text]') : null;
              return setVal(input, ${jsStr(deviceName)});
            })()
            """.trimIndent()
        ) == "true"
        if (!set) throw PortalAutomationException("No se encontró el campo \"Nombre de dispositivo\" en Información Básica.")

        delay(300)
        if (!clickSaveButton()) {
            throw PortalAutomationException("No se encontró un botón para guardar en Información Básica.")
        }
        delay(1200)
    }

    // Pone el nombre OSD en Configuración → Imagen → Ajustes OSD → Nombre
    // del Canal, para Canal 1 y Canal 2. El campo trae de fábrica
    // "Camera 1"/"Camera 2" — se reemplaza solo la palabra "Camera" por el
    // nombre del dispositivo, dejando el número tal cual venía (pedido
    // explícito: no reformatear el sufijo).
    private suspend fun setOsdChannelNames(deviceName: String) {
        for (step in listOf("Configuración", "Imagen", "Ajustes OSD")) {
            if (!clickMenuText(step)) {
                throw PortalAutomationException("No se encontró \"$step\" en el panel de la cámara.")
            }
            delay(800)
        }

        val onPage = waitFor(
            """
            document.body.textContent.toUpperCase().includes('OSD') ||
            document.body.textContent.toUpperCase().includes('NOMBRE DEL CANAL')
            """.trimIndent(),
            5000
        )
        if (!onPage) {
            val diag = try {
                exec("JSON.stringify({url: location.href, bodySnippet: document.body.textContent.slice(0,300)})")
            } catch (e: Exception) { "{}" }
            throw PortalAutomationException("No se llegó a la pantalla de Ajustes OSD ($diag).")
        }

        val channelTabsInfo = exec(
            """
            (function(){
              var all = Array.from(document.querySelectorAll('li, div, span, a, button, [role=tab]'));
              var chTabs = all.filter(function(t){ return /^(canal\s*)?[12]${'$'}|^ch\s*[12]${'$'}/i.test((t.textContent || '').trim()); });
              return chTabs.length;
            })()
            """.trimIndent()
        ).toIntOrNull() ?: 0

        // Reemplaza solo "Camera" en el valor actual del campo, preservando
        // el resto (típicamente el número de canal) — si por algún motivo
        // el campo no dice "Camera", usa el número de canal detectado como
        // respaldo en vez de perder ese dato.
        //
        // No asumimos ninguna estructura de formulario particular (esta
        // pantalla no usa .el-form-item/<label>, ni siquiera input[type=text]
        // explícito) — la señal más confiable es directamente el VALOR
        // actual del campo ("Camera 01"/"Camera 02"), y solo si eso falla se
        // busca por cercanía a un texto "Nombre del canal" que no sea botón.
        suspend fun setChannelName(fallbackSuffix: String): Boolean {
            val js = """
                (function(){
                  function setVal(el, val) {
                    if (!el) return false;
                    var proto = Object.getPrototypeOf(el);
                    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                    setter.call(el, val);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                  }
                  function norm(s){ return (s||'').trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
                  var isTextInput = function(el){ return el.tagName === 'INPUT' && (el.type === 'text' || el.type === ''); };
                  var allTextInputs = Array.from(document.querySelectorAll('input')).filter(isTextInput);

                  var input = allTextInputs.find(function(i){ return /camera/i.test(i.value || ''); });

                  if (!input) {
                    var labelLike = Array.from(document.querySelectorAll('label, span, div'))
                      .find(function(el){ return norm(el.textContent) === 'NOMBRE DEL CANAL'; });
                    if (labelLike) {
                      var container = labelLike.parentElement;
                      for (var i = 0; i < 5 && container && !input; i++) {
                        var found = container.querySelector('input');
                        if (found && isTextInput(found)) input = found;
                        container = container.parentElement;
                      }
                    }
                  }

                  if (!input) return false;
                  var current = (input.value || '').trim();
                  var newVal;
                  if (/camera/i.test(current)) {
                    newVal = current.replace(/camera/i, ${jsStr(deviceName)});
                  } else {
                    var m = current.match(/(\d+)\s*${'$'}/);
                    var suffix = m ? m[1] : ${jsStr(fallbackSuffix)};
                    newVal = (${jsStr(deviceName)} + ' ' + suffix).trim();
                  }
                  return setVal(input, newVal);
                })()
            """.trimIndent()
            return exec(js) == "true"
        }

        if (channelTabsInfo >= 2) {
            for (ch in 1..2) {
                val clickJs = """
                    (function(){
                      var all = Array.from(document.querySelectorAll('li, div, span, a, button, [role=tab]'));
                      var re = new RegExp('^(canal\\s*)?$ch${'$'}|^ch\\s*$ch${'$'}', 'i');
                      var candidates = all.filter(function(t){ return re.test((t.textContent || '').trim()); });
                      candidates.sort(function(a, b){ return a.innerHTML.length - b.innerHTML.length; });
                      var tab = candidates[0];
                      if (tab) { tab.click(); return true; }
                      return false;
                    })()
                """.trimIndent()
                if (exec(clickJs) != "true") {
                    throw PortalAutomationException("No se encontró la pestaña del canal $ch en Ajustes OSD.")
                }
                delay(500)
                // Los valores actuales (Camera 01/02, etc.) se cargan de
                // forma asíncrona al entrar a la pantalla o cambiar de canal
                // — confirmado que sin esperar, los campos están vacíos.
                waitFor("Array.from(document.querySelectorAll('input')).some(function(i){ return i.value && i.value.trim() !== ''; })", 4000, 300)
                if (!setChannelName(ch.toString())) {
                    throw PortalAutomationException("No se encontró el campo \"Nombre del Canal\" para el canal $ch.")
                }
            }
        } else {
            waitFor("Array.from(document.querySelectorAll('input')).some(function(i){ return i.value && i.value.trim() !== ''; })", 4000, 300)
            if (!setChannelName("")) {
                val diag = try {
                    exec("JSON.stringify(Array.from(document.querySelectorAll('input')).map(function(i){return {type:i.type,value:i.value};}))")
                } catch (e: Exception) { "[]" }
                throw PortalAutomationException("No se encontró el campo \"Nombre del Canal\" en Ajustes OSD. Inputs visibles: $diag")
            }
        }

        delay(300)
        if (!clickSaveButton()) {
            throw PortalAutomationException("No se encontró un botón para guardar en Ajustes OSD.")
        }
        delay(1200)
    }

    // El asistente es lineal y de varios pasos: escribir la IP y avanzar
    // una vez a la siguiente pantalla no alcanza para que la cámara aplique
    // nada — confirmado contra hardware real (la contraseña, que se aplica
    // desde una pantalla de acción directa, sí quedó puesta; la IP,
    // completada a mitad del asistente y luego abandonada, no). Hay que
    // llegar hasta el paso final y confirmarlo ahí. Como no sabemos de
    // antemano cuántos pasos quedan ni la etiqueta exacta del botón final,
    // se sigue avanzando buscando en cada pantalla un botón de cierre; si
    // no aparece ninguno tras varios pasos, se reporta como no confirmado
    // en vez de asumir que se aplicó igual.
    private suspend fun advanceWizardToFinish(maxSteps: Int = 6): Boolean {
        val finishWords = listOf("Finalizar", "Completar", "Terminar", "Guardar", "Aplicar", "Aceptar", "Confirmar")
        repeat(maxSteps) {
            val wordsJs = finishWords.joinToString(",") { w -> jsStr(w) }
            val clickedFinish = exec(
                """
                (function(){
                  var words = [$wordsJs];
                  var btn = Array.from(document.querySelectorAll('button')).find(function(b){
                    var t = b.textContent.trim();
                    return words.some(function(w){ return t.includes(w); });
                  });
                  if (btn) { btn.click(); return true; }
                  return false;
                })()
                """.trimIndent()
            ) == "true"
            if (clickedFinish) {
                delay(1500)
                return true
            }

            val clickedNext = exec("""(function(){ var btn = ${findButtonByTextJs("Siguiente")}; if (btn) { btn.click(); return true; } return false; })()""") == "true"
            if (!clickedNext) return false
            delay(1200)
        }
        return false
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
            // Orden confirmado por el técnico contra el panel real: primero
            // el nombre del dispositivo (Sistema → Información básica) y el
            // nombre OSD por canal (Imagen → Ajuste OSD, reemplazando
            // "CAMERA") — ambas son pantallas de configuración normal con
            // su propio Guardar que aplica al toque, nada que ver con el
            // asistente rápido. Recién después, el asistente de red (que sí
            // es de varios pasos y solo guarda al llegar al final).
            if (!deviceName.isNullOrBlank()) {
                setDeviceNameInSystemInfo(deviceName)
                setOsdChannelNames(deviceName)
            }

            navigateAndWaitForPortal(accessIp, "/doc/index.html#/wizard")
            if (!waitFor("document.querySelector('.el-form-item') != null", 6000)) {
                throw PortalAutomationException("No se pudo llegar al asistente de configuración de la cámara.")
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

            // El resto del asistente (hora, etc.) se deja sin tocar —
            // avanza solo hasta encontrar el paso final y confirmarlo ahí.
            delay(500)
            val finished = advanceWizardToFinish()
            if (!finished) {
                throw PortalAutomationException("Se completaron los campos pero no se encontró el paso final del asistente para confirmarlos — la cámara puede no haber aplicado los cambios. Probá de nuevo o revisalo manualmente en el panel de la cámara.")
            }
            delay(1500)

            destroyWebView()
            return true
        } catch (e: Exception) {
            destroyWebView()
            throw e
        }
    }
}
