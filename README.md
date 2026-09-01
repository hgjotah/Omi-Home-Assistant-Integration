# Omi Home Assistant

Integración completa para convertir comandos de voz de Omi en acciones reales de un Home Assistant que permanece dentro de la red local.

```text
Omi DevKit → app Omi / STT → Real-Time Transcript
                                  ↓ HTTPS
                         Cloudflare Worker + D1
                                  ↑ polling 1500 ms
                         Waveshare ESP32-C6-LCD-1.47
                                  ↓ HTTP dentro de la LAN
                            Home Assistant local
```

Cloudflare **nunca** llama a una IP `192.168.x.x`. No hacen falta puertos abiertos, Cloudflare Tunnel, Nabu Casa, VPS ni un PC encendido. El Long-Lived Access Token de Home Assistant existe únicamente en la memoria flash del ESP32.

## Funcionalidad

- Webhook oficial Omi Real-Time Transcript: array JSON de segmentos y `uid`/`session_id` en la query.
- Prefijo obligatorio `Omi` y matching completo, determinista y conservador; no usa LLM.
- Deduplicación de transcripciones incrementales por usuario, sesión, comando, tiempo de segmento y firma.
- `is_user=false` no bloquea una orden: cualquier persona puede pronunciar un comando configurado.
- Cola D1 multiusuario con jobs `pending → claimed → completed/failed`, expiración y recuperación tras reinicio del ESP32.
- Bridge Secret aleatorio de 256 bits, mostrado una sola vez y guardado únicamente como HMAC-SHA-256 con salt.
- Sincronización consistente de **todas** las entidades y servicios reales de Home Assistant mediante tablas staging.
- Buscador de entidades, controles derivados de `fields`, editor JSON avanzado y aviso para acciones sensibles.
- Prueba de acción asíncrona: el navegador consulta el job; el Worker nunca espera abierto al ESP32.
- Panel responsive, estado separado ESP32/Home Assistant, diagnóstico y página de privacidad.
- Firmware completo para Waveshare ESP32-C6-LCD-1.47 y simulador `fake-bridge`.
- Tests en el runtime real de Workers con D1 local.

## Fuentes oficiales verificadas

El proyecto se adaptó a la documentación vigente consultada el 28 de agosto de 2026:

