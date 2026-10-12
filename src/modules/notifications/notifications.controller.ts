import { Body, Controller, Get, Post, Put, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AdminGuard } from "../management/management.guards";
import { InstanceConfigService } from "../user/instance-config.service";
import { NotificationsService } from "./notifications.service";
import { NotificationSettingsDto, NotificationSettingsResponseDto } from "./dto/notification-settings.dto";
@ApiTags("Notifications")
@Controller("admin/notifications")
@UseGuards(AdminGuard)
export class NotificationsController {
  constructor(private readonly config: InstanceConfigService, private readonly notifications: NotificationsService) {}
  @Get() @ApiOperation({ summary: "Get notification settings without the bot token" })
  @ApiOkResponse({ type: NotificationSettingsResponseDto })
  settings() { return this.notifications.settings(); }
  @Put() @ApiOperation({ summary: "Save Telegram notification settings" })
  @ApiOkResponse({ type: NotificationSettingsResponseDto })
  save(@Body() body: NotificationSettingsDto) {
    this.config.updateNotificationSettings(body);
    return this.notifications.settings();
  }
  @Post("test") @ApiOperation({ summary: "Send a test using saved settings, even when alerts are disabled" })
  test() { return this.notifications.test(); }
}
