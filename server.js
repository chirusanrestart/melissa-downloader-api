import http from "node:http";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { mkdtemp, readdir, stat, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yts from "yt-search";
import sharp from "sharp";
import webp from "node-webpmux";

function runYtDlpJson(args, { timeoutMs = 60_000, maxOutputBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, [
      "--no-warnings", "--js-runtimes", "node", "--remote-components", "ejs:github",
      ...args
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      if (child.exitCode === null) child.kill("SIGKILL");
      finish(new Error("Tempo limite do yt-dlp excedido"));
    }, timeoutMs);
    timeout.unref();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error ? reject(error) : resolve(value);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxOutputBytes) {
        child.kill("SIGTERM");
        finish(new Error("Resposta do YouTube excedeu o limite"));
      }
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.once("error", err => finish(err));
    child.once("close", code => {
      if (code !== 0) return finish(new Error(stderr.trim() || `yt-dlp terminou com código ${code}`));
      try { finish(null, JSON.parse(stdout)); }
      catch { finish(new Error("yt-dlp retornou JSON inválido")); }
    });
  });
}

async function searchYouTubeByName(query) {
  const normalizedQuery = String(query || "").trim().slice(0, 200);
  if (!normalizedQuery) throw new Error("Informe o nome para pesquisar no YouTube");

  // Pesquisa principal via yt-search, sem precisar executar yt-dlp para localizar o vídeo.
  try {
    const results = await yts(normalizedQuery);
    const video = results?.videos?.[0];
    if (video?.videoId && video?.title) {
      return {
        id: String(video.videoId),
        title: String(video.title).slice(0, 500),
        url: String(video.url || ("https://www.youtube.com/watch?v=" + video.videoId)),
        description: String(video.description || "").slice(0, 3000),
        thumbnail: String(video.thumbnail || "").slice(0, 2000),
        duration: Number(video.seconds || 0) || null
      };
    }
  } catch (error) {
    console.warn("yt-search falhou; tentando pesquisa via yt-dlp:", error.message);
  }

  // Fallback se a pesquisa por yt-search falhar.
  const data = await runYtDlpJson([
    "--dump-single-json", "--skip-download",
    "--", "ytsearch1:" + normalizedQuery
  ], { timeoutMs: 45_000, maxOutputBytes: 1024 * 1024 });
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const video = entries[0] || data;
  if (!video?.id || !video?.title) throw new Error("Nenhum resultado encontrado no YouTube");
  return {
    id: String(video.id),
    title: String(video.title).slice(0, 500),
    url: String(video.webpage_url || ("https://www.youtube.com/watch?v=" + video.id)),
    description: String(video.description || "").slice(0, 3000),
    thumbnail: String(video.thumbnail || "").slice(0, 2000),
    duration: Number(video.duration || 0) || null
  };
}

async function getYouTubePlaylist(url) {
  const data = await runYtDlpJson([
    "--flat-playlist", "--dump-single-json", "--skip-download",
    "--playlist-end", "100", "--", url
  ], { timeoutMs: 90_000, maxOutputBytes: 4 * 1024 * 1024 });
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const tracks = entries.filter(item => item && item.id).map((item, index) => ({
    id: String(item.id),
    title: String(item.title || ("Vídeo " + (index + 1))).slice(0, 300),
    url: "https://www.youtube.com/watch?v=" + item.id,
    thumbnail: String(item.thumbnails?.at?.(-1)?.url || item.thumbnail || "").slice(0, 2000),
    duration: Number(item.duration || 0) || null
  }));
  if (!tracks.length) throw new Error("Nenhum vídeo encontrado nessa playlist");
  return {
    title: String(data.title || "Playlist do YouTube").slice(0, 300),
    total: tracks.length,
    limited: tracks.length >= 100,
    tracks
  };
}



const PORT = Number(process.env.PORT || 8000);
const API_KEY = process.env.API_KEY || "";
const MAX_BODY = 256 * 1024;
const MAX_MEDIA_BODY = 24 * 1024 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const PYTHON = process.env.PYTHON_PATH || "python";
const YTDLP_TIMEOUT_MS = 180_000;


function searchPinterest(query, min, max) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ["./pinterest_search.py"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1500).unref();
      if (!settled) {
        settled = true;
        reject(new Error("Tempo limite da pesquisa Pinterest"));
      }
    }, 45_000);
    timeout.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
        child.kill("SIGTERM");
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error("Resposta Pinterest excedeu o limite"));
        }
      }
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-3000); });
    child.once("error", err => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.once("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(stderr || `pinterest-dl terminou com código ${code}`));
      try {
        const data = JSON.parse(stdout);
        if (!Array.isArray(data)) throw new Error("Formato de resposta inválido");
        resolve(data.slice(0, max));
      } catch (err) {
        reject(new Error("Não foi possível interpretar a resposta do pinterest-dl: " + err.message));
      }
    });
    child.stdin.end(JSON.stringify({ query, min, max }));
  });
}
function normalizePinterestImageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "i.pinimg.com") return "";
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch { return ""; }
}

function dedupePinterestResults(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || typeof item.src !== "string") continue;
    const normalizedSrc = normalizePinterestImageUrl(item.src);
    if (!normalizedSrc) continue;
    const id = item.id == null ? "" : String(item.id).trim();
    const idKey = id ? "id:" + id : "";
    const srcKey = "src:" + normalizedSrc;
    if ((idKey && seen.has(idKey)) || seen.has(srcKey)) continue;
    if (idKey) seen.add(idKey);
    seen.add(srcKey);
    unique.push(item);
  }
  return unique;
}

