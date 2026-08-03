// ============================================================
// QUANTREX-ABBOTT — Puente DispatchTrack
// Express en Railway. Mismo patrón que el puente de Aquatrisq
// (cortiz-maker/aquatrisq), adaptado al modelo de datos de
// Quantrex (solicitudes/OT en vez de pedidos/domicilios).
//
//   App Quantrex (React/Supabase) ──POST /api/dispatches──▶ DispatchTrack
//
// Variables de entorno (Railway → Variables):
//   DISPATCHTRACK_API_KEY   llave API de la cuenta Quantrex en DispatchTrack
//   DT_API_URL              ej: https://quantrex.dispatchtrack.com/api/external/v1
//   SUPABASE_URL            https://euvwfbnbmefqpakbbzni.supabase.co
//   SUPABASE_SERVICE_KEY    service_role key (SOLO aquí, nunca en el frontend)
//   PUENTE_TOKEN            token simple para que solo la app de Quantrex llame /api/dispatches
//   DT_PICKUP_NAME           nombre del punto de origen (por defecto "Bodega DHL Atlantis")
// ============================================================

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors());

const DT_API_URL = process.env.DT_API_URL || "";
const DT_API_KEY = process.env.DISPATCHTRACK_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const PUENTE_TOKEN = process.env.PUENTE_TOKEN || "";
const DT_PICKUP_NAME = process.env.DT_PICKUP_NAME || "Bodega DHL Atlantis";
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const PORT = process.env.PORT || 3000;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

// ── Healthcheck ──────────────────────────────────────────────
app.get("/health", (req, res) =>
  res.json({
    status: "ok",
    service: "quantrex-dt-bridge",
    dispatchtrack: DT_API_KEY && DT_API_URL ? "configurado" : "falta DISPATCHTRACK_API_KEY o DT_API_URL",
    supabase: supabase ? "conectado" : "falta SUPABASE_URL/SERVICE_KEY",
    google_maps: GOOGLE_MAPS_API_KEY ? "configurado" : "falta GOOGLE_MAPS_API_KEY",
  })
);

// ── GET /api/maps/snap-to-roads?path=lat,lng|lat,lng|... ──────────────────
// Reemplaza el proxy público api.allorigins.win (poco confiable — falla
// intermitente, issue documentado en su repo) por una llamada server-side
// directa a la Roads API de Google. La app solo manda los puntos crudos;
// la key de Google Maps vive acá, no en el bundle del frontend.
app.get("/api/maps/snap-to-roads", async (req, res) => {
  const { path } = req.query;
  if (!GOOGLE_MAPS_API_KEY) return res.status(500).json({ error: "Falta GOOGLE_MAPS_API_KEY en el servidor." });
  if (!path) return res.status(400).json({ error: "Falta el parámetro 'path'." });
  try {
    const r = await axios.get("https://roads.googleapis.com/v1/snapToRoads", {
      params: { path, interpolate: true, key: GOOGLE_MAPS_API_KEY },
    });
    return res.json(r.data);
  } catch (err) {
    const detalle = err?.response?.data || err.message;
    console.error("Error snapToRoads:", JSON.stringify(detalle));
    return res.status(502).json({ error: "No se pudo consultar la Roads API.", detalle });
  }
});

// ── GET /api/maps/distance-matrix?origins=...&destinations=... ────────────
app.get("/api/maps/distance-matrix", async (req, res) => {
  const { origins, destinations } = req.query;
  if (!GOOGLE_MAPS_API_KEY) return res.status(500).json({ error: "Falta GOOGLE_MAPS_API_KEY en el servidor." });
  if (!origins || !destinations) return res.status(400).json({ error: "Faltan 'origins'/'destinations'." });
  try {
    const r = await axios.get("https://maps.googleapis.com/maps/api/distancematrix/json", {
      params: { origins, destinations, mode: "driving", language: "es", key: GOOGLE_MAPS_API_KEY },
    });
    return res.json(r.data);
  } catch (err) {
    const detalle = err?.response?.data || err.message;
    console.error("Error distanceMatrix:", JSON.stringify(detalle));
    return res.status(502).json({ error: "No se pudo consultar Distance Matrix.", detalle });
  }
});

function checkPuenteToken(req, res, next) {
  if (!PUENTE_TOKEN) return next();
  if (req.get("x-puente-token") === PUENTE_TOKEN) return next();
  return res.status(401).json({ error: "Token de puente inválido." });
}

function checkDispatchTrack(req, res, next) {
  if (!DT_API_KEY || !DT_API_URL) {
    return res
      .status(500)
      .json({ error: "Falta DISPATCHTRACK_API_KEY o DT_API_URL en el servidor." });
  }
  next();
}

function dtHeaders() {
  return {
    "Content-Type": "application/json",
    "X-AUTH-TOKEN": DT_API_KEY,
  };
}

