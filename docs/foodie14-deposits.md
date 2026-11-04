# FOODIE-14 — Señas y pagos

## Activación y flujo

El módulo `deposits` está apagado por defecto. El administrador general lo
habilita por restaurante en **Módulos**. Desactivarlo oculta Señas y los controles
del chat, bloquea APIs y conserva todos los datos. No modifica los módulos
heredados de PupuIA ni las Gift Cards.

El dueño configura **Señas → Reglas y transferencia** y marca la configuración
como revisada. Las reglas admiten monto fijo o por persona, tramos y excepciones
por evento. No se permite superponer tramos del mismo evento. Si una regla de
evento coincide, tiene prioridad sobre la general. Configuraciones sin revisar
no permiten crear reservas mientras el módulo esté habilitado: evita omitir una
seña por una configuración incompleta.

Se relevó el workflow actual de Estilo Campo: declara seña para reservas normales
de 15 a 20 personas, pero prohíbe inventar importe, cuenta, plazo o devoluciones.
No se cargaron valores supuestos ni se aprobaron reglas automáticamente. El dueño
debe revisar los valores oficiales y guardarlos. Los cambios incrementan la
versión del contexto del asistente para que n8n no conserve reglas antiguas.

Cada solicitud guarda importe, moneda, datos bancarios y plazo como una copia de
las condiciones originales. Las reservas comunes, eventos y reservas web a las
que aplica una regla nacen pendientes, con su asignación retenida. La web pública
informa ese estado y las instrucciones; no afirma que estén confirmadas.

El panel general y el apartado desplegable del chat usan los mismos servicios.
Dueño, gerente y caja pueden ver comprobantes, registrar pagos o devoluciones,
rechazar con motivo y confirmar reservas. Otros roles no reciben información
financiera, ni siquiera por las notificaciones. El teléfono se normaliza en ambos
lados y siempre se limita al restaurante autenticado; nunca autoriza el clientId
de PupuIA. Con varias reservas se exige un código antes de asociar un adjunto.

Un comprobante recibido no acredita dinero. Aprobarlo registra el importe real,
fecha, referencia y responsable. Los pagos parciales y tardíos son manuales;
vencer el plazo no cancela ni libera cupo. Las devoluciones se realizan fuera de
Foodie y se registran con referencia y motivo, sin superar el saldo acreditado.
Las transacciones y claves de operación evitan acreditaciones duplicadas.

**Confirmar reserva** es una acción separada que vuelve a comprobar disponibilidad
y conserva mesas/salones/turno. Solo entonces se genera el evento de confirmación.
El controlador intenta despacharlo y conserva el estado de envío para reintentar.
No se permite sentar una reserva pendiente con seña saltándose este paso.

## Archivos, Drive y demo

Se aceptan PDF, JPG, PNG y WEBP de hasta 10 MB, verificando también contenido y
tamaño. Las cargas externas requieren autorización previa de la API y una
comprobación del objeto recibido. Una clave adicional deduplica mensajes nuevos
sin eliminar ni modificar comprobantes históricos repetidos.

En restaurantes reales los originales permanecen privados en R2. La vista del
comprobante usa el token de Foodie; nunca se publica el bucket. La copia a Drive
no bloquea la revisión: las fallas quedan registradas y pueden reintentarse.
Se reserva y persiste un ID de Google antes de subir, para recuperar operaciones
interrumpidas sin crear un segundo archivo.

Cada dueño conecta su cuenta Google por OAuth. La autorización usa un estado
aleatorio de un solo uso, vencimiento y dueño vigente; los refresh tokens se
guardan cifrados. La cuenta puede seleccionar una carpeta de escritura o crear
Foodie/Comprobantes y Foodie/Archivos generales. Reconectar preserva las referencias.
La autorización revocada se informa como `reconnect_required`. Solo el dueño
conecta y configura carpetas; los roles financieros consultan sus archivos.

La demo guarda sus comprobantes únicamente bajo `private/demo-proofs` (ignorado
por Git y fuera de los archivos públicos). Usa Drive y envíos simulados. Si se
habilita este módulo, `/chat` muestra un chat interno por teléfono sin montar
componentes ni conexiones de PupuIA. Es posible probar la misma revisión allí y
en la bandeja. No conectar n8n ni Google reales a una cuenta demo.

## Despliegue y variables

1. Publicar el backend y aplicar `20261104_deposits_module` con
   `npm run prisma:deploy`, generar Prisma y reiniciar según el despliegue habitual.
   La migración es aditiva y conserva pagos y archivos históricos. Los comprobantes
   ya asociados a movimientos se migran como aprobados.
2. Publicar el frontend. Dejar el módulo deshabilitado en los restaurantes reales.
3. Habilitarlo en la cuenta demo elegida y configurar datos ficticios.
4. Para integrar un restaurante real, configurar los secretos siguientes en el
   servidor, revisar sus reglas y completar la validación antes de habilitarlo.
