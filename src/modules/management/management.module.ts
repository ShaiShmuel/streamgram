import { NotificationsModule } from "../notifications/notifications.module";
import { PasswordResetService } from "./password-reset.service";
import { PasswordResetController } from "./password-reset.controller";
import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ManagementService } from "./management.service";
import {
  AdminGuard,
  PersonalGuard,
  ManagementOriginGuard,
} from "./management.guards";
import {
  InvitationController,
  ManagementController,
} from "./management.controller";
import { AuthModule } from "../auth/auth.module";

@Global()
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [ManagementController, InvitationController, PasswordResetController],
  providers: [
    ManagementService,
    PasswordResetService,
    AdminGuard,
    PersonalGuard,
    { provide: APP_GUARD, useClass: ManagementOriginGuard },
  ],
  exports: [ManagementService, AdminGuard, PersonalGuard],
})
export class ManagementModule {}
