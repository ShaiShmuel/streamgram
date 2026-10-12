import { ApiProperty } from "@nestjs/swagger";
import { IsString, Matches, MaxLength, MinLength } from "class-validator";

export class CompletePasswordResetDto {
  @ApiProperty() @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) token: string;
  @ApiProperty({ minLength: 8, maxLength: 1024 })
  @IsString() @MinLength(8) @MaxLength(1024) password: string;
}
export class PasswordResetResponseDto {
  @ApiProperty() success: boolean;
}
