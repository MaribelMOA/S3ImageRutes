import { HeadObjectCommand, RestoreObjectCommand, S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const REGION = process.env.AWS_REGION || "us-east-2";
const BUCKET = process.env.AWS_S3_BUCKET;                  // <-- pon tu bucket
const SIGNED_TTL_SECONDS = parseInt(process.env.SIGNED_TTL_SECONDS || "3600", 10);
const DEFAULT_PAGE_SIZE = parseInt(process.env.DEFAULT_PAGE_SIZE || "50", 10);
const MAX_PAGE_SIZE = parseInt(process.env.MAX_PAGE_SIZE || "200", 10);

// mismos mapeos que tu C#
const FaceStatus = {
  OK: "OK",
  NO_FACE: "NO_FACE",
  CANCELED: "CANCELED",
  PLAN_FAILURE: "PLAN_FAILURE",
  CAPTURE_FAILED: "CAPTURE_FAILED",
  AWS_ERROR: "AWS_ERROR",
  EXCEEDS_LIMIT: "EXCEEDS_LIMIT",
  MANY_FACES: "MANY_FACES"
};

const statusToPrefix = (s) => {
  switch (s) {
    case FaceStatus.OK:             return "faces/visitas/";
    case FaceStatus.NO_FACE:        return "faces/noface/";
    case FaceStatus.CANCELED:       return "faces/canceled/";
    case FaceStatus.PLAN_FAILURE:   return "faces/planfailure/";
    case FaceStatus.CAPTURE_FAILED: return "faces/errors/";
    case FaceStatus.AWS_ERROR:      return "faces/awsError/";
    case FaceStatus.EXCEEDS_LIMIT:  return "faces/exceedsLimit/";
    case FaceStatus.MANY_FACES:     return "faces/manyFaces";
    default:                        return "faces/errors/";
  }
};

const ALL_PREFIXES = [
  "faces/visitas/",
  "faces/noface/",
  "faces/canceled/",
  "faces/planfailure/",
  "faces/errors/",
  "faces/aws_error/",
  "faces/exceedsLimit/",
  "faces/manyFaces",
];

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const s3 = new S3Client({ region: REGION });

const okJson = (body) => ({
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const bad = (msg) => ({
  statusCode: 400,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ success: false, message: msg }),
});

const notFound = (msg) => ({
  statusCode: 404,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ success: false, message: msg }),
});

function boolParam(v, def = false) {
  if (v === undefined || v === null) return def;
  const s = String(v).trim().toLowerCase();
  return ["1","true","yes","y","on"].includes(s);
}

function hasImageExt(key) {
  const dot = key.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = key.slice(dot).toLowerCase();
  return IMAGE_EXTS.has(ext);
}

async function listByPrefixes({ prefixes, patternFn, limit, continuationToken }) {
  // Itera prefijos hasta llenar 'limit' o agotar iteradores.
  const found = [];
  let nextTokenOut = null;

  for (const prefix of prefixes) {
    if (found.length >= limit) break;

    let token = continuationToken || null;
    do {
      const resp = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        MaxKeys: Math.min(limit, 1000),
        ContinuationToken: token || undefined,
      }));

      const objs = resp.Contents || [];
      for (const o of objs) {
        if (found.length >= limit) break;
        const key = o.Key;
        if (!key) continue;
        if (!hasImageExt(key)) continue;
        if (patternFn && !patternFn(key)) continue;
        found.push({ key, size: o.Size, lastModified: o.LastModified });
      }

      if (found.length >= limit) {
        // aún así expón token de esa página por si el cliente quiere seguir
        nextTokenOut = resp.IsTruncated ? resp.NextContinuationToken || null : null;
        break;
      }

      token = resp.IsTruncated ? (resp.NextContinuationToken || null) : null;
      if (token === null) {
        nextTokenOut = null;
        break;
      } else {
        nextTokenOut = token; // último token visto
      }
    } while (true);

    // si venía un continuationToken “compartido” y ya consumimos una página, no sigas al siguiente prefijo
    if (continuationToken) break;
  }

  return { items: found, nextContinuationToken: nextTokenOut };
}

async function keyToUrl(key) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn: SIGNED_TTL_SECONDS });
}

