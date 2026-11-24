function findDeepObjects(value, predicate, found = [], depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return found;
  if (!Array.isArray(value) && predicate(value)) found.push(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    findDeepObjects(item, predicate, found, depth + 1);
  }
  return found;
}

export function chooseVideoScaleFormat(payload, mode) {
  const formats = findDeepObjects(payload, item =>
    item.FORMAT_ID !== undefined || item.format_id !== undefined || item.formatId !== undefined || item.formatID !== undefined
  );
  if (!formats.length) throw new Error("VideoScale não retornou formatos reconhecíveis");

  const formatId = item => String(item.FORMAT_ID ?? item.format_id ?? item.formatId ?? item.formatID);
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
    const aHeight = Number(a.height ?? String(a.resolution ?? "").match(/(\d+)p/)?.[1] ?? 0);
    const bHeight = Number(b.height ?? String(b.resolution ?? "").match(/(\d+)p/)?.[1] ?? 0);
    if (mode === "audio") {
      return (aHeight || Number.MAX_SAFE_INTEGER) - (bHeight || Number.MAX_SAFE_INTEGER);
    }
    const aScore = (aExt === "mp4" ? 20 : 0) + aHeight / 10000;
    const bScore = (bExt === "mp4" ? 20 : 0) + bHeight / 10000;
    return bScore - aScore;
  });
  return formatId(candidates[0]);
}
