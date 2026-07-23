package com.solucionesmata.fccontrol

import android.print.PrintAttributes
import android.print.PrintManager
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * window.print() no está implementado por el WebView embebido de
 * Capacitor (a diferencia de un navegador completo), así que esto
 * expone el diálogo nativo de impresión de Android (PrintManager)
 * — que incluye "Guardar como PDF" — apuntado al WebView actual de
 * la app, respetando el CSS @media print que ya define index.html.
 */
@CapacitorPlugin(name = "AppPrinter")
class AppPrinterPlugin : Plugin() {

    @PluginMethod
    fun printCurrent(call: PluginCall) {
        activity.runOnUiThread {
            try {
                val webView = bridge.webView
                val printManager = activity.getSystemService(android.content.Context.PRINT_SERVICE) as PrintManager
                val jobName = "FCControl_${System.currentTimeMillis()}"
                val adapter = webView.createPrintDocumentAdapter(jobName)
                printManager.print(jobName, adapter, PrintAttributes.Builder().build())
                call.resolve()
            } catch (e: Exception) {
                call.reject("No se pudo iniciar la impresión: ${e.message}")
            }
        }
    }
}
