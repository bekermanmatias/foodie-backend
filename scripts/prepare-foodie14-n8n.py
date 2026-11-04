"""Prepare pulled workflow envelopes in place. Never modifies _mcp or publishes.
Usage: python scripts/prepare-foodie14-n8n.py <directory containing the two pulled files>
"""
import copy
import json
import sys
import uuid
from pathlib import Path

directory = Path(sys.argv[1])
base = "https://resto.pupuia.com/v1"

def load(name):
    path = directory / name
    envelope = json.loads(path.read_text(encoding="utf-8-sig"))
    return path, envelope, copy.deepcopy(envelope["_mcp"])

def save(path, envelope, before):
    assert envelope["_mcp"] == before, "Never modify MCP metadata"
    path.write_text(json.dumps(envelope, ensure_ascii=False, indent=2), encoding="utf-8")

path, envelope, before = load("foodie14-ai-core.json")
w = envelope["workflow"]
template = next(n for n in w["nodes"] if n["name"] == "foodie_buscar_reserva_por_codigo")
if not any(n["name"] == "foodie_sena_solicitar_comprobante" for n in w["nodes"]):
    for name, suffix, description, queries in [
        ("foodie_sena_configuracion", "/external/deposits/config", "Consulta las reglas de seña del restaurante en Foodie. Usar solamente si el contexto actual features.deposits=true. Nunca inventar importe, plazo o datos bancarios. Si reviewed=false, derivar al equipo.", []),
        ("foodie_sena_solicitar_comprobante", "/external/deposits/request", "Después de crear una reserva con status=pending y deposit, registra la solicitud de comprobante y devuelve instrucciones de transferencia reales y plazo. La reserva conserva cupo y requiere revisión humana. NO afirmar que quedó confirmada.", [])
    ]:
        node = copy.deepcopy(template); node["id"] = str(uuid.uuid4()); node["name"] = name
        node["position"] = [template["position"][0] + 640, template["position"][1] + (0 if "configuracion" in name else 240)]
        p = node["parameters"]; p.update({"url": base + suffix, "toolDescription": description, "sendQuery": False})
        p.pop("queryParameters", None)
        if "solicitar" in name:
            p.update({"method": "POST", "sendBody": True, "specifyBody": "json", "jsonBody": "={{ { reservationCode: $fromAI('reservationCode', 'Código real devuelto por Foodie para esta reserva.', 'string'), phone: $('Entrada Core').first().json.phone } }}"})
        w["nodes"].append(node)
        w["connections"][name] = copy.deepcopy(w["connections"][template["name"]])
    creation = next(n for n in w["nodes"] if n["name"] == "foodie_crear_reserva")
    creation["parameters"]["toolDescription"] += " FOODIE-14: Si Foodie devuelve status=pending y deposit, informar reserva pendiente con cupo retenido, ejecutar foodie_sena_solicitar_comprobante y comunicar SOLO sus instrucciones. La recepción del comprobante y la acreditación no confirman la reserva. Si features.deposits=false, mantener el comportamiento anterior."
save(path, envelope, before)

