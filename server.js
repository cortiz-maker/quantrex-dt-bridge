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
  })
);

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
function nombreClienteDesdeTitulo(titulo){
  // titulo viene como "ID - Nombre" (ej. "000-2 - Dhl Atlantis" o
  // "81.378.300-2 - Abbott Laboratories De Chile"). El RUT trae guiones
  // pegados sin espacio, así que separar por " - " (con espacios) es seguro.
  if(!titulo) return "";
  const partes = titulo.split(" - ");
  return partes.length > 1 ? partes.slice(1).join(" - ").trim() : titulo.trim();
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
    const nombreCliente = nombreClienteDesdeTitulo(solicitud.titulo);
    const fechaCompromiso = solicitud.fecha && solicitud.hora ? `${solicitud.fecha} ${solicitud.hora}` : (solicitud.fecha || null);
    const payload = {
      identifier: solicitud.ot, // QX-XXX, obligatorio
      contact_name: nombreCliente || solicitud.titulo || "",
      contact_address: solicitud.direccion || "",
      contact_phone: "", // "contacto" en Quantrex es texto libre (nombre/teléfono mezclado), no separable con certeza
      min_delivery_time: fechaCompromiso,
      // Se replica en max_delivery_time para evitar que el panel de DispatchTrack
      // muestre "Fecha de compromiso: ... - Invalid date" cuando max queda null.
      max_delivery_time: fechaCompromiso,
      to_be_payed: false,
      pickup_address: { name: DT_PICKUP_NAME }, // obligatorio
      items: [],
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
    const coincidencias = lote.filter(
      (d) => (d.identifier || "").trim().toLowerCase() === buscado
    );
    return res.json({ ok: true, encontrados: coincidencias.length, dispatches: coincidencias });
  } catch (err) {
    const detalle = err?.response?.data || err.message;
    console.error("Error consultando dispatch:", JSON.stringify(detalle));
    return res.status(502).json({ error: "No se pudo consultar DispatchTrack.", detalle });
  }
});

app.listen(PORT, () => console.log(`✅ Quantrex-Abbott DT bridge escuchando en puerto ${PORT}`));
