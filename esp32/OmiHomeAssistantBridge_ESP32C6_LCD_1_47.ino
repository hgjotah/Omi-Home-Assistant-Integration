/*
 * Omi Home Assistant Bridge 1.0.1
 * Board: Waveshare ESP32-C6-LCD-1.47 (ST7789, 172x320)
 *
 * Home Assistant credentials stay in ESP32 Preferences. They are never sent
 * to Cloudflare. Install ArduinoJson 7.x and Arduino_GFX_Library 1.5+.
 */

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Arduino_GFX_Library.h>
#include <DNSServer.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <functional>
#include <vector>

static constexpr char FIRMWARE_VERSION[] = "1.0.1";
static constexpr uint32_t POLL_INTERVAL_MS = 1500;
static constexpr uint32_t HTTP_TIMEOUT_MS = 15000;
static constexpr uint8_t LCD_MOSI = 6;
static constexpr uint8_t LCD_SCLK = 7;
static constexpr uint8_t LCD_CS = 14;
static constexpr uint8_t LCD_DC = 15;
static constexpr uint8_t LCD_RST = 21;
static constexpr uint8_t LCD_BL = 22;
static constexpr uint8_t SETUP_BUTTON = 9;
static constexpr char SETUP_SSID[] = "Omi-HA-Setup";
static constexpr char SETUP_PASSWORD[] = "omi-ha-setup";

// workers.dev currently chains through GTS Root R4 to this GlobalSign root.
// Valid through 2028-01-28. See esp32/README.md for the update procedure.
static const char GLOBALSIGN_ROOT_CA[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
MIIDdTCCAl2gAwIBAgILBAAAAAABFUtaw5QwDQYJKoZIhvcNAQEFBQAwVzELMAkGA1UEBhMCQkUx
GTAXBgNVBAoTEEdsb2JhbFNpZ24gbnYtc2ExEDAOBgNVBAsTB1Jvb3QgQ0ExGzAZBgNVBAMTEkds
b2JhbFNpZ24gUm9vdCBDQTAeFw05ODA5MDExMjAwMDBaFw0yODAxMjgxMjAwMDBaMFcxCzAJBgNV
BAYTAkJFMRkwFwYDVQQKExBHbG9iYWxTaWduIG52LXNhMRAwDgYDVQQLEwdSb290IENBMRswGQYD
VQQDExJHbG9iYWxTaWduIFJvb3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDa
DuaZjc6j40+Kfvvxi4Mla+pIH/EqsLmVEQS98GPR4mdmzxzdzxtIK+6NiY6arymAZavpxy0Sy6sc
THAHoT0KMM0VjU/43dSMUBUc71DuxC73/OlS8pF94G3VNTCOXkNz8kHp1Wrjsok6Vjk4bwY8iGlb
Kk3Fp1S4bInMm/k8yuX9ifUSPJJ4ltbcdG6TRGHRjcdGsnUOhugZitVtbNV4FpWi6cgKOOvyJBNP
c1STE4U6G7weNLWLBYy5d4ux2x8gkasJU26Qzns3dLlwR5EiUWMWea6xrkEmCMgZK9FGqkjWZCrX
gzT/LCrBbBlDSgeF59N89iFo7+ryUp9/k5DPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBRge2YaRQ2XyolQL30EzTSo//z9SzANBgkqhkiG9w0BAQUF
AAOCAQEA1nPnfE920I2/7LqivjTFKDK1fPxsnCwrvQmeU79rXqoRSLblCKOzyj1hTdNGCbM+w6Dj
Y1Ub8rrvrTnhQ7k4o+YviiY776BQVvnGCv04zcQLcFGUl5gE38NflNUVyRRBnMRddWQVDf9VMOyG
j/8N7yy5Y0b2qvzfvGn9LhJIZJrglfCm7ymPAbEVtQwdpf5pLGkkeB6zpxxxYu7KyJesF12KwvhH
hm4qxFYxldBniYUr+WymXUadDKqC5JlR3XC321Y9YeRq4VzW9v493kHMB65jUr9TU/Qr6cf9tveC
X4XSQRjbgbMEHMUfpIBvFSDJ3gyICh3WZlXi/EjJKSZp4A==
-----END CERTIFICATE-----
)EOF";