async function sendPinterestImage(payload, res) {
  if (typeof payload.src !== "string" || !payload.src.trim()) {
    return sendJson(res, 400, { error: "Informe a URL da imagem no campo src" });
  }
  let imageUrl;
  try { imageUrl = new URL(payload.src); }
  catch { return sendJson(res, 400, { error: "URL da imagem inválida" }); }
  if (imageUrl.protocol !== "https:" || imageUrl.hostname !== "i.pinimg.com" ||
      imageUrl.username || imageUrl.password || imageUrl.port) {
    return sendJson(res, 400, { error: "Apenas URLs HTTPS de imagens em i.pinimg.com são aceitas" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  timeout.unref();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });

  try {
    const upstream = await fetch(imageUrl, {
      headers: { "user-agent": "Mozilla/5.0 MelissaDownloaderAPI/3.1" },
      redirect: "error",
      signal: controller.signal
    });
    if (!upstream.ok || !upstream.body) {
      return sendJson(res, 502, { error: "Não foi possível baixar a imagem do Pinterest", upstream_status: upstream.status });
    }
    const contentType = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) {
      await upstream.body.cancel().catch(() => {});
      return sendJson(res, 502, { error: "O Pinterest não retornou um arquivo de imagem" });
    }
    const declaredLength = Number(upstream.headers.get("content-length") || 0);
    const maxImageBytes = 15 * 1024 * 1024;
    if (declaredLength > maxImageBytes) {
      await upstream.body.cancel().catch(() => {});
      return sendJson(res, 413, { error: "Imagem excede o limite de 15 MiB" });
    }

    // GIFs continuam animados e seguem o caminho antigo do bot.
    // Imagens estáticas são normalizadas no servidor para WebP 512x512.
    const chunks = [];
    let bytes = 0;
    for await (const chunk of Readable.fromWeb(upstream.body)) {
      bytes += chunk.length;
      if (bytes > maxImageBytes) {
        return sendJson(res, 413, { error: "Imagem excedeu o limite de 15 MiB" });
      }
      chunks.push(chunk);
    }
    if (!bytes) return sendJson(res, 502, { error: "O Pinterest retornou uma imagem vazia" });
    const input = Buffer.concat(chunks);
    if (contentType === "image/gif" || /\.gif(?:[?#]|$)/i.test(imageUrl.pathname)) {
      res.writeHead(200, {
        "content-type": "image/gif",
        "content-disposition": 'inline; filename="pinterest-image.gif"',
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-length": String(input.length)
      });
      return res.end(input);
    }

    const image = sharp(input, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize(512, 512, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
        withoutEnlargement: false
      });
    let output = await image.clone()
      .webp({ quality: 80, effort: 3, smartSubsample: true })
      .toBuffer();
    if (output.length > 900 * 1024) {
      output = await image.webp({ quality: 55, effort: 4, smartSubsample: true }).toBuffer();
    }

    res.writeHead(200, {
      "content-type": "image/webp",
      "content-disposition": 'inline; filename="pinterest-sticker.webp"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-length": String(output.length),
      "x-sticker-prepared": "1",
      "x-sticker-width": "512",
      "x-sticker-height": "512"
    });
    return res.end(output);
  } catch (err) {
    if (res.destroyed || err.name === "AbortError") return;
    if (!res.headersSent) sendJson(res, 502, { error: "Falha ao baixar a imagem do Pinterest" });
    else if (!res.destroyed) res.destroy(err);
  } finally { clearTimeout(timeout); }
}


function createStickerExif(packname, publisher) {
  const json = Buffer.from(JSON.stringify({
    "sticker-pack-id": "melissa-downloader-api",
    "sticker-pack-name": packname,
    "sticker-pack-publisher": publisher,
    emojis: ["🌸"]
  }), "utf-8");
  const exifAttr = Buffer.from([
    0x49, 0x49, 0x2a, 0x00,
    0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00,
    0x00, 0x00
  ]);
  const exif = Buffer.concat([exifAttr, json]);
  exif.writeUIntLE(json.length, 14, 4);
  return exif;
}

async function addStickerMetadata(file, packname, publisher) {
  const image = new webp.Image();
  await image.load(file);
  image.exif = createStickerExif(packname, publisher);
  await image.save(file);
}

async function processStickerPack(payload, res) {
  if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 60) {
    return sendJson(res, 400, { error: "Informe items com 1 a 60 mídias." });
  }
  const packname = String(payload.packname || "Figurinhas").trim().slice(0, 128) || "Figurinhas";
  const publisher = String(payload.publisher || "Melissa").trim().slice(0, 128) || "Melissa";
  const workDir = await mkdtemp(join(tmpdir(), "melissa-stickers-"));
  const results = [];
  let totalOutput = 0;
  try {
    for (let i = 0; i < payload.items.length; i++) {
      const item = payload.items[i];
      if (!item || typeof item.src !== "string") {
        results.push({ index: i, ok: false, error: "URL da mídia inválida" });
        continue;
      }
      let mediaUrl;
      try { mediaUrl = new URL(item.src); } catch {}
      if (!mediaUrl || mediaUrl.protocol !== "https:" ||
          !(mediaUrl.hostname === "pinimg.com" || mediaUrl.hostname.endsWith(".pinimg.com")) ||
          mediaUrl.username || mediaUrl.password || mediaUrl.port) {
        results.push({ index: i, ok: false, error: "Apenas URLs HTTPS da CDN do Pinterest são aceitas" });
        continue;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      timer.unref();
      try {
        const upstream = await fetch(mediaUrl, {
          headers: { "user-agent": "Mozilla/5.0 MelissaDownloaderAPI/3.1" },
          redirect: "error",
          signal: controller.signal
        });
        if (!upstream.ok || !upstream.body) {
          results.push({ index: i, ok: false, error: "Falha ao baixar mídia", status: upstream.status });
          continue;
        }
        const type = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!type.startsWith("image/") && !type.startsWith("video/")) {
          await upstream.body.cancel().catch(() => {});
          results.push({ index: i, ok: false, error: "O endereço não retornou imagem ou vídeo" });
          continue;
        }
        const chunks = [];
        let bytes = 0;
        for await (const chunk of Readable.fromWeb(upstream.body)) {
          bytes += chunk.length;
          if (bytes > 15 * 1024 * 1024) throw new Error("Mídia excede 15 MiB");
          chunks.push(chunk);
        }
        const input = Buffer.concat(chunks);
        if (!input.length) throw new Error("Mídia vazia");
        const inputPath = join(workDir, `input-${i}`);
        const outputPath = join(workDir, `sticker-${i}.webp`);
        await writeFile(inputPath, input);
        const animated = type === "image/gif" || type.startsWith("video/") ||
          /\.(gif|mp4|webm|mov)(?:[?#]|$)/i.test(mediaUrl.pathname) || item.animated === true;
        if (animated) {
          await new Promise((resolve, reject) => {
            const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
              "-t", "10", "-vf",
              "fps=15,scale=512:512:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
              "-an", "-loop", "0", "-c:v", "libwebp_anim", "-quality", "70",
              "-compression_level", "4", outputPath];
            const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
            let stderr = "";
            const timeout = setTimeout(() => child.kill("SIGKILL"), 90_000);
            child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
            child.on("error", error => { clearTimeout(timeout); reject(error); });
            child.on("close", code => {
              clearTimeout(timeout);
              if (code === 0) resolve();
              else reject(new Error(stderr || "FFmpeg falhou ao converter a mídia"));
            });
          });
        } else {
          let image = sharp(input, { limitInputPixels: 40_000_000 }).rotate().resize(512, 512, {
            fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }
          });
          let output = await image.webp({ quality: 80, effort: 3, smartSubsample: true }).toBuffer();
          if (output.length > 900 * 1024) output = await image.webp({ quality: 55, effort: 4, smartSubsample: true }).toBuffer();
          await writeFile(outputPath, output);
        }
        await addStickerMetadata(outputPath, packname, publisher);
        const output = await readFile(outputPath);
        if (!output.length || output.length > 900 * 1024) throw new Error("Figurinha processada excede 900 KiB");
        totalOutput += output.length;
        if (totalOutput > 20 * 1024 * 1024) throw new Error("O pack processado excedeu 20 MiB");
        results.push({ index: i, ok: true, contentType: "image/webp", data: output.toString("base64"), animated });
      } catch (error) {
        results.push({ index: i, ok: false, error: String(error?.message || "Falha ao processar mídia").slice(0, 250) });
      } finally {
        clearTimeout(timer);
      }
    }
    return sendJson(res, 200, { ok: true, total: payload.items.length, processed: results.filter(x => x.ok).length, results });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}


async function addStickerMetadataBuffer(buffer, packname, publisher) {
  const directory = await mkdtemp(join(tmpdir(), "sticker-metadata-"));
  const file = join(directory, "sticker.webp");
  try {
    await writeFile(file, buffer);
    await addStickerMetadata(file, packname, publisher);
    return await readFile(file);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function processSingleMedia(payload, pathname, res) {
  if (typeof payload.data !== "string" || !payload.data.trim()) {
    return sendJson(res, 400, { error: "Informe a mídia em base64 no campo data." });
  }
  if (payload.data.length > 16 * 1024 * 1024) {
    return sendJson(res, 413, { error: "A mídia excede o limite de 12 MiB." });
  }
  const input = Buffer.from(payload.data, "base64");
  if (!input.length || input.length > 12 * 1024 * 1024) {
    return sendJson(res, 413, { error: "Mídia vazia ou acima de 12 MiB." });
  }

  try {
    let output;
    let contentType;
    let filename;
    if (pathname === "/media/sticker") {
      const animated = payload.animated === true;
      if (animated) {
        const directory = await mkdtemp(join(tmpdir(), "media-sticker-"));
        try {
          const inputPath = join(directory, "input-media");
          const outputPath = join(directory, "sticker.webp");
          await writeFile(inputPath, input);
          await new Promise((resolve, reject) => {
            const child = spawn("ffmpeg", [
              "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
              "-t", "10", "-vf",
              "fps=10,scale=512:512:force_original_aspect_ratio=increase,crop=512:512",
              "-an", "-loop", "0", "-c:v", "libwebp_anim", "-quality", "65",
              "-compression_level", "4", outputPath
            ], { stdio: ["ignore", "ignore", "pipe"] });
            let stderr = "";
            const timeout = setTimeout(() => child.kill("SIGKILL"), 90_000);
            child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
            child.once("error", error => { clearTimeout(timeout); reject(error); });
            child.once("close", code => {
              clearTimeout(timeout);
              code === 0 ? resolve() : reject(new Error(stderr || "FFmpeg falhou ao criar figurinha animada."));
            });
          });
          output = await readFile(outputPath);
        } finally {
          await rm(directory, { recursive: true, force: true }).catch(() => {});
        }
      } else {
        output = await sharp(input, { limitInputPixels: 40_000_000 })
          .rotate()
          .resize(512, 512, { fit: "cover", position: "centre" })
          .webp({ quality: 80, effort: 3, smartSubsample: true })
          .toBuffer();
      }
      const packname = String(payload.packname || "Figurinhas").trim().slice(0, 128) || "Figurinhas";
      const publisher = String(payload.publisher || "Melissa").trim().slice(0, 128) || "Melissa";
      output = await addStickerMetadataBuffer(output, packname, publisher);
      if (!output.length || output.length > 1024 * 1024) {
        return sendJson(res, 413, { error: "A figurinha ultrapassou 1 MiB." });
      }
      contentType = "image/webp";
      filename = "sticker.webp";
    } else if (pathname === "/media/toimg") {
      output = await sharp(input, { limitInputPixels: 40_000_000 })
        .rotate()
        .png({ compressionLevel: 6, adaptiveFiltering: true })
        .toBuffer();
      contentType = "image/png";
      filename = "image.png";
    } else if (pathname === "/media/hd") {
      const profiles = {
        balanced: { contrast: 1.12, brightness: 0.01, saturation: 1.12, sharp: 0.45 },
        anime: { contrast: 1.10, brightness: 0.005, saturation: 1.16, sharp: 0.35 },
        sharp: { contrast: 1.04, brightness: 0, saturation: 1.02, sharp: 0.72 },
        vivid: { contrast: 1.06, brightness: 0.005, saturation: 1.24, sharp: 0.25 },
        natural: { contrast: 1.05, brightness: 0.005, saturation: 1.04, sharp: 0.22 },
        beauty: { contrast: 1.06, brightness: 0.012, saturation: 1.08, sharp: 0.28 }
      };
      const profile = profiles[payload.profile] || profiles.balanced;
      output = await sharp(input, { limitInputPixels: 40_000_000 })
        .rotate()
        .modulate({ saturation: profile.saturation, brightness: 1 + profile.brightness })
        .linear(profile.contrast, profile.brightness * 255)
        .sharpen(profile.sharp)
        .jpeg({ quality: 92, mozjpeg: true })
        .toBuffer();
      contentType = "image/jpeg";
      filename = "image-hd.jpg";
    } else {
      return sendJson(res, 404, { error: "Rota de mídia não encontrada." });
    }

    res.writeHead(200, {
      "content-type": contentType,
      "content-disposition": 'attachment; filename="' + filename + '"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-length": String(output.length)
    });
    return res.end(output);
  } catch (error) {
    console.error("Falha no processamento de mídia:", pathname, error.message);
    return sendJson(res, 502, { error: "Falha ao processar a mídia na nuvem.", details: String(error.message || "").slice(0, 300) });
  }
}

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

function isInstagramUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["instagram.com", "www.instagram.com", "m.instagram.com"].includes(url.hostname) &&
      !url.username && !url.password;
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

async function readJson(req, maxBody = MAX_BODY) {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString("utf8");
    if (Buffer.byteLength(body) > maxBody) {
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

const TIKWM_REQUEST_INTERVAL_MS = 2_000;
let nextTikwmRequestAt = 0;

// Limita globalmente o início das chamadas ao TikWM neste processo,
// inclusive quando vários downloads chegam ao mesmo tempo.
async function waitForTikwmRequestSlot() {
  const now = Date.now();
  const scheduledAt = Math.max(now, nextTikwmRequestAt);
  nextTikwmRequestAt = scheduledAt + TIKWM_REQUEST_INTERVAL_MS;
  const delay = scheduledAt - now;
  if (delay > 0) {
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

async function streamTikTok(payload, req, res) {
  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    const form = new URLSearchParams({ url: payload.url, hd: "1" });
    await waitForTikwmRequestSlot();
    if (abortController.signal.aborted) return;
    const apiResponse = await fetch("https://www.tikwm.com/api/", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "user-agent": "Mozilla/5.0 MelissaDownloaderAPI/3.1"
      },
      body: form,
      signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(20_000)])
    });

    if (!apiResponse.ok) throw new Error("TikWM respondeu com HTTP " + apiResponse.status);

    const result = await apiResponse.json();
    const directUrl = result?.data?.hdplay || result?.data?.play;
    if (result?.code !== 0 || typeof directUrl !== "string") {
      throw new Error("TikWM não conseguiu resolver esse vídeo");
    }

    const videoUrl = new URL(directUrl);
    if (videoUrl.protocol !== "https:") throw new Error("TikWM retornou um endereço de mídia não seguro");

    const videoResponse = await fetch(videoUrl, {
      headers: { "user-agent": "Mozilla/5.0 MelissaDownloaderAPI/3.1" },
      signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(90_000)])
    });

    if (!videoResponse.ok || !videoResponse.body) {
      throw new Error("Não foi possível abrir o vídeo retornado pelo TikWM");
    }

    const declaredLength = Number(videoResponse.headers.get("content-length") || 0);
    if (declaredLength > MAX_VIDEO_BYTES) {
      await videoResponse.body.cancel().catch(() => {});
      return sendJson(res, 413, { error: "Vídeo excede o limite de 500 MiB" });
    }

    const tiktokTitle = String(result?.data?.title || "").slice(0, 500);
    const tiktokCover = String(result?.data?.origin_cover || result?.data?.cover || result?.data?.dynamic_cover || "");
    res.writeHead(200, {
      "content-type": videoResponse.headers.get("content-type") || "video/mp4",
      "content-disposition": 'attachment; filename="tiktok-video.mp4"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...metadataHeaders({ title: tiktokTitle, description: tiktokTitle, thumbnail: tiktokCover }),
      ...(declaredLength ? { "content-length": String(declaredLength) } : {})
    });

    let bytes = 0;
    const sizeGuard = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_VIDEO_BYTES) return callback(new Error("Vídeo excedeu o limite de 500 MiB"));
        callback(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(videoResponse.body), sizeGuard, res);
    return;
  } catch (err) {
    if (err.name === "AbortError" || res.destroyed) return;
    if (res.headersSent) {
      if (!res.destroyed) res.destroy(err);
      return;
    }
    console.warn("TikWM falhou; tentando fallback yt-dlp no servidor:", err.message);
  }

  // Fallback remoto próprio: se TikWM cair ou limitar requisições, baixa com yt-dlp.
  // O vídeo é transmitido em streaming, sem guardar o arquivo inteiro em disco ou RAM.
  return streamTikTokWithYtDlp(payload.url, req, res, abortController.signal);
}

