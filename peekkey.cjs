const D = require("better-sqlite3");
const crypto = require("crypto");
const db = new D(process.env.DB || "E:/proX/manager/data/tam.sqlite", { readonly: true });
const settings = db.prepare("SELECT key, value FROM settings").all();
function dec(p) {
  const [iv, tag, data] = p.replace(/^v1:/, "").split(":");
  const d = crypto.createDecipheriv("aes-256-gcm", crypto.createHash("sha256").update(settings.find(s => s.key === "encryption_key").value).digest(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}
const ids = (process.env.IDS || "20,21,8").split(",").map(Number);
for (const id of ids) {
  const row = db.prepare("SELECT id, provider, account_name FROM api_keys WHERE id = ?").get(id);
  console.log(id + "|" + row.provider + "|" + row.account_name + "|" + dec(db.prepare("SELECT api_key_enc FROM api_keys WHERE id=?").get(id).api_key_enc));
}