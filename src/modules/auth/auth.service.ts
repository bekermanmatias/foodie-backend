import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../prisma/prisma.service";
import { UnauthorizedException } from "@nestjs/common";
import { hashPassword, verifyPassword } from "../../common/security/password";
import type { TokenPayload } from "../../common/auth/token-payload";
import { createOpaqueToken, hashOpaqueToken } from "../../common/security/token-hash";
import { decryptSecret } from "../../common/security/encrypted-secret";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService
  ) {}

  private async ensurePlatformAdmin() {
    const email = process.env.PLATFORM_ADMIN_EMAIL || "emiliano@pushandpullnow.com";
    const password = process.env.PLATFORM_ADMIN_PASSWORD || "07092015Leyla@";
    const fullName = process.env.PLATFORM_ADMIN_NAME || "Emiliano";

    const existing = await this.prisma.platformUser.findUnique({ where: { email } });
    if (existing) {
      const shouldUpdateName = existing.fullName !== fullName;
      const shouldUpdatePassword = !verifyPassword(password, existing.passwordHash);

      if (shouldUpdateName || shouldUpdatePassword) {
        return this.prisma.platformUser.update({
          where: { id: existing.id },
          data: {
            fullName,
            passwordHash: shouldUpdatePassword ? hashPassword(password) : existing.passwordHash
          }
        });
      }

      return existing;
    }

    return this.prisma.platformUser.create({
      data: {
        email,
        fullName,
        passwordHash: hashPassword(password),
        role: "platform_admin"
      }
    });
  }

  async login(
    input: { email: string; password: string; context?: "platform" | "restaurant" },
    sessionMeta?: { userAgent?: string; ipAddress?: string }
  ) {
    await this.ensurePlatformAdmin();

    if (input.context === "platform") {
      const user = await this.prisma.platformUser.findUnique({ where: { email: input.email } });
      if (!user || !verifyPassword(input.password, user.passwordHash)) {
        throw new UnauthorizedException("Invalid platform credentials");
      }
      return this.issueToken({
        sub: user.id,
        scope: "platform",
        role: user.role,
        email: user.email,
        fullName: user.fullName
      }, sessionMeta);
    }

    if (!input.context) {
      const platformUser = await this.prisma.platformUser.findUnique({ where: { email: input.email } });
      if (platformUser && verifyPassword(input.password, platformUser.passwordHash)) {
        return this.issueToken({
          sub: platformUser.id,
          scope: "platform",
          role: platformUser.role,
          email: platformUser.email,
          fullName: platformUser.fullName
        }, sessionMeta);
      }
    }

    const user = await this.prisma.restaurantUser.findFirst({
      where: { email: input.email, isActive: true },
      include: { restaurant: true }
    });
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      throw new UnauthorizedException(input.context === "restaurant" ? "Invalid restaurant credentials" : "Invalid credentials");
    }

    const issued = await this.issueToken({
      sub: user.id,
      scope: "restaurant",
      role: user.role,
      email: user.email,
      fullName: user.fullName,
      restaurantId: user.restaurantId
    }, sessionMeta);

    const chatSession = user.restaurant.isDemo ? null : await this.loginToChat(user.restaurant.chatAuthEmail, user.restaurant.chatAuthSecret);

    return {
      ...issued,
      chatSession
    };
  }

  async refresh(refreshToken: string, sessionMeta?: { userAgent?: string; ipAddress?: string }) {
    const tokenHash = hashOpaqueToken(refreshToken);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: {
        platformUser: true,
        restaurantUser: true
      }
    });

    if (!record || record.revokedAt || record.expiresAt <= new Date()) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    const payload: TokenPayload = record.scope === "platform"
      ? {
          sub: record.platformUser!.id,
          scope: "platform",
          role: record.platformUser!.role,
          email: record.platformUser!.email,
          fullName: record.platformUser!.fullName
        }
      : {
          sub: record.restaurantUser!.id,
          scope: "restaurant",
          role: record.restaurantUser!.role,
          email: record.restaurantUser!.email,
          fullName: record.restaurantUser!.fullName,
          restaurantId: record.restaurantUser!.restaurantId
        };

    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: {
        revokedAt: new Date(),
        lastUsedAt: new Date()
      }
    });

    return this.issueToken(payload, sessionMeta);
  }

  async logout(refreshToken: string) {
    const tokenHash = hashOpaqueToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: {
        tokenHash,
        revokedAt: null
      },
      data: {
        revokedAt: new Date()
      }
    });
    return { ok: true };
  }

  private async issueToken(payload: TokenPayload, sessionMeta?: { userAgent?: string; ipAddress?: string }) {
    const refreshToken = createOpaqueToken();
    const refreshTokenHash = hashOpaqueToken(refreshToken);
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);

    await this.prisma.refreshToken.create({
      data: {
        tokenHash: refreshTokenHash,
        scope: payload.scope,
        platformUserId: payload.scope === "platform" ? payload.sub : null,
        restaurantUserId: payload.scope === "restaurant" ? payload.sub : null,
        expiresAt,
        userAgent: sessionMeta?.userAgent,
        ipAddress: sessionMeta?.ipAddress || null
      }
    });

    return {
      accessToken: this.jwtService.sign(payload),
      refreshToken,
      user: payload
    };
  }

  private async loginToChat(email?: string | null, encryptedPassword?: string | null) {
    if (!email || !encryptedPassword) return null;

    try {
      const password = decryptSecret(encryptedPassword);
      if (!password) return null;

      const baseUrl = process.env.CHAT_API_URL || "https://chat.pupuia.com/api";
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ email, password })
      });

      if (!response.ok) return null;
      const data = await response.json() as { token?: string; user?: unknown };
      if (!data.token || !data.user) return null;

      return {
        token: data.token,
        user: data.user
      };
    } catch {
      return null;
    }
  }
}
