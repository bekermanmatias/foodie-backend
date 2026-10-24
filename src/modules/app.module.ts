import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { CustomersModule } from "./customers/customers.module";
import { FloorPlansModule } from "./floor-plans/floor-plans.module";
import { IntegrationsModule } from "./integrations/integrations.module";
import { PrismaModule } from "./prisma/prisma.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { ReservationsModule } from "./reservations/reservations.module";
import { RestaurantsModule } from "./restaurants/restaurants.module";
import { TablesModule } from "./tables/tables.module";
import { OnlineBookingsModule } from "./online-bookings/online-bookings.module";
import { RestaurantConfigurationModule } from "./restaurant-configuration/restaurant-configuration.module";
import { GiftCardsModule } from "./gift-cards/gift-cards.module";
import { ChatTagStylesModule } from "./chat-tag-styles/chat-tag-styles.module";
import { DepositsModule } from "./deposits/deposits.module";
import { HealthController } from "../health.controller";
import { NotificationsModule } from "./notifications/notifications.module";

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    RestaurantsModule,
    FloorPlansModule,
    TablesModule,
    ReservationsModule,
    CustomersModule,
    RealtimeModule,
    IntegrationsModule,
    OnlineBookingsModule,
    RestaurantConfigurationModule,
    GiftCardsModule,
    ChatTagStylesModule,
    DepositsModule,
    NotificationsModule,
    AuditModule
  ]
})
export class AppModule {}
