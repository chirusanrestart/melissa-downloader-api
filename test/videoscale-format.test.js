import test from "node:test";
import assert from "node:assert/strict";
import { chooseVideoScaleFormat } from "../videoscale-format.js";

test("lê o campo FORMAT_ID documentado pelo VideoScale", () => {
  const payload = {
    formats: [
      { FORMAT_ID: "22", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 720 }
    ]
  };

  assert.equal(chooseVideoScaleFormat(payload, "video"), "22");
});

test("mantém compatibilidade com respostas que usam format_id minúsculo", () => {
  const payload = {
    formats: [
      { format_id: "18", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 360 }
    ]
  };

  assert.equal(chooseVideoScaleFormat(payload, "video"), "18");
});