// ── POST /api/dispatches — crear despacho en DispatchTrack ──
// Body: { solicitud: {...} }. Botón manual "Enviar a DispatchTrack"
// en la app — NO se llama automáticamente al guardar una solicitud.
// Si la solicitud ya tiene dt_dispatch_id, se rechaza para evitar
// crear despachos duplicados por doble clic o reintento.
function partesCliente(titulo){
  // titulo viene como "ID - Nombre" (ej. "000-2 - Dhl Atlantis" o
  // "81.378.300-2 - Abbott Laboratories De Chile"). El RUT trae guiones
  // pegados sin espacio, así que separar por " - " (con espacios) es seguro.
  if(!titulo) return { id:"", nombre:titulo||"" };
  const partes = titulo.split(" - ");
  if(partes.length < 2) return { id:"", nombre:titulo.trim() };
  return { id: partes[0].trim(), nombre: partes.slice(1).join(" - ").trim() };
}

app.post("/api/dispatches", checkPuenteToken, checkDispatchTrack, async (req, res) => {
  const { solicitud } = req.body;
  if (!solicitud || !solicitud.ot) {
    return res.status(400).json({ error: "Se requiere 'solicitud' con ot." });
  }
  if (solicitud.dtDispatchId) {
    return res.status(409).json({ error: "Esta solicitud ya fue enviada a DispatchTrack.", dispatch_id: solicitud.dtDispatchId });
  }

  try {
    const { id: idCliente, nombre: nombreCliente } = partesCliente(solicitud.titulo);
    const fechaCompromiso = solicitud.fecha && solicitud.hora ? `${solicitud.fecha} ${solicitud.hora}` : (solicitud.fecha || null);
    const payload = {
      identifier: solicitud.ot, // QX-XXX, obligatorio
      contact_name: nombreCliente || solicitud.titulo || "",
      contact_address: solicitud.direccion || "",
      contact_phone: "", // "contacto" en Quantrex es texto libre (nombre/teléfono mezclado), no separable con certeza
      contact_id: idCliente || "",
      contact_identifier: idCliente || "", // mismo valor por compatibilidad (así lo hace Aquatrisq)
      min_delivery_time: fechaCompromiso,
      // Se replica en max_delivery_time para evitar que el panel de DispatchTrack
      // muestre "Fecha de compromiso: ... - Invalid date" cuando max queda null.
      max_delivery_time: fechaCompromiso,
      to_be_payed: false,
      pickup_address: { name: DT_PICKUP_NAME }, // obligatorio
      items: Array.isArray(solicitud.items)
        ? solicitud.items.filter(it=>it?.nombre).map((it,i)=>({
            name: it.nombre,
            description: it.nombre,
            quantity: it.cantidad || 1,
            code: String(i+1),
          }))
        : [],
      tags: [
        solicitud.descripcion ? { name: "Descripción", value: solicitud.descripcion, type: "string" } : null,
        solicitud.destino && solicitud.destino !== nombreCliente ? { name: "Destino", value: solicitud.destino, type: "string" } : null,
        solicitud.tipo ? { name: "Tipo", value: solicitud.tipo, type: "string" } : null,
        solicitud.contacto ? { name: "Contacto", value: solicitud.contacto, type: "string" } : null,
        solicitud.guia ? { name: "Guia", value: solicitud.guia, type: "string" } : null,
        solicitud.choferAsignado ? { name: "Chofer", value: solicitud.choferAsignado, type: "string" } : null,
        solicitud.ppuAsignada ? { name: "PPU", value: solicitud.ppuAsignada, type: "string" } : null,
        solicitud.usuarioDT ? { name: "Usuario DT", value: solicitud.usuarioDT, type: "string" } : null,
        solicitud.prioridad ? { name: "Prioridad", value: solicitud.prioridad, type: "string" } : null,
        solicitud.solicitante ? { name: "Solicitante", value: solicitud.solicitante, type: "string" } : null,
        solicitud.canalSolicitud ? { name: "Canal Solicitud", value: solicitud.canalSolicitud, type: "string" } : null,
        solicitud.notas ? { name: "Notas", value: solicitud.notas, type: "string" } : null,
      ].filter(Boolean),
    };

    const r = await axios.post(`${DT_API_URL}/dispatches`, payload, { headers: dtHeaders() });

    // Guardar el resultado en Supabase para no volver a crear el mismo despacho.
    if (supabase) {
      const dispatchId = r.data?.id || r.data?.dispatch_id || null;
      const { error } = await supabase
        .from("solicitudes")
        .update({ dt_dispatch_id: dispatchId, dt_enviado_en: new Date().toISOString() })
        .eq("id", solicitud.id);
      if (error) console.error("Error guardando dt_dispatch_id en Supabase:", error.message);
    }

    return res.json({ ok: true, dispatchtrack: r.data });
  } catch (err) {
    const detalle = err?.response?.data || err.message;
    console.error("Error creando dispatch:", JSON.stringify(detalle));
    return res.status(502).json({ error: "DispatchTrack rechazó el despacho.", detalle });
  }
});