async function keyToBytes(key) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  const resp = await s3.send(cmd);
  const chunks = [];
  for await (const c of resp.Body) chunks.push(c);
  const buf = Buffer.concat(chunks);
  const contentType = resp.ContentType || guessContentType(key);
  return { bytes: buf, base64: buf.toString("base64"), contentType, size: buf.length };
}

function guessContentType(key) {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "application/octet-stream";
}

function parseCommonParams(query) {
    const mode = (query.return || "urls").toLowerCase(); // urls (default) | bytes | base64
    const status = query.status || null;
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, parseInt(query.limit || DEFAULT_PAGE_SIZE, 10)));
    const continuationToken = query.continuationToken || null;
    return { mode, status, limit, continuationToken };
}
// --- RESTORE FUNCTIONS ---
  
  async function headKey(key) {
    const resp = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    // Ejemplos:
    // resp.StorageClass === "DEEP_ARCHIVE"
    // resp.Restore === 'ongoing-request="true"'  ó 'ongoing-request="false", expiry-date="Fri, 27 Sep 2025 10:00:00 GMT"'
    return {
      storageClass: resp.StorageClass || "STANDARD",
      restoreHeader: resp.Restore || null,
      contentType: resp.ContentType || guessContentType(key),
      size: resp.ContentLength,
      lastModified: resp.LastModified,
    };
  }

  function parseRestoreHeader(restoreHeader) {
    if (!restoreHeader) return { requested: false, ongoing: false, expiryDate: null };
    const requested = true;
    const ongoing = /ongoing-request="true"/.test(restoreHeader);
    const match = /expiry-date="([^"]+)"/.exec(restoreHeader);
    return { requested, ongoing, expiryDate: match ? match[1] : null };
  }

  function isArchived(storageClass) {
    return storageClass === "DEEP_ARCHIVE" || storageClass === "GLACIER" || storageClass === "GLACIER_IR" || storageClass === "GLACIER_DEEP_ARCHIVE";
  }

  async function safeGetObject(key) {
    try {
      const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
      return await s3.send(cmd); // si está archivado, lanzará InvalidObjectState
    } catch (err) {
      if (err?.name === "InvalidObjectState") {
        return { archived: true };
      }
      throw err;
    }
  }

  async function requestRestore(key, { days = 1, tier = "Bulk" } = {}) {
    // tier: "Standard" | "Bulk"
    await s3.send(new RestoreObjectCommand({
      Bucket: BUCKET,
      Key: key,
      RestoreRequest: {
        Days: days,
        GlacierJobParameters: { Tier: tier }, 
      },
    }));
    return { requested: true, tier, days };
  }
  
  async function buildImageRecords(items, { mode, autoRestore=false, restoreDays=1, restoreTier="Bulk" }) {
    const out = [];
    let archivedPendingRestore = 0;
  
    for (const it of items) {
      const key = it.key;
      // Lee metadatos (barato)
      let meta;
      try {
        meta = await headKey(key);
      } catch (e) {
        out.push({
          key,
          url: null,
          archived: null,
          restoreRequested: null,
          restoreOngoing: null,
          restoreExpiryDate: null,
          note: "Fallo HeadObject",
          error: e?.message || "HEAD_FAILED",
        });
        continue;
      }
  
      const archived = isArchived(meta.storageClass);
      const { requested, ongoing, expiryDate } = parseRestoreHeader(meta.restoreHeader);
  
      // Caso: NO archivado
      if (!archived) {
        if (mode === "urls") {
          out.push({
            key,
            url: await keyToUrl(key),
            archived: false,
            restoreRequested: false,
            restoreOngoing: false,
            restoreExpiryDate: null,
          });
        } else {
          const got = await keyToBytes(key);
          out.push({
            key,
            url: null,
            ...(mode === "bytes" ? { bytes: Array.from(got.bytes) } : { base64: got.base64 }),
            archived: false,
            restoreRequested: false,
            restoreOngoing: false,
            restoreExpiryDate: null,
          });
        }
        continue;
      }
  
      // Archivado: ¿ya restaurado y visible?
      if (requested && !ongoing && expiryDate) {
        if (mode === "urls") {
          out.push({
            key,
            url: await keyToUrl(key),
            archived: true,
            restoreRequested: true,
            restoreOngoing: false,
            restoreExpiryDate: expiryDate,
          });
        } else {
          const got = await keyToBytes(key); // puede fallar si está justo refrescando, pero normalmente OK
          out.push({
            key,
            url: null,
            ...(mode === "bytes" ? { bytes: Array.from(got.bytes) } : { base64: got.base64 }),
            archived: true,
            restoreRequested: true,
            restoreOngoing: false,
            restoreExpiryDate: expiryDate,
          });
        }
        continue;
      }
  
      // Archivado: restore en progreso
      if (requested && ongoing) {
        archivedPendingRestore++;
        out.push({
          key,
          url: null,
          archived: true,
          restoreRequested: true,
          restoreOngoing: true,
          restoreExpiryDate: expiryDate || null,
          note: "Restore en progreso; reintenta más tarde.",
        });
        continue;
      }
  
      // Archivado: sin restore solicitado
      if (!requested) {
        archivedPendingRestore++;
        if (autoRestore) {
          try {
            await requestRestore(key, { days: restoreDays, tier: restoreTier });
            out.push({
              key,
              url: null,
              archived: true,
              restoreRequested: true,
              restoreOngoing: true,
              restoreExpiryDate: null,
              note: `Restore solicitado (/images/restoreImages); estará disponible cuando finalice y durará ${restoreDays} día(s).`,
            });
          } catch (e) {
            out.push({
              key,
              url: null,
              archived: true,
              restoreRequested: false,
              restoreOngoing: false,
              restoreExpiryDate: null,
              note: "No se pudo solicitar restore automáticamente.",
              error: e?.message || "RESTORE_REQUEST_FAILED",
            });
          }
        } else {
          out.push({
            key,
            url: null,
            archived: true,
            restoreRequested: false,
            restoreOngoing: false,
            restoreExpiryDate: null,
            note: "Este objeto está en Deep Archive. Usa /images-restore o autoRestore=true para rehidratar.",
          });
        }
      }
    }
  
    return { records: out, archivedPendingRestore };
  }
  
  