Arduino_DataBus *lcdBus = new Arduino_ESP32SPI(LCD_DC, LCD_CS, LCD_SCLK, LCD_MOSI, GFX_NOT_DEFINED);
Arduino_GFX *gfx = new Arduino_ST7789(lcdBus, LCD_RST, 0, true, 172, 320, 34, 0, 34, 0);
Preferences preferences;
WebServer portal(80);
DNSServer dns;
WiFiClientSecure workerClient;

struct DeviceConfig {
  String wifiSsid;
  String wifiPassword;
  String workerUrl;
  String bridgeId;
  String bridgeSecret;
  String haUrl;
  String haToken;
};

DeviceConfig cfg;
bool portalMode = false;
bool haOk = false;
uint32_t nextPollAt = 0;
String screenStatus;

String trimTrailingSlash(String value) {
  value.trim();
  while (value.endsWith("/")) value.remove(value.length() - 1);
  return value;
}

String htmlEscape(const String &value) {
  String output;
  output.reserve(value.length() + 16);
  for (size_t index = 0; index < value.length(); ++index) {
    const char character = value[index];
    switch (character) {
      case '&': output += F("&amp;"); break;
      case '<': output += F("&lt;"); break;
      case '>': output += F("&gt;"); break;
      case '"': output += F("&quot;"); break;
      case '\'': output += F("&#39;"); break;
      default: output += character;
    }
  }
  return output;
}

void drawStatus(const String &status, uint16_t color = 0xFFFF) {
  if (status == screenStatus) return;
  screenStatus = status;
  gfx->fillScreen(0x0841);
  gfx->setTextColor(0xFFFF);
  gfx->setTextSize(2);
  gfx->setCursor(12, 20);
  gfx->println(F("OMI HOME"));
  gfx->setTextSize(1);
  gfx->setTextColor(0xBDF7);
  gfx->setCursor(12, 53);
  gfx->println(F("ESP32-C6 BRIDGE"));
  gfx->drawFastHLine(12, 72, 148, 0x4208);
  gfx->setTextColor(color);
  gfx->setTextSize(2);
  gfx->setCursor(12, 95);
  gfx->println(status);
  gfx->setTextSize(1);
  gfx->setTextColor(0x9CD3);
  gfx->setCursor(12, 148);
  if (WiFi.status() == WL_CONNECTED) {
    gfx->print(F("WiFi: "));
    gfx->println(WiFi.localIP().toString());
    gfx->setCursor(12, 166);
    gfx->print(F("RSSI: "));
    gfx->println(WiFi.RSSI());
  } else {
    gfx->println(F("WiFi desconectado"));
  }
  gfx->setCursor(12, 196);
  gfx->print(F("Home Assistant: "));
  gfx->println(haOk ? F("OK") : F("--"));
  gfx->setCursor(12, 285);
  gfx->print(F("Firmware "));
  gfx->println(FIRMWARE_VERSION);
}

bool loadConfig() {
  preferences.begin("omiha", true);
  cfg.wifiSsid = preferences.getString("ssid", "");
  cfg.wifiPassword = preferences.getString("wifi_pass", "");
  cfg.workerUrl = preferences.getString("worker", "");
  cfg.bridgeId = preferences.getString("bridge_id", "");
  cfg.bridgeSecret = preferences.getString("bridge_sec", "");
  cfg.haUrl = preferences.getString("ha_url", "");
  cfg.haToken = preferences.getString("ha_token", "");
  preferences.end();
  return !cfg.wifiSsid.isEmpty() && cfg.workerUrl.startsWith("https://") &&
         !cfg.bridgeId.isEmpty() && !cfg.bridgeSecret.isEmpty() &&
         cfg.haUrl.startsWith("http://") && !cfg.haToken.isEmpty();
}