// ── GET /api/track/:identifier — consultar estado de un despacho ──
// Reemplaza el widget de copiar/pegar: la app llama aquí directo
// con el número buscado y muestra el resultado en pantalla.
// CONFIRMADO (prueba real 2026-08-01): el parámetro identifier del API
// de DispatchTrack NO filtra exacto del lado del servidor — devuelve un
// lote más amplio de despachos recientes. Por eso se filtra acá, en el
// puente, por coincidencia exacta (sin distinguir mayúsculas/espacios)
// antes de responder a la app.
//
// La respuesta de este endpoint NO trae firma/fotos/comentarios de la
// "Prueba de entrega" — DispatchTrack solo envía eso una vez, por webhook,
// al momento de cerrar la entrega. Por eso acá se complementa cada
// coincidencia con lo que haya quedado guardado en dt_entregas_quantrex
// (poblada por /api/webhooks/dispatchtrack más abajo). Entregas cerradas
// antes de activar el webhook no van a tener este dato — no hay forma de
// recuperarlo retroactivamente vía API.
app.get("/api/track/:identifier", checkDispatchTrack, async (req, res) => {
  const { identifier } = req.params;
  if (!identifier) return res.status(400).json({ error: "Falta el identificador." });
  const buscado = identifier.trim().toLowerCase();

  try {
    const r = await axios.get(`${DT_API_URL}/dispatches`, {
      headers: dtHeaders(),
      params: { identifier },
    });
    const lote = r.data?.response || [];
    let coincidencias = lote.filter(
      (d) => (d.identifier || "").trim().toLowerCase() === buscado
    );

    if (supabase && coincidencias.length > 0) {
      const ids = coincidencias.map((d) => d.dispatch_id).filter(Boolean);
      const { data: entregas, error } = await supabase
        .from("dt_entregas_quantrex")
        .select("dispatch_id,evaluation_answers")
        .in("dispatch_id", ids);
      if (error) console.error("Error leyendo dt_entregas_quantrex:", error.message);
      const porId = Object.fromEntries((entregas || []).map((e) => [e.dispatch_id, e.evaluation_answers]));
      coincidencias = coincidencias.map((d) => ({
        ...d,
        evaluation_answers: porId[d.dispatch_id] || null,
      }));
    }

    return res.json({ ok: true, encontrados: coincidencias.length, dispatches: coincidencias });
  } catch (err) {
    const detalle = err?.response?.data || err.message;
    console.error("Error consultando dispatch:", JSON.stringify(detalle));
    return res.status(502).json({ error: "No se pudo consultar DispatchTrack.", detalle });
  }
});

// ── POST /api/webhooks/dispatchtrack — entrega completada ────
// Configúralo en el panel de DispatchTrack (Webhooks) apuntando a:
// https://TU-DOMINIO.up.railway.app/api/webhooks/dispatchtrack
// Guarda el evento crudo siempre (para depurar), y una versión normalizada
// con evaluation_answers TAL CUAL las manda DT — no se intenta adivinar
// nombres de campo porque son específicos de cómo configuraste el
// formulario del chofer en esta cuenta. El frontend muestra cada
// name/value tal cual venga.
app.post("/api/webhooks/dispatchtrack", async (req, res) => {
  const evento = req.body;
  console.log("📦 Webhook DispatchTrack (Quantrex):", JSON.stringify(evento));

  if (supabase) {
    try {
      const { error } = await supabase.from("dt_eventos_quantrex").insert({ payload: evento });
      if (error) console.error("Error guardando evento crudo:", error.message);
    } catch (e) {
      console.error("Excepción guardando evento crudo:", e.message);
    }
  }

  if (supabase && evento && evento.resource === "dispatch" && evento.dispatch_id) {
    const registro = {
      dispatch_id: evento.dispatch_id,
      identifier: evento.identifier || evento.guide || null,
      status: evento.status ?? null,
      substatus: evento.substatus || null,
      contact_name: evento.contact_name || null,
      contact_address: evento.contact_address || null,
      number_of_retries: evento.number_of_retries ?? null,
      arrived_at: evento.arrived_at || null,
      evaluation_answers: evento.evaluation_answers || null,
      raw: evento,
      actualizado_en: new Date().toISOString(),
    };
    try {
      const { error } = await supabase
        .from("dt_entregas_quantrex")
        .upsert(registro, { onConflict: "dispatch_id" });
      if (error) console.error("Error en upsert dt_entregas_quantrex:", error.message);
    } catch (e) {
      console.error("Excepción en upsert dt_entregas_quantrex:", e.message);
    }
  }

  return res.json({ received: true });
});

app.listen(PORT, () => console.log(`✅ Quantrex-Abbott DT bridge escuchando en puerto ${PORT}`));
