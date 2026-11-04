# Despliegue de producción

El backend se despliega manualmente desde el VPS con `scripts/deploy-production.sh`.

## Flujo protegido

El script crea y valida un backup PostgreSQL en formato custom antes de actualizar Git. Conserva 14 días de backups en `/var/backups/foodie/postgres`. Si falla la actualización de Git, instalación, generación de Prisma, build o migración, PM2 no se recarga.

Tras una recarga, el script exige que `GET /v1/health` responda correctamente. Ante un fallo muestra el commit y backup necesarios para usar el rollback manual. El endpoint verifica Nest y una consulta mínima a PostgreSQL sin devolver información sensible.

Para ejecutar el mismo flujo manualmente en el servidor:

```bash
cd /var/www/apps/foodie/foodie-backend
bash scripts/deploy-production.sh
```

No usar `prisma migrate dev` en producción. Las migraciones productivas se aplican con `npm run prisma:deploy`.

## Recuperar el fallo de `20261104_deposits_module`

Si el despliegue falló con P3018 / PostgreSQL 42701 porque
`DepositProof.rejectionReason` ya existe, actualizar primero el código con la
corrección. Esta conserva las columnas existentes, admite los primeros ALTER
dejados por el intento anterior y ejecuta el resto de la migración en una
transacción. No elimina ni renumera comprobantes o movimientos.

Para ese fallo concreto, ejecutar desde el checkout del backend en el VPS:

```bash
git pull --ff-only origin main &&
npx prisma migrate resolve --rolled-back 20261104_deposits_module --schema prisma/schema.prisma &&
bash scripts/deploy-production.sh
```

`--rolled-back` marca el intento fallido como reintentable; no revierte datos.
El script de despliegue crea otro backup y vuelve a aplicar la migración
corregida antes de recargar PM2. No usar `--applied`: faltan tablas e índices
cuando ocurre este error. Si aparece un error distinto, revisar su causa antes
de marcar cualquier migración.

Prueba de regresión aislada (requiere Docker, no usa `DATABASE_URL` ni publica
puertos): `node test/deposits-migration.integration.cjs`. Cubre instalación
sobre el esquema previo, columna heredada, reintento tras el fallo original,
conservación de registros y rollback ante un error posterior.

## Backups y rollback

El servidor necesita `pg_dump`, `pg_restore` y espacio de disco para los dumps. En Ubuntu/Debian se instalan con `apt install postgresql-client`.

Crear el directorio una vez y asignarlo al usuario que ejecuta el deploy:

```bash
install -d -m 700 /var/backups/foodie/postgres
```

Rollback solo de código:

```bash
bash scripts/rollback-production.sh <commit>
```

Rollback de código y base de datos, durante una ventana controlada:

```bash
bash scripts/rollback-production.sh <commit> --restore-db /var/backups/foodie/postgres/<backup>.dump --confirm
```

La restauración de base detiene PM2, realiza un backup adicional del estado actual y requiere confirmación explícita. No se ejecuta automáticamente.
