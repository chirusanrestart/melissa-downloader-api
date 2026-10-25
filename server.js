import http from "node:http";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const PORT = Number(process.env.PORT || 8000);
const API_KEY = process.env.API_KEY || "";
const MAX_BODY = 8 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const YTDLP_TIMEOUT_MS = 180_000;

function sendJson(res, status, body) {
  if (res.headersSent || res.destroyed) return;
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

function isYouTubeUrl(value) {
  try {
    const url = new URL(value);
    const hosts = new Set([
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be",
      "youtube-nocookie.com",
      "www.youtube-nocookie.com"
    ]);
    return url.protocol === "https:" && hosts.has(url.hostname) &&
      !url.username && !url.password;
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

async function streamTikTok(payload, req, res) {
  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    const form = new URLSearchParams({ url: payload.url, hd: "1" });
    const apiResponse = await fetch("https://www.tikwm.com/api/", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "user-agent": "Mozilla/5.0 MelissaDownloaderAPI/3.0"
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
      headers: { "user-agent": "Mozilla/5.0 MelissaDownloaderAPI/3.0" },
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
      "x-content-type-options": "nosniff",
      ...(declaredLength ? { "content-length": String(declaredLength) } : {})
    });

    let bytes = 0;
    const sizeGuard = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_VIDEO_BYTES) {
          callback(new Error("Vídeo excedeu o limite de 500 MiB"));
          return;
        }
        callback(null, chunk);
      }
    });

    await pipeline(Readable.fromWeb(videoResponse.body), sizeGuard, res);
  } catch (err) {
    if (err.name === "AbortError" || res.destroyed) return;
    if (!res.headersSent) {
      sendJson(res, 502, { error: "Falha ao consultar TikWM ou transmitir o vídeo" });
    } else {
      res.destroy(err);
    }
  }
}

function streamYouTube(videoUrl, req, res, mode = "video") {
  const isAudio = mode === "audio";
  // Aceita qualquer formato de áudio disponível (M4A, WebM/Opus etc.).
  // O formato é mantido original, sem exigir conversão com FFmpeg.
  const outputFormat = isAudio
    ? "bestaudio[acodec!=none]/bestaudio"
    : "best[ext=mp4][vcodec!=none][acodec!=none]";
  // Como a extensão de áudio pode variar, usa tipo genérico para não mentir
  // ao cliente sobre o contêiner real recebido.
  const outputType = isAudio ? "application/octet-stream" : "video/mp4";
  const outputName = isAudio ? "audio.bin" : "video.mp4";
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--js-runtimes", "node",
    "--remote-components", "ejs:github",
    "-f", outputFormat,
    "-o", "-",
    "--",
    videoUrl
  ];

  const child = spawn(YTDLP, args, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  let gotOutput = false;
  let settled = false;

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 3000).unref();
  }, YTDLP_TIMEOUT_MS);
  timeout.unref();

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => {
    stderr = (stderr + chunk).slice(-4000);
  });

  child.stdout.once("data", firstChunk => {
    if (settled || res.destroyed) return;
    gotOutput = true;
    res.writeHead(200, {
      "content-type": outputType,
      "content-disposition": `attachment; filename="${outputName}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });

    if (!res.write(firstChunk)) {
      child.stdout.pause();
      res.once("drain", () => {
        if (!res.destroyed) child.stdout.pipe(res);
      });
    } else {
      child.stdout.pipe(res);
    }
  });

  child.on("error", err => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    console.error("Não foi possível iniciar yt-dlp:", err.message);
    if (!res.headersSent) {
      sendJson(res, 503, { error: "yt-dlp não está instalado ou não pôde ser iniciado" });
    } else if (!res.destroyed) {
      res.destroy(err);
    }
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);

    if (code === 0 && gotOutput) {
      if (!res.destroyed && !res.writableEnded) res.end();
      return;
    }

    console.error("yt-dlp falhou:", { code, signal, stderr });
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: isAudio ? "Falha ao extrair o áudio do YouTube" : "Falha ao extrair o vídeo do YouTube",
        details: stderr.slice(-1200) || "yt-dlp terminou sem produzir vídeo"
      });
    } else if (!res.destroyed) {
      res.destroy(new Error("yt-dlp terminou antes de concluir a transferência"));
    }
  });

  res.on("close", () => {
    if (!res.writableEnded && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  });
}

const server = http.createServer(async (req, res) => {
  let parsedRequest;
  try {
    parsedRequest = new URL(req.url || "/", "http://localhost");
  } catch {
    return sendJson(res, 400, { error: "URL de requisição inválida" });
  }

  const pathname = parsedRequest.pathname;

  if (req.method === "GET" && (pathname === "/" || pathname === "/health")) {
    return sendJson(res, 200, {
      ok: true,
      service: "melissa-downloader-api",
      runtime: "node",
      port: PORT,
      endpoints: ["POST /download"]
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

  if (typeof payload.url !== "string") {
    return sendJson(res, 400, { error: "Informe uma URL no campo url" });
  }

  if (isTikTokUrl(payload.url)) {
    return streamTikTok(payload, req, res);
  }

  if (isYouTubeUrl(payload.url)) {
    const mode = payload.mode === "audio" || payload.audio === true ? "audio" : "video";
    return streamYouTube(payload.url, req, res, mode);
  }

  return sendJson(res, 400, {
    error: "URL não suportada. Envie um link HTTPS do TikTok ou YouTube."
  });
});

if (!API_KEY) {
  console.error("Configure API_KEY nos secrets do Hostless.");
  process.exit(1);
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Melissa Downloader API ouvindo na porta ${PORT}`);
});