path, envelope, before = load("foodie14-realtime.json")
w = envelope["workflow"]
if not any(n["name"] == "FOODIE14 Consultar solicitud" for n in w["nodes"]):
    source = next(n for n in w["nodes"] if n["name"] == "Obtener instrucciones de pago")
    auth = {k: copy.deepcopy(v) for k, v in source["parameters"].items() if k in ["authentication", "genericAuthType", "nodeCredentialType", "sendHeaders", "headerParameters"]}
    def node(name, kind, params, x, y, extra=None):
        value = {"id": str(uuid.uuid4()), "name": name, "type": kind, "typeVersion": 4.2 if kind.endswith("httpRequest") else 2, "position": [x, y], "parameters": params}
        if extra: value.update(extra)
        w["nodes"].append(value)
        return name
    def link(start, end, output=0):
        outputs = w["connections"].setdefault(start, {}).setdefault("main", [])
        while len(outputs) <= output: outputs.append([])
        outputs[output].append({"node": end, "type": "main", "index": 0})
    def http(name, suffix, method="GET", body=None, query=None, response=False):
        params = {**copy.deepcopy(auth), "url": base + suffix, "method": method, "options": {"timeout": 120000}}
        if body is not None: params.update({"sendBody": True, "specifyBody": "json", "jsonBody": body})
        if query: params.update({"sendQuery": True, "queryParameters": {"parameters": query}})
        if response: params["options"]["response"] = {"response": {"fullResponse": True, "neverError": True}}
        return node(name, "n8n-nodes-base.httpRequest", params, 22000, 17000 + len(w["nodes"]) * 20, {"credentials": copy.deepcopy(source.get("credentials", {}))})
    def condition(name, expression):
        return node(name, "n8n-nodes-base.if", {"conditions": {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2}, "conditions": [{"id": str(uuid.uuid4()), "leftValue": expression, "rightValue": True, "operator": {"type": "boolean", "operation": "true", "singleValue": True}}], "combinator": "and"}, "options": {}}, 22400, 17000 + len(w["nodes"]) * 20)
    query = http("FOODIE14 Consultar solicitud", "/external/deposits/proof-request", query=[{"name": "phone", "value": "={{ $('Preparar comprobante para Drive').first().json.phoneNumber }}"}, {"name": "reservationCode", "value": "={{ $('Preparar comprobante para Drive').first().json.reservationCode || '' }}"}], response=True)
    gate = condition("FOODIE14 Modulo habilitado", "={{ $json.statusCode === 200 }}")
    active = condition("FOODIE14 Solicitud sin ambiguedad", "={{ $json.body.active === true }}")
    legacy = condition("FOODIE14 Comprobante Gift Card heredado", "={{ /gift.?card/i.test(String($('Preparar comprobante para Drive').first().json.paymentType || '')) }}")
    prepare = node("FOODIE14 Preparar comprobante", "n8n-nodes-base.code", {"jsCode": "const source = $('Preparar comprobante para Drive').first(); const buffer = await this.helpers.getBinaryDataBuffer(0, 'data'); return [{ json: { ...source.json, requestId: $('FOODIE14 Consultar solicitud').first().json.body.requestId, size: buffer.length }, binary: source.binary }];"}, 22800, 18000)
    upload = http("FOODIE14 Autorizar carga", "/external/deposits/proof-requests/{{$json.requestId}}/upload-url", "POST", "={{ { fileName: $json.fileName, mimeType: $json.mimeType, size: $json.size } }}")
    # n8n expressions in URLs must carry the '=' expression prefix.
    next(n for n in w["nodes"] if n["name"] == upload)["parameters"]["url"] = "={{ '" + base + "/external/deposits/proof-requests/' + $json.requestId + '/upload-url' }}"
    binary = node("FOODIE14 Restaurar binario", "n8n-nodes-base.code", {"jsCode": "const source = $('Preparar comprobante para Drive').first(); return [{json: $input.first().json, binary: source.binary}];"}, 23000, 18000)
    put = node("FOODIE14 Guardar privado", "n8n-nodes-base.httpRequest", {"method": "PUT", "url": "={{ $json.uploadUrl }}", "sendBody": True, "contentType": "binaryData", "inputDataFieldName": "data", "sendHeaders": True, "headerParameters": {"parameters": [{"name": "Content-Type", "value": "={{ $('FOODIE14 Preparar comprobante').first().json.mimeType }}"}]}, "options": {"timeout": 120000}}, 23200, 18000)
    confirm = http("FOODIE14 Recibido para revision", "/external/deposits/proof-requests/unused/confirm-upload", "POST", "={{ { ...$('FOODIE14 Preparar comprobante').first().json, objectKey: $('FOODIE14 Autorizar carga').first().json.objectKey, caption: $('FOODIE14 Preparar comprobante').first().json.content || '' } }}")
    next(n for n in w["nodes"] if n["name"] == confirm)["parameters"]["url"] = "={{ '" + base + "/external/deposits/proof-requests/' + $('FOODIE14 Preparar comprobante').first().json.requestId + '/confirm-upload' }}"
    reply_source = next(n for n in w["nodes"] if n["name"] == "Enviar WhatsApp - Audio recibido")
    reply = copy.deepcopy(reply_source); reply["id"] = str(uuid.uuid4()); reply["name"] = "FOODIE14 Pedir codigo de reserva"; reply["parameters"]["textBody"] = "Para asociar este comprobante a la reserva correcta, escribinos su código. El comprobante no confirma el pago ni la reserva."; w["nodes"].append(reply)
    w["connections"]["Preparar comprobante para Drive"] = {"main": [[{"node": query, "type": "main", "index": 0}]]}
    restore = node("FOODIE14 Recuperar archivo original", "n8n-nodes-base.code", {"jsCode": "const source = $('Preparar comprobante para Drive').first(); return [{json: source.json, binary: source.binary}];"}, 22600, 18000)
    fallback = node("FOODIE14 Restaurar flujo heredado", "n8n-nodes-base.code", {"jsCode": "const result = $('FOODIE14 Consultar solicitud').first().json; if (![200,403,404].includes(result.statusCode)) throw new Error('FOODIE14_UNAVAILABLE: comprobante conservado en PupuIA, reintentar asociación'); const source = $('Preparar comprobante para Drive').first(); return [{json: source.json, binary: source.binary}];"}, 22600, 18500)
    link(query, gate); link(gate, active); link(gate, fallback, 1)
    link(active, restore); link(restore, prepare); link(active, legacy, 1); link(legacy, fallback); link(fallback, "Guardar en Drive - Comprobantes"); link(legacy, reply["name"], 1)
    link(prepare, upload); link(upload, binary); link(binary, put); link(put, confirm)