void saveConfig(const DeviceConfig &value) {
  preferences.begin("omiha", false);
  preferences.putString("ssid", value.wifiSsid);
  preferences.putString("wifi_pass", value.wifiPassword);
  preferences.putString("worker", trimTrailingSlash(value.workerUrl));
  preferences.putString("bridge_id", value.bridgeId);
  preferences.putString("bridge_sec", value.bridgeSecret);
  preferences.putString("ha_url", trimTrailingSlash(value.haUrl));
  preferences.putString("ha_token", value.haToken);
  preferences.end();
}

String setupPage(const String &message = "") {
  String page;
  page.reserve(6500);
  page += F("<!doctype html><html lang='es'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Omi HA Setup</title><style>body{font:16px system-ui;background:#f3f5fa;color:#172033;margin:0}.box{max-width:560px;margin:24px auto;background:#fff;padding:22px;border-radius:18px;box-shadow:0 12px 35px #17203318}h1{margin-top:0}label{font-weight:700;display:block;margin:14px 0 5px}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #ccd2df;border-radius:10px}button{width:100%;border:0;border-radius:11px;padding:13px;margin-top:18px;background:#5b4df5;color:white;font-weight:800}.note{background:#fff6d9;border-left:4px solid #d18a00;padding:10px;margin:12px 0;border-radius:7px}.ok{background:#dcf7ed;padding:10px;border-radius:7px}</style></head><body><main class='box'><h1>Omi Home Assistant</h1><p>Los datos se guardan solo en este ESP32.</p>");
  if (!message.isEmpty()) page += "<div class='ok'>" + htmlEscape(message) + "</div>";
  page += F("<div class='note'><b>Home Assistant token:</b> no lo copies en Cloudflare, GitHub ni Omi.</div><form method='post' action='/save'>");
  page += "<label>Wi-Fi SSID</label><input name='ssid' maxlength='64' required value='" + htmlEscape(cfg.wifiSsid) + "'>";
  page += F("<label>Contraseña Wi-Fi</label><input type='password' name='wifi_password' maxlength='128' placeholder='Dejar vacío para conservar'>");
  page += "<label>Worker URL</label><input name='worker_url' maxlength='240' required placeholder='https://nombre.subdominio.workers.dev' value='" + htmlEscape(cfg.workerUrl) + "'>";
  page += "<label>Bridge ID</label><input name='bridge_id' maxlength='100' required value='" + htmlEscape(cfg.bridgeId) + "'>";
  page += F("<label>Bridge Secret</label><input type='password' name='bridge_secret' maxlength='160' placeholder='Dejar vacío para conservar'>");
  page += "<label>Home Assistant URL local</label><input name='ha_url' maxlength='180' required placeholder='http://192.168.1.124:8123' value='" + htmlEscape(cfg.haUrl) + "'>";
  page += F("<label>Home Assistant Long-Lived Access Token</label><input type='password' name='ha_token' maxlength='512' placeholder='Dejar vacío para conservar'><button type='submit'>Guardar y reiniciar</button></form><form method='post' action='/reset' onsubmit=\"return confirm('¿Borrar toda la configuración local?')\"><button style='background:#c83f3f'>Borrar configuración</button></form></main></body></html>");
  return page;
}

