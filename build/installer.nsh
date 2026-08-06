; Reemplaza el chequeo "¿sigue corriendo FCControl?" que trae electron-builder
; por defecto. El original solo hace un intento de cierre normal + un
; force-kill, y si el proceso sigue apareciendo (por ejemplo, porque el
; antivirus está escaneando el .exe mientras Electron termina de liberar sus
; procesos hijos) muestra "No se puede cerrar FCControl" y depende de que el
; técnico clickee Reintentar a mano.
;
; Reutiliza las macros FIND_PROCESS/KILL_PROCESS que ya trae electron-builder
; (probadas en producción) en vez de reimplementar la detección de procesos
; a mano — solo se le da mucho más presupuesto de reintentos (hasta 20,
; ≈20s) antes de mostrarle algo al técnico. Electron-builder detecta este
; archivo automáticamente por su nombre y ubicación
; (directories.buildResources, "build/" por defecto) — no hace falta
; configuración adicional en package.json.

Var fccWaitCount
Var pid

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  StrCpy $fccWaitCount 0
  StrCpy $pid "0"

  fcc_wait_loop:
    IntOp $fccWaitCount $fccWaitCount + 1

    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 != 0
      Goto fcc_not_running
    ${endIf}

    DetailPrint "Cerrando FCControl... (intento $fccWaitCount)"
    !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1
    Sleep 1000

    ${if} $fccWaitCount >= 20
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY fcc_wait_loop
      Quit
    ${endIf}
    Goto fcc_wait_loop

  fcc_not_running:
!macroend

; Segunda capa de defensa, más importante que la de arriba: cuando se
; actualiza sobre una instalación existente, quien realmente intenta
; cerrar la app y borrar los archivos viejos es el DESINSTALADOR VIEJO
; (una copia guardada de la versión previa) — no el instalador nuevo. Si
; esa versión vieja es anterior a este fix, todavía puede fallar con
; "Fallo al desinstalar archivos antiguos" sin importar qué tan bueno sea
; el customCheckAppRunning de la versión NUEVA, porque ese código nunca
; llega a ejecutarse en esta transición.
;
; Este gancho vive del lado del instalador NUEVO, así que no depende de
; qué versión vieja haya en el disco: si desinstalar la versión anterior
; falla (por la razón que sea — proceso que no cierra, archivo bloqueado
; un instante por el antivirus, etc.), reintenta la operación completa
; varias veces con pausas en vez de mostrar el diálogo al primer fallo.
; Reutiliza $fccWaitCount (declarada arriba) en vez de una variable nueva
; — customUnInstallCheck solo se inserta en el instalador, nunca junto
; con customCheckAppRunning en la misma pasada, así que no hay conflicto.

; Se probaron tres variantes de retry acá (chequeo directo de $R0, chequeo
; con IfErrors, prechequeo de si hay UninstallString en el registro) y las
; tres siguieron fallando en la práctica — $R0 es un registro NSIS de uso
; general reutilizado en decenas de lugares del script completo, y confiar
; en su valor puntual en este hook resultó ser inherentemente frágil
; (contaminación cruzada confirmada varias veces). Además se confirmó que
; esta build nunca llega a escribir una entrada de desinstalación en el
; registro de Windows en primer lugar (ni en instalaciones limpias), así
; que "desinstalar la versión anterior" no tiene, de base, nada real y
; confiable que hacer.
;
; La solución que de verdad funciona: no bloquear la instalación nueva por
; esto. Los archivos de la versión nueva se copian igual encima en el
; mismo directorio de instalación sin importar el resultado de este paso
; — el peor caso es un archivo viejo que ya no se usa quedando huérfano,
; no una instalación rota.
!macro customUnInstallCheck
!macroend
