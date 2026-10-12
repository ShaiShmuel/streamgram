import { Body, Controller, HttpCode, Post, Req, Res } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { CompletePasswordResetDto, PasswordResetResponseDto } from "./dto/password-reset.dto";
import { PasswordResetService } from "./password-reset.service";

@ApiTags("Admin password recovery")
@Controller("admin/password-reset")
export class PasswordResetController {
  constructor(private readonly reset: PasswordResetService) {}
  @Post("request") @HttpCode(200)
  @ApiOperation({ summary: "Request a ten-minute reset link through the configured Telegram notification chat" })
  @ApiOkResponse({ type: PasswordResetResponseDto })
  request(@Req() request: Request) { return this.reset.request(request); }
  @Post("complete") @HttpCode(200)
  @ApiOperation({ summary: "Consume a reset link, change the admin password, and sign in" })
  @ApiOkResponse({ type: PasswordResetResponseDto })
  complete(@Body() body: CompletePasswordResetDto, @Req() request: Request,
    @Res({ passthrough: true }) response: Response) {
    return this.reset.complete(body.token, body.password, request, response);
  }
}