void startPortal(const String &message = "") {
  portalMode = true;
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(SETUP_SSID, SETUP_PASSWORD);
  dns.start(53, "*", WiFi.softAPIP());
  portal.on("/", HTTP_GET, [message]() { portal.send(200, "text/html; charset=utf-8", setupPage(message)); });
  portal.on("/save", HTTP_POST, []() {
    DeviceConfig next = cfg;
    next.wifiSsid = portal.arg("ssid");
    if (!portal.arg("wifi_password").isEmpty()) next.wifiPassword = portal.arg("wifi_password");
    next.workerUrl = trimTrailingSlash(portal.arg("worker_url"));
    next.bridgeId = portal.arg("bridge_id");
    if (!portal.arg("bridge_secret").isEmpty()) next.bridgeSecret = portal.arg("bridge_secret");
    next.haUrl = trimTrailingSlash(portal.arg("ha_url"));
    if (!portal.arg("ha_token").isEmpty()) next.haToken = portal.arg("ha_token");
    if (next.wifiSsid.isEmpty() || !next.workerUrl.startsWith("https://") ||
        !next.bridgeId.startsWith("br_") || next.bridgeSecret.length() < 32 ||
        !next.haUrl.startsWith("http://") || next.haToken.length() < 20) {
      portal.send(400, "text/html; charset=utf-8", setupPage("Revisa los campos. Worker debe usar HTTPS y Home Assistant una URL HTTP local."));
      return;
    }
    saveConfig(next);
    portal.send(200, "text/html; charset=utf-8", "<h2>Guardado. El ESP32 se reiniciará.</h2>");
    delay(700);
    ESP.restart();
  });
  portal.on("/reset", HTTP_POST, []() {
    preferences.begin("omiha", false);
    preferences.clear();
    preferences.end();
    portal.send(200, "text/html; charset=utf-8", "<h2>Configuración borrada. Reiniciando.</h2>");
    delay(700);
    ESP.restart();
  });
  portal.onNotFound([]() { portal.sendHeader("Location", "http://192.168.4.1/", true); portal.send(302, "text/plain", ""); });
  portal.begin();
  drawStatus("CONFIGURAR", 0xFFE0);
}

bool connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  WiFi.begin(cfg.wifiSsid.c_str(), cfg.wifiPassword.c_str());
  drawStatus("CONECTANDO", 0xFFE0);
  const uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 20000) delay(200);
  return WiFi.status() == WL_CONNECTED;
}

bool workerPost(const String &path, const String &body, String &response, int &code) {
  response = "";
  code = 0;
  HTTPClient http;
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(workerClient, cfg.workerUrl + path)) {
    code = -1;
    response = "No se pudo iniciar la conexión HTTPS";
    Serial.println(F("[Cloudflare]"));
    Serial.println("POST " + path);
    Serial.println(F("HTTP: -1"));
    Serial.println(F("Response:"));
    Serial.println(response);
    return false;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Bridge-ID", cfg.bridgeId);
  http.addHeader("Authorization", "Bearer " + cfg.bridgeSecret);
  code = http.POST(body);
  response = code > 0 ? http.getString() : "";
  http.end();
  const bool ok = code >= 200 && code < 300;
  if (!ok) {
    Serial.println(F("[Cloudflare]"));
    Serial.println("POST " + path);
    Serial.print(F("HTTP: "));
    Serial.println(code);
    Serial.println(F("Response:"));
    if (response.isEmpty()) Serial.println(F("(sin body)"));
    else Serial.println(response);
  }
  return ok;
}

String cloudflareFailure(const String &path, int code, const String &response) {
  String message = F("Cloudflare POST ");
  message += path;
  message += F(" HTTP ");
  message += String(code);
  if (!response.isEmpty()) message += ": " + response;
  return message.substring(0, 900);
}

bool homeAssistantRequest(const String &method, const String &path, const String &body, String &response, int &code) {
  WiFiClient localClient;
  HTTPClient http;
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(localClient, cfg.haUrl + path)) return false;
  http.addHeader("Authorization", "Bearer " + cfg.haToken);
  http.addHeader("Content-Type", "application/json");
  if (method == "GET") code = http.GET(); else code = http.POST(body);
  response = code > 0 ? http.getString() : "";
  http.end();
  return code >= 200 && code < 300;
}

String stateOf(const String &entityId) {
  String response;
  int code = 0;
  if (!homeAssistantRequest("GET", "/api/states/" + entityId, "", response, code)) return "";
  JsonDocument document;
  if (deserializeJson(document, response)) return "";
  return document["state"] | "";
}

