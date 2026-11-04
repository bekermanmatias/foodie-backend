# Módulos por restaurante y cuenta demo

El admin general incluye **Módulos** en cada restaurante. Solo `platform_admin`
puede guardar opciones. La pantalla muestra módulos y funciones en prueba del
catálogo del backend. Actualmente ofrece Gift Cards y Notificaciones; no hay
funciones experimentales implementadas todavía.

## Publicación

1. Publicar primero este backend con la migración
   `20261104_restaurant_features`: ejecutar `npm run prisma:deploy` antes de
   iniciar la versión nueva. Luego generar el cliente Prisma y compilar, según
   el procedimiento de despliegue existente. Ambos campos agregados tienen
   valores iniciales compatibles: `isDemo=false`, `featureOverrides={}`.
2. Verificar `/restaurant/bootstrap` y los endpoints de administración de módulos.
3. Publicar el frontend. Mantiene compatibilidad con un bootstrap anterior, pero
   el menú de administración requiere los endpoints nuevos.
4. Crear un restaurante separado con datos ficticios y usuarios propios. No
   configurar chat ni conectar flujos de n8n a esta cuenta. En Módulos marcar
   **Cuenta demo**, habilitar las opciones deseadas y guardar.
5. Validar una función nueva allí y habilitarla después en los restaurantes
   elegidos. Recuperar el foco de la app actualiza el bootstrap y sus menús.

No se modificaron restaurantes reales ni se aplicó esta migración a producción.
El esquema de notificaciones se reconcilió con el modelo ya versionado en main.
La migración local antigua `20261010_notifications`, que no estaba versionada y
duplicaba la tabla de producción, se preservó en
`../tmp/legacy-local-migrations/20261010_notifications`, fuera del historial activo.
No incorporarla al despliegue. Los scripts locales antiguos de notificaciones
siguen siendo trabajo previo ajeno a esta funcionalidad.

## Contrato

- `GET /platform/restaurants/:restaurantId/features` devuelve
  `{ isDemo, overrides, enabled, catalog }`.
- `PATCH` acepta `{ isDemo?: boolean, overrides?: Record<string, boolean> }`.
  Solo admite claves del catálogo y actualiza exclusivamente las enviadas.
  Serializa modificaciones por restaurante y guarda la auditoría en la misma
  transacción. No borra datos al deshabilitar un módulo.
- El bootstrap agrega `isDemo` y `features`, con las opciones efectivas.
- `MODULE_DISABLED` devuelve HTTP 403 cuando el módulo no está habilitado.
- `DEMO_EXTERNAL_BLOCKED` devuelve HTTP 403 para envíos de Gift Cards,
  configuración de chat e integraciones por API key en cuentas demo.
- `DEMO_HAS_CONNECTIONS` devuelve HTTP 409 al intentar marcar como demo una
  cuenta que ya tiene conexiones de chat configuradas. Usar una cuenta separada.

La demo no inicia sesión en el chat externo. El frontend bloquea sus rutas de
chat y limpia la sesión local al cargar el bootstrap. Los servicios externos
independientes de Foodie no quedan controlados por estos interruptores: no
conectar automatizaciones externas a la cuenta demo. La configuración no revoca
sesiones emitidas anteriormente por un servicio de terceros.

## Agregar una función

Agregar la clave a `FEATURE_CATALOG` junto con su implementación. Al omitir
`defaultEnabled`, su valor inicial es **false**. Para una función en prueba usar
`group: "preview"` y `module` con la clave del módulo del que depende.

El backend debe consultar `restaurantFeatures(prisma, restaurantId).enabled`
antes de elegir entre comportamiento estable y nuevo. Para módulos completos,
`requireFeature` rechaza el acceso cuando están deshabilitados. No usar flags del
JWT ni del navegador como autorización. Resolver el restaurante desde el usuario,
el recurso autorizado o el token de integración, nunca desde un ID no verificado.

El frontend consume `bootstrap.features` para elegir el comportamiento; las
funciones nuevas deben usar un valor inicial false cuando la clave esté ausente.
La sección experimental vacía es intencional hasta que exista una implementación.

## Validación

- Backend: `npm run test:restaurant-features`.
- Frontend: `npm run test:restaurant-features` y `npm run build`.
- Regresión: `node --test test/restaurant-configuration.test.js test/multi-gift-cards.test.js`
  después de compilar el backend.
- Integración PostgreSQL: crear una base **vacía y descartable**
  `foodie_features_check` en `127.0.0.1:5437`, sincronizar allí el esquema con
  `prisma db push --skip-generate`, y ejecutar
  `node test/restaurant-features.integration.cjs` con
  `FOODIE_FEATURES_TEST_DATABASE_URL` apuntando exclusivamente a esa base.
  La prueba rechaza otro host/puerto/nombre, requiere una base sin restaurantes y
  comprueba la migración real, persistencia, concurrencia, aislamiento,
  conservación de productos, auditoría atómica y restricciones demo.