async function streamTikTokWithYtDlp(videoUrl, req, res, signal) {
  let parsed;
  try { parsed = new URL(videoUrl); } catch {}
  if (!parsed || parsed.protocol !== "https:" ||
      !["tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"].includes(parsed.hostname) ||
      parsed.username || parsed.password) {
    return sendJson(res, 400, { error: "URL HTTPS do TikTok inválida" });
  }

  const attempts = [
    { label: "padrão", args: [] },
    { label: "Chrome via curl_cffi", args: ["--impersonate", "chrome"] }
  ];
  let lastError;

  for (const attempt of attempts) {
    if (signal?.aborted || res.destroyed) return;
    let child;
    let timer;
    let stderr = "";
    let abortChild;
    let onResponseClose;
    let closeResolve;
    const closePromise = new Promise(resolve => { closeResolve = resolve; });

    try {
      const args = [
        "--no-playlist", "--no-warnings", "--no-progress",
        "--js-runtimes", "node", "--remote-components", "ejs:github",
        ...attempt.args,
        "--max-filesize", "500M",
        "-f", "best[ext=mp4]/best",
        "-o", "-",
        "--", videoUrl
      ];
      child = spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-3000); });
      child.once("close", (code, childSignal) => closeResolve({ code, signal: childSignal }));

      const killChild = () => {
        if (child && child.exitCode === null) child.kill("SIGTERM");
        setTimeout(() => {
          if (child && child.exitCode === null) child.kill("SIGKILL");
        }, 1500).unref();
      };
      abortChild = killChild;
      signal?.addEventListener("abort", abortChild, { once: true });
      onResponseClose = () => { if (!res.writableEnded) killChild(); };
      res.once("close", onResponseClose);
      timer = setTimeout(killChild, YTDLP_TIMEOUT_MS);
      timer.unref();

      let firstChunk;
      try {
        firstChunk = await new Promise((resolve, reject) => {
          let done = false;
          const finish = (error, value) => {
            if (done) return;
            done = true;
            child.stdout.removeListener("data", onData);
            child.removeListener("error", onError);
            child.removeListener("close", onCloseBeforeData);
            error ? reject(error) : resolve(value);
          };
          const onData = chunk => {
            child.stdout.pause();
            finish(null, chunk);
          };
          const onError = error => finish(error);
          const onCloseBeforeData = code => {
            if (code !== 0) finish(new Error(stderr.trim() || "yt-dlp encerrou sem vídeo (código " + code + ")"));
            else finish(new Error("yt-dlp terminou sem produzir vídeo"));
          };
          child.stdout.once("data", onData);
          child.once("error", onError);
          child.once("close", onCloseBeforeData);
          if (signal?.aborted) finish(new Error("Pedido cancelado pelo cliente"));
        });
      } catch (error) {
        if (signal?.aborted || res.destroyed) return;
        lastError = error;
        console.warn("TikTok yt-dlp (" + attempt.label + ") falhou antes do envio:", error.message);
        killChild();
        if (attempt === attempts[attempts.length - 1]) break;
        continue;
      }

      if (signal?.aborted || res.destroyed) {
        killChild();
        return;
      }

      res.writeHead(200, {
        "content-type": "video/mp4",
        "content-disposition": 'attachment; filename="tiktok-video.mp4"',
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      });

      let bytes = 0;
      const sizeGuard = new Transform({
        transform(chunk, encoding, callback) {
          bytes += chunk.length;
          if (bytes > MAX_VIDEO_BYTES) return callback(new Error("Vídeo excedeu o limite de 500 MiB"));
          callback(null, chunk);
        },
        flush(callback) {
          closePromise.then(({ code, signal: childSignal }) => {
            if (code !== 0) {
              callback(new Error(stderr.trim() || "yt-dlp encerrou com código " + code + (childSignal ? " (" + childSignal + ")" : "")));
            } else {
              callback();
            }
          }, callback);
        }
      });

      // Recoloca o primeiro bloco para que o pipeline envie todos os bytes.
      child.stdout.unshift(firstChunk);
      child.stdout.resume();
      await pipeline(child.stdout, sizeGuard, res);
      return;
    } catch (error) {
      lastError = error;
      if (res.destroyed) return;
      if (res.headersSent) {
        console.error("Falha no meio do streaming TikTok:", error.message);
        if (!res.destroyed) res.destroy(error);
        return;
      }
      console.warn("TikTok yt-dlp (" + attempt.label + ") falhou:", error.message);
      if (attempt === attempts[attempts.length - 1]) break;
    } finally {
      clearTimeout(timer);
      if (abortChild) signal?.removeEventListener("abort", abortChild);
      if (onResponseClose) res.removeListener("close", onResponseClose);
      if (child && child.exitCode === null) child.kill("SIGTERM");
    }
  }

  if (!res.destroyed && !res.headersSent) {
    return sendJson(res, 502, {
      error: "TikWM e yt-dlp do servidor falharam",
      details: String(lastError?.message || "Erro desconhecido").slice(0, 900)
    });
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
  const mediaUrl = findDeepStringChildFirst(downloadPayload, [
    "download_url", "downloadUrl", "direct_url", "directUrl",
    "file_url", "fileUrl", "media_url", "mediaUrl", "url"
  ]);
  if (!mediaUrl || mediaUrl === videoUrl) throw new Error("VideoScale não retornou uma URL de mídia");
  let parsedMediaUrl;
  try {
    parsedMediaUrl = new URL(mediaUrl, VIDEOSCALE_BASE_URL);
  } catch {
    throw new Error("VideoScale retornou uma URL de mídia inválida");
  }
  // Algumas respostas retornam URLs HTTP ou relativas. Converte HTTP para HTTPS,
  // sem aceitar credenciais embutidas nem protocolos diferentes de HTTP(S).
  if (parsedMediaUrl.protocol === "http:") parsedMediaUrl.protocol = "https:";
  if (parsedMediaUrl.protocol !== "https:" || parsedMediaUrl.username || parsedMediaUrl.password) {
    throw new Error("VideoScale retornou uma URL de mídia não segura");
  }

  if (mode === "audio") {
    // Produz um M4A completo em disco antes de responder. Evita M4A fragmentado
    // em streaming, que alguns clientes do WhatsApp não conseguem reproduzir.
    const directory = await mkdtemp(join(tmpdir(), "videoscale-audio-"));
    const sourcePath = join(directory, "source.media");
    const outputPath = join(directory, "audio.m4a");
    let activeChild = null;
    try {
      const mediaResponse = await fetch(parsedMediaUrl, {
        headers: { "user-agent": "MelissaDownloaderAPI/3.1" },
        signal: AbortSignal.timeout(60_000),
        redirect: "follow"
      });
      if (!mediaResponse.ok || !mediaResponse.body) throw new Error(`VideoScale mídia HTTP ${mediaResponse.status}`);
      let bytes = 0;
      const limiter = new Transform({ transform(chunk, encoding, callback) {
        bytes += chunk.length;
        callback(bytes > 500 * 1024 * 1024 ? new Error("Áudio do VideoScale excede 500 MiB") : null, chunk);
      }});
      await pipeline(Readable.fromWeb(mediaResponse.body), limiter, createWriteStream(sourcePath, { flags: "wx" }));
      if (!bytes) throw new Error("VideoScale retornou áudio vazio");
      await new Promise((resolve, reject) => {
        let stderr = "";
        let settled = false;
        let timeout;
        const finish = error => { if (settled) return; settled = true; clearTimeout(timeout); error ? reject(error) : resolve(); };
        activeChild = spawn(process.env.FFMPEG_PATH || "ffmpeg", [
          "-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath,
          "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "128k",
          "-ar", "44100", "-ac", "2", "-movflags", "+faststart", "-f", "ipod", outputPath
        ], { stdio: ["ignore", "ignore", "pipe"] });
        timeout = setTimeout(() => { activeChild.kill("SIGTERM"); finish(new Error("Tempo limite convertendo áudio VideoScale")); }, 180_000);
        timeout.unref();
        activeChild.stderr.setEncoding("utf8");
        activeChild.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
        activeChild.once("error", finish);
        activeChild.once("close", (code, signal) => code === 0 ? finish() : finish(new Error(`FFmpeg falhou (${code}/${signal || "sem sinal"}): ${stderr.slice(-800)}`)));
      });
      const info = await stat(outputPath);
      if (!info.isFile() || info.size <= 0) throw new Error("FFmpeg gerou M4A vazio");
      if (info.size > 500 * 1024 * 1024) throw new Error("Áudio convertido excede 500 MiB");
      if (res.destroyed) return;
      res.writeHead(200, {
        "content-type": "audio/mp4",
        "content-disposition": 'attachment; filename="audio.m4a"',
        "content-length": String(info.size),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-audio-format": "m4a-aac"
      });
      await pipeline(createReadStream(outputPath), res);
      console.log("VideoScale fallback convertido para M4A/AAC", { bytes: info.size });
    } finally {
      if (activeChild && activeChild.exitCode === null) activeChild.kill("SIGTERM");
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
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

function getYtDlpMetadata(videoUrl, platform, useImpersonation = false) {
  return new Promise((resolve, reject) => {
    const args = [
      "--no-playlist", "--no-warnings", "--dump-single-json", "--skip-download",
      "--js-runtimes", "node", "--remote-components", "ejs:github",
      ...(useImpersonation ? ["--impersonate", "chrome"] : []),
      "--", videoUrl
    ];
    const child = spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) { settled = true; reject(new Error("Tempo limite lendo metadados")); }
    }, 25_000);
    timeout.unref();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error ? reject(error) : resolve(value);
    };
    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > 1024 * 1024) {
        child.kill("SIGTERM");
        finish(new Error("Metadados excederam o limite"));
      }
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-1500); });
    child.once("error", err => finish(err));
    child.once("close", code => {
      if (code !== 0) return finish(new Error(stderr || "yt-dlp não retornou metadados"));
      try {
        const data = JSON.parse(stdout);
        finish(null, {
          title: String(data.title || "").slice(0, 500),
          description: String(data.description || "").slice(0, 5000),
          thumbnail: String(data.thumbnail || "").slice(0, 2000)
        });
      } catch { finish(new Error("Metadados JSON inválidos")); }
    });
  });
}