void sendResult(const String &jobId, bool success, const String &message, int upstreamCode = 0,
                const String &state = "", const String &previousState = "") {
  JsonDocument document;
  document["job_id"] = jobId;
  document["success"] = success;
  document["message"] = message.substring(0, 900);
  document["upstream_http_code"] = upstreamCode;
  if (!state.isEmpty()) document["state"] = state;
  if (!previousState.isEmpty()) document["previous_state"] = previousState;
  String body;
  serializeJson(document, body);
  String response;
  int code;
  workerPost("/api/bridge/result", body, response, code);
}

bool sendChunk(const String &path, const String &jobId, const std::vector<String> &items,
               String &failure, int &failureCode) {
  String body = F("{\"job_id\":\"");
  body += jobId;
  body += F("\",\"items\":[");
  for (size_t index = 0; index < items.size(); ++index) {
    if (index) body += ',';
    body += items[index];
  }
  body += F("]}");
  String response;
  int code;
  const bool ok = workerPost(path, body, response, code);
  if (!ok) {
    failure = cloudflareFailure(path, code, response);
    failureCode = code;
  }
  return ok;
}

bool syncMarker(const String &path, const String &jobId, int count,
                String &failure, int &failureCode) {
  JsonDocument document;
  document["job_id"] = jobId;
  if (count >= 0) document["count"] = count;
  String body, response;
  int code;
  serializeJson(document, body);
  const bool ok = workerPost(path, body, response, code);
  if (!ok) {
    failure = cloudflareFailure(path, code, response);
    failureCode = code;
  }
  return ok;
}

bool streamTopLevelObjects(Stream &stream, const std::function<bool(const String &)> &consumer,
                           size_t maximumObjectBytes) {
  String object;
  object.reserve(4096);
  bool inString = false, escaped = false, capturing = false;
  int objectDepth = 0, arrayDepth = 0;
  uint32_t lastData = millis();
  while (millis() - lastData < HTTP_TIMEOUT_MS) {
    while (stream.available()) {
      const char c = static_cast<char>(stream.read());
      lastData = millis();
      if (!capturing) {
        if (c == '[') arrayDepth++;
        else if (c == ']') return true;
        else if (c == '{' && arrayDepth == 1) {
          capturing = true;
          objectDepth = 1;
          object = "{";
        }
        continue;
      }
      object += c;
      if (object.length() > maximumObjectBytes) return false;
      if (inString) {
        if (escaped) escaped = false;
        else if (c == '\\') escaped = true;
        else if (c == '"') inString = false;
        continue;
      }
      if (c == '"') inString = true;
      else if (c == '{') objectDepth++;
      else if (c == '}' && --objectDepth == 0) {
        capturing = false;
        if (!consumer(object)) return false;
        object = "";
      }
    }
    delay(1);
  }
  return false;
}

bool withHaArrayStream(const String &path, const std::function<bool(Stream &)> &consumer, int &httpCode) {
  WiFiClient localClient;
  HTTPClient http;
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(localClient, cfg.haUrl + path)) return false;
  http.addHeader("Authorization", "Bearer " + cfg.haToken);
  http.addHeader("Content-Type", "application/json");
  httpCode = http.GET();
  bool ok = httpCode == 200 && consumer(http.getStream());
  http.end();
  return ok;
}

