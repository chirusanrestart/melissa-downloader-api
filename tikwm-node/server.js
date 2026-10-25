import http from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || "";
const MAX_BODY = 8 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function isTikTokUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "tiktok.com" || url.hostname.endsWith(".tiktok.com"));
  } catch {
    return false;
  }
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString("utf8");
    if (Buffer.byteLength(body) > MAX_BODY) {
      const err = new Error("Corpo muito grande");
      err.statusCode = 413;
      throw err;
    }
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    const err = new Error("JSON inválido");
    err.statusCode = 400;
    throw err;
  }
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;

  if (req.method === "GET" && (pathname === "/" || pathname === "/health")) {
    return sendJson(res, 200, {
      ok: true,
      service: "melissa-tikwm-node-test",
      endpoint: "POST /download",
      chunkSize: CHUNK_SIZE
    });
  }

  if (req.method !== "POST" || pathname !== "/download") {
    return sendJson(res, 404, { error: "Rota não encontrada" });
  }

  if (!API_KEY || req.headers["x-api-key"] !== API_KEY) {
    return sendJson(res, 401, { error: "X-API-Key inválida ou API_KEY não configurada" });
  }

  let payload;
  try {
    payload = await readJson(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: err.message });
  }

  if (!isTikTokUrl(payload.url)) {
    return sendJson(res, 400, { error: "Envie uma URL HTTPS válida do TikTok no campo url" });
  }

  const abortController = new AbortController();
  req.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    const form = new URLSearchParams({ url: payload.url, hd: "1" });
    const apiResponse = await fetch("https://www.tikwm.com/api/", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "user-agent": "Mozilla/5.0 MelissaDownloaderAPI/1.0"
      },
      body: form,
      signal: abortController.signal
    });

    if (!apiResponse.ok) {
      return sendJson(res, 502, { error: "TikWM respondeu com HTTP " + apiResponse.status });
    }

    const result = await apiResponse.json();
    const directUrl = result?.data?.hdplay || result?.data?.play;
    if (result?.code !== 0 || typeof directUrl !== "string") {
      return sendJson(res, 502, {
        error: "TikWM não conseguiu resolver esse vídeo",
        code: result?.code ?? null
      });
    }

    const videoUrl = new URL(directUrl);
    if (videoUrl.protocol !== "https:") {
      return sendJson(res, 502, { error: "TikWM retornou um endereço de mídia não seguro" });
    }

    const videoResponse = await fetch(videoUrl, {
      headers: { "user-agent": "Mozilla/5.0 MelissaDownloaderAPI/1.0" },
      signal: abortController.signal
    });

    if (!videoResponse.ok || !videoResponse.body) {
      return sendJson(res, 502, { error: "Não foi possível abrir o vídeo retornado pelo TikWM" });
    }

    const declaredLength = Number(videoResponse.headers.get("content-length") || 0);
    if (declaredLength > MAX_VIDEO_BYTES) {
      abortController.abort();
      return sendJson(res, 413, { error: "Vídeo excede o limite de 500 MiB" });
    }

    res.writeHead(200, {
      "content-type": videoResponse.headers.get("content-type") || "video/mp4",
      "content-disposition": 'attachment; filename="tiktok-video.mp4"',
      "cache-control": "no-store",
      "x-stream-chunk-size": String(CHUNK_SIZE),
      ...(declaredLength ? { "content-length": String(declaredLength) } : {})
    });

    let bytes = 0;
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_VIDEO_BYTES) {
          callback(new Error("Vídeo excedeu o limite de 500 MiB"));
          return;
        }
        callback(null, chunk);
      }
    });

    await pipeline(Readable.fromWeb(videoResponse.body), limiter, res);
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 502, { error: "Falha ao consultar TikWM ou transmitir o vídeo" });
    } else {
      res.destroy(err);
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Melissa TikWM Node test ouvindo na porta ${PORT}`);
});