5. Revisar y publicar los borradores de n8n por separado. Esta implementación
   guardó borradores con `publishIfActive=false`; no solicitó activación.

Variables del backend:

- Las variables R2 existentes: `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`.
- `CHAT_CREDENTIAL_SECRET`: clave estable para cifrar tokens; requerida para OAuth.
- `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`.
- `GOOGLE_DRIVE_REDIRECT_URI`: URL registrada en Google, con la ruta
  `/v1/external/deposits/drive/callback` del backend público.
- `N8N_DEPOSIT_CONFIRMATION_WEBHOOK_URL`: webhook
  `/webhook/foodie-deposit-confirmation-v1` del workflow Realtime, una vez publicado.
- `N8N_WEBHOOK_TOKEN`: secreto compartido con n8n. El workflow debe permitir su
  lectura por expresiones `$env`; si la política del servidor lo bloquea,
  configurar autenticación equivalente mediante una credencial Header Auth antes
  de publicar. No retirar la verificación del secreto.

La aplicación OAuth solicita acceso Drive para consultar las carpetas existentes
y administrar las elegidas. Configurar consentimiento y usuarios de prueba en
Google Cloud antes de validar el flujo. No se incluyeron secretos en código.

Referencias oficiales utilizadas:
[OAuth web server](https://developers.google.com/identity/protocols/oauth2/web-server),
[crear archivos](https://developers.google.com/workspace/drive/api/guides/create-file),
[carga multipart](https://developers.google.com/workspace/drive/api/guides/manage-uploads).

## API e integraciones

Las rutas internas están bajo `/v1/restaurant/deposits`: `settings`, `events`,
`contact-reservations`, `reservation-options`, bandeja y revisión de comprobantes,
`/:id/entries`, `/:id/proof-requests`, `/:id/upload`, `/:id/confirm-reservation`,
`/:id/send-confirmation`, `/:id/delivery` y `/:id/resolve-delivery`.
Crear o actualizar una seña manual usa
`PUT /v1/restaurant/reservations/:reservationId/deposit`.

Las rutas de Drive están bajo `/restaurant/deposits/drive` y las de un comprobante
bajo `/restaurant/deposits/proofs/:proofId`: descarga, rechazo y sincronización.

Las rutas externas bajo `/v1/external/deposits` requieren API key del restaurante:
`config`, `request`, `proof-request`, autorización y confirmación de cargas,
`delivery/claim` y `delivery/finish`. La validación de recordatorios existente
conserva su disponibilidad cuando el nuevo módulo está apagado.

El despacho reclama un evento una sola vez y obtiene teléfono y canal desde
Foodie. No usa un destinatario arbitrario enviado al webhook. Los envíos fallidos
con resultado incierto quedan `unknown`: el operador debe verificar en n8n y
registrar una referencia antes de reintentarlos. Los envíos confirmados son
idempotentes. El bloqueo de despacho y la auditoría se guardan en PostgreSQL.

Se prepararon y verificaron estos borradores, conservando `_mcp` y los snapshots:

- `foodie14-ai-core.json`, workflow `YbT20rx3AL3sJpq5`: herramientas de consulta
  de configuración y solicitud de comprobante; no confirmar reservas pendientes.
- `foodie14-realtime.json`, workflow `HES7HUWChBQppy2U`: recepción privada de
  comprobantes, selección por código y webhook autenticado de confirmación.

Están en el directorio `workflows` del MCP de n8n. El script
`scripts/prepare-foodie14-n8n.py` documenta los cambios y puede aplicarse a un pull
fresco; nunca modifica `_mcp` ni publica. No versionar los JSON completos con
credenciales del workflow en este repositorio.

## Validación

- `npm run test:deposits`: reglas, estado inicial y validación de archivos.
- Regresión: `node --test test/restaurant-features.test.js test/restaurant-configuration.test.js test/multi-gift-cards.test.js` tras compilar.
- Frontend: `npm run test:restaurant-features` y `npm run build`.
- `test/deposits.integration.cjs` exige PostgreSQL descartable en
  `127.0.0.1:5438/foodie14_check` mediante `FOODIE14_TEST_DATABASE_URL`. Cubre
  permisos, aislamiento, comprobantes, concurrencia, pagos parciales y tardíos,
  rechazo/reenvío, cupo y confirmación manual, devoluciones, notificaciones,
  desactivación, OAuth, cifrado, reconexión, revocación y reintento de cargas Drive.
  Los HTTP de Google se simulan: esta prueba no valida credenciales reales.
- Validar los archivos de n8n con `n8n_validate_workflow_file` antes de guardar el
  borrador; los dos pasaron sin errores ni advertencias estructurales.

FOODIE-14 debe permanecer en **Testing** hasta probar Google OAuth, R2 y WhatsApp
reales en un restaurante de prueba apropiado y completar la publicación
controlada de sus workflows. Las pruebas internas y los builds no sustituyen
esa validación externa.
