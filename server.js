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


const VIDEOSCALE_BASE_URL = "https://gate.apiscrape.net:16262";
const VIDEOSCALE_USERNAME = process.env.VIDEOSCALE_USERNAME || "";
const VIDEOSCALE_PASSWORD = process.env.VIDEOSCALE_PASSWORD || "";
const VIDEOSCALE_TIMEOUT_MS = 15_000;
const VIDEOSCALE_TASK_TIMEOUT_MS = 120_000;

function videoScaleAuthHeaders() {
  if (!VIDEOSCALE_USERNAME || !VIDEOSCALE_PASSWORD) {
    throw new Error("VideoScale não configurado: defina VIDEOSCALE_USERNAME e VIDEOSCALE_PASSWORD");
  }
  const token = Buffer.from(`${VIDEOSCALE_USERNAME}:${VIDEOSCALE_PASSWORD}`).toString("base64");
  return { authorization: `Basic ${token}` };
}

async function videoScaleJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(VIDEOSCALE_TIMEOUT_MS),
    headers: { ...videoScaleAuthHeaders(), ...(options.headers || {}) }
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch {
    throw new Error(`VideoScale respondeu HTTP ${response.status} com JSON inválido`);
  }
  if (!response.ok) {
    throw new Error(`VideoScale HTTP ${response.status}: ${String(data?.error || data?.message || "requisição falhou").slice(0, 300)}`);
  }
  return data;
}

function findDeepObjects(value, predicate, found = [], depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return found;
  if (!Array.isArray(value) && predicate(value)) found.push(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    findDeepObjects(item, predicate, found, depth + 1);
  }
  return found;
}

function findDeepString(value, keys, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return "";
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const found = findDeepString(item, keys, depth + 1);
    if (found) return found;
  }
  return "";
}

function findDeepStringChildFirst(value, keys, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return "";
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const found = findDeepStringChildFirst(item, keys, depth + 1);
    if (found) return found;
  }
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  return "";
}

function chooseVideoScaleFormat(payload, mode) {
  const formats = findDeepObjects(payload, item =>
    item.format_id !== undefined || item.formatId !== undefined || item.formatID !== undefined
  );
  if (!formats.length) throw new Error("VideoScale não retornou formatos reconhecíveis");

  const formatId = item => String(item.format_id ?? item.formatId ?? item.formatID);
  const codec = (item, keys) => String(keys.map(key => item[key]).find(value => value !== undefined && value !== null) ?? "").toLowerCase();
  const audioFormats = formats.filter(item => {
    const audio = codec(item, ["acodec", "audio_codec", "audioCodec"]);
    const video = codec(item, ["vcodec", "video_codec", "videoCodec"]);
    return audio && audio !== "none" && (video === "none" || item.audio_only === true || item.audioOnly === true || item.type === "audio");
  });
  const combinedFormats = formats.filter(item => {
    const audio = codec(item, ["acodec", "audio_codec", "audioCodec"]);
    const video = codec(item, ["vcodec", "video_codec", "videoCodec"]);
    return video && video !== "none" && audio && audio !== "none";
  });
  const videoFormats = formats.filter(item => {
    const video = codec(item, ["vcodec", "video_codec", "videoCodec"]);
    const type = String(item.type ?? item.format_type ?? "").toLowerCase();
    return (video && video !== "none" && type !== "audio") ||
      (type.includes("video") && !type.includes("only"));
  });
  // No fallback de áudio, baixar vídeo com áudio embutido na menor resolução disponível.
  const candidates = mode === "audio"
    ? (combinedFormats.length ? combinedFormats : (videoFormats.length ? videoFormats : audioFormats))
    : (combinedFormats.length ? combinedFormats : videoFormats);
  if (!candidates.length) throw new Error(`VideoScale não retornou formato adequado para ${mode}`);

  candidates.sort((a, b) => {
    const aExt = String(a.ext ?? a.extension ?? "").toLowerCase();
    const bExt = String(b.ext ?? b.extension ?? "").toLowerCase();
    const aHeight = Number(a.height ?? String(a.resolution ?? "").match(/(\\d+)p/)?.[1] ?? 0);
    const bHeight = Number(b.height ?? String(b.resolution ?? "").match(/(\\d+)p/)?.[1] ?? 0);
    if (mode === "audio") {
      return (aHeight || Number.MAX_SAFE_INTEGER) - (bHeight || Number.MAX_SAFE_INTEGER);
    }
    const aScore = (aExt === "mp4" ? 20 : 0) + aHeight / 10000;
    const bScore = (bExt === "mp4" ? 20 : 0) + bHeight / 10000;
    return bScore - aScore;
  });
  return formatId(candidates[0]);
}