// --- ROUTES ---

async function imagesByDate(query) {
    const date = (query.date || "").trim();
    if (!/^\d{8}$/.test(date)) return bad("Debe proporcionar una fecha válida (formato: yyyyMMdd).");
  
    const { mode, status, limit, continuationToken } = parseCommonParams(query);
   
    const autoRestore = boolParam(query.autoRestore, false);
    const restoreDays  = Math.max(1, parseInt(query.restoreDays || "1", 10));
    const restoreTier  = (query.restoreTier || "Bulk"); // "Bulk" | "Standard"

    const needle = `_${date}_`;
    const prefixes = status ? [statusToPrefix(status)] : ALL_PREFIXES;
  
    // 1) BUSCAR (LIST) + filtrar por fecha
    const { items, nextContinuationToken } = await listByPrefixes({
      prefixes,
      patternFn: (key) => key.includes(needle),
      limit,
      continuationToken,
    });
  
    if (items.length === 0) {
      return notFound(`No se encontraron imágenes para ${date}${status ? " con status " + status : ""}.`);
    }
  
    const { records, archivedPendingRestore } =
    await buildImageRecords(items, { mode, autoRestore, restoreDays, restoreTier });

    return okJson({
      success: true,
      count: records.length,
      archivedPendingRestore,
      nextContinuationToken,
      images: records,
    });
  }
  

  async function imagesByTransaction(query) {
    const tx = (query.tx || "").trim();
    if (!tx) return bad("Debe proporcionar el transactionId.");
  
    const { mode, status, limit, continuationToken } = parseCommonParams(query);

    const autoRestore = boolParam(query.autoRestore, false);
    const restoreDays  = Math.max(1, parseInt(query.restoreDays || "1", 10));
    const restoreTier  = (query.restoreTier || "Bulk");

    const prefixes = status ? [statusToPrefix(status)] : ALL_PREFIXES;
  
    const { items, nextContinuationToken } = await listByPrefixes({
      prefixes,
      patternFn: (key) => {
        if (status) {
          // p.ej. faces/visitas/<tx>_....  (evita falsos positivos)
          const expectedPrefix = `${statusToPrefix(status)}${tx}_`;
          return key.startsWith(expectedPrefix);
        }
        // sin status: busca .../<tx>_...
        return key.includes(`/${tx}_`);
      },
      limit,
      continuationToken,
    });
  
    if (items.length === 0) {
      return notFound("No se encontraron imágenes para ese transactionId.");
    }
  
    const { records, archivedPendingRestore } =
    await buildImageRecords(items, { mode, autoRestore, restoreDays, restoreTier });

    return okJson({
      success: true,
      count: records.length,
      archivedPendingRestore,
      nextContinuationToken,
      images: records,
    });
  }


  
  async function imagesByFaceIdAndDate(query) {
    const faceId = (query.faceid || query.faceId || "").trim();
    const date   = (query.date || "").trim();
    if (!faceId) return bad("Debe proporcionar el faceId.");
    if (!/^\d{8}$/.test(date)) return bad("Debe proporcionar una fecha válida (formato: yyyyMMdd).");
  
    const { mode, status, limit, continuationToken } = parseCommonParams(query);
    const autoRestore = boolParam(query.autoRestore, false);
    const restoreDays  = Math.max(1, parseInt(query.restoreDays || "1", 10));
    const restoreTier  = (query.restoreTier || "Bulk");
  
    const prefixes = status ? [statusToPrefix(status)] : ALL_PREFIXES;
  
    const { items, nextContinuationToken } = await listByPrefixes({
      prefixes,
      patternFn: (key) => {
        const slash = key.lastIndexOf("/");
        const filename = slash >= 0 ? key.slice(slash + 1) : key;
        const parts = filename.split("_"); // [tx, faceId, date, time.ext]
        if (parts.length < 4) return false;
        return parts[1] === faceId && parts[2] === date && hasImageExt(key);
      },
      limit,
      continuationToken,
    });
  
    if (items.length === 0) {
      const st = status ? ` con status ${status}` : "";
      return notFound(`No se encontraron imágenes para faceId=${faceId} y date=${date}${st}.`);
    }
  
    const { records, archivedPendingRestore } =
      await buildImageRecords(items, { mode, autoRestore, restoreDays, restoreTier });
  
    return okJson({
      success: true,
      count: records.length,
      archivedPendingRestore,
      nextContinuationToken,
      images: records,
    });
  }
  

  async function restoreImage(queryOrBody) {
    const key = (queryOrBody.key || "").trim();
    if (!key) return bad("Debe proporcionar 'key' de S3.");
    const days = parseInt(queryOrBody.days || "1", 10);
    const tier = (queryOrBody.tier || "Standard");
  
    const head = await headKey(key);
    if (!isArchived(head.storageClass)) {
      return okJson({ success: true, message: "El objeto no está en Deep Archive.", alreadyAvailable: true });
    }
  
    const r = parseRestoreHeader(head.restoreHeader);
    if (r.requested && r.ongoing) {
      return okJson({
        success: true,
        message: "Restore en progreso.",
        restoreOngoing: true,
        estimatedWaitHintHours: tier === "Bulk" ? 48 : 12 // aproximado
      });
    }
  
    // Solicitar restore
    await requestRestore(key, { days, tier });
    return okJson({
      success: true,
      message: "Restore solicitado.",
      tier,
      days,
      estimatedWaitHintHours: tier === "Bulk" ? 48 : 12 // aproximado
    });
  }
  
  

// Lambda proxy handler
export const handler = async (event) => {
  try {
    const path = (event.rawPath || event.path || "").toLowerCase();
    const query = event.queryStringParameters || {};

    if (path.endsWith("/images-by-date")) {
      return await imagesByDate(query);
    }
    if (path.endsWith("/images-by-transaction")) {
      return await imagesByTransaction(query);
    }
    if (path.endsWith("/images-by-faceid-date")) {  
      return await imagesByFaceIdAndDate(query);
    }
    if (path.endsWith("/images-restore")) {
      const body = event.body ? JSON.parse(event.body) : {};
      // o usar query params si prefieres GET/POST con query
      return await restoreImage({ ...query, ...body });
    }
    

    return { statusCode: 404, body: "Not Found" };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: "Internal Error" };
  }
};