import { NotificationsModule } from "../notifications/notifications.module";
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { ReservationsModule } from "../reservations/reservations.module";
import { IntegrationsController } from "./integrations.controller";
import { IntegrationsService } from "./integrations.service";

@Module({
  imports: [NotificationsModule, ReservationsModule, RealtimeModule, AuditModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService]
})
export class IntegrationsModule {}