# Confirmation dispatch is a separate authenticated webhook branch. Disabled until the draft is published.
if not any(n["name"] == "FOODIE14 Webhook confirmacion" for n in w["nodes"]):
    source = next(n for n in w["nodes"] if n["name"] == "Obtener instrucciones de pago")
    headers = {k: copy.deepcopy(v) for k, v in source["parameters"].items() if k in ["authentication", "genericAuthType", "nodeCredentialType", "sendHeaders", "headerParameters"]}
    def add(name, kind, params, extra=None):
        n = {"id": str(uuid.uuid4()), "name": name, "type": kind, "typeVersion": 4.2 if kind.endswith("httpRequest") else 2 if kind.endswith("if") else 1, "position": [24000, 22000 + len(w["nodes"]) * 20], "parameters": params}
        if extra: n.update(extra)
        w["nodes"].append(n)
        return name
    def connect(a, b, output=0):
        outputs = w["connections"].setdefault(a, {}).setdefault("main", [])
        while len(outputs) <= output: outputs.append([])
        outputs[output].append({"node": b, "type": "main", "index": 0})
    webhook = add("FOODIE14 Webhook confirmacion", "n8n-nodes-base.webhook", {"httpMethod": "POST", "path": "foodie-deposit-confirmation-v1", "responseMode": "responseNode", "options": {}}, {"webhookId": str(uuid.uuid4())})
    def check(name, expression):
        return add(name, "n8n-nodes-base.if", {"conditions": {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2}, "conditions": [{"id": str(uuid.uuid4()), "leftValue": expression, "rightValue": True, "operator": {"type": "boolean", "operation": "true", "singleValue": True}}], "combinator": "and"}, "options": {}})
    guard = check("FOODIE14 Verificar secreto", "={{ Boolean($env.N8N_WEBHOOK_TOKEN) && $json.headers['x-n8n-token'] === $env.N8N_WEBHOOK_TOKEN }}")
    reject = add("FOODIE14 Sin autorizacion", "n8n-nodes-base.respondToWebhook", {"respondWith": "json", "responseBody": '{"sent":false,"retrySafe":true}', "options": {"responseCode": 401}})
    claim = add("FOODIE14 Tomar envio", "n8n-nodes-base.httpRequest", {**copy.deepcopy(headers), "method": "POST", "url": base + "/external/deposits/delivery/claim", "sendBody": True, "specifyBody": "json", "jsonBody": "={{ { eventId: $('FOODIE14 Webhook confirmacion').first().json.body.eventId } }}", "options": {}}, {"credentials": copy.deepcopy(source.get("credentials", {}))})
    sent = check("FOODIE14 Ya enviado", "={{ $json.alreadySent === true }}")
    sender = copy.deepcopy(next(n for n in w["nodes"] if n["name"] == "Enviar WhatsApp - Audio recibido"))
    sender["name"] = "FOODIE14 Enviar confirmacion"; sender["id"] = str(uuid.uuid4()); sender["parameters"].update({"phoneNumberId": "={{ $json.channelId }}", "recipientPhoneNumber": "={{ $json.phone }}", "textBody": "={{ $json.message }}"}); w["nodes"].append(sender)
    finish = add("FOODIE14 Registrar envio", "n8n-nodes-base.httpRequest", {**copy.deepcopy(headers), "method": "POST", "url": base + "/external/deposits/delivery/finish", "sendBody": True, "specifyBody": "json", "jsonBody": "={{ { eventId: $('FOODIE14 Tomar envio').first().json.eventId, messageId: $json.messages[0].id } }}", "options": {}}, {"credentials": copy.deepcopy(source.get("credentials", {}))})
    respond = add("FOODIE14 Confirmacion enviada", "n8n-nodes-base.respondToWebhook", {"respondWith": "json", "responseBody": '{"sent":true}', "options": {}})
    connect(webhook, guard); connect(guard, claim); connect(guard, reject, 1); connect(claim, sent); connect(sent, respond); connect(sent, sender["name"], 1); connect(sender["name"], finish); connect(finish, respond)
save(path, envelope, before)
print("Prepared FOODIE-14 drafts; MCP metadata unchanged. No workflows were published.")
