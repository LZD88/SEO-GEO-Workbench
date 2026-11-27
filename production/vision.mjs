import { randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { HttpError } from "./http.mjs";

const probes = [
  ["deepseek", "DeepSeek"],
  ["doubao", "豆包"],
  ["qwen", "千问"],
  ["wenxin", "文心"],
];

export async function hasVerifiedVision(db, platforms, id) {
  const platform = platforms?.list().find((item) => item.id === id);
  if (!platform?.ready || !platform.vision) return false;
  const { model, routeFingerprint } = platforms.configuration(id);
  const { rowCount } = await db.query(`
    SELECT 1 FROM yaosight.vision_checks
    WHERE platform_id=$1 AND model=$2 AND route_fingerprint=$3 AND expires_at>now()
  `, [id, model, routeFingerprint]);
  return rowCount === 1;
}

export async function availablePlatforms(db, platforms) {
  const rows = platforms?.list() ?? [];
  return Promise.all(rows.map(async (platform) => ({
    ...platform, vision: await hasVerifiedVision(db, platforms, platform.id),
  })));
}

export async function verifyVision(db, platforms, id) {
  const channel = platforms.list().find((platform) => platform.id === id);
  if (!channel?.ready || !channel.vision) throw new HttpError(409, "需先配置允许识图的模型渠道。");
  const configuration = platforms.configuration(id);
  const key = [id, configuration.model, configuration.routeFingerprint];
  // If a verification attempt fails, revoke the existing capability.
  await db.query("DELETE FROM yaosight.vision_checks WHERE platform_id=$1 AND model=$2 AND route_fingerprint=$3", key);
  const first = randomInt(probes.length);
  const second = (first + 1 + randomInt(probes.length - 1)) % probes.length;
  for (const choice of [first, second]) {
    const [file] = probes[choice];
    const image = await readFile(new URL("../public/platform-icons/" + file + ".png", import.meta.url));
    const result = await platforms.answer(id,
      "识别这张图片中的 AI 品牌标志。按以下选项只回复数字，不添加其他文字。1 DeepSeek，2 豆包，3 千问，4 文心。",
      { images: [{ number: 1, dataUrl: "data:image/png;base64," + image.toString("base64") }], maxTokens: 64, webSearch: false },
    );
    if (result.text?.trim() !== String(choice + 1)) return false;
  }
  await db.query(`
    INSERT INTO yaosight.vision_checks (platform_id,model,route_fingerprint,expires_at)
    VALUES ($1,$2,$3,now()+interval '1 day')
    ON CONFLICT (platform_id,model,route_fingerprint)
      DO UPDATE SET verified_at=now(),expires_at=EXCLUDED.expires_at
  `, key);
  return true;
}