void syncEntities(const String &jobId) {
  String failure;
  int failureCode = 0;
  if (!syncMarker("/api/bridge/sync/entities/start", jobId, -1, failure, failureCode)) {
    sendResult(jobId, false, failure, failureCode > 0 ? failureCode : 0); return;
  }
  int count = 0, httpCode = 0;
  std::vector<String> chunk;
  bool ok = withHaArrayStream("/api/states", [&](Stream &stream) {
    return streamTopLevelObjects(stream, [&](const String &source) {
      JsonDocument input;
      if (deserializeJson(input, source)) return true;
      String entityId = input["entity_id"] | "";
      if (entityId.isEmpty() || entityId.indexOf('.') < 1) return true;
      JsonDocument output;
      output["entity_id"] = entityId;
      output["domain"] = entityId.substring(0, entityId.indexOf('.'));
      output["state"] = input["state"] | "unknown";
      output["friendly_name"] = input["attributes"]["friendly_name"] | entityId;
      if (!input["attributes"]["icon"].isNull()) output["icon"] = input["attributes"]["icon"];
      String encoded;
      serializeJson(output, encoded);
      chunk.push_back(encoded);
      count++;
      if (chunk.size() >= 12) {
        if (!sendChunk("/api/bridge/sync/entities/chunk", jobId, chunk, failure, failureCode)) return false;
        chunk.clear();
      }
      return true;
    }, 65536);
  }, httpCode);
  if (ok && !chunk.empty()) ok = sendChunk("/api/bridge/sync/entities/chunk", jobId, chunk, failure, failureCode);
  if (!ok) {
    sendResult(jobId, false, failure.isEmpty() ? "Fallo leyendo entidades de Home Assistant" : failure,
               failure.isEmpty() ? httpCode : (failureCode > 0 ? failureCode : 0));
    return;
  }
  if (!syncMarker("/api/bridge/sync/entities/complete", jobId, count, failure, failureCode)) {
    sendResult(jobId, false, failure, failureCode > 0 ? failureCode : 0); return;
  }
  drawStatus("ENTIDADES OK", 0x07E0);
}

void syncServices(const String &jobId) {
  String failure;
  int failureCode = 0;
  if (!syncMarker("/api/bridge/sync/services/start", jobId, -1, failure, failureCode)) {
    sendResult(jobId, false, failure, failureCode > 0 ? failureCode : 0); return;
  }
  int count = 0, httpCode = 0;
  std::vector<String> chunk;
  bool ok = withHaArrayStream("/api/services", [&](Stream &stream) {
    return streamTopLevelObjects(stream, [&](const String &source) {
      JsonDocument input;
      if (deserializeJson(input, source)) return false;
      const String domain = input["domain"] | "";
      JsonObject services = input["services"].as<JsonObject>();
      for (JsonPair pair : services) {
        JsonObject definition = pair.value().as<JsonObject>();
        JsonDocument output;
        output["domain"] = domain;
        output["service"] = pair.key().c_str();
        output["name"] = definition["name"] | pair.key().c_str();
        output["description"] = definition["description"] | "";
        if (definition["fields"].isNull()) output["fields"].to<JsonObject>();
        else output["fields"].set(definition["fields"]);
        String encoded;
        serializeJson(output, encoded);
        chunk.push_back(encoded);
        count++;
        if (chunk.size() >= 8) {
          if (!sendChunk("/api/bridge/sync/services/chunk", jobId, chunk, failure, failureCode)) return false;
          chunk.clear();
        }
      }
      return true;
    }, 196608);
  }, httpCode);
  if (ok && !chunk.empty()) ok = sendChunk("/api/bridge/sync/services/chunk", jobId, chunk, failure, failureCode);
  if (!ok) {
    sendResult(jobId, false, failure.isEmpty() ? "Fallo leyendo acciones de Home Assistant" : failure,
               failure.isEmpty() ? httpCode : (failureCode > 0 ? failureCode : 0));
    return;
  }
  if (!syncMarker("/api/bridge/sync/services/complete", jobId, count, failure, failureCode)) {
    sendResult(jobId, false, failure, failureCode > 0 ? failureCode : 0); return;
  }
  drawStatus("ACCIONES OK", 0x07E0);
}

