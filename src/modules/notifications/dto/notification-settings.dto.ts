import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, ArrayUnique, validateSync } from "class-validator";
import { plainToInstance } from "class-transformer";
import { BadRequestException } from "@nestjs/common";

export const NOTIFICATION_EVENTS = ["account_joined", "account_deleted", "admin_login", "admin_password_failed", "admin_lockout"] as const;
export type NotificationEventType = typeof NOTIFICATION_EVENTS[number];
export interface NotificationSettings {
  enabled: boolean;
  botToken?: string;
  chatId?: string;
  events: NotificationEventType[];
}
export class NotificationSettingsDto {
  @ApiProperty() @IsBoolean() enabled: boolean;
  @ApiPropertyOptional({ description: "Blank preserves the saved token" })
  @IsOptional() @IsString() @MaxLength(256)
  @Matches(/^(?:\d+:[A-Za-z0-9_-]+)?$/) botToken?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128)
  @Matches(/^(?:-?[1-9]\d*|@[A-Za-z][A-Za-z0-9_]{4,31})?$/) chatId?: string;
  @ApiProperty({ enum: NOTIFICATION_EVENTS, isArray: true })
  @IsArray() @ArrayUnique() @IsIn(NOTIFICATION_EVENTS, { each: true }) events: NotificationEventType[];
}
export function validateNotificationSettings(value: unknown): NotificationSettings {
  const parsed = plainToInstance(NotificationSettingsDto, value);
  if (!parsed || validateSync(parsed, { whitelist: true, forbidNonWhitelisted: true }).length ||
      (parsed.enabled && (!parsed.botToken || !parsed.chatId))) {
    throw new BadRequestException("Invalid notification settings; enabling requires a bot token and chat ID");
  }
  return { enabled: parsed.enabled, botToken: parsed.botToken, chatId: parsed.chatId, events: [...parsed.events] };
}
export class NotificationSettingsResponseDto {
  @ApiProperty() enabled: boolean;
  @ApiProperty() botTokenConfigured: boolean;
  @ApiProperty() chatId: string;
  @ApiProperty({ enum: NOTIFICATION_EVENTS, isArray: true }) events: NotificationEventType[];
  @ApiPropertyOptional({ nullable: true }) lastDelivery: { at: string; success: boolean; message: string } | null;
}
