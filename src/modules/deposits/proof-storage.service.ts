import { BadRequestException, Injectable } from "@nestjs/common";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { R2StorageService } from "./r2-storage.service";

export const MAX_PROOF_BYTES = 10 * 1024 * 1024;
export function verifyProofContent(data: Buffer, mimeType: string) {
  const valid = mimeType === "application/pdf" ? data.subarray(0, 5).toString() === "%PDF-"
    : mimeType === "image/jpeg" ? data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    : mimeType === "image/png" ? data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mimeType === "image/webp" && data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP";
  if (!valid || !data.length || data.length > MAX_PROOF_BYTES) throw new BadRequestException("El contenido del comprobante no coincide con el tipo o tamaño permitido");
}

@Injectable()
export class ProofStorageService {
  constructor(private readonly urls: R2StorageService) {}
  private client() { return new S3Client({ region: "auto", endpoint: process.env.R2_ENDPOINT, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID || "", secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "" } }); }
  private demoPath(key: string) {
    const base = resolve(process.cwd(), "private", "demo-proofs");
    const target = resolve(base, key);
    if (!target.startsWith(base + sep)) throw new BadRequestException("Archivo inválido");
    return target;
  }
  async put(key: string, data: Buffer, mimeType: string, demo: boolean) {
    verifyProofContent(data, mimeType);
    if (demo) { const path = this.demoPath(key); await mkdir(resolve(path, ".."), { recursive: true }); await writeFile(path, data); return; }
    await this.client().send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: key, Body: data, ContentType: mimeType }));
  }
  async get(key: string, demo: boolean) {
    if (demo) return readFile(this.demoPath(key));
    const object = await this.client().send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: key }));
    if (!object.Body || (object.ContentLength ?? 0) > MAX_PROOF_BYTES) throw new BadRequestException("Archivo inválido");
    return Buffer.from(await object.Body.transformToByteArray());
  }
  async verify(key: string, mimeType: string, size: number) {
    const info = await this.client().send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: key }));
    if (info.ContentLength !== size || info.ContentType !== mimeType) throw new BadRequestException("El archivo cargado no coincide con la solicitud");
    verifyProofContent(await this.get(key, false), mimeType);
  }
  uploadUrl(key: string, mimeType: string) { return this.urls.uploadUrl(key, mimeType); }
}