- [Omi · Integration Apps](https://docs.omi.me/doc/developer/apps/Integrations): Real-Time Transcript envía `POST ...?session_id=...&uid=...` con un array de segmentos; `Setup Completed URL` devuelve `{"is_setup_completed": boolean}`.
- [Cloudflare · Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/) y [Git integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/).
- [Cloudflare · Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/): deploy por defecto `npx wrangler deploy` y rama de producción `main`.
- [Home Assistant · REST API](https://developers.home-assistant.io/docs/api/rest/): se usa `GET /api/`, `/api/states`, `/api/services`, `/api/states/<entity_id>` y `POST /api/services/<domain>/<service>`.
- [Home Assistant · Authentication](https://www.home-assistant.io/docs/authentication/): creación del Long-Lived Access Token desde Perfil de usuario → Seguridad.
- [Waveshare · ESP32-C6-LCD-1.47](https://www.waveshare.com/wiki/ESP32-C6-LCD-1.47): ST7789 172×320 y pinout de pantalla.

Omi no documenta actualmente una firma criptográfica, un header secreto ni un app token en los webhooks de Integration Apps. Esta app privada mitiga esa limitación con un `OMI_WEBHOOK_TOKEN` aleatorio incluido en la Webhook URL. Es un secreto compartido de URL, no una firma de Omi: alguien que conozca esa URL podría enviar un webhook. El Worker además solo acepta usuarios registrados por `/setup`, limita peticiones y deduplica ejecuciones.

## Estructura

```text
.
├── .github/workflows/ci.yml
├── esp32/
│   ├── OmiHomeAssistantBridge_ESP32C6_LCD_1_47.ino
│   └── README.md
├── migrations/0001_initial.sql
├── public/
├── src/
│   ├── api.ts                 # API de la interfaz
│   ├── auth.ts                # sesión, CSRF y Bridge Secret
│   ├── bridge.ts              # protocolo ESP32, jobs y sync
│   ├── crypto.ts
│   ├── database.ts
│   ├── homeAssistant.ts       # validación de acciones HA
│   ├── http.ts
│   ├── index.ts               # router Worker
│   ├── normalization.ts
│   ├── omi.ts                 # webhook y deduplicación
│   ├── types.ts
│   └── ui.ts                  # HTML/CSS/JS responsive
├── tests/
├── tools/fake-bridge.ts
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── wrangler.jsonc
```

## Requisitos

- Cuenta gratuita de GitHub.
- Cuenta gratuita de Cloudflare con un subdominio `workers.dev` activado.
- Node.js 20 o posterior para pruebas/migraciones locales.
- Omi con Developer Mode / creación de Integration Apps.
- Home Assistant accesible desde la misma red Wi-Fi que el ESP32.
- Waveshare ESP32-C6-LCD-1.47 **sin touch**.

## 1. Verificar el proyecto localmente

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

Para desarrollo local:

1. Copia `.dev.vars.example` como `.dev.vars`.
2. Sustituye ambos valores por secretos aleatorios de al menos 32 caracteres.
3. Ejecuta las migraciones y arranca Wrangler:

```bash
npm run db:migrate:local
npm run dev
```

No subas `.dev.vars`: ya está cubierto por `.gitignore`.

## 2. Crear el repositorio GitHub

Desde esta carpeta:

```bash
git init
git add .
git commit -m "Initial Omi Home Assistant"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/omi-home-assistant.git
git push -u origin main
```

También puedes crear el repositorio vacío en github.com, usar **Add file → Upload files** y subir el contenido completo. No añadas secretos, tokens ni un archivo `.dev.vars`.

## 3. Importar GitHub en Cloudflare Workers Builds

1. Abre Cloudflare Dashboard.
2. Ve a **Workers & Pages**.
3. Pulsa **Create** / **Create application**.
4. Elige **Import a repository** o **Connect to Git** para Workers.
5. Autoriza la app **Cloudflare Workers and Pages** en GitHub solo para este repositorio.
6. Selecciona `omi-home-assistant` y la rama `main`.
7. Usa estos valores de build:

| Campo Cloudflare | Valor |
|---|---|
| Root directory | `/` o vacío |
| Build command | vacío |
| Deploy command | `npx wrangler deploy` |
| Production branch | `main` |
| Non-production deploy | valor por defecto `npx wrangler versions upload` |

`package.json` y `wrangler.jsonc` están en la raíz. Cada push posterior a `main` desencadena un despliegue automático.

El primer build puede quedar pendiente/fallar hasta que D1 y los secretos obligatorios estén disponibles. Eso es esperado: termina los dos apartados siguientes y pulsa **Retry deployment** o haz un nuevo push.

## 4. Crear y vincular Cloudflare D1

El binding debe llamarse exactamente `DB`; la base se llama `omi-home-assistant-db`.

### Ruta recomendada: aprovisionamiento de Wrangler

El `wrangler.jsonc` declara el binding sin un ID. Wrangler 4 puede aprovisionar automáticamente el recurso al desplegar. Tras el primer intento, abre:

**Worker → Settings → Bindings**

y comprueba que existe un binding D1 `DB` hacia `omi-home-assistant-db`.

### Ruta explícita si tu cuenta no lo aprovisiona

```bash
npx wrangler login
npx wrangler d1 create omi-home-assistant-db
```

Copia el `database_id` devuelto y añádelo al objeto de `d1_databases` en `wrangler.jsonc`:

```jsonc
{
  "binding": "DB",
  "database_name": "omi-home-assistant-db",
  "database_id": "UUID_DEVUELTO_POR_CLOUDFLARE",
  "migrations_dir": "migrations"
}
```

Haz commit y push. Alternativamente, crea la base en **Storage & Databases → D1 → Create database** y copia su Database ID al mismo lugar. Mantén `wrangler.jsonc` como fuente de verdad para que los siguientes builds no pierdan el binding.

## 5. Aplicar migraciones

Con Wrangler autenticado:

```bash
npx wrangler d1 migrations list omi-home-assistant-db --remote
npx wrangler d1 migrations apply omi-home-assistant-db --remote
```

Confirma la migración `0001_initial.sql`. Después, en D1 → Console, una comprobación opcional es:

```sql
SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;
```

Debes ver `users`, `bridges`, `commands`, `jobs`, `entity_cache`, `service_cache`, `executions` y las dos tablas staging.

## 6. Configurar Secrets de Cloudflare

Genera **dos valores diferentes**. Este comando imprime un secreto; ejecútalo dos veces:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Configúralos por CLI:

```bash
npx wrangler secret put APP_SECRET
npx wrangler secret put OMI_WEBHOOK_TOKEN
```

o en **Worker → Settings → Variables & Secrets → Add → Secret**:

| Secret | Uso |
|---|---|
| `APP_SECRET` | Firma cookies, CSRF y hashes del Bridge Secret. |
| `OMI_WEBHOOK_TOKEN` | Protege la URL del webhook de esta app privada. |

No uses el mismo valor para ambos. No los pongas en GitHub, `wrangler.jsonc`, D1 ni variables de tipo texto. Después pulsa **Retry deployment**.

## 7. Obtener la URL workers.dev

Abre el Worker y mira **Settings → Domains & Routes** o la cabecera del despliegue. Será similar a:

```text
https://omi-home-assistant.TU_SUBDOMINIO.workers.dev
```

Comprueba:

```text
https://omi-home-assistant.TU_SUBDOMINIO.workers.dev/health
```

La respuesta pública debe ser exactamente `{"ok":true}`.

## 8. Configurar la Integration App privada de Omi

En Omi activa Developer Mode y crea una Integration App. Los nombres documentados actualmente son **Webhook URL**, **Setup Completed URL**, **Auth URL** y **Setup Instructions**; la pantalla también puede mostrar App Home y metadatos del repositorio.

Sustituye `BASE` y `TOKEN_OMI`:

| Campo de Omi | Valor exacto |
|---|---|
| Trigger Event / Capability | `Real-Time Transcript` |
| Webhook URL | `BASE/webhook/omi?token=TOKEN_OMI` |
| App Home URL | `BASE/` |
| Auth URL / Setup URL | `BASE/setup` |
| Setup Completed URL | `BASE/setup-status` |
| Setup Instructions | `Conecta tu bridge ESP32 y configura tus comandos de Home Assistant.` |
| Chat Tools Manifest URL | dejar vacío |
| GitHub Repository URL | `https://github.com/TU_USUARIO/omi-home-assistant` |

Ejemplo de Webhook URL:

```text
https://omi-home-assistant.TU_SUBDOMINIO.workers.dev/webhook/omi?token=EL_MISMO_VALOR_DE_OMI_WEBHOOK_TOKEN
```

No añadas `uid` ni `session_id`: Omi los añade. El Worker acepta el formato oficial actual: body array de segmentos y query `?uid=...&session_id=...`. Una query existente con `token` se conserva y Omi añade sus parámetros.

Al abrir Auth/Setup desde Omi, el Worker registra el `uid`, crea una cookie `HttpOnly; Secure; SameSite=Lax` firmada y redirige al panel. El frontend nunca envía ni decide el UID.

## 9. Crear el bridge en la web

1. Abre la Integration App desde Omi para obtener la sesión.
2. En el panel entra en **Configuración**.
3. Pulsa **Añadir bridge**.
4. Copia inmediatamente **Bridge ID** y **Bridge Secret**.

El secreto no se podrá consultar de nuevo. Si se pierde, pulsa **Regenerar secreto** y actualiza el ESP32; el anterior deja de funcionar.

## 10. Crear el Long-Lived Access Token de Home Assistant

1. En Home Assistant abre tu perfil de usuario.
2. Ve a la pestaña **Security / Seguridad**.
3. En **Long-lived access tokens**, pulsa **Create token**.
4. Pon un nombre como `Omi ESP32 Bridge`.
5. Copia el valor una sola vez.

> **NO introduzcas este token en Codex, GitHub, Cloudflare, D1 ni Omi.** Se introduce solamente en `http://192.168.4.1` del ESP32.

Home Assistant usa `Authorization: Bearer TOKEN`. El firmware prueba `GET /api/`, lista `GET /api/states` y `GET /api/services`, consulta estados con `GET /api/states/<entity_id>` y controla dispositivos con `POST /api/services/<domain>/<service>`. Nunca usa `POST /api/states/<entity_id>` para controlar un dispositivo.

## 11. Compilar y configurar el ESP32

Consulta también [esp32/README.md](esp32/README.md).

1. Instala Arduino IDE y el core **esp32 by Espressif Systems** con soporte ESP32-C6.
2. Instala `ArduinoJson` 7.x y `Arduino_GFX_Library` 1.5+.
3. Abre `esp32/OmiHomeAssistantBridge_ESP32C6_LCD_1_47.ino`.
4. Selecciona una placa ESP32-C6 compatible y el puerto USB.
5. Compila y flashea.
6. Tras el primer arranque, conéctate a:

```text
Wi-Fi: Omi-HA-Setup
Password: omi-ha-setup
```

7. Abre `http://192.168.4.1`.
8. Introduce:
   - SSID y contraseña de tu Wi-Fi de 2,4 GHz.
   - Worker URL `https://...workers.dev` sin ruta final.
   - Bridge ID y Bridge Secret de la web.
   - Home Assistant URL local, por ejemplo `http://192.168.1.124:8123`.
   - Long-Lived Access Token de Home Assistant.
9. Guarda; el ESP32 se reinicia.

El firmware valida el certificado HTTPS de `workers.dev`, consulta Cloudflare exactamente cada 1500 ms cuando está conectado y no envía ningún heartbeat adicional. Puedes volver al portal manteniendo pulsado BOOT durante el arranque.

## 12. Primera sincronización

1. Verifica en Inicio que **ESP32** aparece conectado.
2. Pulsa **Probar Home Assistant**. El ESP32 ejecuta `GET /api/` local y devuelve el resultado.
3. Pulsa **Actualizar entidades y acciones**.
4. Se crean dos jobs: `sync_entities` y `sync_services`.
5. El ESP32 transmite los datos por chunks.

La caché viva solo se sustituye en `complete` si el número recibido coincide. Si se corta la corriente a mitad, los datos anteriores siguen intactos. Una entidad o servicio desaparecido no borra su comando; la web lo marca como **Entidad no disponible** o **Acción no disponible**.

## 13. Crear y probar el primer comando

1. Pulsa **Añadir comando**.
2. Escribe en **Buscar entidad** `Luz habitación`, `light.habitacion` o `light`.
3. Selecciona la entidad; no hay un selector gigante.
4. En la frase escribe solo `enciende la luz`: el prefijo fijo muestra `Omi`.
5. Elige una acción real sincronizada, por ejemplo `light.turn_on`.
6. Configura `brightness_pct`, `transition` u otros campos si Home Assistant los publica. Usa Modo avanzado para JSON.
7. Pulsa **PROBAR ACCIÓN**. Es una ejecución real; para acciones sensibles aparece confirmación.
8. Espera el resultado del ESP32 y guarda.

Ahora di delante de Omi:

```text
Omi, enciende la luz.
```

La puntuación, mayúsculas y tildes se normalizan. `enciende la luz` sin `Omi` no ejecuta. Tampoco se buscan substrings dentro de una conversación; solo unidades recientes que empiezan por Omi.

## 14. Simular el ESP32

Permite verificar Cloudflare antes de conectar hardware:

```bash
npm run fake-bridge -- \
  --url https://omi-home-assistant.TU_SUBDOMINIO.workers.dev \
  --bridge-id br_xxx \
  --bridge-secret SECRETO
```

En PowerShell usa una sola línea o el continuador `` ` ``. Añade `--once` para una única consulta. El simulador:

- autentica el bridge;
- hace `/api/bridge/next`;
- simula call_service/test/get-state;
- transmite entidades y servicios de ejemplo;
- devuelve `/api/bridge/result`.

No pongas las credenciales en `tools/fake-bridge.config.json`: ese nombre está ignorado, pero la opción más segura es pasarlas como variables de entorno temporales.

## API del bridge

Todos requieren `X-Bridge-ID` y `Authorization: Bearer BRIDGE_SECRET`:

| Método | Ruta |
|---|---|
| POST | `/api/bridge/next` |
| POST | `/api/bridge/result` |
| POST | `/api/bridge/sync/entities/start` |
| POST | `/api/bridge/sync/entities/chunk` |
| POST | `/api/bridge/sync/entities/complete` |
| POST | `/api/bridge/sync/services/start` |
| POST | `/api/bridge/sync/services/chunk` |
| POST | `/api/bridge/sync/services/complete` |

`/next` devuelve como máximo un job. Un job reclamado no vuelve a entregarse antes de 45 s; pasado ese plazo puede recuperarse si el ESP32 se reinició. Jobs pendientes de más de 5 minutos expiran. El protocolo es de entrega **al menos una vez**: una caída exacta después de ejecutar en Home Assistant pero antes de enviar el resultado puede provocar un retry.

## Free tier y rendimiento

El polling cada 1,5 s genera aproximadamente 57.600 peticiones/día. El límite vigente de Workers Free es 100.000 peticiones/día. Para conservar margen:

- no hay heartbeats extra;
- `/next` es el heartbeat;
- `last_seen` se escribe como máximo cada 45 s;
- no hay escrituras D1 en polls vacíos salvo ese intervalo;
- el webhook no consulta cachés de entidades/servicios en el camino crítico;
- la interfaz solo consulta un job después de una prueba iniciada por el usuario.

Un único ESP32 encendido 24/7 cabe en el presupuesto. Dos bridges con polling continuo superarían el límite diario de 100.000; esta V1 permite varios por usuario, pero el free tier práctico es uno activo permanentemente.

## Seguridad y privacidad

- Sesión web HMAC con cookie HttpOnly/Secure/SameSite=Lax.
- CSRF obligatorio en mutaciones.
- Autorización por UID derivado de sesión o bridge; nunca desde el body.
- Rate limiting best-effort por isolate sin escribir D1 en cada poll.
- Límites de payload, validación estricta y CSP/headers de seguridad.
- Bridge Secrets no se registran ni se almacenan en claro.
- La app no registra headers Authorization, token Omi ni URLs completas.
- No se almacenan conversaciones completas: solo firma, comando, sesión, timing y metadatos mínimos de ejecución.
- `/diagnostics` exige sesión; `/health` solo devuelve `{"ok":true}`.

La primera visita a `/setup?uid=...` sigue el mecanismo oficial de Omi: Omi añade el UID, pero no firma esa visita según la documentación actual. Por eso el proyecto está planteado como app privada, emite inmediatamente una sesión firmada y no acepta UID posteriores desde JavaScript.

## Diagnóstico

Abre `/diagnostics` con una sesión válida o la pestaña **Diagnóstico**. Comprueba en este orden:

1. **Worker / D1**: ambos deben decir OK. Si D1 falla, aplica la migración y revisa el binding `DB`.
2. **ESP32**: si está desconectado, revisa Wi-Fi, Worker URL, Bridge ID/Secret y la pantalla/Serial.
3. **Home Assistant**: si dice NO, prueba `http://IP:8123/api/` desde la LAN y regenera el token si devuelve 401.
4. **Último webhook Omi**: si nunca aparece, revisa Trigger Event, Webhook URL, `OMI_WEBHOOK_TOKEN` y Developer Mode.
5. **Último job**: `pending` significa que el ESP32 no lo ha recogido; `claimed`, que lo recogió; `failed`, que devolvió un error; `expired`, que llegó tarde.
6. **Última acción**: revisa HTTP upstream y el mensaje del firmware.

Problemas frecuentes:

| Síntoma | Solución |
|---|---|
| `/health` devuelve 503 | Configura ambos secrets y redespliega. |
| Build falla por D1 | Crea D1, añade `database_id` y vuelve a hacer push. |
| Setup status siempre false | Deben existir usuario + bridge conectado + prueba HA correcta. |
| 401 del bridge | Regenera secreto y vuelve a guardarlo en `192.168.4.1`. |
| 401 Home Assistant | Token incorrecto/revocado; crea otro en Perfil → Seguridad. |
| Entidades antiguas tras sync | Mira el job: una sync incompleta conserva la caché anterior deliberadamente. |
| Omi no ejecuta | La unidad debe empezar por `Omi` y coincidir casi exactamente con un comando activo. |
| Omi ejecuta una sola vez | Repeticiones con timing distinto se permiten; duplicados incrementales del mismo segmento se descartan. |
| Pantalla `CLOUD ERROR` en 2028 | Actualiza la CA del firmware según `esp32/README.md`. |

## Desarrollo

Scripts disponibles:

```text
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
npm run deploy
npm run db:migrate:local
npm run db:migrate:remote
npm run fake-bridge
```

Chat Tools no forma parte de V1. La separación entre `homeAssistant.ts`, jobs tipados y cachés deja preparado añadir en el futuro `get_entity_state`, `call_service` y `list_entities` sin cambiar el protocolo base.
