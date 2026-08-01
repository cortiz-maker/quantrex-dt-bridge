# Quantrex-Abbott — Puente DispatchTrack

Servicio Express que conecta la app Quantrex-Abbott (React/Supabase)
con DispatchTrack. Mismo patrón que `cortiz-maker/aquatrisq`.

- `POST /api/dispatches` — crea un despacho en DispatchTrack (botón manual "Enviar a DispatchTrack").
- `GET /api/track/:identifier` — consulta el estado de un despacho (reemplaza el widget de copiar/pegar).
- `GET /health` — chequeo de estado.

## Despliegue en Railway

1. Crea un repo nuevo en GitHub (ej. `quantrex-dt-bridge`) y sube estos 3 archivos.
2. En Railway: **New Project → Deploy from GitHub repo → quantrex-dt-bridge**.
3. **Settings → Networking → Generate Domain**. Quedará algo como `quantrex-dt-bridge-production.up.railway.app`.
4. En **Variables**, carga:
   - `DISPATCHTRACK_API_KEY`
   - `DT_API_URL` (ej. `https://quantrex.dispatchtrack.com/api/external/v1`)
   - `SUPABASE_URL` → `https://euvwfbnbmefqpakbbzni.supabase.co`
   - `SUPABASE_SERVICE_KEY` (service_role key del proyecto Quantrex-Abbott — **nunca** la pongas en el frontend)
   - `PUENTE_TOKEN` (inventa un token cualquiera, ej. una cadena larga random)
   - `DT_PICKUP_NAME` (opcional, por defecto "Bodega DHL Atlantis")
5. Verifica abriendo `https://TU-DOMINIO.up.railway.app/health` — debe decir todo "configurado"/"conectado".
6. Corre `alter_solicitudes.sql` en el SQL Editor de Supabase (agrega `dt_dispatch_id` y `dt_enviado_en`).
7. En la app Quantrex, define `BRIDGE_URL` con el dominio del paso 3, y `PUENTE_TOKEN` con el valor del paso 4.

## Pendiente / a verificar

El endpoint de creación (`POST {DT_API_URL}/dispatches`) sigue el mismo
contrato que usa Aquatrisq en producción, así que es de alta confianza.

El endpoint de consulta (`GET /api/track/:identifier`) **no está verificado**
contra la documentación de la cuenta Quantrex — se implementó por
convención razonable, pero pruébalo primero con un número real antes
de confiar en él para uso diario. Si no devuelve resultados, revisa la
documentación del API en el panel de DispatchTrack (sección "Llaves API"
o similar) para confirmar el nombre exacto del endpoint de búsqueda.
