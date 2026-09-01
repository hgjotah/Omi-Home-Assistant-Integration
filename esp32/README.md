# Firmware Waveshare ESP32-C6-LCD-1.47

El sketch usa el pinout oficial del modelo **sin touch**:

- LCD ST7789 172×320: MOSI GPIO6, SCLK GPIO7, CS GPIO14, DC GPIO15, RST GPIO21, BL GPIO22.
- El portal local aparece como `Omi-HA-Setup`, contraseña `omi-ha-setup`, en `http://192.168.4.1`.
- Polling normal: una única petición `POST /api/bridge/next` cada 1500 ms. No existe heartbeat adicional.
- Firmware actual: `1.0.1`. Envía chunks de 12 entidades y 8 servicios.

## Dependencias Arduino

Instala desde Library Manager:

1. `ArduinoJson` 7.x.
2. `GFX Library for Arduino` (`Arduino_GFX_Library`) 1.5 o posterior.

Instala **esp32 by Espressif Systems** con soporte ESP32-C6 y selecciona una placa ESP32-C6 compatible. Activa USB CDC on boot si quieres ver el puerto serie.

## TLS

El sketch valida el certificado HTTPS de `workers.dev` contra la raíz GlobalSign usada por la cadena vigente. Esa raíz caduca el 28 de enero de 2028. Si Cloudflare cambia de autoridad certificadora o después de esa fecha, actualiza `GLOBALSIGN_ROOT_CA` con la raíz de confianza vigente antes de compilar. El firmware no usa `setInsecure()`.

Home Assistant se espera en una URL HTTP privada tipo `http://192.168.1.124:8123`. Esa llamada nunca sale de la LAN.

## Memoria durante sincronización

Las entidades se analizan una a una desde el stream de `/api/states`; no se carga la respuesta completa. `/api/services` se procesa por dominios y conserva el objeto `fields` real. Se rechaza un objeto individual anormalmente grande en vez de agotar toda la RAM.

## Errores Cloudflare por Serial

Desde `1.0.1`, cualquier respuesta no 2xx conserva e imprime método, ruta, código HTTP y body completo. El detalle, truncado de forma segura, también se devuelve en `/api/bridge/result` para que aparezca en Diagnóstico. No se imprimen Bridge Secret, token de Home Assistant ni headers de autorización.