void executeJob(JsonObject job) {
  const String jobId = job["id"] | "";
  const String type = job["type"] | "";
  JsonObject payload = job["payload"].as<JsonObject>();
  drawStatus("EJECUTANDO", 0xFFE0);
  if (type == "test_home_assistant") {
    String response;
    int code = 0;
    const bool ok = homeAssistantRequest("GET", "/api/", "", response, code);
    haOk = ok;
    sendResult(jobId, ok, ok ? "API running." : "Home Assistant no responde", code);
  } else if (type == "get_entity_state") {
    const String entityId = payload["entity_id"] | "";
    const String state = stateOf(entityId);
    sendResult(jobId, !state.isEmpty(), state.isEmpty() ? "No se pudo consultar la entidad" : "Estado consultado", state.isEmpty() ? 0 : 200, state);
  } else if (type == "call_service") {
    const String domain = payload["domain"] | "";
    const String service = payload["service"] | "";
    const String entityId = payload["entity_id"] | "";
    const String previous = stateOf(entityId);
    JsonDocument request;
    request["entity_id"] = entityId;
    JsonObject serviceData = payload["service_data"].as<JsonObject>();
    for (JsonPair pair : serviceData) {
      if (strcmp(pair.key().c_str(), "entity_id") != 0) request[pair.key()] = pair.value();
    }
    String requestBody, response;
    serializeJson(request, requestBody);
    int code = 0;
    const bool ok = homeAssistantRequest("POST", "/api/services/" + domain + "/" + service, requestBody, response, code);
    const String current = ok ? stateOf(entityId) : "";
    haOk = ok;
    sendResult(jobId, ok, ok ? "OK" : response.substring(0, 700), code, current, previous);
  } else if (type == "sync_entities") {
    syncEntities(jobId);
  } else if (type == "sync_services") {
    syncServices(jobId);
  } else {
    sendResult(jobId, false, "Tipo de trabajo desconocido");
  }
  drawStatus(haOk ? "LISTO" : "EN LINEA", 0x07E0);
}

void pollWorker() {
  JsonDocument heartbeat;
  heartbeat["firmware"] = FIRMWARE_VERSION;
  heartbeat["ip"] = WiFi.localIP().toString();
  heartbeat["rssi"] = WiFi.RSSI();
  heartbeat["ha_ok"] = haOk;
  String body, response;
  serializeJson(heartbeat, body);
  int code = 0;
  if (!workerPost("/api/bridge/next", body, response, code)) {
    drawStatus("CLOUD ERROR", 0xF800);
    return;
  }
  JsonDocument document;
  if (deserializeJson(document, response)) {
    drawStatus("JSON ERROR", 0xF800);
    return;
  }
  if (!document["job"].isNull()) executeJob(document["job"].as<JsonObject>());
  else drawStatus(haOk ? "LISTO" : "EN LINEA", 0x07E0);
}

void setup() {
  Serial.begin(115200);
  pinMode(LCD_BL, OUTPUT);
  digitalWrite(LCD_BL, HIGH);
  pinMode(SETUP_BUTTON, INPUT_PULLUP);
  gfx->begin(40000000);
  gfx->setRotation(0);
  drawStatus("INICIANDO", 0xFFFF);
  workerClient.setCACert(GLOBALSIGN_ROOT_CA);
  const bool configured = loadConfig();
  delay(100);
  if (!configured || digitalRead(SETUP_BUTTON) == LOW) {
    startPortal();
    return;
  }
  if (!connectWiFi()) {
    startPortal("No se pudo conectar al Wi-Fi. Revisa las credenciales.");
    return;
  }
  drawStatus("EN LINEA", 0x07E0);
  nextPollAt = millis();
}

void loop() {
  if (portalMode) {
    dns.processNextRequest();
    portal.handleClient();
    delay(2);
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    drawStatus("SIN WIFI", 0xF800);
    WiFi.reconnect();
    delay(250);
    return;
  }
  const uint32_t now = millis();
  if (static_cast<int32_t>(now - nextPollAt) >= 0) {
    nextPollAt += POLL_INTERVAL_MS;
    pollWorker();
    if (static_cast<int32_t>(millis() - nextPollAt) >= 0) nextPollAt = millis() + POLL_INTERVAL_MS;
  }
  delay(2);
}
