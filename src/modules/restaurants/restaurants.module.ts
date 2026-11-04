import { RestaurantFeaturesController } from "./restaurant-features.controller";
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { RestaurantsController } from "./restaurants.controller";
import { PlatformTenantsController } from "./platform-tenants.controller";
import { RestaurantBootstrapController } from "./restaurant-bootstrap.controller";
import { RestaurantsService } from "./restaurants.service";

@Module({
  imports: [AuditModule],
  controllers: [RestaurantFeaturesController, RestaurantsController, RestaurantBootstrapController, PlatformTenantsController],
  providers: [RestaurantsService],
  exports: [RestaurantsService]
})
export class RestaurantsModule {}
