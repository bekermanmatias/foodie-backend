import { ProofStorageService } from "./proof-storage.service";
import { DepositDriveService } from "./deposit-drive.service";
import { ReservationsModule } from "../reservations/reservations.module";
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { DepositsController } from "./deposits.controller";
import { DepositsService } from "./deposits.service";
import { R2StorageService } from "./r2-storage.service";
@Module({ imports: [AuditModule, ReservationsModule], controllers: [DepositsController], providers: [DepositsService, R2StorageService, ProofStorageService, DepositDriveService], exports: [DepositsService] })
export class DepositsModule {}