function metadataHeaders(metadata) {
  const headers = {};
  if (metadata?.title) headers["x-media-title-b64"] = Buffer.from(metadata.title, "utf8").toString("base64url");
  if (metadata?.description) headers["x-media-description-b64"] = Buffer.from(metadata.description, "utf8").toString("base64url");
  if (metadata?.thumbnail && /^https:\/\//i.test(metadata.thumbnail)) headers["x-media-thumbnail-url"] = metadata.thumbnail;
  return headers;
}

async function streamYouTubeMergedFallback(videoUrl, res, metadata) {
  // Último recurso para vídeos sem formato combinado: o yt-dlp baixa os fluxos
  // separados e usa FFmpeg para muxar sem recodificar. O fallback usa disco
  // temporário apenas quando a transmissão direta falha.
  const directory = await mkdtemp(join(tmpdir(), "yt-merge-"));
  let child;
  let stderr = "";
  let timedOut = false;
  const args = [
    "--no-playlist", "--no-warnings", "--no-progress",
    "--js-runtimes", "node", "--remote-components", "ejs:github",
    "--max-filesize", "500M",
    "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]",
    "--merge-output-format", "mp4",
    "-o", join(directory, "video.%(ext)s"),
    "--", videoUrl
  ];
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        error ? reject(error) : resolve();
      };
      child = spawn(YTDLP, args, { stdio: ["ignore", "ignore", "pipe"] });
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2000).unref();
        finish(new Error("Tempo limite do fallback FFmpeg excedido"));
      }, YTDLP_TIMEOUT_MS);
      timeout.unref();
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-3000); });
      child.once("error", error => finish(error));
      child.once("close", code => {
        if (code === 0) finish();
        else finish(new Error((timedOut ? "Tempo limite; " : "") + (stderr.trim() || `yt-dlp/FFmpeg encerrou com código ${code}`)));
      });
      res.once("close", () => {
        if (!res.writableEnded && child?.exitCode === null) child.kill("SIGTERM");
      });
    });

    const files = await readdir(directory);
    const outputName = files.find(name => name.toLowerCase().endsWith(".mp4"));
    if (!outputName) throw new Error("FFmpeg não gerou um MP4 combinado; confira se FFmpeg está instalado");
    const outputPath = join(directory, outputName);
    const info = await stat(outputPath);
    if (!info.isFile() || info.size <= 0) throw new Error("O MP4 combinado ficou vazio");
    if (info.size > MAX_VIDEO_BYTES) throw new Error("Vídeo combinado excede o limite de 500 MiB");
    if (res.destroyed) return;
    res.writeHead(200, {
      "content-type": "video/mp4",
      "content-disposition": 'attachment; filename="video.mp4"',
      "content-length": String(info.size),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...metadataHeaders(metadata)
    });
    await pipeline(createReadStream(outputPath), res);
    console.log("Fallback de combinação YouTube concluído com FFmpeg", { bytes: info.size });
  } finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function streamYouTubeAudioM4a(videoUrl, res, metadata = null) {
  // Gera um M4A/AAC completo antes de responder, evitando MIME/extensão incompatíveis.
  const directory = await mkdtemp(join(tmpdir(), "youtube-audio-"));
  let activeChild = null;
  let timedOut = false;
  const run = (command, args, label) => new Promise((resolve, reject) => {
    let stderr = "";
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error ? reject(error) : resolve();
    };
    activeChild = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const timeout = setTimeout(() => {
      timedOut = true;
      activeChild.kill("SIGTERM");
      setTimeout(() => {
        if (activeChild && activeChild.exitCode === null) activeChild.kill("SIGKILL");
      }, 1500).unref();
      finish(new Error("Tempo limite excedido ao " + label));
    }, YTDLP_TIMEOUT_MS);
    timeout.unref();
    activeChild.stderr.setEncoding("utf8");
    activeChild.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-3000); });
    activeChild.once("error", error => finish(error));
    activeChild.once("close", code => {
      if (code === 0) finish();
      else finish(new Error((timedOut ? "Tempo limite; " : "") + (stderr.trim() || label + " terminou com código " + code)));
    });
    res.once("close", () => {
      if (!res.writableEnded && activeChild && activeChild.exitCode === null) activeChild.kill("SIGTERM");
    });
  });

  try {
    const downloadArgs = [
      "--no-playlist", "--no-warnings", "--no-progress",
      "--js-runtimes", "node", "--remote-components", "ejs:github",
      "--max-filesize", "500M",
      // Aceita qualquer contêiner/codec de áudio disponível; o FFmpeg
      // normaliza tudo para M4A/AAC depois do download.
      "-f", "bestaudio/best",
      "-o", join(directory, "source.%(ext)s"),
      "--", videoUrl
    ];
    try {
      await run(YTDLP, downloadArgs, "baixar o áudio do YouTube");
    } catch (firstError) {
      console.warn("Download de áudio falhou sem impersonação; tentando Chrome:", firstError.message);
      const retryArgs = [
        "--no-playlist", "--no-warnings", "--no-progress",
        "--js-runtimes", "node", "--remote-components", "ejs:github",
        "--max-filesize", "500M",
        "-f", "bestaudio/best",
        "--impersonate", "chrome",
        "-o", join(directory, "source.%(ext)s"),
        "--", videoUrl
      ];
      await run(YTDLP, retryArgs, "baixar o áudio do YouTube com impersonação Chrome");
    }

    const files = await readdir(directory);
    const sourceName = files.find(name => name.startsWith("source.") && !/\.(part|ytdl)$/i.test(name));
    if (!sourceName) throw new Error("yt-dlp terminou sem gerar o arquivo de áudio");
    const sourcePath = join(directory, sourceName);
    const outputPath = join(directory, "audio.m4a");

    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", sourcePath, "-vn", "-map", "0:a:0",
      "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
      "-movflags", "+faststart", "-f", "ipod", outputPath
    ], "converter o áudio para M4A/AAC");

    const info = await stat(outputPath);
    if (!info.isFile() || info.size <= 0) throw new Error("FFmpeg gerou um M4A vazio");
    if (info.size > 500 * 1024 * 1024) throw new Error("O áudio convertido excede o limite de 500 MiB");
    if (res.destroyed) return;

    res.writeHead(200, {
      "content-type": "audio/mp4",
      "content-disposition": 'attachment; filename="audio.m4a"',
      "content-length": String(info.size),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-audio-format": "m4a-aac",
      ...metadataHeaders(metadata)
    });
    await pipeline(createReadStream(outputPath), res);
    console.log("Áudio do YouTube convertido para M4A/AAC", { bytes: info.size });
  } catch (error) {
    console.error("Falha ao preparar áudio M4A:", error.message);
    // O caminho M4A prepara o arquivo antes de responder, então pode trocar
    // para o fallback remoto com segurança enquanto nenhum header foi enviado.
    if (!res.headersSent && !res.destroyed && VIDEOSCALE_USERNAME && VIDEOSCALE_PASSWORD) {
      try {
        console.warn("Tentando fallback VideoScale para áudio após falha local:", error.message);
        await streamViaVideoScale(videoUrl, res, "audio");
        return;
      } catch (fallbackError) {
        console.error("VideoScale fallback de áudio falhou:", fallbackError.message);
        if (!res.headersSent && !res.destroyed) {
          sendJson(res, 502, {
            error: "Falha no áudio do YouTube via yt-dlp/FFmpeg e VideoScale",
            yt_dlp: String(error.message || "Erro desconhecido").slice(0, 700),
            videoscale: String(fallbackError.message || "Erro desconhecido").slice(0, 700)
          });
        } else if (!res.destroyed) {
          res.destroy(fallbackError);
        }
      }
    } else if (!res.headersSent && !res.destroyed) {
      sendJson(res, 502, {
        error: "Falha ao converter o áudio do YouTube para M4A/AAC",
        details: String(error.message || "Erro desconhecido").slice(0, 900),
        ...(!VIDEOSCALE_USERNAME || !VIDEOSCALE_PASSWORD ? { fallback: "VideoScale não está configurado no ambiente do servidor" } : {})
      });
    } else if (!res.destroyed) {
      res.destroy(error);
    }
  } finally {
    if (activeChild && activeChild.exitCode === null) activeChild.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function streamYouTube(videoUrl, req, res, mode = "video", platform = "youtube", useImpersonation = false) {
  let metadata = null;
  try { metadata = await getYtDlpMetadata(videoUrl, platform, useImpersonation); }
  catch (error) { console.warn("Metadados indisponíveis:", error.message); }
  const isAudio = mode === "audio";
  const isInstagram = platform === "instagram";
  if (isAudio && !isInstagram) return streamYouTubeAudioM4a(videoUrl, res, metadata);
  // O YouTube nem sempre oferece um formato combinado moderno; o formato 18
  // costuma ser MP4 com áudio+vídeo em um único fluxo, adequado para streaming.
  // Mantemos um fallback combinado para vídeos em que o formato 18 não existe.
  const outputFormat = isInstagram
    ? "best[ext=mp4]/best"
    : isAudio
      ? "bestaudio[ext=m4a]/best[ext=m4a][acodec!=none]"
      : "18/best[ext=mp4][vcodec!=none][acodec!=none]";
  const outputType = isAudio ? "audio/mp4" : "video/mp4";
  const outputName = isInstagram ? "instagram-video.mp4" : isAudio ? "audio.m4a" : "video.mp4";
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--js-runtimes", "node",
    "--remote-components", "ejs:github",
    ...(isInstagram ? ["--extractor-retries", "2"] : []),
    ...(useImpersonation ? ["--impersonate", "chrome"] : []),
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
      "x-content-type-options": "nosniff",
      ...metadataHeaders(metadata)
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

  child.on("error", async err => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    console.error("Não foi possível iniciar yt-dlp:", err.message);
    // Se o binário local não iniciar, ainda tentamos o extrator remoto.
    if (platform === "youtube" && !res.headersSent && !res.destroyed &&
        VIDEOSCALE_USERNAME && VIDEOSCALE_PASSWORD) {
      try {
        console.warn("Tentando fallback VideoScale porque yt-dlp não iniciou");
        await streamViaVideoScale(videoUrl, res, mode);
        return;
      } catch (fallbackError) {
        console.error("VideoScale fallback após erro de inicialização falhou:", fallbackError.message);
        if (!res.headersSent && !res.destroyed) {
          sendJson(res, 502, {
            error: "yt-dlp não iniciou e o fallback VideoScale falhou",
            yt_dlp: String(err.message || "Erro ao iniciar yt-dlp").slice(0, 700),
            videoscale: String(fallbackError.message || "Erro desconhecido").slice(0, 700)
          });
        } else if (!res.destroyed) {
          res.destroy(fallbackError);
        }
      }
      return;
    }
    if (!res.headersSent && !res.destroyed) {
      sendJson(res, 503, {
        error: "yt-dlp não está instalado ou não pôde ser iniciado",
        ...(!VIDEOSCALE_USERNAME || !VIDEOSCALE_PASSWORD ? { fallback: "VideoScale não está configurado no ambiente do servidor" } : {})
      });
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

    console.error("yt-dlp falhou:", { code, signal, stderr, impersonation: useImpersonation });
    // Primeira tentativa sem curl_cffi/impersonação. Só tenta o navegador depois
    // de uma falha limpa, antes de qualquer byte ter sido enviado ao cliente.
    if (!useImpersonation && !res.headersSent && !res.destroyed) {
      console.log("Tentando novamente yt-dlp com impersonação Chrome (curl_cffi)");
      await streamYouTube(videoUrl, req, res, mode, platform, true);
      return;
    }
    if (platform === "youtube" && mode === "video" && !res.headersSent && !res.destroyed) {
      console.log("Tentando fallback FFmpeg para combinar áudio e vídeo do YouTube");
      try {
        await streamYouTubeMergedFallback(videoUrl, res, metadata);
        return;
      } catch (fallbackError) {
        console.error("Fallback FFmpeg falhou:", fallbackError.message);
        // Continua para o fallback remoto já existente, se configurado.
        stderr = (stderr + "\\nFallback FFmpeg: " + fallbackError.message).slice(-4000);
      }
    }

    if (!isInstagram && !res.headersSent && !res.destroyed && VIDEOSCALE_USERNAME && VIDEOSCALE_PASSWORD) {
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
      endpoints: ["POST /download", "POST /youtube/search", "POST /youtube/playlist", "POST /youtube/playlist/download (faixa individual)", "POST /pinterest/search", "POST /pinterest/image", "POST /media/process-pack", "POST /media/sticker", "POST /media/toimg", "POST /media/hd"]
    });
  }

  if (req.method !== "POST" || !["/download", "/pinterest/search", "/pinterest/image", "/youtube/search", "/youtube/playlist", "/youtube/playlist/download", "/media/process-pack", "/media/sticker", "/media/toimg", "/media/hd"].includes(pathname)) {
    return sendJson(res, 404, { error: "Rota não encontrada" });
  }

  if (!API_KEY || req.headers["x-api-key"] !== API_KEY) {
    return sendJson(res, 401, { error: "X-API-Key inválida ou API_KEY não configurada" });
  }

  let payload;
  try {
    payload = await readJson(req, pathname.startsWith("/media/") ? MAX_MEDIA_BODY : MAX_BODY);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: err.message });
  }


  if (pathname === "/youtube/search") {
    if (typeof payload.query !== "string" || !payload.query.trim()) {
      return sendJson(res, 400, { error: "Informe o nome no campo query" });
    }
    try {
      const result = await searchYouTubeByName(payload.query.trim().slice(0, 200));
      return sendJson(res, 200, { ok: true, result });
    } catch (err) {
      return sendJson(res, 502, { error: "Falha na pesquisa do YouTube", details: String(err.message || "").slice(0, 500) });
    }
  }

  if (pathname === "/youtube/playlist") {
    if (typeof payload.url !== "string" || !isYouTubeUrl(payload.url)) {
      return sendJson(res, 400, { error: "Informe uma URL válida do YouTube no campo url" });
    }
    try {
      const result = await getYouTubePlaylist(payload.url);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, 502, { error: "Falha ao ler a playlist do YouTube", details: String(err.message || "").slice(0, 500) });
    }
  }

  if (pathname === "/youtube/playlist/download") {
    if (typeof payload.url !== "string" || !isYouTubeUrl(payload.url)) {
      return sendJson(res, 400, { error: "Informe a URL de uma faixa do YouTube no campo url" });
    }
    let trackUrl;
    try { trackUrl = new URL(payload.url); } catch {}
    if (!trackUrl || trackUrl.searchParams.has("list")) {
      return sendJson(res, 400, { error: "Esta rota recebe uma faixa individual, não o link da playlist inteira" });
    }
    const mode = payload.mode === "audio" || payload.audio === true ? "audio" : "video";
    console.log(`[PLAYLIST DOWNLOAD] Enviando faixa individual como ${mode}: ${trackUrl.hostname}`);
    return streamYouTube(payload.url, req, res, mode, "youtube");
  }

  if (pathname === "/pinterest/image") return sendPinterestImage(payload, res);
  if (pathname === "/media/sticker" || pathname === "/media/toimg" || pathname === "/media/hd") return processSingleMedia(payload, pathname, res);
  if (pathname === "/media/process-pack") return processStickerPack(payload, res);

  if (pathname === "/pinterest/search") {
    if (typeof payload.query !== "string" || !payload.query.trim()) {
      return sendJson(res, 400, { error: "Informe uma busca no campo query" });
    }
    const query = payload.query.trim().slice(0, 200);
    const requestedMin = Number(payload.min ?? 1);
    const requestedMax = Number(payload.max ?? 20);
    if (!Number.isInteger(requestedMin) || !Number.isInteger(requestedMax)) {
      return sendJson(res, 400, { error: "Os campos min e max devem ser números inteiros" });
    }
    const min = Math.max(1, Math.min(60, requestedMin));
    const max = Math.max(1, Math.min(60, requestedMax));
    if (min > max) return sendJson(res, 400, { error: "O campo min não pode ser maior que max" });

    try {
      const candidates = [];
      const seenQueries = new Set();
      const addBatch = async (searchQuery, limit) => {
        if (seenQueries.has(searchQuery)) return;
        seenQueries.add(searchQuery);
        candidates.push(...await searchPinterest(searchQuery, 1, Math.max(1, Math.min(60, limit))));
      };
      await addBatch(query, max);
      let results = dedupePinterestResults(candidates).slice(0, max);
      const refillQueries = [`${query} fotografia`, `${query} paisagem`, `${query} fotos`];
      for (const refillQuery of refillQueries) {
        if (results.length >= max) break;
        try {
          const needed = Math.min(60, Math.max(5, max - results.length + 3));
          await addBatch(refillQuery, needed);
          results = dedupePinterestResults(candidates).slice(0, max);
        } catch (refillError) {
          console.warn("Pinterest busca complementar falhou:", refillError.message);
        }
      }
      const uniqueResults = dedupePinterestResults(candidates);
      results = uniqueResults.slice(0, max);
      return sendJson(res, 200, {
        ok: true,
        source: "pinterest-dlp",
        query,
        min_requested: min,
        max_requested: max,
        count: results.length,
        duplicates_removed: candidates.length - uniqueResults.length,
        supplemental_searches: Math.max(0, seenQueries.size - 1),
        min_met: results.length >= min,
        results
      });
    } catch (err) {
      console.error("Pinterest scraper falhou:", err.message);
      return sendJson(res, 502, { error: "Falha ao pesquisar no Pinterest", details: String(err.message || "").slice(0, 500) });
    }
  }

  if (typeof payload.url !== "string") {
    return sendJson(res, 400, { error: "Informe uma URL no campo url" });
  }

  if (isTikTokUrl(payload.url)) {
    return streamTikTok(payload, req, res);
  }

  if (isYouTubeUrl(payload.url)) {
    const mode = payload.mode === "audio" || payload.audio === true ? "audio" : "video";
    return streamYouTube(payload.url, req, res, mode, "youtube");
  }

  if (isInstagramUrl(payload.url)) {
    return streamYouTube(payload.url, req, res, "video", "instagram");
  }

  return sendJson(res, 400, {
    error: "URL não suportada. Envie um link HTTPS do TikTok, YouTube ou Instagram."
  });
});

if (!API_KEY) {
  console.error("Configure API_KEY nos secrets do Hostless.");
  process.exit(1);
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Melissa Downloader API ouvindo na porta ${PORT}`);
});