async function streamViaVideoScale(videoUrl, res, mode) {
  const authHeaders = videoScaleAuthHeaders();
  const formatsUrl = new URL(`${VIDEOSCALE_BASE_URL}/api/formats`);
  formatsUrl.searchParams.set("video_url", videoUrl);
  const formatsPayload = await videoScaleJson(formatsUrl, { method: "GET" });
  const formatId = chooseVideoScaleFormat(formatsPayload, mode);

  const taskPayload = await videoScaleJson(`${VIDEOSCALE_BASE_URL}/api/download`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: videoUrl, format_id: formatId })
  });
  const taskId = findDeepString(taskPayload, ["task_id", "taskId", "taskID"]);
  if (!taskId) throw new Error("VideoScale não retornou task_id");

  const deadline = Date.now() + VIDEOSCALE_TASK_TIMEOUT_MS;
  let taskStatus = "";
  while (Date.now() < deadline) {
    if (res.destroyed) return;
    await new Promise(resolve => setTimeout(resolve, 2000));
    const statusPayload = await videoScaleJson(
      `${VIDEOSCALE_BASE_URL}/api/status/${encodeURIComponent(taskId)}`,
      { method: "GET" }
    );
    taskStatus = findDeepStringChildFirst(statusPayload, ["status", "state"]).toLowerCase();
    if (["completed", "complete", "success", "succeeded", "done", "finished"].includes(taskStatus)) break;
    if (["failed", "error", "cancelled", "canceled"].includes(taskStatus)) {
      throw new Error(`Tarefa VideoScale falhou: ${taskStatus}`);
    }
  }
  if (!["completed", "complete", "success", "succeeded", "done", "finished"].includes(taskStatus)) {
    throw new Error("Tempo limite aguardando o download no VideoScale");
  }

  const downloadPayload = await videoScaleJson(
    `${VIDEOSCALE_BASE_URL}/api/download/${encodeURIComponent(taskId)}`,
    { method: "GET" }
  );
  const mediaUrl = findDeepString(downloadPayload, ["download_url", "downloadUrl", "direct_url", "directUrl", "file_url", "fileUrl"]);
  if (!mediaUrl || mediaUrl === videoUrl) throw new Error("VideoScale não retornou uma URL de mídia");
  const parsedMediaUrl = new URL(mediaUrl);
  if (parsedMediaUrl.protocol !== "https:") throw new Error("VideoScale retornou uma URL de mídia não segura");

  if (mode === "audio") {
    const ffmpeg = spawn(process.env.FFMPEG_PATH || "ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", parsedMediaUrl.toString(),
      "-map", "0:a:0", "-vn",
      "-codec:a", "libmp3lame", "-b:a", "96k",
      "-f", "mp3", "pipe:1"
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let ffmpegError = "";
    let gotOutput = false;
    const timeout = setTimeout(() => ffmpeg.kill("SIGTERM"), 180_000);
    timeout.unref();
    ffmpeg.stderr.setEncoding("utf8");
    ffmpeg.stderr.on("data", chunk => { ffmpegError = (ffmpegError + chunk).slice(-2000); });
    res.on("close", () => {
      if (!res.writableEnded && ffmpeg.exitCode === null) ffmpeg.kill("SIGTERM");
    });
    ffmpeg.stdout.once("data", firstChunk => {
      if (res.destroyed) return;
      gotOutput = true;
      res.writeHead(200, {
        "content-type": "audio/mpeg",
        "content-disposition": 'attachment; filename="audio.mp3"',
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      });
      if (!res.write(firstChunk)) ffmpeg.stdout.pause();
      ffmpeg.stdout.pipe(res);
    });
    ffmpeg.once("error", err => {
      clearTimeout(timeout);
      console.error("Não foi possível iniciar FFmpeg:", err.message);
      if (!res.headersSent && !res.destroyed) sendJson(res, 503, { error: "FFmpeg não está instalado ou não pôde ser iniciado" });
      else if (!res.destroyed) res.destroy(err);
    });
    ffmpeg.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (res.destroyed) return;
      if (code === 0 && gotOutput) {
        if (!res.writableEnded) res.end();
        console.log("VideoScale fallback concluído", { mode, extractor: "ffmpeg" });
        return;
      }
      const message = `FFmpeg falhou (código ${code}, sinal ${signal || "nenhum"}): ${ffmpegError.slice(-800)}`;
      console.error(message);
      if (!res.headersSent) sendJson(res, 502, { error: message });
      else if (!res.destroyed) res.destroy(new Error(message));
    });
    return;
  }

  const mediaResponse = await fetch(parsedMediaUrl, {
    headers: { "user-agent": "MelissaDownloaderAPI/3.0" },
    signal: AbortSignal.timeout(60_000)
  });
  if (!mediaResponse.ok || !mediaResponse.body) {
    throw new Error(`Não foi possível obter a mídia do VideoScale (HTTP ${mediaResponse.status})`);
  }
  res.writeHead(200, {
    "content-type": mediaResponse.headers.get("content-type") || "video/mp4",
    "content-disposition": 'attachment; filename="video.mp4"',
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  await pipeline(Readable.fromWeb(mediaResponse.body), res);
  console.log("VideoScale fallback concluído", { mode });
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

  child.on("close", async (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);

    if (code === 0 && gotOutput) {
      if (!res.destroyed && !res.writableEnded) res.end();
      return;
    }

    console.error("yt-dlp falhou:", { code, signal, stderr });
    if (!res.headersSent && !res.destroyed && VIDEOSCALE_USERNAME && VIDEOSCALE_PASSWORD) {
      console.log("Tentando fallback VideoScale após falha do yt-dlp", { mode });
      try {
        await streamViaVideoScale(videoUrl, res, mode);
        return;
      } catch (fallbackError) {
        console.error("VideoScale fallback falhou:", fallbackError.message);
        if (!res.headersSent && !res.destroyed) {
          sendJson(res, 502, {
            error: isAudio ? "Falha no YouTube via yt-dlp e VideoScale" : "Falha no vídeo via yt-dlp e VideoScale",
            yt_dlp: stderr.slice(-800) || `yt-dlp encerrou com código ${code}`,
            videoscale: fallbackError.message.slice(0, 800)
          });
        } else if (!res.destroyed) {
          res.destroy(fallbackError);
        }
      }
      return;
    }

    if (!res.headersSent) {
      sendJson(res, 502, {
        error: isAudio ? "Falha ao extrair o áudio do YouTube" : "Falha ao extrair o vídeo do YouTube",
        details: stderr.slice(-1200) || "yt-dlp terminou sem produzir vídeo",
        ...(VIDEOSCALE_USERNAME && VIDEOSCALE_PASSWORD ? {} : { fallback: "Configure VIDEOSCALE_USERNAME e VIDEOSCALE_PASSWORD para ativar o fallback" })
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
