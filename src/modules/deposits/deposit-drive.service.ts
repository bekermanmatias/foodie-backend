import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { RequestUser } from "../../common/auth/request-user";
import { encryptSecret, decryptSecret } from "../../common/security/encrypted-secret";
import { restaurantFeatures, requireExternalAccess, requireFeature } from "../../common/restaurant-features";
import { PrismaService } from "../prisma/prisma.service";
import { depositActor } from "./deposit-access";
import { ProofStorageService } from "./proof-storage.service";

const DRIVE_TOKEN_PREFIX = "drive-v1:";

@Injectable()
export class DepositDriveService {
  constructor(private readonly prisma: PrismaService, private readonly storage: ProofStorageService) {}
  private credentials() {
    if (!process.env.GOOGLE_DRIVE_CLIENT_ID || !process.env.GOOGLE_DRIVE_CLIENT_SECRET || !process.env.GOOGLE_DRIVE_REDIRECT_URI || !(process.env.GOOGLE_DRIVE_ENCRYPTION_SECRET || process.env.CHAT_CREDENTIAL_SECRET)) throw new ServiceUnavailableException("Falta configurar la aplicación OAuth de Google Drive");
    return { client_id: process.env.GOOGLE_DRIVE_CLIENT_ID, client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET, redirect_uri: process.env.GOOGLE_DRIVE_REDIRECT_URI };
  }
  private encryptRefreshToken(token: string) {
    const secret = process.env.GOOGLE_DRIVE_ENCRYPTION_SECRET;
    if (secret) return DRIVE_TOKEN_PREFIX + encryptSecret(token, secret);
    return encryptSecret(token);
  }
  private decryptRefreshToken(token: string) {
    if (!token.startsWith(DRIVE_TOKEN_PREFIX)) return decryptSecret(token);
    const secret = process.env.GOOGLE_DRIVE_ENCRYPTION_SECRET;
    if (!secret) throw new ServiceUnavailableException("Falta la clave de cifrado de Google Drive");
    return decryptSecret(token.slice(DRIVE_TOKEN_PREFIX.length), secret);
  }
  async status(user: RequestUser) {
    const restaurantId = await depositActor(this.prisma, user);
    const row = await this.prisma.restaurantDriveConnection.findUnique({ where: { restaurantId } });
    const demo = (await restaurantFeatures(this.prisma, restaurantId)).isDemo;
    return { demo, status: demo ? "simulated" : row?.status ?? "disconnected", rootFolderId: row?.rootFolderId, proofsFolderId: row?.proofsFolderId, generalFolderId: row?.generalFolderId, error: row?.error };
  }
  async connect(user: RequestUser) {
    const restaurantId = await depositActor(this.prisma, user, true);
    await requireExternalAccess(this.prisma, restaurantId);
    const credentials = this.credentials(); const state = randomBytes(32).toString("hex");
    const data = { stateHash: createHash("sha256").update(state).digest("hex"), stateExpiresAt: new Date(Date.now() + 600000), stateUserId: user.sub };
    await this.prisma.restaurantDriveConnection.upsert({ where: { restaurantId }, create: { restaurantId, ...data }, update: data });
    const query = new URLSearchParams({ client_id: credentials.client_id, redirect_uri: credentials.redirect_uri, response_type: "code", scope: "https://www.googleapis.com/auth/drive", access_type: "offline", prompt: "consent", state });
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${query}` };
  }
  async callback(state: string, code?: string) {
    const hash = createHash("sha256").update(state || "").digest("hex");
    const connection = await this.prisma.restaurantDriveConnection.findUnique({ where: { stateHash: hash } });
    if (!connection || !connection.stateExpiresAt || connection.stateExpiresAt < new Date()) throw new BadRequestException("La autorización venció o ya fue utilizada");
    const owner = await this.prisma.restaurantUser.findFirst({ where: { id: connection.stateUserId!, restaurantId: connection.restaurantId, role: "restaurant_owner", isActive: true } });
    if (!owner) throw new BadRequestException("El dueño ya no tiene acceso a este restaurante");
    await depositActor(this.prisma, { sub: owner.id, restaurantId: owner.restaurantId, role: owner.role, scope: "restaurant", fullName: owner.fullName, email: owner.email });
    await requireExternalAccess(this.prisma, connection.restaurantId);
    const claimed = await this.prisma.restaurantDriveConnection.updateMany({ where: { restaurantId: connection.restaurantId, stateHash: hash }, data: { stateHash: null, stateExpiresAt: null, stateUserId: null } });
    if (!claimed.count) throw new BadRequestException("La autorización ya fue utilizada");
    if (!code) throw new BadRequestException("Google no autorizó la conexión");
    const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ ...this.credentials(), code, grant_type: "authorization_code" }), signal: AbortSignal.timeout(20000) });
    const data = await response.json() as { refresh_token?: string };
    if (!response.ok || !data.refresh_token) throw new BadRequestException("Google no entregó autorización para acceso sin conexión; intentá reconectar");
    await this.prisma.restaurantDriveConnection.update({ where: { restaurantId: connection.restaurantId }, data: { encryptedRefreshToken: this.encryptRefreshToken(data.refresh_token), status: "connected", error: null } });
    return { connected: true, message: "Google Drive conectado. Podés cerrar esta ventana y volver a Foodie." };
  }
  private async api(restaurantId: string, suffix: string, init: RequestInit = {}, allowMissing = false) {
    await requireExternalAccess(this.prisma, restaurantId);
    const connection = await this.prisma.restaurantDriveConnection.findUnique({ where: { restaurantId } });
    if (!connection?.encryptedRefreshToken) throw new ConflictException("Conectá Google Drive primero");
    const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ ...this.credentials(), refresh_token: this.decryptRefreshToken(connection.encryptedRefreshToken), grant_type: "refresh_token" }), signal: AbortSignal.timeout(20000) });
    const token = await response.json() as { access_token?: string };
    if (!response.ok || !token.access_token) {
      await this.prisma.restaurantDriveConnection.update({ where: { restaurantId }, data: { status: "reconnect_required", error: "La autorización de Google venció o fue revocada" } });
      throw new ConflictException("Reconectá Google Drive");
    }
    const result = await fetch(`https://www.googleapis.com/${suffix}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(30000) });
    if (allowMissing && result.status === 404) return null;
    if (!result.ok) throw new ServiceUnavailableException(result.status === 403 ? "Google no permite acceder a esta carpeta o archivo" : `Drive no está disponible (${result.status}); podés reintentar`);
    return result.json() as Promise<any>;
  }
  async folders(user: RequestUser, pageToken?: string) {
    const restaurantId = await depositActor(this.prisma, user, true);
    if ((await restaurantFeatures(this.prisma, restaurantId)).isDemo) return { files: [{ id: "demo-root", name: "Foodie Demo" }] };
    return this.api(restaurantId, `drive/v3/files?${new URLSearchParams({ q: "mimeType='application/vnd.google-apps.folder' and trashed=false", fields: "files(id,name),nextPageToken", pageSize: "100", orderBy: "name", ...(pageToken ? { pageToken } : {}) })}`);
  }
  async setup(user: RequestUser, rootId?: string) {
    const restaurantId = await depositActor(this.prisma, user, true);
    const demo = (await restaurantFeatures(this.prisma, restaurantId)).isDemo;
    const prior = await this.prisma.restaurantDriveConnection.findUnique({ where: { restaurantId } });
    const create = async (name: string, parent?: string) => {
      if (demo) return { id: `demo-${name}` };
      if (parent) {
        const existing = await this.api(restaurantId, `drive/v3/files?${new URLSearchParams({ q: `trashed=false and mimeType='application/vnd.google-apps.folder' and name='${name}' and '${parent.replace(/'/g, "\\'")}' in parents`, fields: "files(id)", pageSize: "1" })}`);
        if (existing.files?.[0]) return existing.files[0];
      }
      return this.api(restaurantId, "drive/v3/files?fields=id", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", ...(parent ? { parents: [parent] } : {}) }) });
    };
    if (rootId && !demo) {
      const folder = await this.api(restaurantId, `drive/v3/files/${encodeURIComponent(rootId)}?fields=id,mimeType,trashed,capabilities(canAddChildren)`);
      if (folder.trashed || folder.mimeType !== "application/vnd.google-apps.folder" || !folder.capabilities?.canAddChildren) throw new BadRequestException("Seleccioná una carpeta con permiso de escritura");
    }
    const root = rootId || (prior?.status === "simulated" ? null : prior?.rootFolderId) || (await create("Foodie")).id;
    const proof = await create("Comprobantes", root); const general = await create("Archivos generales", root);
    const data = { rootFolderId: root, proofsFolderId: proof.id, generalFolderId: general.id, status: demo ? "simulated" : "connected", error: null };
    await this.prisma.restaurantDriveConnection.upsert({ where: { restaurantId }, create: { restaurantId, ...data }, update: data });
    return this.status(user);
  }
  async files(user: RequestUser, category = "proofs", pageToken?: string) {
    const restaurantId = await depositActor(this.prisma, user);
    if (category === "proofs") return this.prisma.depositProof.findMany({ where: { restaurantId }, include: { request: { include: { deposit: { include: { reservation: true } } } } }, orderBy: { receivedAt: "desc" }, take: 200 });
    const row = await this.prisma.restaurantDriveConnection.findUnique({ where: { restaurantId } });
    if ((await restaurantFeatures(this.prisma, restaurantId)).isDemo) return { files: [] };
    if (!row?.generalFolderId) throw new ConflictException("Configurá la carpeta de archivos generales");
    return this.api(restaurantId, `drive/v3/files?${new URLSearchParams({ q: `'${row.generalFolderId.replace(/'/g, "\\'")}' in parents and trashed=false`, fields: "files(id,name,webViewLink,mimeType),nextPageToken", pageSize: "100", ...(pageToken ? { pageToken } : {}) })}`);
  }
  async sync(user: RequestUser, proofId: string) {
    return this.syncForRestaurant(await depositActor(this.prisma, user), proofId);
  }
  async syncForRestaurant(restaurantId: string, proofId: string) {
    await requireFeature(this.prisma, restaurantId, "deposits");
    const proof = await this.prisma.depositProof.findFirst({ where: { id: proofId, restaurantId }, include: { request: { include: { deposit: { include: { reservation: true } } } } } });
    if (!proof) throw new NotFoundException("Comprobante no encontrado");
    if (proof.driveStatus === "synced") return proof;
    if ((await restaurantFeatures(this.prisma, restaurantId)).isDemo) return this.prisma.depositProof.update({ where: { id: proof.id }, data: { driveStatus: "simulated", driveError: null } });
    const row = await this.prisma.restaurantDriveConnection.findUnique({ where: { restaurantId } });
    if (!row?.proofsFolderId) return this.prisma.depositProof.update({ where: { id: proofId }, data: { driveStatus: "failed", driveError: "Configurá la carpeta de comprobantes para sincronizar" } });
    if (!proof.driveFileId) {
      const allocated = await this.api(restaurantId, "drive/v3/files/generateIds?count=1&space=drive");
      await this.prisma.depositProof.updateMany({ where: { id: proofId, driveFileId: null }, data: { driveFileId: allocated.ids[0] } });
    }
    // Lock this proof throughout the copy. appProperties identifies uploads after interrupted requests.
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "DepositProof" WHERE id=${proofId} FOR UPDATE`;
      const current = await tx.depositProof.findUniqueOrThrow({ where: { id: proofId } });
      if (current.driveStatus === "synced") return current;
      try {
        let file = await this.api(restaurantId, `drive/v3/files/${encodeURIComponent(current.driveFileId!)}?fields=id,webViewLink`, {}, true);
        if (!file) {
          const data = await this.storage.get(proof.objectKey, false);
          const reservation = proof.request.deposit.reservation;
          const boundary = randomBytes(16).toString("hex");
          const metadata = { id: current.driveFileId, name: `${reservation.fullName} - ${reservation.code} - Seña - ${proof.originalName}`, parents: [row.proofsFolderId], appProperties: { foodieProofId: proofId, restaurantId } };
          const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${proof.mimeType}\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--`)]);
          file = await this.api(restaurantId, "upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
        }
        return tx.depositProof.update({ where: { id: proofId }, data: { driveFileId: file.id, driveFileUrl: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`, driveStatus: "synced", driveError: null } });
      } catch (error) {
        return tx.depositProof.update({ where: { id: proofId }, data: { driveStatus: "failed", driveError: error instanceof Error ? error.message : "Error de Drive" } });
      }
    }, { timeout: 120000 });
  }
}
