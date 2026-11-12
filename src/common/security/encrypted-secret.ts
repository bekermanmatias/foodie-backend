import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function getKey(secret = process.env.CHAT_CREDENTIAL_SECRET || process.env.JWT_SECRET || "foodie-local-dev-secret") {
  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(value: string, secret?: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptSecret(value: string, secret?: string) {
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue) return "";
  const decipher = createDecipheriv("aes-256-gcm", getKey(secret), Buffer.from(ivValue, "base64"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64")),
    decipher.final()
  ]).toString("utf8");
}
