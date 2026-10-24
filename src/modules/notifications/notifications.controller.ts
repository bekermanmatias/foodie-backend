import { BadRequestException, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { RequestUser } from "../../common/auth/request-user";
import { NotificationsService } from "./notifications.service";

const querySchema = z.object({
  status: z.enum(["pending", "attended"]).optional(),
  unread: z.enum(["true", "false"]).optional().transform((value) => value === "true"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
});

@Controller("restaurant/notifications")
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}
  @Get() list(@CurrentUser() user: RequestUser, @Query() query: unknown) {
    const result = querySchema.safeParse(query);
    if (!result.success) throw new BadRequestException("Filtros de notificaciones inválidos");
    return this.service.list(user, result.data);
  }
  @Get("counts") counts(@CurrentUser() user: RequestUser) { return this.service.counts(user); }
  @Post(":id/read") read(@CurrentUser() user: RequestUser, @Param("id") id: string) { return this.service.read(user, id); }
  @Post(":id/attend") attend(@CurrentUser() user: RequestUser, @Param("id") id: string) { return this.service.attend(user, id); }
  @Delete(":id") remove(@CurrentUser() user: RequestUser, @Param("id") id: string) { return this.service.remove(user, id); }
}
